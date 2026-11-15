const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = path.join(process.env.APPDATA, 'velario');
const BIN = path.join(DIR, 'purchase-account.bin');
const BAK = BIN + '.backup';
const LS = path.join(DIR, 'Local State');
const TMP = path.join(os.tmpdir(), 'velario-buy');
const HARNESS = path.join(TMP, 'account.json');
const ps = s => execFileSync('powershell', ['-NoProfile', '-Command', s], { encoding: 'utf8' }).trim();

// 1. clave de Chromium: os_crypt.encrypted_key (base64, prefijo "DPAPI")
const state = JSON.parse(fs.readFileSync(LS, 'utf8'));
const raw = Buffer.from(state.os_crypt.encrypted_key, 'base64');
const prefijo = raw.slice(0, 5).toString('latin1');
console.log('Local State | encrypted_key:', raw.length, 'bytes, prefijo:', JSON.stringify(prefijo));
const blob = raw.slice(5);
fs.writeFileSync(path.join(TMP, 'key-blob.bin'), blob);
ps(`Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes('${path.join(TMP, 'key-blob.bin')}'); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [IO.File]::WriteAllBytes('${path.join(TMP, 'key.bin')}',$d); 'ok'`);
const key = fs.readFileSync(path.join(TMP, 'key.bin'));
console.log('clave AES obtenida:', key.length, 'bytes');

function decrypt(data) {
  if (data.slice(0, 3).toString('latin1') !== 'v10') throw new Error('sin prefijo v10');
  const nonce = data.slice(3, 15);
  const tag = data.slice(data.length - 16);
  const ct = data.slice(15, data.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function encrypt(text) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct, c.getAuthTag()]);
}

// 2. prueba: descifrar el archivo ORIGINAL (asi se demuestra que el esquema es el correcto)
const original = fs.readFileSync(BAK);
let originalJson = null;
try {
  originalJson = JSON.parse(decrypt(original));
  console.log('ORIGINAL descifrado correctamente | claves:', Object.keys(originalJson).join(', '));
  console.log('  apiBaseUrl:', originalJson.apiBaseUrl, '| accountId:', originalJson.accountId);
} catch (e) { console.log('no se pudo descifrar el original:', e.message); }

// 3. escribir la cuenta pagada
const objetivo = JSON.parse(fs.readFileSync(HARNESS, 'utf8'));
const packed = encrypt(JSON.stringify(objetivo));
fs.writeFileSync(BIN, packed);
const leido = JSON.parse(decrypt(fs.readFileSync(BIN)));
const ok = leido.accountId === objetivo.accountId && leido.token === objetivo.token && leido.apiBaseUrl === objetivo.apiBaseUrl;
console.log('cuenta pagada escrita:', ok ? 'SI' : 'NO', '|', fs.statSync(BIN).size, 'bytes (el original medía', original.length + ')');
console.log('  accountId:', leido.accountId, '| apiBaseUrl:', leido.apiBaseUrl);
process.exit(originalJson && ok ? 0 : 1);
