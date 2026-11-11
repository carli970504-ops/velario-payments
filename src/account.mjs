import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// El token de instalacion no se guarda en ningun sitio: es la cuenta firmada.
// Asi un reinicio de Render (que borra el disco) no invalida a los clientes que ya pagaron.
const PREFIX = 'v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readAccountSecret(env = process.env) {
  if (env.ACCOUNT_SECRET) {
    if (env.ACCOUNT_SECRET.length < 32) throw new Error('ACCOUNT_SECRET must be at least 32 characters');
    return { secret: env.ACCOUNT_SECRET, source: 'env' };
  }
  // Sin secreto propio se deriva uno del servidor que ya existe: el despliegue funciona
  // sin configurar nada nuevo y las sesiones siguen validas tras un reinicio.
  if (env.STRIPE_SECRET_KEY) {
    const secret = createHmac('sha256', env.STRIPE_SECRET_KEY).update('velario/account-token/v1').digest('hex');
    return { secret, source: 'stripe' };
  }
  return { secret: randomBytes(32).toString('hex'), source: 'random' };
}

export function createAccounts(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('An account secret is required');
  const signature = accountId => createHmac('sha256', secret).update('velario/account/' + accountId).digest('base64url');

  return {
    issue() {
      const accountId = randomUUID();
      const encoded = Buffer.from(accountId, 'utf8').toString('base64url');
      return { accountId, token: PREFIX + '.' + encoded + '.' + signature(accountId) };
    },
    verify(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 300) return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
      let accountId;
      try { accountId = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch { return null; }
      if (!UUID.test(accountId)) return null;
      const expected = Buffer.from(signature(accountId), 'utf8'), given = Buffer.from(parts[2], 'utf8');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      return accountId;
    }
  };
}
