// Inyecta o actualiza la Mesa dentro de index.html y recalcula el hash de la CSP.
//
// Uso: node tools/apply-desk.mjs [ruta/al/index.html]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const archivo = process.argv[2] || path.join(here, '..', 'work-app', 'desktop', 'index.html');
const css = fs.readFileSync(path.join(here, 'desk', 'desk.css'), 'utf8');
const js = fs.readFileSync(path.join(here, 'desk', 'desk.js'), 'utf8');

let html = fs.readFileSync(archivo, 'utf8');

const JS_START = '/* ===== Mesa: trading simulado';
const JS_END = '/* ---------- eventos ---------- */';
const CSS_START = '/* ===== Mesa ===== */';

function reemplazarHash(texto) {
  const block = texto.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/);
  if (!block) throw new Error('No encontrado: script inline');
  const hash = crypto.createHash('sha256').update(block[1], 'utf8').digest('base64');
  const csp = texto.match(/script-src 'sha256-([^']+)'/);
  if (!csp) throw new Error('No encontrado: hash de la CSP');
  return { html: texto.replace(csp[1], () => hash), hash };
}

function guardar(texto) {
  const { html: final, hash } = reemplazarHash(texto);
  fs.writeFileSync(archivo, final);
  console.log('Mesa escrita en', archivo);
  console.log('  tamano:', Buffer.byteLength(final), 'bytes');
  console.log('  hash CSP:', hash.slice(0, 12) + '...');
}

if (html.includes('DESK_SEGS')) {
  // Ya estaba inyectada: se sustituyen CSS y JS por la versión actual.
  const i = html.indexOf(JS_START);
  const j = html.indexOf(JS_END);
  if (i < 0 || j < 0 || j < i) throw new Error('No se pudo delimitar el bloque JS de la mesa');
  html = html.slice(0, i) + js + '\n' + html.slice(j);

  const ci = html.indexOf(CSS_START);
  if (ci < 0) throw new Error('No se pudo delimitar el CSS de la mesa');
  const ce = html.indexOf('</style>', ci);
  if (ce < 0) throw new Error('No encontrado el cierre de estilos');
  html = html.slice(0, ci) + css + '\n' + html.slice(ce);

  guardar(html);
  process.exit(0);
}

function reemplazar(buscado, nuevo, etiqueta) {
  if (!html.includes(buscado)) throw new Error('No encontrado: ' + etiqueta);
  html = html.replace(buscado, () => nuevo);
}

// 1. Pestaña en la barra inferior
reemplazar(
  '  <button data-tab="perfil">',
  '  <button data-tab="mesa"><svg class="ic" viewBox="0 0 24 24"><path d="M4 19h16M6 15l4-5 3 3 5-7"/></svg>Astra</button>\n  <button data-tab="perfil">',
  'boton de la pestaña Astra'
);

// 2. Estilos
if (!html.includes('</style>')) throw new Error('No encontrado: cierre de estilos');
html = html.replace('</style>', () => css + '\n</style>');

// 3. Ruta: pintar la mesa y pedir datos
reemplazar(
  "  root.innerHTML = tab === 'inicio' ? viewInicio() : tab === 'aprende' ? viewAprende() : viewPerfil();",
  "  root.innerHTML = tab === 'inicio' ? viewInicio() : tab === 'aprende' ? viewAprende() : tab === 'mesa' ? viewMesa() : viewPerfil();\n  if (tab === 'mesa') deskEnsure();",
  'ruta de la mesa'
);

// 4. Hash permitido (dos sitios)
const partes = html.split("['inicio', 'aprende', 'perfil']");
if (partes.length !== 3) throw new Error('No encontrado: lista de pestañas del hash');
html = partes.join("['inicio', 'aprende', 'mesa', 'perfil']");

// 5. Eventos de clic
reemplazar(
  "  else if (a === 'close') closeOv();",
  "  else if (a === 'deskseg') deskSeg(el.dataset.v);\n" +
  "  else if (a === 'desksym') deskPick(el.dataset.id);\n" +
  "  else if (a === 'desktf') { DESK.tf = el.dataset.v; DESK.chart = null; render(); deskChart(); }\n" +
  "  else if (a === 'deskbuy') deskTradeSpot('buy');\n" +
  "  else if (a === 'desksell') deskTradeSpot('sell');\n" +
  "  else if (a === 'deskclose') deskClose(el.dataset.id);\n" +
  "  else if (a === 'deskopt') { const par = (el.dataset.k || '').split(':'); if (par.length === 2) deskBuyOption(par[0], Number(par[1])); }\n" +
  "  else if (a === 'deskoptexp') { DESK.opt.exp = el.dataset.v; render(); deskChain(); }\n" +
  "  else if (a === 'deskrefresh') { DESK.msg = null; DESK.err = null; deskEnsure(true); }\n" +
  "  else if (a === 'close') closeOv();",
  'eventos de la mesa'
);

// 6. Cantidad del ticket
reemplazar(
  "  if (e.target.id === 'nm')",
  "  if (e.target.id === 'dq') { DESK.qty = Math.max(0.0001, Number(e.target.value) || 0); const q = DESK.q[DESK.sym]; const t = document.getElementById('dTotal'); if (t) t.textContent = deskUsd(DESK.qty * (q?.price || 0)); }\n" +
  "  if (e.target.id === 'nm')",
  'campo de cantidad'
);

// 7. Lógica de la mesa antes de los eventos
reemplazar(JS_END, js + '\n' + JS_END, 'bloque de la mesa');

guardar(html);
