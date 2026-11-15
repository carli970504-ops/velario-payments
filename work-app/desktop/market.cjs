// Precios reales de Yahoo Finance para la Mesa de Velario.
// Se ejecuta en el proceso principal: el renderer nunca sale a la red (la CSP lo impide).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1d', '5d', '1wk', '1mo']);
const SYMBOL = /^[A-Z0-9.^=_-]{1,24}$/;
const TTL = 30_000;
const MAX_CANDLES = 420;
const cache = new Map();

function trimCache() {
  if (cache.size <= 240) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 80);
  for (const [key] of oldest) cache.delete(key);
}

function parseChart(json, symbol, range, interval) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'Yahoo Finance no devolvió datos.');
  const quote = result.indicators?.quote?.[0] || {};
  const candles = [];
  (result.timestamp || []).forEach((t, i) => {
    const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i];
    if ([o, h, l, c].every(v => Number.isFinite(v))) candles.push({ t, o, h, l, c });
  });
  const meta = result.meta || {};
  const prev = Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose
    : candles.length > 1 ? candles[candles.length - 2].c : candles[0]?.c ?? null;
  const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : candles.at(-1)?.c ?? null;
  if (!Number.isFinite(price)) throw new Error('Ese símbolo no tiene precio ahora mismo.');
  return {
    symbol: meta.symbol || symbol,
    name: meta.shortName || meta.longName || symbol,
    currency: meta.currency || 'USD',
    price,
    prev,
    changePct: Number.isFinite(prev) && prev ? (price - prev) / prev * 100 : 0,
    time: meta.regularMarketTime || null,
    range, interval,
    candles: candles.slice(-MAX_CANDLES)
  };
}

async function chart(symbol, range, interval) {
  const sym = String(symbol || '').toUpperCase();
  if (!SYMBOL.test(sym)) throw new Error('Símbolo no válido.');
  const r = RANGES.has(range) ? range : '1d';
  const i = INTERVALS.has(interval) ? interval : '1d';
  const key = `${sym}|${r}|${i}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${r}&interval=${i}&includePrePost=false`;
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(response.status === 404 ? 'Ese símbolo no existe en Yahoo Finance.' : `Yahoo Finance respondió ${response.status}.`);
  const data = parseChart(await response.json(), sym, r, i);
  cache.set(key, { at: Date.now(), data });
  trimCache();
  return data;
}

async function quotes(symbols) {
  const list = [...new Set((Array.isArray(symbols) ? symbols : []).map(s => String(s).toUpperCase()).filter(s => SYMBOL.test(s)))].slice(0, 24);
  if (!list.length) throw new Error('No hay símbolos que consultar.');
  const settled = await Promise.allSettled(list.map(s => chart(s, '1d', '1d')));
  const data = [];
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue;
    const c = item.value;
    data.push({ symbol: c.symbol, name: c.name, currency: c.currency, price: c.price, prev: c.prev, changePct: c.changePct, time: c.time });
  }
  if (!data.length) throw new Error('Sin conexión con Yahoo Finance. Revisa tu red e inténtalo otra vez.');
  return data;
}

function registerMarket(ipcMain, trusted) {
  ipcMain.handle('market:chart', async (event, symbol, range, interval) => {
    if (!trusted(event)) return { ok: false, error: 'Origen no permitido.' };
    try { return { ok: true, data: await chart(symbol, range, interval) }; }
    catch (error) { return { ok: false, error: error.message || 'No se pudo leer el gráfico.' }; }
  });
  ipcMain.handle('market:quotes', async (event, symbols) => {
    if (!trusted(event)) return { ok: false, error: 'Origen no permitido.' };
    try { return { ok: true, data: await quotes(symbols) }; }
    catch (error) { return { ok: false, error: error.message || 'No se pudieron leer los precios.' }; }
  });
}

module.exports = { chart, quotes, registerMarket };
