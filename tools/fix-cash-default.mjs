// Arregla el saldo inicial: las partidas guardadas antes de existir el
// presupuesto no tienen 'cash' y la carga lo dejaba en 0 en vez de 100.
// Es idempotente y recalcula el hash de la CSP tras tocar el script.
//
// Uso: node tools/fix-cash-default.mjs [ruta/al/index.html]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const archivo = process.argv[2] || path.join(process.cwd(), 'work-app', 'desktop', 'index.html');
let html = fs.readFileSync(archivo, 'utf8');
const original = html;

const bucle = "      if (typeof state[key] === 'number') state[key] = Number.isFinite(r[key]) && r[key] >= 0 ? Math.floor(r[key]) : 0;";
const cash = '    state.recent = Array.isArray(r.recent)';

if (!html.includes(bucle)) throw new Error('No encontrado: bucle de carga');
if (!html.includes(cash)) throw new Error('No encontrado: carga de recientes');

if (!html.includes("if (key === 'cash') continue;")) {
  html = html.replace(bucle, () => "      if (key === 'cash') continue;\n" + bucle);
}
if (!html.includes('state.cash = Number.isFinite(r.cash)')) {
  html = html.replace(cash, () => '    state.cash = Number.isFinite(r.cash) && r.cash >= 0 ? Math.round(r.cash * 100) / 100 : 100;\n' + cash);
}

// Recalcular el hash del script inline para que la CSP siga permitiendolo.
const script = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/);
if (!script) throw new Error('No encontrado: script inline');
const hash = crypto.createHash('sha256').update(script[1], 'utf8').digest('base64');
const csp = html.match(/script-src 'sha256-([^']+)'/);
if (!csp) throw new Error('No encontrado: hash en la CSP');
html = html.replace(csp[1], () => hash);

fs.writeFileSync(archivo, html);
console.log(original === html ? 'sin cambios (ya estaba aplicado)' : 'arreglo del saldo aplicado');
console.log('  hash CSP:', hash.slice(0, 12) + '...');
