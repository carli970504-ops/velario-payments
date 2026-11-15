// Servidor de pruebas de pagos: usa la aplicación real (src/app.mjs) con proveedores
// simulados y una API de control para marcar un pago como completado.
//
// Uso: node tools/qa/mock-gateway.mjs     (PORT=8790 por defecto)
//   POST /__pay   {"reference":"cs_test_..."}   marca el pago como pagado
//   GET  /__state                               estado de las sesiones simuladas
//   POST /__reset                               limpia las sesiones

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.mjs';
import { Store } from '../../src/store.mjs';
import { createAccounts } from '../../src/account.mjs';
import { readConfig } from '../../src/config.mjs';

const port = Number(process.env.QA_PORT || 8790);
const sessions = new Map();

const stripe = {
  configured: true,
  async create(account) {
    const reference = 'cs_test_' + randomUUID().replace(/-/g, '').slice(0, 24);
    sessions.set(reference, { account, kind: 'checkout', paid: false });
    return { reference, kind: 'checkout', url: 'https://checkout.stripe.com/c/pay/' + reference };
  },
  async createCredit(account, mode) {
    const reference = 'cs_test_' + randomUUID().replace(/-/g, '').slice(0, 24);
    sessions.set(reference, { account, kind: 'credit', paid: false, mode });
    return { reference, url: 'https://checkout.stripe.com/c/pay/' + reference, mode };
  },
  async claimCredit(reference, account) {
    const s = sessions.get(reference);
    if (!s || s.account !== account) throw Object.assign(new Error('La compra no corresponde a esta cuenta.'), { status: 403 });
    if (!s.paid) return { paid: false, mode: s.mode, credits: 0, status: 'open' };
    return { paid: true, mode: s.mode, credits: 1000, status: 'paid' };
  },
  async inspect(reference, account) {
    const s = sessions.get(reference);
    if (!s) return { active: false, expiresAt: null, status: 'pending' };
    if (s.account !== account) throw Object.assign(new Error('La compra no corresponde a esta cuenta.'), { status: 403 });
    const expiresAt = new Date(Date.now() + 7 * 864e5).toISOString();
    return s.paid ? { active: true, expiresAt, status: 'active' } : { active: false, expiresAt, status: 'pending' };
  },
  async manage() { return { url: 'https://billing.stripe.com/p/session/test_session' }; },
  async findByAccount(account) {
    return [...sessions].filter(([, s]) => s.kind === 'checkout' && s.paid && s.account === account).map(([id]) => id);
  },
  async verifyWebhook(raw) {
    const event = JSON.parse(raw);
    const s = sessions.get(event.reference);
    if (s) s.paid = true;
    return { id: event.id, updates: s ? [{ account: s.account, reference: event.reference, kind: 'subscription', revokedAt: 0 }] : [] };
  }
};
const off = () => { throw Object.assign(new Error('El proveedor no está configurado.'), { status: 503 }); };
const paypal = { configured: false, create: off, inspect: off, verifyWebhook: off, manage: off };
const play = { configured: false, create: off, inspect: off, ready: off, manage: off };

const config = readConfig({ PAYMENTS_MODE: 'test', PUBLIC_BASE_URL: 'https://velario-payments.onrender.com' });
const store = new Store(':memory:');
const app = createApp({ config, store, providers: { stripe, paypal, play }, accounts: createAccounts('qa-secreto-de-pruebas-1234567890'), log: { error() {} } });

await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
console.log('gateway en http://127.0.0.1:' + port);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/__pay') {
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const s = sessions.get(input.reference);
    if (!s) return send(404, { error: 'sesión desconocida', reference: input.reference });
    s.paid = true;
    return send(200, { paid: true, reference: input.reference, mode: s.mode || 'subscription' });
  }
  if (req.url === '/__state') return send(200, { sessions: [...sessions].map(([id, s]) => ({ id, ...s })), count: sessions.size });
  if (req.url === '/__reset') { sessions.clear(); return send(200, { ok: true }); }
  if (req.url === '/__health') return send(200, { ok: true });
  send(404, { error: 'ruta de control desconocida' });
}).listen(port + 1, '127.0.0.1', () => console.log('control en http://127.0.0.1:' + (port + 1)));
