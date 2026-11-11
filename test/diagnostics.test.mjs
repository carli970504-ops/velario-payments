import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.mjs';
import { createProviders, PaymentError } from '../src/providers.mjs';
import { diagnoseProviders, formatReport, sanitize } from '../src/diagnostics.mjs';

const accountFile = path.join(os.tmpdir(), 'velario-test-service-account.json');
fs.writeFileSync(accountFile, JSON.stringify({ client_email: 'robot@project.iam.gserviceaccount.com', private_key: 'no-usar' }));

const ready = () => ({ configured: true, validatePrice: async () => { }, token: async () => 'token', validatePlan: async () => { } });
const providersFor = overrides => ({
  stripe: { ...ready(), ...overrides.stripe },
  paypal: { ...ready(), ...overrides.paypal },
  play: { ...ready(), ...overrides.play }
});
const configured = () => readConfig({
  PAYMENTS_MODE: 'test', PUBLIC_BASE_URL: 'https://payments.example.com',
  STRIPE_SECRET_KEY: 'sk_test_SECRETO_STTRIPE', STRIPE_PRICE_ID: 'price_weekly', STRIPE_WEBHOOK_SECRET: 'whsec_SECRETO_WEBHOOK',
  PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'SECRETO_PAYPAL', PAYPAL_PLAN_ID: 'plan_weekly', PAYPAL_WEBHOOK_ID: 'hook-id',
  GOOGLE_SERVICE_ACCOUNT_FILE: accountFile, GOOGLE_PACKAGE_NAME: 'com.velario.app', GOOGLE_BASE_PLAN_ID: 'weekly'
});

test('un servidor sin credenciales informa qué variable falta y no llama a los proveedores', async () => {
  const config = readConfig({});
  const providers = createProviders(config);
  let touched = 0;
  for (const name of ['stripe', 'paypal', 'play']) {
    for (const method of ['validatePrice', 'token', 'validatePlan']) {
      if (typeof providers[name][method] === 'function') {
        const original = providers[name][method].bind(providers[name]);
        providers[name][method] = async (...args) => { touched++; return original(...args); };
      }
    }
  }
  const report = await diagnoseProviders({ config, providers });
  assert.equal(touched, 0);
  assert.equal(report.ok, false);
  const stripe = report.providers.find(item => item.provider === 'stripe');
  assert.equal(stripe.configured, false);
  assert.deepEqual(stripe.missing, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'PUBLIC_BASE_URL']);
  assert.equal(stripe.checks[0].code, 'sin_credenciales');
  const paypal = report.providers.find(item => item.provider === 'paypal');
  assert.deepEqual(paypal.missing, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_PLAN_ID', 'PAYPAL_WEBHOOK_ID', 'PUBLIC_BASE_URL']);
});

test('todo configurado y correcto da un diagnóstico en verde', async () => {
  const report = await diagnoseProviders({ config: configured(), providers: providersFor({}) });
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'test');
  assert.deepEqual(report.providers.map(item => item.provider), ['stripe', 'paypal', 'play']);
  assert.deepEqual(report.providers.find(item => item.provider === 'stripe').missing, []);
});

test('clave de Stripe rechazada, precio inexistente y precio incorrecto se distinguen', async () => {
  const invalidKey = Object.assign(new PaymentError('No se pudo verificar la operación con el proveedor.'), { providerStatus: 401 });
  let report = await diagnoseProviders({ config: configured(), providers: providersFor({ stripe: { validatePrice: async () => { throw invalidKey; } } }) });
  let stripe = report.providers.find(item => item.provider === 'stripe');
  assert.equal(stripe.ok, false);
  assert.equal(stripe.checks.find(check => check.id === 'precio').code, 'clave_invalida');

  const notFound = Object.assign(new PaymentError('No se pudo verificar la operación con el proveedor.'), { providerStatus: 404 });
  report = await diagnoseProviders({ config: configured(), providers: providersFor({ stripe: { validatePrice: async () => { throw notFound; } } }) });
  stripe = report.providers.find(item => item.provider === 'stripe');
  assert.equal(stripe.checks.find(check => check.id === 'precio').code, 'precio_no_encontrado');

  report = await diagnoseProviders({ config: configured(), providers: providersFor({ stripe: { validatePrice: async () => { throw new PaymentError('El precio debe ser 2 USD cada semana.', 503); } } }) });
  stripe = report.providers.find(item => item.provider === 'stripe');
  assert.equal(stripe.checks.find(check => check.id === 'precio').code, 'precio_incorrecto');
  assert.match(stripe.checks.find(check => check.id === 'precio').detail, /2 USD/);
});

test('modo de clave incoherente y secreto de webhook mal formado se reportan', async () => {
  const base = configured();
  const config = { ...base, mode: 'live', stripe: { ...base.stripe, webhookSecret: 'no-es-stripe' } };
  const report = await diagnoseProviders({ config, providers: providersFor({}) });
  const stripe = report.providers.find(item => item.provider === 'stripe');
  assert.equal(stripe.checks.find(check => check.id === 'modo_clave').ok, false);
  assert.equal(stripe.checks.find(check => check.id === 'webhook_secreto').code, 'webhook_formato');
});

test('paypal con credenciales rechazadas y google con cuenta ilegible no se confunden con un fallo de precio', async () => {
  const denied = Object.assign(new PaymentError('No se pudo verificar la operación con el proveedor.'), { providerStatus: 401 });
  let report = await diagnoseProviders({ config: configured(), providers: providersFor({ paypal: { token: async () => { throw denied; } } }) });
  const paypal = report.providers.find(item => item.provider === 'paypal');
  assert.equal(paypal.checks.find(check => check.id === 'credenciales').code, 'credenciales_invalidas');
  assert.equal(paypal.checks.some(check => check.id === 'plan'), false);

  const broken = readConfig({ GOOGLE_SERVICE_ACCOUNT_FILE: import.meta.filename, GOOGLE_PACKAGE_NAME: 'com.velario.app', GOOGLE_BASE_PLAN_ID: 'weekly' });
  report = await diagnoseProviders({ config: broken, providers: providersFor({}) });
  const play = report.providers.find(item => item.provider === 'play');
  assert.equal(play.checks.find(check => check.id === 'cuenta_servicio').code, 'cuenta_invalida');
});

test('el diagnóstico nunca imprime claves ni secretos', async () => {
  const text = JSON.stringify(await diagnoseProviders({ config: configured(), providers: providersFor({}) }));
  for (const secret of ['SECRETO_STTRIPE', 'SECRETO_WEBHOOK', 'SECRETO_PAYPAL']) assert.equal(text.includes(secret), false);
  assert.equal(text.includes('price_weekly'), true);
  assert.equal(sanitize('Invalid API Key provided: sk_test_ABCdef123'), 'Invalid API Key provided: sk_test_***');
  assert.equal(sanitize('token EAAAabcdefghijklmnop'), 'token EAAA***');
  assert.equal(sanitize('x'.repeat(45)).includes('xxxx'), false);
});

test('el reporte legible nombra cada proveedor y su estado', async () => {
  const data = await diagnoseProviders({ config: readConfig({}), providers: createProviders(readConfig({})) });
  const text = formatReport(data);
  assert.match(text, /diagnóstico de pagos/);
  assert.match(text, /FALLA stripe/);
  assert.match(text, /sin configurar/);
  assert.match(text, /Faltan variables: STRIPE_SECRET_KEY/);
});
