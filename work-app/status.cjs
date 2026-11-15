const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBilling } = require('./desktop/billing.cjs');
const cfg = require('./desktop/billing.config.json');
const FILE = path.join(os.tmpdir(), 'velario-buy', 'account.json');
const readAccount = async () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const writeAccount = async v => fs.writeFileSync(FILE, JSON.stringify(v));
let abierto = null;
const billing = createBilling({ baseUrl: cfg.apiBaseUrl, readAccount, writeAccount, openExternal: async u => { abierto = u; } });
(async () => {
  const acc = await readAccount();
  console.log('cuenta de la compra:', acc ? acc.accountId : 'ninguna');
  const st = await billing.getStatus();
  console.log('ESTADO DE LA APP:', JSON.stringify(st, null, 1));
  console.log('¿PRO?:', st.active === true ? 'SI' : 'NO');
  if (acc) {
    const r = await fetch(cfg.apiBaseUrl + '/api/entitlement', { headers: { Authorization: 'Bearer ' + acc.token } });
    const raw = await r.json();
    console.log('servidor dice:', r.status, JSON.stringify(raw));
  }
})().catch(e => console.error('ERROR:', e.message));
