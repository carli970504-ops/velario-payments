// Genera el icono de la app sin dependencias externas.
//   node tools/make-icon.mjs            → build/icon.png (256) + build/icon.ico
//   node tools/make-icon.mjs 512        → build/icon-512.png
//   node tools/make-icon.mjs 1024       → build/icon-1024.png (App Store)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const salida = path.join(here, '..', 'work-app', 'build');
fs.mkdirSync(salida, { recursive: true });

const TAM = Number(process.argv[2] || 256);
if (![256, 512, 1024].includes(TAM)) throw new Error('Tamaño no soportado: usa 256, 512 o 1024');

const S = 4;                  // supermuestreo
const N = TAM * S;            // lienzo de dibujo
const k = N / 256;            // el dibujo está definido sobre una rejilla de 256
const px = new Uint8Array(N * N * 4);

const color = (hex, a = 255) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), a];
const fondo = color('#16233a');
const ambar = color('#f0a421');
const teal = color('#3dd0a0');
const claro = color('#f6b63f');

function poner(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= N || y >= N || a === 0) return;
  const i = (y * N + x) * 4;
  const alfa = a / 255, inv = 1 - alfa;
  px[i] = Math.round(r * alfa + px[i] * inv);
  px[i + 1] = Math.round(g * alfa + px[i + 1] * inv);
  px[i + 2] = Math.round(b * alfa + px[i + 2] * inv);
  px[i + 3] = Math.max(px[i + 3], a);
}
function rect(x0, y0, x1, y1, col) {
  for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) poner(x, y, col);
}
function redondeado(x0, y0, x1, y1, radio, col) {
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const cx = Math.min(Math.max(x, x0 + radio), x1 - radio);
      const cy = Math.min(Math.max(y, y0 + radio), y1 - radio);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radio * radio) poner(x, y, col);
    }
  }
}

redondeado(16 * k, 16 * k, 240 * k, 240 * k, 52 * k, fondo);
for (let y = 24 * k; y < 232 * k; y++) {
  const t = (y - 24 * k) / (208 * k);
  const col = [Math.round(22 + 12 * t), Math.round(35 + 14 * t), Math.round(58 + 18 * t), 255];
  for (let x = 24 * k; x < 232 * k; x++) {
    const i = (y * N + x) * 4;
    if (px[i + 3] === 255) { px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; }
  }
}

const velas = [
  { x: 74, o: 150, c: 108, col: ambar },
  { x: 118, o: 132, c: 84, col: teal },
  { x: 162, o: 112, c: 60, col: claro }
];
for (const v of velas) {
  const x0 = v.x * k, ancho = 26 * k;
  const arriba = Math.min(v.o, v.c) * k, abajo = Math.max(v.o, v.c) * k;
  const mecha = arriba - 14 * k;
  rect(x0 + ancho / 2 - 3 * k, mecha, x0 + ancho / 2 + 3 * k, arriba, v.col);
  rect(x0 + ancho / 2 - 3 * k, abajo, x0 + ancho / 2 + 3 * k, abajo + 14 * k, v.col);
  rect(x0, arriba, x0 + ancho, abajo, v.col);
}

const out = Buffer.alloc(TAM * TAM * 4);
for (let y = 0; y < TAM; y++) {
  for (let x = 0; x < TAM; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
      const i = ((y * S + dy) * N + (x * S + dx)) * 4;
      r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
    }
    const n = S * S, j = (y * TAM + x) * 4;
    out[j] = Math.round(r / n); out[j + 1] = Math.round(g / n); out[j + 2] = Math.round(b / n); out[j + 3] = Math.round(a / n);
  }
}

const tabla = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tabla[n] = c; }
const crc32 = buf => { let c = 0xffffffff; for (const byte of buf) c = tabla[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const trozo = (tipo, datos) => {
  const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
};
const crudo = Buffer.alloc((TAM * 4 + 1) * TAM);
for (let y = 0; y < TAM; y++) {
  crudo[y * (TAM * 4 + 1)] = 0;
  out.copy(crudo, y * (TAM * 4 + 1) + 1, y * TAM * 4, (y + 1) * TAM * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(TAM, 0); ihdr.writeUInt32BE(TAM, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(crudo, { level: 9 })), trozo('IEND', Buffer.alloc(0))
]);

if (TAM === 256) {
  fs.writeFileSync(path.join(salida, 'icon.png'), png);
  const cabecera = Buffer.alloc(6); cabecera.writeUInt16LE(0, 0); cabecera.writeUInt16LE(1, 2); cabecera.writeUInt16LE(1, 4);
  const entrada = Buffer.alloc(16);
  entrada[0] = 0; entrada[1] = 0; entrada[2] = 0; entrada[3] = 0;
  entrada.writeUInt16LE(1, 4); entrada.writeUInt16LE(32, 6);
  entrada.writeUInt32LE(png.length, 8); entrada.writeUInt32LE(22, 12);
  fs.writeFileSync(path.join(salida, 'icon.ico'), Buffer.concat([cabecera, entrada, png]));
  console.log('escritorio:', path.join(salida, 'icon.png'), '+', path.join(salida, 'icon.ico'));
} else {
  const destino = path.join(salida, 'icon-' + TAM + '.png');
  fs.writeFileSync(destino, png);
  console.log('tienda:', destino, png.length, 'bytes');
}
