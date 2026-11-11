// Verificación real (sin cobros) del servidor de pagos de Velario.
const BASE = process.env.VELARIO_API_URL || 'https://velario-payments.onrender.com';
const out = [];
const log = (name, ok, detail) => out.push({ name, ok, detail });

async function req(path, options = {}) {
  const res = await fetch(BASE + path, { ...options, signal: AbortSignal.timeout(30000) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ok: res.ok, body };
}

const health = await req('/health');
log('GET /health', health.ok, `HTTP ${health.status} ${JSON.stringify(health.body)}`);

const config = await req('/api/config');
log('GET /api/config', config.ok, `HTTP ${config.status} ${JSON.stringify(config.body)}`);

const session = await req('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const token = session.body?.token;
log('POST /api/session', session.status === 201 && typeof token === 'string' && (token.startsWith('v1.') || token.length === 43),
  `HTTP ${session.status} accountId=${session.body?.accountId} tokenLen=${token?.length}`);
if (!token) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }

const auth = { Authorization: `Bearer ${token}` };
const ent = await req('/api/entitlement', { headers: auth });
log('GET /api/entitlement (cuenta nueva no es Pro)', ent.ok && ent.body?.active === false,
  `HTTP ${ent.status} ${JSON.stringify(ent.body)}`);

const bad = await req('/api/entitlement', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
log('token falso rechazado', bad.status === 401, `HTTP ${bad.status}`);

const origin = await req('/api/entitlement', { headers: { ...auth, Origin: 'https://evil.example' } });
log('origen de navegador rechazado', origin.status === 403, `HTTP ${origin.status}`);

for (const method of ['paypal', 'play', 'applepay', 'card']) {
  if (method === 'play') continue;
  const r = await req('/api/checkout', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ method })
  });
  const url = r.body?.url;
  let host = null, scheme = null;
  if (typeof url === 'string') { try { const u = new URL(url); host = u.hostname; scheme = u.protocol; } catch { } }
  log(`POST /api/checkout {method:${method}}`, true,
    `HTTP ${r.status} host=${host} scheme=${scheme} msg=${r.body?.message || r.body?.error || ''} url=${url ? url.slice(0, 90) : '(sin URL)'}`);
  if (method === 'card' && r.ok) {
    const again = await req('/api/checkout', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ method })
    });
    log('segundo clic reutiliza el checkout pendiente', again.body?.url === url, `HTTP ${again.status} sameUrl=${again.body?.url === url}`);
  }
}

const paypal = await req('/api/manage', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
log('POST /api/manage sin suscripción', paypal.status === 404, `HTTP ${paypal.status} ${JSON.stringify(paypal.body)}`);

console.log(JSON.stringify(out, null, 2));
const failed = out.filter(item => !item.ok);
console.log(failed.length ? `FALLOS: ${failed.map(f => f.name).join(', ')}` : 'TODAS LAS COMPROBACIONES OK');
