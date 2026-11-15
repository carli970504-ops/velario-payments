const PRODUCT = 'velario.pro.weekly';
const CHECKOUT_HOSTS = new Set(['checkout.stripe.com', 'www.paypal.com', 'www.sandbox.paypal.com', 'billing.stripe.com']);

function apiBase(raw) {
  if (!raw) return null;
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('El servicio de pagos necesita una dirección HTTPS válida.');
  }
  return url.href.replace(/\/$/, '');
}

function entitlement(value, now = Date.now()) {
  const expires = Date.parse(value?.expiresAt);
  const active = value?.active === true && value.productId === PRODUCT && Number.isFinite(expires) && expires > now;
  return {
    active, productId: PRODUCT, expiresAt: active ? new Date(expires).toISOString() : null,
    status: active ? 'active' : 'inactive', configured: true,
    methods: Object.entries(value?.methods || {})
      .filter(([id, enabled]) => enabled === true && /^[a-z][a-z_]{1,23}$/.test(id))
      .map(([id]) => id),
    message: active ? 'Velario Pro activo.' : 'Versión gratuita: nivel 1.'
  };
}

function checkoutUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !CHECKOUT_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('El proveedor devolvió una dirección de pago no válida.');
  }
  return url.href;
}

function createBilling({ baseUrl, readAccount, writeAccount, fetchImpl = fetch, openExternal }) {
  const base = apiBase(baseUrl);
  let sessionInFlight;
  async function call(route, options = {}) {
    const response = await fetchImpl(base + route, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'El servicio de pagos no responde.');
    return data;
  }
  async function account() {
    const existing = await readAccount();
    if (existing?.token) {
      if (existing.apiBaseUrl !== base) throw new Error('La dirección de tu cuenta de compras ha cambiado.');
      return existing;
    }
    if (!sessionInFlight) sessionInFlight = call('/api/session', { method: 'POST', body: '{}' })
      .then(async value => {
        if (typeof value.token !== 'string' || !value.token || typeof value.accountId !== 'string') throw new Error('Cuenta de compra no válida.');
        const saved = { ...value, apiBaseUrl: base };
        await writeAccount(saved);
        return saved;
      }).finally(() => { sessionInFlight = null; });
    return sessionInFlight;
  }
  async function getStatus() {
    if (!base) return { active: false, configured: false, status: 'unconfigured', methods: [], message: 'Las compras todavía no están habilitadas en esta edición.' };
    try {
      const user = await account();
      return entitlement(await call('/api/entitlement', { headers: { Authorization: `Bearer ${user.token}` } }));
    } catch {
      return { active: false, configured: true, status: 'unavailable', methods: [], message: 'No se pudo verificar Pro. Conéctate y pulsa Restaurar compras.' };
    }
  }
  async function purchase(method) {
    if (!base) throw new Error('Las compras todavía no están habilitadas en esta edición.');
    const status = await getStatus();
    if (!status.methods.includes(method)) throw new Error('Este método no está disponible actualmente.');
    const user = await account();
    const result = await call('/api/checkout', { method: 'POST', body: JSON.stringify({ method }), headers: { Authorization: `Bearer ${user.token}` } });
    await openExternal(checkoutUrl(result.url));
    return { ...status, message: 'Completa el pago seguro y pulsa Restaurar compras al volver.' };
  }
  async function manage() {
    if (!base) throw new Error('Las compras todavía no están habilitadas en esta edición.');
    const user = await account();
    const result = await call('/api/manage', { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${user.token}` } });
    await openExternal(checkoutUrl(result.url));
  }
  // Saldo simulado: pago único de 1 USD que carga 1.000 en un modo concreto.
  async function creditCheckout(mode) {
    if (!base) throw new Error('Las compras todavía no están habilitadas en esta edición.');
    if (!/^(cripto|acciones|etf|opciones)$/.test(String(mode))) throw new Error('Modo no válido.');
    const user = await account();
    const result = await call('/api/credits/checkout', { method: 'POST', body: JSON.stringify({ mode }), headers: { Authorization: `Bearer ${user.token}` } });
    await openExternal(checkoutUrl(result.url));
    return { reference: result.reference, mode: result.mode, credits: result.credits, amount: result.amount };
  }
  async function creditClaim(session) {
    if (!base) throw new Error('Las compras todavía no están habilitadas en esta edición.');
    if (typeof session !== 'string' || !session || session.length > 200) throw new Error('Compra no válida.');
    const user = await account();
    return call('/api/credits/claim', { method: 'POST', body: JSON.stringify({ session }), headers: { Authorization: `Bearer ${user.token}` } });
  }
  // Recompensa del reto: el día y el alta los decide el servidor.
  async function claimReward(mode, amount) {
    if (!base) throw new Error('El servidor de recompensas no está disponible.');
    if (!/^(cripto|acciones|etf|opciones)$/.test(String(mode))) throw new Error('Modo no válido.');
    const value = Math.floor(Number(amount));
    if (!Number.isFinite(value) || value < 0 || value > 15) throw new Error('Recompensa fuera de rango.');
    const user = await account();
    return call('/api/rewards/daily', { method: 'POST', body: JSON.stringify({ mode, amount: value }), headers: { Authorization: `Bearer ${user.token}` } });
  }
  return { getStatus, purchase, restore: getStatus, manage, creditCheckout, creditClaim, claimReward };
}

module.exports = { PRODUCT, apiBase, entitlement, checkoutUrl, createBilling };
