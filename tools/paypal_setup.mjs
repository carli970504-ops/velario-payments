// Crea en PayPal (sandbox o live segun PAYMENTS_MODE) el producto, el plan
// semanal de 2 USD y el webhook que espera el servidor.
//
// Es idempotente: si el plan o el webhook ya existen, los reutiliza en vez de
// duplicarlos. PayPal no permite editar precio ni ciclos de un plan, asi que si
// el plan existente no cumple la forma exigida se crea uno nuevo y se avisa.
//
// Uso:
//   1. Deja las credenciales de la app de PayPal en el archivo .paypal-creds
//      (primera linea: client id, segunda linea: secret) o en las variables
//      PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.
//   2. node tools/paypal_setup.mjs
//
// Nunca imprime el client id ni el secret; solo los IDs.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const NOMBRE_PRODUCTO = 'Velario Pro';

function readEnvFile() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function credentials() {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    return { clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET };
  }
  const file = path.join(root, '.paypal-creds');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  return { clientId: lines[0], secret: lines[1] };
}

function idsGuardados() {
  const file = path.join(root, 'paypal-env.txt');
  if (!fs.existsSync(file)) return {};
  const salida = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(PAYPAL_PLAN_ID|PAYPAL_WEBHOOK_ID)=(.*)$/);
    if (m && m[2].trim()) salida[m[1]] = m[2].trim();
  }
  return salida;
}

const envFile = readEnvFile();
const mode = envFile.PAYMENTS_MODE || process.env.PAYMENTS_MODE || 'test';
const publicBaseUrl = (envFile.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const creds = credentials();
if (!creds) {
  console.error('Faltan credenciales: crea .paypal-creds con el client id y el secret de la app de PayPal.');
  process.exit(2);
}
if (!publicBaseUrl.startsWith('https://')) {
  console.error('Falta PUBLIC_BASE_URL (https) en .env para saber donde registrar el webhook.');
  process.exit(2);
}

let accessToken = null;
async function token() {
  if (accessToken) return accessToken;
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`PayPal rechazo las credenciales (HTTP ${res.status}). Revisa el client id y el secret del modo ${mode}.`);
    process.exit(3);
  }
  accessToken = body.access_token;
  return accessToken;
}

async function call(pathname, method = 'GET', body) {
  const res = await fetch(`${base}/${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) {
    const detail = parsed?.details?.[0]?.issue || parsed?.name || `HTTP ${res.status}`;
    throw new Error(`PayPal ${method} ${pathname} fallo: ${detail}`);
  }
  return parsed;
}

// Forma que exige el servidor: un unico ciclo semanal de 2 USD, sin cuota inicial.
function planValido(plan) {
  if (!plan) return false;
  const cycles = plan.billing_cycles || [], cycle = cycles[0];
  return plan.status === 'ACTIVE' && cycles.length === 1 && cycle?.tenure_type === 'REGULAR'
    && cycle?.frequency?.interval_unit === 'WEEK' && cycle?.frequency?.interval_count === 1
    && cycle?.total_cycles === 0 && cycle?.pricing_scheme?.fixed_price?.currency_code === 'USD'
    && Number(cycle?.pricing_scheme?.fixed_price?.value) === 2
    && Number(plan.payment_preferences?.setup_fee?.value || 0) === 0;
}

async function planPorId(id) {
  try { return await call(`v1/billing/plans/${encodeURIComponent(id)}`); } catch { return null; }
}

const guardados = idsGuardados();
let plan = null;
let producto = null;
let origenPlan = 'nuevo';

// 1) Un plan ya usado antes (paypal-env.txt) y que siga siendo valido.
if (guardados.PAYPAL_PLAN_ID) {
  const existente = await planPorId(guardados.PAYPAL_PLAN_ID);
  if (planValido(existente)) {
    plan = existente;
    producto = { id: existente.product_id };
    origenPlan = 'reutilizado (paypal-env.txt)';
  }
}

// 2) Un producto y un plan con el nombre esperado que ya existan en la cuenta.
if (!plan) {
  const lista = await call('v1/catalogs/products?page_size=100&total_required=true');
  producto = (lista.products || []).find(p => p.name === NOMBRE_PRODUCTO) || null;
  if (producto) {
    const planes = await call(`v1/billing/plans?product_id=${encodeURIComponent(producto.id)}&page_size=20&status=ACTIVE`);
    for (const candidato of planes.plans || []) {
      const completo = await planPorId(candidato.id);
      if (planValido(completo)) { plan = completo; origenPlan = 'reutilizado (cuenta PayPal)'; break; }
    }
  }
}

// 3) Si no hay nada reutilizable, se crea.
if (!producto) {
  producto = await call('v1/catalogs/products', 'POST', {
    name: NOMBRE_PRODUCTO,
    description: 'Suscripcion semanal a Velario Pro',
    type: 'SERVICE',
    category: 'SOFTWARE'
  });
}
if (!plan) {
  plan = await call('v1/billing/plans', 'POST', {
    product_id: producto.id,
    name: `${NOMBRE_PRODUCTO} semanal ${mode}`,
    description: '2 USD por semana, sin cuota inicial ni prueba',
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: 'WEEK', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: '2', currency_code: 'USD' } }
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: '0', currency_code: 'USD' },
      setup_fee_failure_action: 'CONTINUE',
      payment_failure_threshold: 3
    }
  });
  const comprobacion = await planPorId(plan.id);
  if (!planValido(comprobacion)) {
    console.error('El plan creado no cumple la forma que exige el servidor.');
    process.exit(4);
  }
  plan = comprobacion;
}

if (!planValido(plan)) {
  console.error('Hay un plan guardado que ya no cumple la forma exigida y no se pudo sustituir.');
  process.exit(4);
}

const webhookUrl = `${publicBaseUrl}/webhooks/paypal`;
const eventos = [
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED'
];

const existentes = await call('v1/notifications/webhooks');
let webhook = (existentes.webhooks || []).find(v => v.url === webhookUrl);
let origenWebhook = 'reutilizado';
if (webhook) {
  await call(`v1/notifications/webhooks/${encodeURIComponent(webhook.id)}`, 'PATCH', [
    { op: 'replace', path: '/event_types', value: eventos.map(name => ({ name })) }
  ]);
} else {
  webhook = await call('v1/notifications/webhooks', 'POST', { url: webhookUrl, event_types: eventos.map(name => ({ name })) });
  origenWebhook = 'creado';
}

fs.writeFileSync(path.join(root, 'paypal-env.txt'), `PAYPAL_PLAN_ID=${plan.id}\nPAYPAL_WEBHOOK_ID=${webhook.id}\n`);

console.log('producto         :', producto.id);
console.log('plan             :', plan.id, '(' + origenPlan + ')');
console.log('webhook          :', webhook.id, '(' + origenWebhook + ')');
console.log('webhook apuntando:', webhookUrl);
console.log('guardado en      : paypal-env.txt');
console.log('Falta ademas PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET en Render.');
