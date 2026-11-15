// Empaqueta un directorio en un archivo .asar (formato de Electron).
// Uso: node tools/pack-asar.mjs <carpeta_origen> <archivo_destino>
import fs from 'node:fs';
import path from 'node:path';

const [origen, destino] = process.argv.slice(2);
if (!origen || !destino) { console.error('Uso: node tools/pack-asar.mjs <carpeta_origen> <archivo_destino>'); process.exit(2); }

const ordenados = [];
function recorrer(dirAbs, dirRel) {
  const nodo = { files: {} };
  const entradas = fs.readdirSync(dirAbs, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entrada of entradas) {
    const rel = dirRel ? `${dirRel}/${entrada.name}` : entrada.name;
    if (entrada.isDirectory()) nodo.files[entrada.name] = recorrer(path.join(dirAbs, entrada.name), rel);
    else if (entrada.isFile()) {
      const buf = fs.readFileSync(path.join(dirAbs, entrada.name));
      ordenados.push({ rel, buf });
      nodo.files[entrada.name] = { size: buf.length };
    }
  }
  return nodo;
}

const arbol = recorrer(origen, '');
let offset = 0;
const indices = new Map();
for (const f of ordenados) { indices.set(f.rel, offset); offset += f.buf.length; }

function asignar(nodo, prefijo) {
  for (const [nombre, hijo] of Object.entries(nodo.files)) {
    const rel = prefijo ? `${prefijo}/${nombre}` : nombre;
    if (hijo.files) asignar(hijo, rel);
    else hijo.offset = String(indices.get(rel));
  }
}
asignar(arbol, '');

const headerJson = Buffer.from(JSON.stringify(arbol), 'utf8');
const relleno = (4 - (headerJson.length % 4)) % 4;
const A = headerJson.length + relleno;
const B = 4 + A;
const C = 4 + B;

const cabecera = Buffer.alloc(16);
cabecera.writeUInt32LE(4, 0);
cabecera.writeUInt32LE(C, 4);
cabecera.writeUInt32LE(B, 8);
cabecera.writeUInt32LE(headerJson.length, 12);

const cuerpo = Buffer.alloc(A);
headerJson.copy(cuerpo, 0);

fs.writeFileSync(destino, Buffer.concat([cabecera, cuerpo, ...ordenados.map(f => f.buf)]));
console.log(`empaquetado: ${destino} (${fs.statSync(destino).size} bytes, ${ordenados.length} archivos)`);
