// Prueba de punta a punta de Velario contra el servidor simulado (tools/qa/mock-gateway.mjs).
// Comprueba arranque, Pro, compra de saldo, idempotencia, PayPal apagado y caída de red.
//
// Uso: node tools/qa/e2e.mjs [ruta/Velario.exe]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = process.argv[2] || process.env.VELARIO_APP || 'C:/Users/carlo/Desktop/Velario-Pro-PC-v3/Velario.exe';
const API = process.env.VELARIO_API || 'http://127.0.0.1:8790';
const CONTROL = API.replace(/:(\d+)$/, (m, p) => ':' + (Number(p) + 1));
const PORT = Number(process.env.CDP_PORT || 9260);
const PROFILE = path.join(os.tmpdir(), 'velario-qa-profile');
const SINK = path.join(os.tmpdir(), 'velario-qa-open.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
let ws = null;
let seq = 0;
const errores = [];
const resultados = [];

function ok(nombre, condicion, detalle = '') {
  resultados.push({ nombre, ok: Boolean(condicion), detalle });
  console.log((condicion ? 'PASS ' : 'FAIL ') + nombre + (detalle ? ' · ' + detalle : ''));
}

async function attach() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
        ws.addEventListener('message', e => {
          const m = JSON.parse(e.data);
          if (m.method === 'Runtime.exceptionThrown') errores.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errores.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
        });
        return true;
      }
    } catch { /* todavía arrancando */ }
    await sleep(500);
  }
  throw new Error('No se pudo conectar con la ventana de Velario');
}

const cmd = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const h = e => {
    const m = JSON.parse(e.data);
    if (m.id !== id) return;
    ws.removeEventListener('message', h);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id, method, params }));
});

const ev = expr => new Promise((resolve, reject) => {
  const id = ++seq;
  const h = e => {
    const m = JSON.parse(e.data);
    if (m.id !== id) return;
    ws.removeEventListener('message', h);
    if (m.result?.exceptionDetails) reject(new Error(String(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text)));
    else resolve(m.result?.result?.value);
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});

async function waitFor(expr, timeout = 20000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    try { if (await ev(expr)) return true; } catch { /* aún no */ }
    await sleep(400);
  }
  return false;
}

const senderos = async () => (fs.existsSync(SINK) ? fs.readFileSync(SINK, 'utf8').trim().split('\n').filter(Boolean) : []);
const ultimoPago = async () => { const l = await senderos(); return l.length ? l.at(-1) : null; };

function launch(extraEnv = {}) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.writeFileSync(SINK, '');
  child = spawn(APP, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE], {
    detached: false, stdio: 'ignore',
    env: { ...process.env, VELARIO_API_URL: API, VELARIO_OPEN_SINK: SINK, ...extraEnv }
  });
}

async function stopApp() {
  try { ws?.close(); } catch { /* nada */ }
  ws = null;
  if (child) {
    try { child.kill(); } catch { /* nada */ }
    child = null;
  }
  await new Promise(r => setTimeout(r, 1200));
}

try {
  launch();
  await attach();
  await cmd('Runtime.enable');
  await cmd('Log.enable');
  const listo = await waitFor("window.__velarioReady === true && !document.getElementById('boot')", 25000);
  ok('arranque: la interfaz avisa que está lista', listo);
  const ui = await ev("JSON.stringify({botones: document.querySelectorAll('button').length, texto: document.body.innerText.length, tabs: document.querySelectorAll('.tabs button').length, tarjetas: document.querySelectorAll('.card').length, boot: !!document.getElementById('boot')})");
  console.log('  interfaz:', ui);
  const u = JSON.parse(ui || '{}');
  ok('arranque: hay controles y contenido visibles', u.botones >= 8 && u.texto > 400 && u.tabs === 4, u.botones + ' botones, ' + u.texto + ' caracteres, ' + u.tabs + ' pestañas');

  // ---- Pro: iniciar pago, volver, activar, restaurar ----
  const antes = await ev("JSON.stringify({ activo: isPro(), mensaje: billing.message, metodos: billing.methods })");
  console.log('  estado inicial:', antes);
  const pago = await ev("(async () => { const r = await velarioNative.purchase('card'); return JSON.stringify(r); })()");
  console.log('  compra:', pago);
  const url = await ultimoPago();
  ok('Pro: se abre el pago del proveedor', Boolean(url && url.startsWith('https://checkout.stripe.com/')), url || 'sin URL');
  const referencia = url ? url.split('/').filter(Boolean).at(-1) : null;
  const pagado = referencia ? await (await fetch(CONTROL + '/__pay', { method: 'POST', body: JSON.stringify({ reference: referencia }) })).json() : null;
  ok('Pro: el proveedor confirma el pago', pagado?.paid === true);
  const estado = await ev("(async () => { await refreshBilling(); return JSON.stringify({ activo: isPro(), mensaje: billing.message, vence: billing.expiresAt }); })()");
  console.log('  tras pagar:', estado);
  ok('Pro: al volver a Velario la cuenta queda activa', JSON.parse(estado || '{}').activo === true);
  const restaurado = await ev("(async () => { const r = await velarioNative.restore(); return JSON.stringify({ activo: r.active, mensaje: r.message }); })()");
  ok('Pro: restaurar compra mantiene el acceso', JSON.parse(restaurado || '{}').activo === true, restaurado);

  // ---- Saldo: compra única, acreditación y doble cobro ----
  const topup = await ev("(async () => { await deskTopup('etf'); return JSON.stringify({ pendiente: localStorage.getItem('velario.desk.pending'), aviso: DESK.msg && DESK.msg.text }); })()");
  console.log('  topup:', topup);
  const urlSaldo = await ultimoPago();
  const referenciaSaldo = urlSaldo ? urlSaldo.split('/').filter(Boolean).at(-1) : null;
  const pendiente = JSON.parse(topup || '{}').pendiente;
  ok('saldo: se abre el pago de $1 en el modo ETF', Boolean(referenciaSaldo && referenciaSaldo !== referencia && pendiente && JSON.parse(pendiente).mode === 'etf'), (JSON.parse(topup || '{}').aviso || '') + ' · ' + (urlSaldo || 'sin URL'));
  await fetch(CONTROL + '/__pay', { method: 'POST', body: JSON.stringify({ reference: referenciaSaldo }) });
  const antesSaldo = await ev('DT.cash.etf');
  const cobro = await ev("(async () => { const r = await deskClaim(); return JSON.stringify({ r, cash: DT.cash.etf }); })()");
  console.log('  saldo:', cobro, 'antes', antesSaldo);
  const c1 = JSON.parse(cobro || '{}');
  ok('saldo: acredita exactamente 1.000 en el modo comprado', c1.r === true && Math.round(c1.cash - antesSaldo) === 1000, 'de ' + antesSaldo + ' a ' + c1.cash);
  const repetido = await ev("(async () => { localStorage.setItem('velario.desk.pending', JSON.stringify({ session: " + JSON.stringify(referenciaSaldo) + ", mode: 'etf', at: Date.now() })); const cash = DT.cash.etf; const r = await deskClaim(); return JSON.stringify({ r, cash, igual: DT.cash.etf === cash, aviso: DESK.msg && DESK.msg.text }); })()");
  console.log('  cobre repetido:', repetido);
  const rep = JSON.parse(repetido || '{}');
  ok('saldo: el mismo pago no se acredita dos veces', rep.r === false && rep.igual === true, rep.aviso || '');

  // ---- Recompensa del reto con un modo de 3 letras (ETF) ----
  const reto = await ev("(async () => { try { const r = await velarioNative.claimReward('etf', 3); return JSON.stringify(r); } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); } })()");
  console.log('  reto:', reto);
  const retoJson = JSON.parse(reto || '{}');
  ok('reto: el modo ETF se acepta en el proceso principal', retoJson.error === undefined && typeof retoJson.credited === 'number', reto);

  // ---- Idempotencia de webhooks y de checkout ----
  const wh = JSON.stringify({ id: 'evt_qa_1', reference: referencia });
  const first = await (await fetch(API + '/webhooks/stripe', { method: 'POST', body: wh })).json();
  const second = await (await fetch(API + '/webhooks/stripe', { method: 'POST', body: wh })).json();
  ok('webhooks: el mismo evento se procesa una sola vez', first.duplicate === false && second.duplicate === true, JSON.stringify(second));

  // ---- PayPal solo si está configurado ----
  const cfg = await (await fetch(API + '/api/config')).json();
  ok('paypal: no se anuncia si no está configurado', cfg.methods.paypal === false);
  const session = await (await fetch(API + '/api/session', { method: 'POST', body: '{}' })).json();
  const intento = await fetch(API + '/api/checkout', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'paypal' }) });
  ok('paypal: el servidor rechaza cobrar sin configuración', intento.status === 503, 'HTTP ' + intento.status);

  // ---- Caída de red: la app sigue usable y lo dice ----
  await stopApp();
  child = spawn(APP, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE], {
    detached: false, stdio: 'ignore', env: { ...process.env, VELARIO_API_URL: 'http://127.0.0.1:9', VELARIO_OPEN_SINK: SINK }
  });
  await attach();
  await cmd('Runtime.enable');
  const listoSinRed = await waitFor("window.__velarioReady === true && !document.getElementById('boot')", 25000);
  const sinRed = await ev("(async () => { await refreshBilling(); return JSON.stringify({ activo: billing.active, mensaje: billing.message, botones: document.querySelectorAll('button').length, aviso: !!document.getElementById('velario-warning') }); })()");
  console.log('  sin red:', sinRed);
  const s = JSON.parse(sinRed || '{}');
  ok('red caída: la interfaz arranca igual', listoSinRed === true && s.botones >= 8);
  ok('red caída: el estado de compra es claro', s.activo === false && /No se pudo verificar Pro/i.test(s.mensaje || ''), s.mensaje || '');

  ok('sin errores de JavaScript en la ventana', errores.length === 0, errores.join(' | '));
} catch (error) {
  ok('la prueba terminó sin excepciones', false, error.message);
} finally {
  await stopApp();
  const fallos = resultados.filter(r => !r.ok);
  console.log('\n' + (resultados.length - fallos.length) + '/' + resultados.length + ' comprobaciones correctas');
  if (fallos.length) process.exitCode = 1;
}
