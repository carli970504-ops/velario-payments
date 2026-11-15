// Inserta el arranque seguro dentro de index.html y recalcula el hash de la CSP.
// Es idempotente: se puede ejecutar después de apply-desk sin duplicar bloques.
//
// Uso: node tools/patch-boot.mjs [ruta/al/index.html]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const archivo = process.argv[2] || path.join(here, '..', 'work-app', 'desktop', 'index.html');
let html = fs.readFileSync(archivo, 'utf8');
const cambios = [];

const CSS = `/* ===== Arranque seguro ===== */
#boot{position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:var(--bg);padding:24px;text-align:center}
#boot .boot-in{max-width:400px;display:grid;gap:10px;justify-items:center}
#boot h1{font-size:26px}
#boot .spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:bspin .9s linear infinite}
@keyframes bspin{to{transform:rotate(360deg)}}
#boot[data-state="error"] .spin{display:none}
#boot .boot-detail{font:12px/1.5 var(--f-mono);color:var(--muted);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;text-align:left;width:100%;background:var(--surface2);border-radius:10px;padding:10px;margin:0}
#boot .boot-actions{display:flex;gap:8px;justify-content:center}
#boot .boot-hint{font-size:12.5px;color:var(--muted);margin:6px 0 0}
#boot .boot-hint a{color:var(--accent-fg)}
`;

const MARKUP = `<div id="boot" role="status" aria-live="polite">
  <div class="boot-in">
    <div class="spin" aria-hidden="true"></div>
    <h1 id="boot-title">Velario</h1>
    <p id="boot-msg" class="muted">Preparando la mesa…</p>
    <pre id="boot-detail" class="boot-detail" hidden></pre>
    <div id="boot-actions" class="boot-actions" hidden>
      <button class="btn" data-boot="retry">Reintentar</button>
      <button class="btn ghost" data-boot="logs">Abrir registro</button>
    </div>
    <p class="boot-hint"><a href="error.html">Diagnóstico de arranque</a></p>
  </div>
</div>
`;

const GUARD = `/* ===== Arranque seguro: si algo falla antes de pintar, se ve un aviso claro ===== */
(function bootGuard() {
  const shell = document.getElementById('boot');
  const title = document.getElementById('boot-title');
  const msg = document.getElementById('boot-msg');
  const detail = document.getElementById('boot-detail');
  const actions = document.getElementById('boot-actions');
  const native = window.velarioNative || {};
  const send = (kind, text) => { try { if (native.log) native.log(kind, text); } catch (error) { /* sin registro */ } };
  let failed = false;
  function fail(kind, error) {
    if (failed) return;
    failed = true;
    const text = (error && (error.stack || error.message)) || String(error || 'Error desconocido');
    send(kind, text);
    if (!shell) { document.body && (document.body.textContent = 'Velario no pudo iniciar. ' + text); return; }
    shell.dataset.state = 'error';
    shell.hidden = false;
    if (title) title.textContent = 'No se pudo abrir Velario';
    if (msg) msg.textContent = kind === 'csp'
      ? 'La política de seguridad (CSP) bloqueó el código de la app. Reinstala o envía el registro a soporte.'
      : 'Algo falló al preparar la pantalla. Puedes reintentar sin perder tu progreso.';
    if (detail) { detail.hidden = false; detail.textContent = text.slice(0, 800); }
    if (actions) actions.hidden = false;
  }
  window.velarioBootFail = fail;
  window.addEventListener('error', event => fail('error', event.error || event.message));
  window.addEventListener('unhandledrejection', event => fail('promesa', event.reason));
  document.addEventListener('securitypolicyviolation', event => fail('csp', (event.violatedDirective || 'directiva') + ' ' + (event.blockedURI || '')));
  if (actions) actions.addEventListener('click', async event => {
    const boton = event.target.closest('button');
    if (!boton) return;
    if (boton.dataset.boot === 'retry') location.reload();
    if (boton.dataset.boot === 'logs') { try { await native.openLogs(); } catch (error) { /* nada */ } }
  });
  setTimeout(() => { if (!window.__velarioReady) fail('tiempo', 'La interfaz no terminó de cargar en 10 segundos.'); }, 10000);
})();
`;

if (!html.includes('id="boot"')) {
  if (!html.includes('<body>')) throw new Error('No encontrado: <body>');
  html = html.replace('<body>', () => '<body>\n' + MARKUP);
  cambios.push('pantalla de carga');
}
if (!html.includes('#boot{')) {
  const i = html.indexOf('<style>');
  if (i < 0) throw new Error('No encontrado: <style>');
  html = html.slice(0, i) + '<style>\n' + CSS + html.slice(i + '<style>'.length);
  cambios.push('estilos de arranque');
}
if (!html.includes('function bootGuard')) {
  const i = html.indexOf('<script>');
  if (i < 0) throw new Error('No encontrado: <script>');
  html = html.slice(0, i + '<script>'.length) + '\n' + GUARD + html.slice(i + '<script>'.length);
  cambios.push('guarda de arranque');
}
if (!html.includes('__velarioReady = true')) {
  const ancla = 'window.addEventListener(\'velario:billing\'';
  const i = html.indexOf(ancla);
  if (i < 0) throw new Error('No encontrado: eventos de facturación');
  const ready = `window.__velarioReady = true;\ntry { const b = document.getElementById('boot'); if (b) b.remove(); if (window.velarioNative && window.velarioNative.bootOk) window.velarioNative.bootOk(); } catch (error) { /* la app ya pintó */ }\n`;
  html = html.slice(0, i) + ready + html.slice(i);
  cambios.push('aviso de interfaz lista');
}

const block = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/);
if (!block) throw new Error('No encontrado: script inline');
const hash = crypto.createHash('sha256').update(block[1], 'utf8').digest('base64');
const csp = html.match(/script-src 'sha256-([^']+)'/);
if (!csp) throw new Error('No encontrado: hash de la CSP');
html = html.replace(csp[1], () => hash);

fs.writeFileSync(archivo, html);
console.log('index.html:', cambios.length ? cambios.join(', ') : 'ya estaba al día');
console.log('  bytes:', Buffer.byteLength(html), '· CSP:', hash.slice(0, 12) + '...');
