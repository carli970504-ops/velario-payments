// Extrae un .asar a una carpeta.
// Uso: node tools/unpack-asar.mjs <archivo.asar> <carpeta_destino>
import fs from 'node:fs';
import path from 'node:path';

const [archivo, destino] = process.argv.slice(2);
if (!archivo || !destino) { console.error('Uso: node tools/unpack-asar.mjs <archivo.asar> <carpeta_destino>'); process.exit(2); }

const buf = fs.readFileSync(archivo);
const tamCabecera = buf.readUInt32LE(4);
const largoJson = buf.readUInt32LE(12);
const arbol = JSON.parse(buf.subarray(16, 16 + largoJson).toString('utf8'));
const base = 8 + tamCabecera;

let extraidos = 0;
function escribir(nodo, dirAbs) {
  fs.mkdirSync(dirAbs, { recursive: true });
  for (const [nombre, hijo] of Object.entries(nodo.files)) {
    const ruta = path.join(dirAbs, nombre);
    if (hijo.files) escribir(hijo, ruta);
    else {
      const inicio = base + Number(hijo.offset);
      fs.writeFileSync(ruta, buf.subarray(inicio, inicio + hijo.size));
      extraidos++;
    }
  }
}
fs.rmSync(destino, { recursive: true, force: true });
escribir(arbol, destino);
console.log(`extraidos ${extraidos} archivos en ${destino}`);
