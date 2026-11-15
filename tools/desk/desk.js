/* ===== Mesa: trading simulado con precios reales de Yahoo Finance ===== */
const DESK_KEY = 'velario.desk.v1';
const DESK_START = 1000;
const DESK_MODES = ['cripto', 'acciones', 'etf', 'opciones'];
const DESK_SEGS = {
  cripto: { label: 'Cripto', items: [['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['SOL-USD', 'Solana'], ['XRP-USD', 'XRP'], ['DOGE-USD', 'Dogecoin'], ['ADA-USD', 'Cardano']] },
  acciones: { label: 'Acciones', items: [['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['TSLA', 'Tesla'], ['AMZN', 'Amazon'], ['META', 'Meta']] },
  etf: { label: 'ETF', items: [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['IWM', 'Russell 2000'], ['DIA', 'Dow Jones 30'], ['GLD', 'Oro'], ['XLE', 'Energía']] },
  opciones: { label: 'Opciones', items: [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['AAPL', 'Apple'], ['NVDA', 'Nvidia'], ['TSLA', 'Tesla']] }
};
const DESK_TF = { '1D': ['1d', '5m'], '5D': ['5d', '15m'], '1M': ['1mo', '1d'], '6M': ['6mo', '1d'], '1A': ['1y', '1wk'] };

let DESK = {
  seg: 'cripto', sym: 'BTC-USD', tf: '1D', qty: 1,
  q: {}, chart: null, chartSym: '', chartTf: '', chartErr: null,
  vol: {}, err: null, msg: null, segLoaded: '', lastLoad: 0, warnKey: '',
  opt: { under: 'SPY', exp: null, chain: null, busy: false }
};
let DT = deskLoad();

function deskBlank() {
  const cash = {}, stats = {}, hist = {};
  for (const m of DESK_MODES) { cash[m] = DESK_START; stats[m] = { trades: 0, wins: 0, realized: 0, earned: 0 }; hist[m] = []; }
  return { v: 2, cash, stats, hist, pos: {} };
}
function deskSegOf(p) {
  if (p.kind === 'opt') return 'opciones';
  if (/-USD$/i.test(String(p.sym))) return 'cripto';
  if (DESK_SEGS.etf.items.some(x => x[0] === p.sym)) return 'etf';
  return 'acciones';
}
function deskLoad() {
  const base = deskBlank();
  let r = null;
  try { r = JSON.parse(localStorage.getItem(DESK_KEY) || 'null'); } catch (e) { r = null; }
  if (!r || typeof r !== 'object' || !r.pos || typeof r.pos !== 'object') return base;
  const pos = {};
  for (const [id, p] of Object.entries(r.pos)) {
    if (!p || typeof p !== 'object' || !p.sym || !(Number(p.qty) > 0)) continue;
    const kind = p.kind === 'opt' ? 'opt' : 'spot';
    const item = {
      id: String(id), sym: String(p.sym).toUpperCase(), name: String(p.name || p.sym), kind,
      qty: Number(p.qty), avg: Number(p.avg) || 0, type: p.type === 'put' ? 'put' : 'call',
      strike: Number(p.strike) || 0, exp: String(p.exp || '')
    };
    item.seg = DESK_MODES.includes(p.seg) ? p.seg : deskSegOf(item);
    pos[item.id] = item;
  }
  if (r.v === 2 && r.cash) {
    for (const m of DESK_MODES) {
      if (Number.isFinite(Number(r.cash[m]))) base.cash[m] = Math.max(0, Number(r.cash[m]));
      const s = r.stats?.[m];
      if (s) base.stats[m] = { trades: Math.max(0, Number(s.trades) || 0), wins: Math.max(0, Number(s.wins) || 0), realized: Number(s.realized) || 0, earned: Number(s.earned) || 0 };
      const h = r.hist?.[m];
      if (Array.isArray(h)) base.hist[m] = h.filter(x => x && Number.isFinite(Number(x.v))).map(x => ({ t: Number(x.t) || 0, v: Number(x.v) })).slice(-120);
    }
  }
  base.pos = pos;
  return base;
}
function deskPersist() {
  try { localStorage.setItem(DESK_KEY, JSON.stringify(DT)); } catch (e) { }
}
const deskBridge = () => window.velarioMarket || null;
const deskUsd = v => Number.isFinite(v) ? (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const deskPctTxt = v => Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '—';
const deskIso = d => d.toISOString().slice(0, 10);
const deskNum = n => Math.abs(n) >= 1 ? (Math.round(n * 100) / 100).toString() : (+n.toFixed(6)).toString();
const deskCashNow = () => DT.cash[DESK.seg];
function deskAddCash(seg, delta) { DT.cash[seg] = Math.max(0, Math.round((DT.cash[seg] + delta) * 100) / 100); }
function deskSay(kind, text) { DESK.msg = { kind, text }; render(); }

/* ---------- datos ---------- */
async function deskQuotes(symbols) {
  const bridge = deskBridge();
  if (!bridge) return false;
  const res = await bridge.quotes(symbols).catch(error => ({ ok: false, error: error.message }));
  if (!res || !res.ok) { DESK.err = res?.error || 'No se pudieron leer los precios.'; return false; }
  DESK.err = null;
  for (const q of res.data) DESK.q[q.symbol] = q;
  return true;
}
async function deskChart() {
  const bridge = deskBridge();
  if (!bridge) return;
  const [range, interval] = DESK_TF[DESK.tf] || DESK_TF['1D'];
  const sym = DESK.sym, tf = DESK.tf;
  DESK.chartSym = sym; DESK.chartTf = tf; DESK.chartErr = null;
  const res = await bridge.chart(sym, range, interval).catch(error => ({ ok: false, error: error.message }));
  if (DESK.sym !== sym || DESK.tf !== tf) return;
  if (res && res.ok) {
    DESK.chart = res.data;
    DESK.q[res.data.symbol] = { symbol: res.data.symbol, name: res.data.name, price: res.data.price, prev: res.data.prev, changePct: res.data.changePct };
  } else {
    DESK.chart = null;
    DESK.chartErr = res?.error || 'Sin datos para ese gráfico.';
  }
  if (tab === 'mesa') render();
}
async function deskVol(sym) {
  if (DESK.vol[sym]) return DESK.vol[sym];
  const bridge = deskBridge();
  if (!bridge) return 0.35;
  const res = await bridge.chart(sym, '3mo', '1d').catch(() => null);
  const closes = res && res.ok ? res.data.candles.map(c => c.c).filter(Number.isFinite) : [];
  if (closes.length < 10) return (DESK.vol[sym] = 0.35);
  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  return (DESK.vol[sym] = Math.min(1.6, Math.max(0.08, Number.isFinite(vol) ? vol : 0.35)));
}
function deskEnsure(force) {
  if (!deskBridge()) return;
  if (!force && DESK.segLoaded === DESK.seg && Date.now() - DESK.lastLoad < 20000) return;
  DESK.segLoaded = DESK.seg;
  DESK.lastLoad = Date.now();
  deskSample(DESK.seg, false);
  const items = DESK_SEGS[DESK.seg].items.map(x => x[0]);
  deskQuotes(items).then(() => {
    if (tab !== 'mesa') return;
    if (DESK.seg === 'opciones') deskChain(); else deskChart();
    render();
  });
}

/* ---------- progreso de la cartera ---------- */
function deskPriceOf(sym) { return DESK.q[sym]?.price ?? null; }
function deskOptPrice(p) {
  const spot = DESK.q[p.sym]?.price ?? p.avg;
  const days = Math.max(0, (new Date(p.exp + 'T20:00:00Z').getTime() - Date.now()) / 864e5);
  return deskBS(p.type, spot, p.strike, days / 365, DESK.vol[p.sym] || 0.35);
}
function deskValue(p) { return p.kind === 'opt' ? p.qty * 100 * deskOptPrice(p) : p.qty * (deskPriceOf(p.sym) ?? p.avg); }
function deskCostOf(p) { return p.kind === 'opt' ? p.qty * 100 * p.avg : p.qty * p.avg; }
function deskPositionsOf(seg) { return Object.values(DT.pos).filter(p => p.seg === seg); }
function deskEquity(seg) {
  const mode = seg || DESK.seg;
  return deskPositionsOf(mode).reduce((s, p) => s + deskValue(p), 0) + DT.cash[mode];
}
function deskSample(seg, force) {
  const list = DT.hist[seg] || (DT.hist[seg] = []);
  const value = Math.round(deskEquity(seg) * 100) / 100;
  const last = list[list.length - 1];
  if (!force && last && Date.now() - last.t < 120000) { last.v = value; last.t = Date.now(); return; }
  list.push({ t: Date.now(), v: value });
  while (list.length > 120) list.shift();
}
function deskSpark(vals) {
  const W = 300, H = 68, pad = 5;
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx - mn < 2) { mn -= 1; mx += 1; }
  const X = i => pad + i * (W - 2 * pad) / Math.max(1, vals.length - 1);
  const Y = v => pad + (mx - v) / (mx - mn) * (H - 2 * pad);
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="${pad}" x2="${W - pad}" y1="${Y(vals[0]).toFixed(1)}" y2="${Y(vals[0]).toFixed(1)}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>
    <polyline points="${pts}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function deskProgress() {
  const seg = DESK.seg;
  const hist = DT.hist[seg] || [];
  const eq = Math.round(deskEquity(seg) * 100) / 100;
  const diff = eq - DESK_START;
  const pct = diff / DESK_START * 100;
  const st = DT.stats[seg];
  const vals = [DESK_START, ...hist.map(x => x.v), eq];
  const peak = Math.max(...vals), low = Math.min(...vals);
  const broke = DT.cash[seg] < 25;
  return `<div class="card stack" style="gap:10px">
    <div class="row between"><span class="eyebrow">Progreso · ${DESK_SEGS[seg].label}</span><span class="mono" style="font-size:13px">${deskUsd(DT.cash[seg])} libres</span></div>
    <div class="row between" style="align-items:flex-end">
      <div><div class="mono" style="font-size:24px;font-weight:600">${deskUsd(eq)}</div><span class="pct ${diff >= 0 ? 'up' : 'dn'}" style="display:inline-block;margin-top:4px">${deskPctTxt(pct)}</span></div>
      <div style="text-align:right"><small class="muted">desde ${deskUsd(DESK_START)}</small><div class="mono" style="color:var(--${diff >= 0 ? 'up' : 'down'})">${diff >= 0 ? '+' : ''}${deskUsd(diff)}</div></div>
    </div>
    ${deskSpark(vals)}
    <div class="pgrid">
      <div><small class="muted">Máximo</small><b class="mono">${deskUsd(peak)}</b></div>
      <div><small class="muted">Mínimo</small><b class="mono">${deskUsd(low)}</b></div>
      <div><small class="muted">Operaciones</small><b class="mono">${st.trades}</b></div>
      <div><small class="muted">Cerradas en verde</small><b class="mono">${st.wins}</b></div>
      <div><small class="muted">Ganado operando</small><b class="mono" style="color:var(--${st.realized >= 0 ? 'up' : 'down'})">${st.realized >= 0 ? '+' : ''}${deskUsd(st.realized)}</b></div>
      <div><small class="muted">Ganado trabajando</small><b class="mono">${deskUsd(st.earned || 0)}</b></div>
    </div>
    ${broke ? '<button class="btn block" data-act="dg-play">Trabajar para recuperar saldo</button>' : '<button class="btn ghost block" data-act="dg-play">Ganar saldo con un reto</button>'}
  </div>`;
}

/* ---------- opciones (precio simulado) ---------- */
function deskN(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function deskBS(type, spot, strike, T, vol, rate = 0.04) {
  if (!(spot > 0) || !(strike > 0)) return 0;
  if (T <= 0) return Math.max(0, type === 'call' ? spot - strike : strike - spot);
  const s = Math.max(0.01, vol) * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (rate + s * s / 2) * T) / s, d2 = d1 - s;
  const disc = Math.exp(-rate * T);
  return type === 'call' ? spot * deskN(d1) - strike * disc * deskN(d2) : strike * disc * deskN(-d2) - spot * deskN(-d1);
}
function deskExpiries(n) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 7);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  for (let i = 0; i < (n || 3); i++) { out.push(new Date(d)); d.setDate(d.getDate() + 7); }
  return out;
}
async function deskChain() {
  if (!deskBridge() || DESK.opt.busy) return;
  DESK.opt.busy = true;
  try {
    const under = DESK.opt.under;
    await deskQuotes([under]);
    const q = DESK.q[under];
    if (!q) { DESK.opt.chain = null; return; }
    const vol = await deskVol(under);
    const exps = deskExpiries(3);
    const exp = DESK.opt.exp && exps.some(d => deskIso(d) === DESK.opt.exp) ? DESK.opt.exp : deskIso(exps[0]);
    DESK.opt.exp = exp;
    const days = Math.max(1, Math.round((new Date(exp + 'T20:00:00Z').getTime() - Date.now()) / 864e5));
    const T = days / 365;
    const step = q.price < 25 ? 1 : q.price < 100 ? 2.5 : q.price < 500 ? 5 : 10;
    const strikes = [...new Set([-0.1, -0.05, 0, 0.05, 0.1].map(k => Math.round(q.price * (1 + k) / step) * step))].sort((a, b) => a - b);
    const rows = strikes.map(K => ({ K, call: deskBS('call', q.price, K, T, vol), put: deskBS('put', q.price, K, T, vol) }));
    DESK.opt.chain = { under, exp, days, T, vol, spot: q.price, rows };
  } catch (e) {
    DESK.opt.chain = null;
    DESK.err = 'No se pudo calcular la cadena de opciones.';
  } finally {
    DESK.opt.busy = false;
    if (tab === 'mesa') render();
  }
}

/* ---------- órdenes ---------- */
function deskTradeSpot(side) {
  const q = DESK.q[DESK.sym];
  if (!q || !q.price) return deskSay('down', 'Todavía no hay precio para ese símbolo.');
  const seg = DESK.seg;
  const n = Math.max(0.0001, Number(DESK.qty) || 1);
  const held = DT.pos[q.symbol];
  if (side === 'buy') {
    const cost = n * q.price;
    if (cost > DT.cash[seg] + 1e-9) return deskSay('down', `Te faltan ${deskUsd(cost - DT.cash[seg])} en ${DESK_SEGS[seg].label}. Puedes ganar saldo con un reto.`);
    deskAddCash(seg, -cost);
    if (held) { held.avg = (held.avg * held.qty + cost) / (held.qty + n); held.qty += n; }
    else DT.pos[q.symbol] = { id: q.symbol, sym: q.symbol, name: `${q.symbol} · ${q.name || ''}`.trim(), kind: 'spot', qty: n, avg: q.price, seg };
    deskSample(seg, true);
    deskPersist();
    deskSay('up', `Compraste ${deskNum(n)} ${q.symbol} a ${deskUsd(q.price)}.`);
  } else {
    if (!held) return deskSay('down', `No tienes ${q.symbol} en cartera.`);
    const m = Math.min(held.qty, n);
    const ingreso = m * q.price;
    const dif = (q.price - held.avg) * m;
    DT.stats[seg].trades++; if (dif >= 0) DT.stats[seg].wins++;
    DT.stats[seg].realized = Math.round((DT.stats[seg].realized + dif) * 100) / 100;
    deskAddCash(seg, ingreso);
    held.qty -= m;
    if (held.qty <= 1e-9) delete DT.pos[held.sym];
    deskSample(seg, true);
    deskPersist();
    deskSay('up', `Vendiste ${deskNum(m)} ${q.symbol} a ${deskUsd(q.price)}.`);
  }
}
function deskBuyOption(type, strike) {
  const chain = DESK.opt.chain;
  if (!chain) return deskSay('down', 'La cadena de opciones aún no está lista.');
  const row = chain.rows.find(r => Math.abs(r.K - strike) < 1e-9);
  if (!row) return deskSay('down', 'Ese contrato ya no está disponible.');
  const n = Math.max(1, Math.floor(Number(DESK.qty) || 1));
  const premium = row[type];
  const cost = n * 100 * premium;
  if (cost > DT.cash.opciones + 1e-9) return deskSay('down', `Esa orden cuesta ${deskUsd(cost)} y en Opciones tienes ${deskUsd(DT.cash.opciones)}.`);
  const id = `${chain.under}|${chain.exp}|${type}|${strike}`;
  deskAddCash('opciones', -cost);
  const held = DT.pos[id];
  if (held) { held.avg = (held.avg * held.qty + premium * n) / (held.qty + n); held.qty += n; }
  else DT.pos[id] = { id, sym: chain.under, name: `${chain.under} ${type === 'call' ? 'Call' : 'Put'} ${strike}`, kind: 'opt', qty: n, avg: premium, type, strike, exp: chain.exp, seg: 'opciones' };
  deskSample('opciones', true);
  deskPersist();
  deskSay('up', `Compraste ${n} contrato${n > 1 ? 's' : ''} ${type.toUpperCase()} ${strike} de ${chain.under} por ${deskUsd(cost)}.`);
}
function deskClose(id) {
  const p = DT.pos[id];
  if (!p) return;
  const value = deskValue(p);
  const dif = value - deskCostOf(p);
  DT.stats[p.seg].trades++; if (dif >= 0) DT.stats[p.seg].wins++;
  DT.stats[p.seg].realized = Math.round((DT.stats[p.seg].realized + dif) * 100) / 100;
  deskAddCash(p.seg, value);
  delete DT.pos[id];
  deskSample(p.seg, true);
  deskPersist();
  deskSay('up', `Cerraste ${p.name} por ${deskUsd(value)}.`);
}

/* ---------- acciones de interfaz ---------- */
function deskSeg(seg) {
  if (!DESK_SEGS[seg]) return;
  DESK.seg = seg;
  DESK.sym = DESK_SEGS[seg].items[0][0];
  DESK.tf = '1D';
  DESK.chart = null; DESK.chartErr = null; DESK.msg = null;
  if (seg === 'opciones') { DESK.opt.under = DESK.sym; DESK.opt.exp = null; DESK.opt.chain = null; }
  render();
  deskEnsure(true);
}
function deskPick(sym) {
  DESK.msg = null;
  if (DESK.seg === 'opciones') {
    DESK.opt.under = sym; DESK.sym = sym; DESK.opt.exp = null; DESK.opt.chain = null;
    render(); deskEnsure(true); return;
  }
  DESK.sym = sym; DESK.chart = null; DESK.chartErr = null;
  render(); deskChart();
}

/* ---------- vistas ---------- */
function deskRow(sym, label, selected) {
  const q = DESK.q[sym];
  const cls = !q ? '' : q.changePct > 0 ? 'up' : q.changePct < 0 ? 'dn' : '';
  return `<button class="desk-row" data-act="desksym" data-id="${sym}" aria-pressed="${selected ? 'true' : 'false'}">
    <span class="ds"><b>${sym}</b><small>${esc(label)}</small></span>
    <span class="dp">${q ? deskUsd(q.price) : '—'}</span>
    <span class="pct ${cls}">${q ? deskPctTxt(q.changePct) : '—'}</span></button>`;
}
function deskChartBox() {
  if (DESK.chartErr) return `<div class="desk-empty">${esc(DESK.chartErr)}</div>`;
  if (!DESK.chart || DESK.chartSym !== DESK.sym || DESK.chartTf !== DESK.tf) return '<div class="desk-empty">Cargando gráfica…</div>';
  const cs = DESK.chart.candles.map(c => ({ o: c.o, c: c.c, h: c.h, l: c.l }));
  const key = DESK.sym + '|' + DESK.tf;
  const warn = DESK.warnKey === key ? '' : `<div class="desk-warn">${ic('alert')}<span>Datos con <b>5 min de retraso</b>. No sirve para decidir operaciones reales.</span></div>`;
  if (warn) DESK.warnKey = key;
  return `<div class="desk-chartwrap">${warn}${chart({ c: cs, after: [], dec: 2, lines: [], showHl: false }, false, 236)}</div>`;
}
function deskDetail() {
  const q = DESK.q[DESK.sym];
  const cls = !q ? '' : q.changePct > 0 ? 'up' : q.changePct < 0 ? 'dn' : '';
  const total = DESK.qty * (q?.price || 0);
  return `<div class="card stack" style="gap:12px">
    <div class="row between" style="align-items:flex-start">
      <div style="min-width:0"><div class="eyebrow">${DESK_SEGS[DESK.seg].label}</div><h2 style="margin-top:4px">${DESK.sym}</h2><p class="muted" style="font-size:13px;margin-top:2px">${esc(q?.name || '')}</p></div>
      <div style="text-align:right;flex:none"><div class="mono" style="font-size:22px;font-weight:600">${q ? deskUsd(q.price) : '—'}</div><span class="pct ${cls}" style="display:inline-block;margin-top:4px">${q ? deskPctTxt(q.changePct) : '—'}</span></div>
    </div>
    <div class="tfbar">${Object.keys(DESK_TF).map(t => `<button data-act="desktf" data-v="${t}" aria-pressed="${DESK.tf === t}">${t}</button>`).join('')}</div>
    <div class="desk-chart">${deskChartBox()}</div>
    <div class="ticket"><label class="eyebrow" for="dq">Cantidad</label><input id="dq" type="number" min="0.0001" step="any" inputmode="decimal" value="${DESK.qty}"><span class="mono muted" style="margin-left:auto" id="dTotal">${deskUsd(total)}</span></div>
    <div class="row" style="gap:10px"><button class="btn" data-act="deskbuy" style="flex:1">Comprar</button><button class="btn ghost" data-act="desksell" style="flex:1">Vender</button></div>
    <p class="note" style="margin:0">Precio real de Yahoo Finance. La orden es simulada y se paga con el saldo de ${DESK_SEGS[DESK.seg].label} (${deskUsd(deskCashNow())}).</p></div>`;
}
function deskOptions() {
  const chain = DESK.opt.chain;
  const exps = deskExpiries(3);
  return `<div class="card stack" style="gap:12px">
    <div class="row between"><div><div class="eyebrow">Opciones simuladas</div><h2 style="margin-top:4px">${DESK.opt.under}</h2><p class="muted" style="font-size:13px;margin-top:2px">${chain ? `${deskUsd(chain.spot)} · volatilidad ${(chain.vol * 100).toFixed(0)}% · ${chain.days} días` : 'Calculando cadena…'}</p></div>
    <span class="pill mono">1 contrato = 100</span></div>
    <div class="chips">${exps.map(d => `<button data-act="deskoptexp" data-v="${deskIso(d)}" aria-pressed="${DESK.opt.exp === deskIso(d)}">${deskIso(d).slice(5)}</button>`).join('')}</div>
    ${chain ? `<div class="chain"><span class="h">Call</span><span class="h">Strike</span><span class="h">Put</span>
      ${chain.rows.map(r => `<button data-act="deskopt" data-k="call:${r.K}">${deskUsd(r.call)}</button><span class="k">${r.K % 1 ? r.K.toFixed(2) : r.K}</span><button data-act="deskopt" data-k="put:${r.K}">${deskUsd(r.put)}</button>`).join('')}</div>
      <div class="ticket"><label class="eyebrow" for="dq">Contratos</label><input id="dq" type="number" min="1" step="1" inputmode="numeric" value="${DESK.qty}"><span class="muted" style="margin-left:auto;font-size:12px">Toca un precio para comprar</span></div>` : '<div class="desk-empty">Cargando cadena de opciones…</div>'}
    <p class="note" style="margin:0">Contratos simulados: el precio sale de Black-Scholes con el precio real del subyacente y su volatilidad reciente. No son opciones reales de mercado.</p></div>`;
}
function deskPositions() {
  const list = deskPositionsOf(DESK.seg);
  if (!list.length) return `<div class="card"><div class="row between"><span class="eyebrow">Cartera · ${DESK_SEGS[DESK.seg].label}</span><b class="mono">${deskUsd(deskCashNow())}</b></div><p class="muted" style="margin-top:8px">Sin posiciones todavía.</p></div>`;
  return `<div class="card">
    <div class="row between" style="margin-bottom:6px"><span class="eyebrow">Cartera · ${list.length}</span><b class="mono">${deskUsd(deskEquity(DESK.seg))}</b></div>
    ${list.map(p => {
      const value = deskValue(p), cost = deskCostOf(p), diff = value - cost;
      return `<div class="pos"><div class="pn"><b>${esc(p.name)}</b><small>${deskNum(p.qty)} ${p.kind === 'opt' ? 'contrato' + (p.qty > 1 ? 's' : '') : 'unidad' + (p.qty > 1 ? 'es' : '')} · ${p.kind === 'opt' ? 'vence ' + p.exp : 'media ' + deskUsd(p.avg)}</small></div>
        <div class="pv"><b>${deskUsd(value)}</b><small style="color:var(--${diff >= 0 ? 'up' : 'down'})">${diff >= 0 ? '+' : ''}${deskUsd(diff)}</small></div>
        <button class="link" data-act="deskclose" data-id="${esc(p.id)}" style="padding:6px 0 6px 8px">Cerrar</button></div>`;
    }).join('')}</div>`;
}
function viewMesa() {
  if (!deskBridge()) {
    return `<div class="stack"><h1 style="font-size:23px;line-height:1.2">Centro de Operaciones</h1><div class="card"><h3>Disponible en la app de escritorio</h3><p class="muted">La Mesa pide los precios a Yahoo Finance desde la app instalada. Abre Velario Pro para operar.</p></div></div>`;
  }
  const seg = `<div class="seg desk4">${Object.entries(DESK_SEGS).map(([k, v]) => `<button data-act="deskseg" data-v="${k}" aria-pressed="${DESK.seg === k}">${v.label}</button>`).join('')}</div>`;
  const msg = DESK.msg ? `<div class="card msg"><p style="margin:0;font-size:14px;color:var(--${DESK.msg.kind === 'up' ? 'up' : 'down'})">${esc(DESK.msg.text)}</p></div>` : '';
  const err = DESK.err ? `<div class="card"><p class="muted" style="margin:0 0 10px">${esc(DESK.err)}</p><button class="btn ghost" data-act="deskrefresh">Reintentar</button></div>` : '';
  const list = `<div class="card desk-list">${DESK_SEGS[DESK.seg].items.map(([s, l]) => deskRow(s, l, s === DESK.sym)).join('')}</div>`;
  return `<div class="stack">
    <div class="top" style="margin-bottom:0"><div><h1 style="font-size:23px;line-height:1.2">Centro de Operaciones</h1><p class="muted sub">Precios reales · operaciones simuladas</p></div>
      <div class="stats-mini"><span class="row" style="gap:6px"><span class="mono cash-mini">${deskUsd(deskCashNow())}</span></span><span class="pill mono">${deskUsd(deskEquity(DESK.seg))}</span></div></div>
    ${seg}${msg}${err}${list}${DESK.seg === 'opciones' ? deskOptions() : deskDetail()}${deskPositions()}${deskProgress()}
    <p class="note">Datos de Yahoo Finance. Todo se ejecuta en simulado: nada de esto es dinero real ni asesoría financiera.</p></div>`;
}

/* ===== Pulso del mercado: reto para ganar saldo ===== */
const DG = { on: false, timer: null, prices: [], score: 0, combo: 0, hits: 0, fails: 0, left: 0, seg: 'cripto', earn: 0, over: false };
const DG_SECONDS = 30, DG_MAX = 250, DG_POINTS = 46;

function deskGameSVG() {
  const W = 320, H = 172, pad = 8;
  const arr = DG.prices.length ? DG.prices : [100];
  let mn = Math.min(...arr), mx = Math.max(...arr);
  if (mx - mn < 1) { mn -= 0.5; mx += 0.5; }
  const Y = v => pad + (mx - v) / (mx - mn) * (H - 2 * pad);
  const X = i => pad + i * (W - 2 * pad) / Math.max(1, DG_POINTS - 1);
  const pts = arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const last = arr[arr.length - 1];
  const hi = Y(mn + (mx - mn) * 0.66), lo = Y(mn + (mx - mn) * 0.34);
  return `<svg viewBox="0 0 ${W} ${H}" class="dgchart" aria-hidden="true">
    <rect x="${pad}" y="${pad}" width="${W - 2 * pad}" height="${(hi - pad).toFixed(1)}" fill="var(--down)" opacity=".10"/>
    <rect x="${pad}" y="${lo.toFixed(1)}" width="${W - 2 * pad}" height="${(H - pad - lo).toFixed(1)}" fill="var(--up)" opacity=".12"/>
    <line x1="${pad}" x2="${W - pad}" y1="${hi.toFixed(1)}" y2="${hi.toFixed(1)}" stroke="var(--down)" stroke-dasharray="4 4" stroke-width="1" opacity=".55"/>
    <line x1="${pad}" x2="${W - pad}" y1="${lo.toFixed(1)}" y2="${lo.toFixed(1)}" stroke="var(--up)" stroke-dasharray="4 4" stroke-width="1" opacity=".55"/>
    <polyline points="${pts}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(arr.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="4" fill="var(--accent)"/>
  </svg>`;
}
function deskGameHTML() {
  return `<div class="ov"><div class="ovtop"><button class="x" data-act="dg-quit" aria-label="Salir">${ic('x')}</button><span class="eyebrow">Reto · ${DESK_SEGS[DG.seg].label}</span></div>
  <div class="stack" style="gap:12px">
    <div><h1 style="font-size:26px">Pulso del mercado</h1><p class="muted" style="margin-top:4px;font-size:14px">Compra en la zona verde y vende en la zona roja. Acierta para sumar; falla y pierdes el combo.</p></div>
    <div class="card stack" style="gap:10px">
      <div class="row between"><span class="eyebrow">Tiempo</span><span class="mono" id="dgTime">${DG_SECONDS.toFixed(1)} s</span></div>
      <div class="bar"><i id="dgBar" style="width:100%"></i></div>
      <div class="dgbox" id="dgChart">${deskGameSVG()}</div>
      <div class="pgrid">
        <div><small class="muted">Aciertos</small><b class="mono" id="dgHits">0</b></div>
        <div><small class="muted">Combo</small><b class="mono" id="dgCombo">0</b></div>
        <div><small class="muted">Ganado</small><b class="mono" id="dgScore">$0</b></div>
      </div>
    </div>
    <div class="row" style="gap:10px"><button class="btn" data-act="dg-buy" style="flex:1">Comprar</button><button class="btn ghost" data-act="dg-sell" style="flex:1">Vender</button></div>
    <p class="note" style="margin:0">Cada acierto paga 15 dólares más el combo. Al acabar cobras lo que juntes (máximo ${deskUsd(DG_MAX)} por ronda).</p>
  </div></div>`;
}
function deskPlay() {
  if (DG.on) return;
  DG.on = true; DG.over = false;
  DG.prices = []; DG.score = 0; DG.combo = 0; DG.hits = 0; DG.fails = 0; DG.earn = 0;
  DG.left = DG_SECONDS; DG.seg = DESK.seg;
  let p = 100;
  for (let i = 0; i < DG_POINTS; i++) { p += (Math.random() - 0.5) * 2.4; DG.prices.push(p); }
  OV = { mode: 'game' };
  ov().innerHTML = deskGameHTML();
  openOv();
  ov().scrollTop = 0;
  clearInterval(DG.timer);
  DG.timer = setInterval(deskGameTick, 260);
}
function deskGameTick() {
  if (!DG.on) { clearInterval(DG.timer); return; }
  if (ov().hidden || !OV || OV.mode !== 'game') { clearInterval(DG.timer); DG.on = false; return; }
  const last = DG.prices[DG.prices.length - 1];
  DG.prices.push(last + (Math.random() - 0.5) * 2.6);
  if (DG.prices.length > DG_POINTS) DG.prices.shift();
  DG.left -= 0.26;
  const chartEl = document.getElementById('dgChart');
  if (chartEl) chartEl.innerHTML = deskGameSVG();
  const timeEl = document.getElementById('dgTime');
  if (timeEl) timeEl.textContent = Math.max(0, DG.left).toFixed(1) + ' s';
  const barEl = document.getElementById('dgBar');
  if (barEl) barEl.style.width = Math.max(0, DG.left / DG_SECONDS * 100) + '%';
  if (DG.left <= 0) deskGameEnd();
}
function deskGamePress(side) {
  if (!DG.on || DG.over) return;
  const arr = DG.prices, last = arr[arr.length - 1];
  const mn = Math.min(...arr), mx = Math.max(...arr);
  const pos = (last - mn) / Math.max(1e-9, mx - mn);
  const good = side === 'buy' ? pos <= 0.34 : pos >= 0.66;
  if (good) {
    DG.hits++; DG.combo++;
    DG.score = Math.min(DG_MAX, DG.score + 15 + Math.min(6, DG.combo) * 3);
  } else {
    DG.combo = 0; DG.fails++;
    DG.score = Math.max(0, DG.score - 5);
  }
  const hits = document.getElementById('dgHits'), combo = document.getElementById('dgCombo'), score = document.getElementById('dgScore'), box = document.getElementById('dgChart');
  if (hits) hits.textContent = DG.hits;
  if (combo) combo.textContent = DG.combo;
  if (score) score.textContent = deskUsd(DG.score);
  if (box) {
    box.classList.remove('good', 'bad');
    box.classList.add(good ? 'good' : 'bad');
    setTimeout(() => box.classList.remove('good', 'bad'), 340);
  }
}
function deskGameEnd() {
  clearInterval(DG.timer);
  DG.on = false; DG.over = true;
  DG.earn = Math.min(DG_MAX, Math.round(DG.score));
  OV = { mode: 'game' };
  ov().innerHTML = `<div class="ov"><div class="ovtop"><button class="x" data-act="dg-quit" aria-label="Cerrar">${ic('x')}</button><span class="eyebrow">Reto terminado</span></div>
  <div class="stack" style="gap:12px">
    <div class="big">${deskUsd(DG.earn)}</div>
    <p class="muted">${DG.hits} aciertos y ${DG.fails} fallos en ${DG_SECONDS} segundos.</p>
    <div class="card row between"><span class="row">${ic('bolt')} Se suma a ${DESK_SEGS[DG.seg].label}</span><b class="mono">${deskUsd(DG.earn)}</b></div>
    <button class="btn block" data-act="dg-collect">Cobrar y volver</button>
    <button class="btn ghost block" data-act="dg-play">Otra ronda</button>
  </div></div>`;
  ov().scrollTop = 0;
}
function deskGameCollect() {
  const earn = Math.min(DG_MAX, Math.round(DG.earn || 0));
  const seg = DG.seg;
  if (earn > 0) {
    deskAddCash(seg, earn);
    DT.stats[seg].earned = Math.round(((DT.stats[seg].earned || 0) + earn) * 100) / 100;
    deskSample(seg, true);
    deskPersist();
  }
  DG.earn = 0;
  closeOv();
  DESK.msg = { kind: earn > 0 ? 'up' : 'down', text: earn > 0 ? `Ganaste ${deskUsd(earn)} y se sumaron a ${DESK_SEGS[seg].label}.` : 'Esta vez no sumaste nada. Prueba otra ronda.' };
  render();
}

/* Refresco automático mientras la mesa está abierta */
setInterval(() => {
  if (tab !== 'mesa' || document.hidden || !deskBridge()) return;
  const items = DESK_SEGS[DESK.seg].items.map(x => x[0]);
  deskQuotes(items).then(ok => { if (ok && tab === 'mesa') render(); });
}, 30000);

/* Eventos propios de la Mesa y del reto */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act;
  if (a === 'dg-play') { DG.earn = 0; deskPlay(); }
  else if (a === 'dg-buy') deskGamePress('buy');
  else if (a === 'dg-sell') deskGamePress('sell');
  else if (a === 'dg-collect') deskGameCollect();
  else if (a === 'dg-quit') { clearInterval(DG.timer); DG.on = false; DG.earn = 0; closeOv(); }
});
