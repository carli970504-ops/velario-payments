// Validación de la cadena real de Stripe en modo prueba contra el servidor desplegado.
// Lee la clave de .env pero NUNCA la imprime: solo publica resultados (importes, estados, ids).
//
// Uso: node tools/qa/stripe-check.mjs

import fs from 'node:fs';

const BASE = process.env.VELARIO_API || 'https://velario-payments.onrender.com';
const env = {};
for (const linea of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split('\n') : [])) {
  const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const key = env.STRIPE_SECRET_KEY;
const price = env.STRIPE_PRICE_ID;
console.log('clave de Stripe en .env:', key ? (key.startsWith('sk_test_') ? 'sk_test_ (modo prueba)' : 'NO es sk_test_') : 'ausente');
console.log('precio configurado en .env:', price ? 'sí' : 'ausente');
if (!key || !price) { console.log('BLOQUEO: faltan STRIPE_SECRET_KEY o STRIPE_PRICE_ID en .env'); process.exit(2); }

const stripe = async (ruta, metodo = 'GET', datos) => {
  const respuesta = await fetch('https://api.stripe.com/v1/' + ruta, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': '2026-10-28.endive', ...(datos ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(datos ? { body: new URLSearchParams(datos) } : {})
  });
  const cuerpo = await respuesta.json();
  if (!respuesta.ok) throw Object.assign(new Error(cuerpo?.error?.message || 'HTTP ' + respuesta.status), { detalle: cuerpo?.error });
  return cuerpo;
};

const fallos = [];
const ok = (nombre, condicion, detalle = '') => { console.log((condicion ? 'PASS ' : 'FAIL ') + nombre + (detalle ? ' · ' + detalle : '')); if (!condicion) fallos.push(nombre); };

let suscripcion = null;
try {
  const precio = await stripe('prices/' + encodeURIComponent(price));
  ok('el precio existe y es 2 USD por semana', precio.active === true && precio.unit_amount === 200 && precio.currency === 'usd' && precio.recurring?.interval === 'week', precio.unit_amount + ' ' + precio.currency + '/' + precio.recurring?.interval);

  const cuenta = await (await fetch(BASE + '/api/session', { method: 'POST', body: '{}' })).json();
  const auth = { Authorization: 'Bearer ' + cuenta.token, 'Content-Type': 'application/json' };
  const entitlement = async () => (await (await fetch(BASE + '/api/entitlement', { headers: auth })).json());

  // La API nueva ya no expone payment_intent en la factura: se cobra con una tarjeta de
  // prueba real del modo test, adjunta al cliente.
  // El API no acepta datos de tarjeta en crudo: se usa el valor de prueba pm_card_visa a
  // través de un SetupIntent confirmado, que deja un método real adjunto al cliente.
  const cliente = await stripe('customers', 'POST', { email: 'velario.prueba@example.com', 'metadata[account_id]': cuenta.accountId });
  const setup = await stripe('setup_intents', 'POST', {
    customer: cliente.id, payment_method: 'pm_card_visa', confirm: 'true', usage: 'off_session',
    'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never'
  });
  const metodo = { id: setup.payment_method };
  ok('se adjunta una tarjeta de prueba', Boolean(metodo.id) && setup.status === 'succeeded', setup.status);
  await stripe('customers/' + cliente.id, 'POST', { 'invoice_settings[default_payment_method]': metodo.id });
  const creada = await stripe('subscriptions', 'POST', {
    customer: cliente.id, 'items[0][price]': price, 'items[0][quantity]': '1',
    default_payment_method: metodo.id, payment_behavior: 'allow_incomplete',
    'metadata[account_id]': cuenta.accountId
  });
  suscripcion = creada.id;
  ok('Stripe crea la suscripción con tarjeta de prueba', Boolean(suscripcion), (creada.status || '') + ' · factura ' + (creada.latest_invoice?.status || 'sin factura'));

  const final = await stripe('subscriptions/' + suscripcion + '?expand[]=latest_invoice');
  const factura = final.latest_invoice && typeof final.latest_invoice === 'object' ? final.latest_invoice : null;
  ok('la suscripción queda activa y con factura', final.status === 'active' && Boolean(factura?.id), final.status + ' · factura ' + (factura?.status || 'ausente'));
  if (!factura) throw new Error('Stripe no devolvió la factura de la suscripción');

  const recibos = await stripe('invoice_payments?invoice=' + encodeURIComponent(factura.id) + '&status=paid&limit=10');
  ok('el primer cobro figura como pagado', (recibos.data || []).length > 0, 'pagos: ' + (recibos.data || []).length + ' · importe: ' + ((recibos.data || [])[0]?.amount_paid || 0) / 100);

  const activa = await entitlement();
  ok('producción activa Pro con el pago real de prueba', activa.active === true && activa.productId === 'velario.pro.weekly', JSON.stringify({ active: activa.active, status: activa.status, expiresAt: activa.expiresAt }));

  const restaurada = await entitlement();
  ok('restaurar compras mantiene el acceso', restaurada.active === true, JSON.stringify({ active: restaurada.active, status: restaurada.status }));

  const checkout = await fetch(BASE + '/api/checkout', { method: 'POST', headers: auth, body: JSON.stringify({ method: 'card' }) });
  ok('con Pro activo no se abre otro cobro', checkout.status === 409, 'HTTP ' + checkout.status);

  const cancelada = await stripe('subscriptions/' + suscripcion, 'DELETE');
  suscripcion = null;
  ok('al cancelar, Stripe deja la suscripción cancelada', cancelada.status === 'canceled', cancelada.status);
  const trasCancelar = await entitlement();
  ok('producción deja de dar Pro tras la cancelación', trasCancelar.active === false, JSON.stringify({ active: trasCancelar.active, status: trasCancelar.status }));
} catch (error) {
  ok('la validación con Stripe terminó sin errores', false, (error.message || String(error)) + (error.detalle ? ' · ' + JSON.stringify(error.detalle).slice(0, 200) : ''));
} finally {
  if (suscripcion) {
    try { await stripe('subscriptions/' + suscripcion, 'DELETE'); console.log('limpieza: suscripción de prueba cancelada'); } catch { console.log('limpieza: no se pudo cancelar'); }
  }
  console.log('\n' + (fallos.length ? fallos.length + ' comprobaciones fallidas' : 'todas las comprobaciones correctas'));
  if (fallos.length) process.exitCode = 1;
}
