const fs = require('fs');
const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('='); if (i < 0) continue;
  env[line.slice(0, i)] = line.slice(i + 1);
}
const key = env.STRIPE_SECRET_KEY;
const h = { Authorization: 'Bearer ' + key, 'Stripe-Version': '2026-10-28.endive' };
(async () => {
  const s = await (await fetch('https://api.stripe.com/v1/checkout/sessions?limit=5', { headers: h })).json();
  console.log('=== sesiones de checkout recientes ===');
  for (const x of s.data || []) {
    console.log(' ', x.id, '| status:', x.status, '| pago:', x.payment_status, '| cuenta:', x.client_reference_id, '| sub:', x.subscription || '-');
  }
  const subs = await (await fetch('https://api.stripe.com/v1/subscriptions?limit=5&expand[]=data.latest_invoice', { headers: h })).json();
  console.log('=== suscripciones recientes ===');
  for (const x of subs.data || []) {
    const inv = x.latest_invoice;
    console.log(' ', x.id, '| status:', x.status, '| cuenta:', x.metadata && x.metadata.account_id, '| fin periodo:', new Date((x.current_period_end || 0) * 1000).toISOString(), '| factura:', inv && typeof inv === 'object' ? inv.status + ' paid=' + inv.paid : String(inv));
  }
  if (s.error) console.log('error stripe:', s.error.message);
})().catch(e => console.error('ERROR:', e.message));
