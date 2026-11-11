import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';
import { createAccounts } from '../src/account.mjs';

const expiry = () => new Date(Date.now() + 86400000).toISOString();

function mockProviders(stripe = {}) {
  const base = {
    configured: true,
    async create() { return { reference: 'cs_test', kind: 'checkout', url: 'https://checkout.stripe.com/test' }; },
    async inspect() { return { active: false, expiresAt: null, status: 'pending' }; },
    async verifyWebhook() { throw new Error('sin firma'); },
    async manage() { return { url: 'https://billing.stripe.com/test' }; }
  };
  return { stripe: { ...base, ...stripe }, paypal: { ...base }, play: { ...base } };
}

async function listen(app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}
const stop = app => new Promise(resolve => app.server.close(() => resolve()));

test('la sesion sobrevive a vaciar la base y la suscripcion se recupera desde Stripe', async () => {
  const accounts = createAccounts('secreto-de-prueba-suficientemente-largo-123456');
  const providers = mockProviders({
    findByAccount: async () => ['sub_recuperada'],
    inspect: async () => ({ active: true, expiresAt: expiry(), status: 'active' })
  });

  // Servidor con su base de datos.
  const storeA = new Store(':memory:');
  const appA = createApp({ config: readConfig({}), store: storeA, providers, log: { error() {} }, accounts });
  const urlA = await listen(appA);
  const session = await (await fetch(urlA + '/api/session', { method: 'POST' })).json();
  assert.match(session.token, /^v1\./);
  assert.equal((await (await fetch(urlA + '/api/entitlement', { headers: { Authorization: 'Bearer ' + session.token } })).json()).active, true);
  await stop(appA);
  storeA.close();

  // "Reinicio de Render": disco nuevo y vacio, mismo secreto.
  const storeB = new Store(':memory:');
  const appB = createApp({ config: readConfig({}), store: storeB, providers, log: { error() {} }, accounts });
  const urlB = await listen(appB);
  assert.equal(storeB.rows(session.accountId).length, 0, 'la cache arranca vacia');
  const response = await fetch(urlB + '/api/entitlement', { headers: { Authorization: 'Bearer ' + session.token } });
  const body = await response.json();
  assert.equal(response.status, 200, 'el mismo token sigue autenticando');
  assert.equal(body.active, true, 'la suscripcion se reconstruye desde Stripe');
  assert.equal(body.productId, 'velario.pro.weekly');
  assert.equal(storeB.rows(session.accountId).length, 1, 'la cache se repuebla');
  await stop(appB);
  storeB.close();
});

test('un token manipulado o de otro secreto no autentica', async () => {
  const accounts = createAccounts('secreto-de-prueba-suficientemente-largo-123456');
  const store = new Store(':memory:');
  const app = createApp({ config: readConfig({}), store, providers: mockProviders(), log: { error() {} }, accounts });
  const url = await listen(app);
  const victima = '11111111-2222-3333-4444-555555555555';
  const manipulado = 'v1.' + Buffer.from(victima).toString('base64url') + '.' + 'A'.repeat(43);
  const otroSecreto = createAccounts('secreto-distinto-para-otra-instalacion-987654321');
  const ajeno = otroSecreto.issue();

  for (const token of [manipulado, ajeno.token]) {
    const response = await fetch(url + '/api/entitlement', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 401, 'token rechazado: ' + token.slice(0, 12));
  }
  await stop(app);
  store.close();
});
