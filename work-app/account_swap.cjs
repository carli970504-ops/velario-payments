const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(process.env.APPDATA, 'velario', 'purchase-account.bin');
const BAK = BIN + '.backup';
const HARNESS = path.join(os.tmpdir(), 'velario-buy', 'account.json');
const TMP = path.join(os.tmpdir(), 'velario-buy');
const ps = script => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();

function decrypt(file) {
  const plain = path.join(TMP, 'dec.bin');
  ps(`Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes('${file}'); $p=$b[3..($b.Length-1)]; $d=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser'); [IO.File]::WriteAllBytes('${plain}',$d); 'ok'`);
  return fs.readFileSync(plain, 'utf8');
}
function encrypt(text, file) {
  const plain = path.join(TMP, 'enc-plain.bin');
  const blob = path.join(TMP, 'enc-blob.bin');
  fs.writeFileSync(plain, text, 'utf8');
  ps(`Add-Type -AssemblyName System.Security; $d=[IO.File]::ReadAllBytes('${plain}'); $e=[Security.Cryptography.ProtectedData]::Protect($d,$null,'CurrentUser'); [IO.File]::WriteAllBytes('${blob}',$e); 'ok'`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('v10', 'latin1'), fs.readFileSync(blob)]));
}

console.log('archivo de la app:', BIN, '|', fs.statSync(BIN).size, 'bytes');
let actual = null;
try { actual = JSON.parse(decrypt(BIN)); } catch (e) { console.log('no se pudo descifrar el archivo actual:', e.message); }
if (actual) {
  console.log('  claves:', Object.keys(actual).join(', '));
  console.log('  apiBaseUrl actual:', actual.apiBaseUrl);
  console.log('  accountId actual:', actual.accountId);
}
const objetivo = JSON.parse(fs.readFileSync(HARNESS, 'utf8'));
console.log('cuenta pagada:', objetivo.accountId, '| servidor:', objetivo.apiBaseUrl, '| token:', objetivo.token.length, 'chars');

if (!fs.existsSync(BAK)) { fs.copyFileSync(BIN, BAK); console.log('copia de seguridad:', path.basename(BAK)); }
encrypt(JSON.stringify(objetivo), BIN);

const verificado = JSON.parse(decrypt(BIN));
const ok = verificado.accountId === objetivo.accountId && verificado.token === objetivo.token && verificado.apiBaseUrl === objetivo.apiBaseUrl;
console.log('escrito y verificado:', ok ? 'SI' : 'NO', '|', fs.statSync(BIN).size, 'bytes');
console.log('  apiBaseUrl ahora:', verificado.apiBaseUrl);
console.log('  accountId ahora:', verificado.accountId);
process.exit(ok ? 0 : 1);
