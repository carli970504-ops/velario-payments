// Verificación de arranque de Velario.exe: ventana única, sin pantalla blanca,
// consola limpia, recuperación automática tras 0x80000003, diagnóstico y modo seguro.
//
// Uso: node tools/qa/startup.mjs [ruta/Velario.exe]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = process.argv[2] || process.env.VELARIO_APP || 'C:/Users/carlo/Desktop/Velario-Pro-PC-v3/Velario.exe';
const PORT = Number(process.env.CDP_PORT || 9270);
const PROFILE = path.join(os.tmpdir(), 'velario-startup-profile');
const LOG = path.join(PROFILE, 'velario.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const resultados = [];
const ok = (nombre, condicion, detalle = '') => {
  resultados.push(Boolean(condicion));
  console.log((condicion ? 'PASS ' : 'FAIL ') + nombre + (detalle ? ' · ' + detalle : ''));
};

function launch(extraEnv = {}) {
  return spawn(APP, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE], { stdio: 'ignore', env: { ...process.env, ...extraEnv } });
}
const matarTodo = () => spawn('taskkill', ['/IM', 'Velario.exe', '/F'], { stdio: 'ignore' });
async function paginas() {
  try { const list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(r => r.json()); return list.filter(t => t.type === 'page'); }
  catch { return []; }
}
async function esperarPagina(condicion, timeout = 25000) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    const encontrada = (await paginas()).find(condicion);
    if (encontrada) return encontrada;
    await sleep(400);
  }
  return null;
}

async function conectar(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('no se pudo abrir la conexión')));
    setTimeout(() => reject(new Error('la conexión no abrió')), 5000);
  });
  let id = 0;
  const enviar = (method, params = {}, ms = 8000) => new Promise((resolve, reject) => {
    const my = ++id;
    const h = e => {
      const m = JSON.parse(e.data);
      if (m.id !== my) return;
      clearTimeout(timer);
      ws.removeEventListener('message', h);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    const timer = setTimeout(() => { ws.removeEventListener('message', h); reject(new Error('sin respuesta de ' + method)); }, ms);
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const ev = async (expr, ms = 6000) => (await enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms)).result?.value;
  return { ws, enviar, ev };
}

// Conexión tolerante: reintenta hasta que la ventana responde de verdad.
async function conectarSeguro(timeout = 30000) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    const page = await esperarPagina(t => /index\.html/.test(t.url), 4000);
    if (!page) { await sleep(500); continue; }
    try {
      const p = await conectar(page);
      await p.enviar('Runtime.enable', {}, 5000);
      return p;
    } catch { await sleep(700); }
  }
  return null;
}

async function esperarListo(p, timeout = 25000) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    try { if (await p.ev("window.__velarioReady === true && !document.getElementById('boot')")) return true; } catch { /* reconectando */ }
    await sleep(400);
  }
  return false;
}

try {
  matarTodo();
  await sleep(1200);
  fs.rmSync(PROFILE, { recursive: true, force: true });

  // 1. Arranque normal
  launch();
  let p = await conectarSeguro();
  ok('se abre una ventana que responde', Boolean(p));
  const listo = p ? await esperarListo(p) : false;
  ok('la interfaz avisa que está lista (sin pantalla en blanco)', listo);
  const estado = JSON.parse((p && await p.ev(`JSON.stringify({
    texto: document.body.innerText.length,
    botones: document.querySelectorAll('button').length,
    tabs: document.querySelectorAll('.tabs button').length,
    boot: !!document.getElementById('boot'),
    aviso: !!document.getElementById('velario-warning'),
    pantallaError: /error\\.html/.test(location.href)
  })`)) || '{}');
  console.log('  ', JSON.stringify(estado));
  ok('hay contenido y controles renderizados', estado.texto > 300 && estado.botones >= 8 && estado.tabs === 4, estado.botones + ' botones / ' + estado.texto + ' caracteres');
  const errores = [];
  if (p) {
    await p.enviar('Log.enable').catch(() => {});
    p.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errores.push(m.params.entry.text);
      if (m.method === 'Runtime.exceptionThrown') errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    // Recarga para capturar también los mensajes del arranque desde cero.
    p.enviar('Page.reload').catch(() => {});
    await sleep(3000);
    const recargada = await conectarSeguro(15000);
    if (recargada) { p = recargada; await esperarListo(p); }
  }
  ok('consola sin errores', errores.length === 0, errores.slice(0, 2).join(' | '));

  // 2. Segunda instancia: no duplica ni rompe la ventana
  const segunda = launch();
  const codigoSegunda = await new Promise(resolve => { segunda.on('exit', code => resolve(code)); setTimeout(() => resolve('sigue abierta'), 9000); });
  await sleep(800);
  ok('la segunda instancia no duplica la ventana', (await paginas()).length === 1, 'salida: ' + codigoSegunda);

  // 3. Primera caída del renderer: reinicio automático sin GPU
  p.enviar('Page.crash').catch(() => {});
  const revivida = await conectarSeguro(35000);
  ok('tras la primera caída la app se reinicia sola', Boolean(revivida));
  ok('la ventana recuperada vuelve a pintar la interfaz', revivida ? await esperarListo(revivida) : false);
  const logCaida = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  ok('el registro explica la recuperación', /reinicio automático en modo seguro/.test(logCaida) && /modo seguro \(sin GPU\)/.test(logCaida));
  p = revivida;

  // 4. Segunda caída: ya no se reintenta a ciegas, se muestra el diagnóstico
  if (p) p.enviar('Page.crash').catch(() => {});
  const errorPage = await esperarPagina(t => /error\.html/.test(t.url), 20000);
  ok('a la segunda caída se muestra el diagnóstico', Boolean(errorPage), errorPage?.url || 'sin pantalla de error');
  if (errorPage) {
    let texto = '';
    const q = await conectar(errorPage).catch(() => null);
    if (q) {
      const fin = Date.now() + 12000;
      while (Date.now() < fin && !/Reintentar|no pudo/i.test(texto)) {
        texto = String(await q.ev('document.body.innerText.slice(0, 160)').catch(() => ''));
        if (!/Reintentar|no pudo/i.test(texto)) await sleep(500);
      }
      q.ws.close();
    }
    ok('la pantalla de error explica qué hacer', /Reintentar|no pudo/i.test(texto), texto.replace(/\s+/g, ' '));
  }
  matarTodo();
  await sleep(2500);

  // 5. Modo seguro tras un intento fallido
  const logAntes = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'arranque-pendiente'), String(Date.now()));
  launch();
  p = await conectarSeguro();
  const listoSeguro = p ? await esperarListo(p) : false;
  ok('arranca en modo seguro si el intento anterior no terminó', listoSeguro);
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  ok('el registro deja constancia del modo seguro', /modo seguro \(sin GPU\)/.test(log.slice(logAntes.length)));
  ok('la marca de arranque pendiente se limpia al arrancar bien', !fs.existsSync(path.join(PROFILE, 'arranque-pendiente')));

  // 6. Cierre limpio
  p?.ws.close();
  matarTodo();
  await sleep(2500);
  ok('el proceso termina al cerrar', (await paginas()).length === 0);
  const final = fs.readFileSync(LOG, 'utf8').split('\n').filter(l => /\[(main|preload)\]/.test(l));
  ok('sin fallos internos del proceso principal', final.length === 0, final.slice(0, 2).join(' | '));
} catch (error) {
  ok('la verificación terminó sin excepciones', false, error.message);
} finally {
  matarTodo();
  const bien = resultados.filter(Boolean).length;
  console.log('\n' + bien + '/' + resultados.length + ' comprobaciones correctas');
  if (bien !== resultados.length) process.exitCode = 1;
}
