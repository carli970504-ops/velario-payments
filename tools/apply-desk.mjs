// Inyecta la Mesa dentro de index.html: pestaña, estilos, lógica, ruta y eventos.
// Idempotente: si ya está, no toca el archivo. Recalcula el hash de la CSP.
//
// Uso: node tools/apply-desk.mjs [ruta/al/index.html]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const archivo = process.argv[2] || path.join(here, '..', 'work-app', 'desktop', 'index.html');
const css = fs.readFileSync(path.join(here, 'desk', 'desk.css'), 'utf8');
let js = fs.readFileSync(path.join(here, 'desk', 'desk.js'), 'utf8');

let html = fs.readFileSync(archivo, 'utf8');
if (html.includes('DESK_SEGS')) {
  console.log('la Mesa ya estaba dentro; no se toca nada');
  process.exit(0);
}

function reemplazar(buscado, nuevo, etiqueta) {
  if (!html.includes(buscado)) throw new Error('No encontrado: ' + etiqueta);
  html = html.replace(buscado, () => nuevo);
}

// 1. Pestaña en la barra inferior
reemplazar(
  '  <button data-tab="perfil">',
  '  <button data-tab="mesa"><svg class="ic" viewBox="0 0 24 24"><path d="M4 19h16M6 15l4-5 3 3 5-7"/></svg>Mesa</button>\n  <button data-tab="perfil">',
  'boton de la pestaña Mesa'
);

// 2. Estilos
if (!html.includes('</style>')) throw new Error('No encontrado: cierre de estilos');
html = html.replace('</style>', () => css + '</style>');

// 3. Ruta: pintar la mesa y pedir datos
reemplazar(
  "  root.innerHTML = tab === 'inicio' ? viewInicio() : tab === 'aprende' ? viewAprende() : viewPerfil();",
  "  root.innerHTML = tab === 'inicio' ? viewInicio() : tab === 'aprende' ? viewAprende() : tab === 'mesa' ? viewMesa() : viewPerfil();\n  if (tab === 'mesa') deskEnsure();",
  'ruta de la mesa'
);

// 4. Hash permitido (dos sitios)
const hashes = html.split("['inicio', 'aprende', 'perfil']");
if (hashes.length !== 3) throw new Error('No encontrado: lista de pestañas del hash');
html = hashes.join("['inicio', 'aprende', 'mesa', 'perfil']");

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
reemplazar(
  '/* ---------- eventos ---------- */',
  js + '\n/* ---------- eventos ---------- */',
  'bloque de la mesa'
);

// 8. Hash de la CSP
const scriptBlock = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/);
if (!scriptBlock) throw new Error('No encontrado: script inline');
const hash = crypto.createHash('sha256').update(scriptBlock[1], 'utf8').digest('base64');
const csp = html.match(/script-src 'sha256-([^']+)'/);
if (!csp) throw new Error('No encontrado: hash de la CSP');
html = html.replace(csp[1], () => hash);

fs.writeFileSync(archivo, html);
console.log('Mesa insertada en', archivo);
console.log('  tamano:', Buffer.byteLength(html), 'bytes');
console.log('  hash CSP:', hash.slice(0, 12) + '...');
