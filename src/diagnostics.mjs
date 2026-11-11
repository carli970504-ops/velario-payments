import fs from 'node:fs';

// Diagnóstico de proveedores de pago. Nunca incluye claves: solo nombres de variables,
// identificadores públicos (price_id, plan_id, producto) y la causa concreta del fallo.
export function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/sk_(test|live)_[A-Za-z0-9_*]+/g, 'sk_$1_***')
    .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_***')
    .replace(/EAAA[A-Za-z0-9_-]+/g, 'EAAA***')
    .replace(/[A-Za-z0-9_-]{40,}/g, '***');
}

function report(provider, configured, missing, checks) {
  return { provider, configured, ok: configured && checks.every(check => check.ok), missing, checks };
}

function classifyStripePrice(error, priceId) {
  const status = error?.providerStatus;
  const base = { id: 'precio', ok: false };
  if (status === 401) return { ...base, code: 'clave_invalida', detail: 'Stripe rechaza la clave secreta (401): no existe, fue revocada o pertenece a otra cuenta.' };
  if (status === 404) return { ...base, code: 'precio_no_encontrado', detail: `El precio ${priceId} no existe en la cuenta de esa clave (404).` };
  if (status === 403) return { ...base, code: 'clave_restringida', detail: 'La clave no tiene permiso para leer precios (403).' };
  if (error?.status === 503) return { ...base, code: 'precio_incorrecto', detail: sanitize(error.message) };
  return { ...base, code: 'error_api', detail: sanitize(error?.providerDetail || error?.message || 'Error desconocido de Stripe.') };
}

async function checkStripe(config, provider) {
  const settings = config.stripe || {};
  const missing = [['STRIPE_SECRET_KEY', 'key'], ['STRIPE_PRICE_ID', 'priceId'], ['STRIPE_WEBHOOK_SECRET', 'webhookSecret']]
    .filter(([, field]) => !settings[field]).map(([name]) => name);
  if (!config.publicBaseUrl) missing.push('PUBLIC_BASE_URL');
  const checks = [];
  if (missing.length) {
    checks.push({ id: 'configuracion', ok: false, code: 'sin_credenciales', detail: `Faltan variables: ${missing.join(', ')}` });
    return report('stripe', false, missing, checks);
  }
  const liveKey = String(settings.key).startsWith('sk_live_');
  const modeOk = (config.mode === 'live') === liveKey;
  checks.push({ id: 'modo_clave', ok: modeOk, code: modeOk ? 'ok' : 'modo_clave',
    detail: modeOk ? `Clave ${liveKey ? 'live' : 'test'} acorde a PAYMENTS_MODE=${config.mode}.`
      : `PAYMENTS_MODE=${config.mode} pero la clave es ${liveKey ? 'live' : 'test'}.` });
  const webhookOk = /^whsec_/.test(String(settings.webhookSecret));
  checks.push({ id: 'webhook_secreto', ok: webhookOk, code: webhookOk ? 'ok' : 'webhook_formato',
    detail: webhookOk ? 'Secreto de webhook con formato whsec_ correcto.' : 'STRIPE_WEBHOOK_SECRET no empieza por whsec_.' });
  try {
    await provider.validatePrice();
    checks.push({ id: 'precio', ok: true, code: 'ok', detail: `Precio ${settings.priceId} válido: 200 USD cada semana.` });
  } catch (error) {
    checks.push(classifyStripePrice(error, settings.priceId));
  }
  return report('stripe', true, missing, checks);
}

async function checkPaypal(config, provider) {
  const settings = config.paypal || {};
  const missing = [['PAYPAL_CLIENT_ID', 'clientId'], ['PAYPAL_CLIENT_SECRET', 'secret'], ['PAYPAL_PLAN_ID', 'planId'], ['PAYPAL_WEBHOOK_ID', 'webhookId']]
    .filter(([, field]) => !settings[field]).map(([name]) => name);
  if (!config.publicBaseUrl) missing.push('PUBLIC_BASE_URL');
  const checks = [];
  if (missing.length) {
    checks.push({ id: 'configuracion', ok: false, code: 'sin_credenciales', detail: `Faltan variables: ${missing.join(', ')}` });
    return report('paypal', false, missing, checks);
  }
  try {
    await provider.token();
    checks.push({ id: 'credenciales', ok: true, code: 'ok', detail: `PayPal acepta las claves (${config.mode === 'live' ? 'live' : 'sandbox'}).` });
  } catch (error) {
    checks.push({ id: 'credenciales', ok: false, code: error?.providerStatus === 401 ? 'credenciales_invalidas' : 'error_api',
      detail: sanitize(error?.providerDetail || error?.message) });
    return report('paypal', true, missing, checks);
  }
  try {
    await provider.validatePrice();
    checks.push({ id: 'plan', ok: true, code: 'ok', detail: `Plan ${settings.planId} válido: 2 USD cada semana.` });
  } catch (error) {
    const code = error?.providerStatus === 404 ? 'plan_no_encontrado' : error?.status === 503 ? 'plan_incorrecto' : 'error_api';
    checks.push({ id: 'plan', ok: false, code, detail: sanitize(error?.providerDetail || error?.message) });
  }
  return report('paypal', true, missing, checks);
}

async function checkGoogle(config, provider) {
  const settings = config.google || {};
  const missing = [];
  if (!settings.file) missing.push('GOOGLE_SERVICE_ACCOUNT_FILE');
  if (!settings.packageName) missing.push('GOOGLE_PACKAGE_NAME');
  if (!settings.basePlanId) missing.push('GOOGLE_BASE_PLAN_ID');
  const checks = [];
  if (missing.length) {
    checks.push({ id: 'configuracion', ok: false, code: 'sin_credenciales', detail: `Faltan variables: ${missing.join(', ')}` });
    return report('play', false, missing, checks);
  }
  let service;
  try {
    service = JSON.parse(fs.readFileSync(settings.file, 'utf8'));
    if (!service.client_email || !service.private_key) throw new Error('faltan client_email o private_key');
    checks.push({ id: 'cuenta_servicio', ok: true, code: 'ok', detail: `Cuenta de servicio ${service.client_email}.` });
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'archivo_no_encontrado' : 'cuenta_invalida';
    checks.push({ id: 'cuenta_servicio', ok: false, code, detail: sanitize(error.message) });
    return report('play', true, missing, checks);
  }
  try {
    await provider.token();
    checks.push({ id: 'credenciales', ok: true, code: 'ok', detail: 'Google acepta la firma de la cuenta de servicio.' });
  } catch (error) {
    checks.push({ id: 'credenciales', ok: false, code: 'credenciales_invalidas', detail: sanitize(error?.providerDetail || error?.message) });
    return report('play', true, missing, checks);
  }
  try {
    await provider.validatePlan();
    checks.push({ id: 'producto', ok: true, code: 'ok', detail: `Producto ${settings.packageName} con plan ${settings.basePlanId} de 2 USD semanales.` });
  } catch (error) {
    const code = error?.providerStatus === 404 ? 'producto_no_encontrado' : error?.status === 503 ? 'plan_incorrecto' : 'error_api';
    checks.push({ id: 'producto', ok: false, code, detail: sanitize(error?.providerDetail || error?.message) });
  }
  return report('play', true, missing, checks);
}

export async function diagnoseProviders({ config, providers, now = Date.now() }) {
  const jobs = [['stripe', checkStripe], ['paypal', checkPaypal], ['play', checkGoogle]];
  const settled = await Promise.allSettled(jobs.map(([name, check]) => check(config, providers[name])));
  const list = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return { provider: jobs[index][0], configured: true, ok: false, missing: [],
      checks: [{ id: 'diagnostico', ok: false, code: 'excepcion', detail: sanitize(result.reason?.message || 'Error inesperado del diagnóstico.') }] };
  });
  return { ok: list.every(item => item.ok), mode: config.mode, checkedAt: new Date(now).toISOString(), providers: list };
}

export function formatReport(data) {
  const lines = [`Velario · diagnóstico de pagos (modo ${data.mode})`, data.ok ? 'Resultado: todo listo' : 'Resultado: hay problemas', ''];
  for (const item of data.providers) {
    lines.push(`${item.ok ? 'OK   ' : 'FALLA'} ${item.provider}${item.configured ? '' : ' (sin configurar)'}`);
    for (const check of item.checks) {
      lines.push(`   ${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}${check.ok ? '' : ` [${check.code}]`}`);
    }
  }
  return lines.join('\n');
}
