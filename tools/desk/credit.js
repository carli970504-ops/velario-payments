/* ---------- compra de saldo (pago único) ---------- */
const DESK_PEND = 'velario.desk.pending';
function deskPending() {
  try {
    const p = JSON.parse(localStorage.getItem(DESK_PEND) || 'null');
    return p && typeof p.session === 'string' && DESK_MODES.includes(p.mode) ? p : null;
  } catch (e) { return null; }
}
function deskErrText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}
async function deskTopup(mode) {
  if (!DESK_MODES.includes(mode)) return;
  const native = window.velarioNative;
  if (!native?.topup) return deskSay('down', 'Comprar saldo solo funciona en la app de escritorio.');
  try {
    const result = await native.topup(mode);
    localStorage.setItem(DESK_PEND, JSON.stringify({ session: result.reference, mode: result.mode || mode, at: Date.now() }));
    deskSay('up', `Pago abierto en el navegador. Al terminar vuelve y pulsa "Ya pagué" para cargar ${deskUsd(result.credits || DESK_START)} en ${DESK_SEGS[mode].label}.`);
  } catch (error) {
    deskSay('down', deskErrText(error) || 'No se pudo abrir el pago.');
  }
}
async function deskClaim(silent) {
  const pending = deskPending();
  if (!pending) return false;
  const native = window.velarioNative;
  if (!native?.claimTopup) return false;
  try {
    const res = await native.claimTopup(pending.session);
    if (res?.paid && res.credits > 0) {
      DT.cash[pending.mode] = Math.round((DT.cash[pending.mode] + res.credits) * 100) / 100;
      DT.stats[pending.mode].bought = Math.round(((DT.stats[pending.mode].bought || 0) + res.credits) * 100) / 100;
      deskSample(pending.mode, true);
      deskPersist();
      localStorage.removeItem(DESK_PEND);
      deskSay('up', `Compra confirmada: ${deskUsd(res.credits)} cargados en ${DESK_SEGS[pending.mode].label}.`);
      return true;
    }
    if (res?.paid && res.alreadyCredited) {
      localStorage.removeItem(DESK_PEND);
      deskSay('down', 'Ese pago ya se había cargado antes.');
      return false;
    }
    if (!silent) deskSay('down', 'El pago todavía no aparece. Si acabas de pagar, espera unos segundos y vuelve a verificar.');
    return false;
  } catch (error) {
    if (!silent) deskSay('down', deskErrText(error) || 'No se pudo verificar el pago.');
    return false;
  }
}
function deskStoreCard() {
  const pending = deskPending();
  return `<div class="card stack" style="gap:10px">
    <div class="row between"><span class="eyebrow">Comprar saldo</span><span class="pill mono">$1 = ${deskUsd(DESK_START)}</span></div>
    <p class="muted" style="font-size:13px;margin:0">Cada compra carga ${deskUsd(DESK_START)} en el modo que elijas. Ese saldo solo se puede usar ahí.</p>
    ${DESK_MODES.map(m => `<div class="pos"><div class="pn"><b>${DESK_SEGS[m].label}</b><small>Tienes ${deskUsd(DT.cash[m])}</small></div><button class="btn ghost" data-act="dg-buy-credit" data-id="${m}" style="padding:10px 14px;font-size:13px">+${deskUsd(DESK_START)} · $1</button></div>`).join('')}
    ${pending ? `<button class="btn block" data-act="dg-claim">Ya pagué · verificar</button><p class="note" style="margin:0">Pago pendiente para ${DESK_SEGS[pending.mode].label}.</p>` : ''}
    <p class="note" style="margin:0">Pago único con Stripe. El saldo se acredita cuando el servidor confirma el cobro.</p>
  </div>`;
}
