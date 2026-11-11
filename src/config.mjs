import path from 'node:path';

export const PRODUCT_ID = 'velario.pro.weekly';
export function readConfig(env = process.env) {
  const publicBaseUrl = env.PUBLIC_BASE_URL || '';
  if (publicBaseUrl && !publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use HTTPS');
  const mode = env.PAYMENTS_MODE || 'test';
  if (!['test', 'live'].includes(mode)) throw new Error('PAYMENTS_MODE must be test or live');
  if (env.STRIPE_SECRET_KEY && !(mode === 'live' ? /^sk_live_/ : /^sk_test_/).test(env.STRIPE_SECRET_KEY)) {
    throw new Error('Stripe key does not match PAYMENTS_MODE');
  }
  if (env.DIAGNOSTICS_TOKEN && env.DIAGNOSTICS_TOKEN.length < 24) throw new Error('DIAGNOSTICS_TOKEN must be at least 24 characters');
  return {
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8787), mode, publicBaseUrl,
    databasePath: path.resolve(env.DATABASE_PATH || './data/velario.sqlite'),
    diagnosticsToken: env.DIAGNOSTICS_TOKEN || '',
    stripe: { key: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, priceId: env.STRIPE_PRICE_ID },
    paypal: { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID, planId: env.PAYPAL_PLAN_ID },
    google: { file: env.GOOGLE_SERVICE_ACCOUNT_FILE, packageName: env.GOOGLE_PACKAGE_NAME || 'com.velario.app',
      basePlanId: env.GOOGLE_BASE_PLAN_ID || 'weekly' }
  };
}
