/* ===== Mesa: trading simulado con precios reales de Yahoo Finance ===== */
const DESK_KEY = 'velario.desk.v1';
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
  vol: {}, err: null, msg: null, segLoaded: '', lastLoad: 0,
  opt: { under: 'SPY', exp: null, chain: null, busy: false }
};
let DT = deskLoad();

function deskLoad() {
  try {
    const r = JSON.parse(localStorage.getItem(DESK_KEY) || 'null');
    if (r && r.pos && typeof r.pos === 'object' && !Array.isArray(r.pos)) {
      const pos = {};
      for (const [id, p] of Object.entries(r.pos)) {
        if (!p || typeof p !== 'object' || !p.sym || !(Number(p.qty) > 0)) continue;
        pos[String(id)] = {
          id: String(id), sym: String(p.sym).toUpperCase(), name: String(p.name || p.sym),
          kind: p.kind === 'opt' ? 'opt' : 'spot', qty: Number(p.qty), avg: Number(p.avg) || 0,
          type: p.type === 'put' ? 'put' : 'call', strike: Number(p.strike) || 0, exp: String(p.exp || '')
        };
      }
      const cash = Number(r.cash);
      return { pos, cash: Number.isFinite(cash) && cash >= 0 ? cash : 10000, trades: Math.max(0, Number(r.trades) || 0), realized: Number(r.realized) || 0 };
    }
  } catch (e) { }
  return { pos: {}, cash: 10000, trades: 0, realized: 0 };
}
function deskPersist() {
  try { localStorage.setItem(DESK_KEY, JSON.stringify(DT)); } catch (e) { }
  save();
}
const deskBridge = () => window.velarioMarket || null;
const deskUsd = v => Number.isFinite(v) ? (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const deskPctTxt = v => Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '—';
const deskIso = d => d.toISOString().slice(0, 10);
function deskCash(delta) {
  DT.cash = Math.max(0, Math.round((DT.cash + delta) * 100) / 100);
}
const deskNum = n => Math.abs(n) >= 1 ? (Math.round(n * 100) / 100).toString() : (+n.toFixed(6)).toString();
function deskSay(kind, text) {
  DESK.msg = { kind, text };
  render();
}

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
  const items = DESK_SEGS[DESK.seg].items.map(x => x[0]);
  deskQuotes(items).then(() => {
    if (tab !== 'mesa') return;
    if (DESK.seg === 'opciones') { deskChain(); } else { deskChart(); }
    render();
  });
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
function deskOptPrice(p) {
  const spot = DESK.q[p.sym]?.price ?? p.avg;
  const days = Math.max(0, (new Date(p.exp + 'T20:00:00Z').getTime() - Date.now()) / 864e5);
  return deskBS(p.type, spot, p.strike, days / 365, DESK.vol[p.sym] || 0.35);
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

/* ---------- cartera ---------- */
function deskPriceOf(sym) { return DESK.q[sym]?.price ?? null; }
function deskValue(p) {
  if (p.kind === 'opt') return p.qty * 100 * deskOptPrice(p);
  return p.qty * (deskPriceOf(p.sym) ?? p.avg);
}
function deskCostOf(p) { return p.kind === 'opt' ? p.qty * 100 * p.avg : p.qty * p.avg; }
function deskEquity() { return Object.values(DT.pos).reduce((s, p) => s + deskValue(p), 0) + DT.cash; }

function deskTradeSpot(side) {
  const q = DESK.q[DESK.sym];
  if (!q || !q.price) return deskSay('down', 'Todavía no hay precio para ese símbolo.');
  const n = Math.max(0.0001, Number(DESK.qty) || 1);
  const held = DT.pos[q.symbol];
  if (side === 'buy') {
    const cost = n * q.price;
    if (cost > DT.cash + 1e-9) return deskSay('down', `Te faltan ${deskUsd(cost - DT.cash)} para esa compra.`);
    deskCash(-cost);
    if (held) { held.avg = (held.avg * held.qty + cost) / (held.qty + n); held.qty += n; }
    else DT.pos[q.symbol] = { id: q.symbol, sym: q.symbol, name: `${q.symbol} · ${q.name || ''}`.trim(), kind: 'spot', qty: n, avg: q.price };
    DT.trades++; deskPersist();
    deskSay('up', `Compraste ${deskNum(n)} ${q.symbol} a ${deskUsd(q.price)}.`);
  } else {
    if (!held) return deskSay('down', `No tienes ${q.symbol} en cartera.`);
    const m = Math.min(held.qty, n);
    const ingreso = m * q.price;
    DT.realized += (q.price - held.avg) * m;
    deskCash(ingreso);
    held.qty -= m;
    if (held.qty <= 1e-9) delete DT.pos[held.sym];
    DT.trades++; deskPersist();
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
  if (cost > DT.cash + 1e-9) return deskSay('down', `Esa orden cuesta ${deskUsd(cost)} y no te alcanza.`);
  const id = `${chain.under}|${chain.exp}|${type}|${strike}`;
  deskCash(-cost);
  const held = DT.pos[id];
  if (held) { held.avg = (held.avg * held.qty + premium * n) / (held.qty + n); held.qty += n; }
  else DT.pos[id] = { id, sym: chain.under, name: `${chain.under} ${type === 'call' ? 'Call' : 'Put'} ${strike}`, kind: 'opt', qty: n, avg: premium, type, strike, exp: chain.exp };
  DT.trades++; deskPersist();
  deskSay('up', `Compraste ${n} contrato${n > 1 ? 's' : ''} ${type.toUpperCase()} ${strike} de ${chain.under} por ${deskUsd(cost)}.`);
}
function deskClose(id) {
  const p = DT.pos[id];
  if (!p) return;
  const value = deskValue(p);
  DT.realized += value - deskCostOf(p);
  deskCash(value);
  delete DT.pos[id];
  DT.trades++; deskPersist();
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
  const dec = 2;
  const key = DESK.sym + '|' + DESK.tf;
  const warn = DESK.warnKey === key ? '' : `<div class="desk-warn">${ic('alert')}<span>Datos con <b>5 min de retraso</b>. No sirve para decidir operaciones reales.</span></div>`;
  if (warn) DESK.warnKey = key;
  return `<div class="desk-chartwrap">${warn}${chart({ c: cs, after: [], dec, lines: [], showHl: false }, false, 236)}</div>`;
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
    <p class="note" style="margin:0">Precio real de Yahoo Finance (puede ir con retraso). La orden es simulada y se paga con tu saldo.</p></div>`;
}
function deskOptions() {
  const chain = DESK.opt.chain;
  const exps = deskExpiries(3);
  const head = `<div class="card stack" style="gap:12px">
    <div class="row between"><div><div class="eyebrow">Opciones simuladas</div><h2 style="margin-top:4px">${DESK.opt.under}</h2><p class="muted" style="font-size:13px;margin-top:2px">${chain ? `${deskUsd(chain.spot)} · volatilidad ${(chain.vol * 100).toFixed(0)}% · ${chain.days} días` : 'Calculando cadena…'}</p></div>
    <span class="pill mono">1 contrato = 100</span></div>
    <div class="chips">${exps.map(d => `<button data-act="deskoptexp" data-v="${deskIso(d)}" aria-pressed="${DESK.opt.exp === deskIso(d)}">${deskIso(d).slice(5)}</button>`).join('')}</div>
    ${chain ? `<div class="chain"><span class="h">Call</span><span class="h">Strike</span><span class="h">Put</span>
      ${chain.rows.map(r => `<button data-act="deskopt" data-k="call:${r.K}">${deskUsd(r.call)}</button><span class="k">${r.K % 1 ? r.K.toFixed(2) : r.K}</span><button data-act="deskopt" data-k="put:${r.K}">${deskUsd(r.put)}</button>`).join('')}</div>
      <div class="ticket"><label class="eyebrow" for="dq">Contratos</label><input id="dq" type="number" min="1" step="1" inputmode="numeric" value="${DESK.qty}"><span class="muted" style="margin-left:auto;font-size:12px">Toca un precio para comprar</span></div>` : '<div class="desk-empty">Cargando cadena de opciones…</div>'}
    <p class="note" style="margin:0">Contratos simulados: el precio sale de Black-Scholes con el precio real del subyacente y su volatilidad reciente. No son opciones reales de mercado.</p></div>`;
  return head;
}
function deskPositions() {
  const list = Object.values(DT.pos);
  if (!list.length) return `<div class="card"><div class="row between"><span class="eyebrow">Tu cartera</span><b class="mono">${deskUsd(deskEquity())}</b></div><p class="muted" style="margin-top:8px">Sin posiciones todavía.</p></div>`;
  return `<div class="card">
    <div class="row between" style="margin-bottom:6px"><span class="eyebrow">Tu cartera · ${list.length}</span><b class="mono">${deskUsd(deskEquity())}</b></div>
    ${list.map(p => {
      const value = deskValue(p), cost = deskCostOf(p), diff = value - cost;
      return `      <div class="pos"><div class="pn"><b>${esc(p.name)}</b><small>${deskNum(p.qty)} ${p.kind === 'opt' ? 'contrato' + (p.qty > 1 ? 's' : '') : 'unidad' + (p.qty > 1 ? 'es' : '')} · ${p.kind === 'opt' ? 'vence ' + p.exp : 'media ' + deskUsd(p.avg)}</small></div>
        <div class="pv"><b>${deskUsd(value)}</b><small style="color:var(--${diff >= 0 ? 'up' : 'down'})">${diff >= 0 ? '+' : ''}${deskUsd(diff)}</small></div>
        <button class="link" data-act="deskclose" data-id="${esc(p.id)}" style="padding:6px 0 6px 8px">Cerrar</button></div>`;
    }).join('')}</div>`;
}
function viewMesa() {
  if (!deskBridge()) {
    return `<div class="stack"><h1>Astra Desk</h1><div class="card"><h3>Disponible en la app de escritorio</h3><p class="muted">La Mesa pide los precios a Yahoo Finance desde la app instalada. Abre Velario Pro para operar.</p></div></div>`;
  }
  const seg = `<div class="seg desk4">${Object.entries(DESK_SEGS).map(([k, v]) => `<button data-act="deskseg" data-v="${k}" aria-pressed="${DESK.seg === k}">${v.label}</button>`).join('')}</div>`;
  const msg = DESK.msg ? `<div class="card msg"><p style="margin:0;font-size:14px;color:var(--${DESK.msg.kind === 'up' ? 'up' : 'down'})">${esc(DESK.msg.text)}</p></div>` : '';
  const err = DESK.err ? `<div class="card"><p class="muted" style="margin:0 0 10px">${esc(DESK.err)}</p><button class="btn ghost" data-act="deskrefresh">Reintentar</button></div>` : '';
  const list = `<div class="card desk-list">${DESK_SEGS[DESK.seg].items.map(([s, l]) => deskRow(s, l, s === DESK.sym)).join('')}</div>`;
  return `<div class="stack">
    <div class="top" style="margin-bottom:0"><div><h1>Mesa</h1><p class="muted sub">Precios reales · operaciones simuladas</p></div>
      <div class="stats-mini"><span class="row" style="gap:6px"><span class="mono cash-mini">${deskUsd(DT.cash)}</span></span><span class="pill mono">${deskUsd(deskEquity())}</span></div></div>
    ${seg}${msg}${err}${list}${DESK.seg === 'opciones' ? deskOptions() : deskDetail()}${deskPositions()}
    <p class="note">Datos de Yahoo Finance. Todo se ejecuta en simulado: nada de esto es dinero real ni asesoría financiera.</p></div>`;
}

/* Refresco automático mientras la mesa está abierta */
setInterval(() => {
  if (tab !== 'mesa' || document.hidden || !deskBridge()) return;
  const items = DESK_SEGS[DESK.seg].items.map(x => x[0]);
  deskQuotes(items).then(ok => { if (ok && tab === 'mesa') render(); });
}, 30000);
