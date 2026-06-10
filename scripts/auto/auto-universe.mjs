// auto-universe.mjs — build the candidate universe from injected market data.
//
// PURE: takes a market snapshot in, returns { universe, rejected } out. No network,
// no order submission, no live keys. Filters enforce spot-only, USDC-quote, liquid,
// tight-spread, non-leveraged-token candidates. In live mode the universe is the
// INTERSECTION with the explicit live allowlist (default BTCUSDC) — autonomous live
// can never reach a symbol outside LIVE_ALLOWED_SYMBOLS.

// Leveraged / weird tokens that must never enter the universe (spot-only policy).
const LEVERAGE_TOKEN_RE = /(UP|DOWN|BULL|BEAR)$|\d+(L|S)$/;

export const DEFAULT_UNIVERSE_FILTERS = Object.freeze({
  minVolume24hUsd: 5_000_000,
  maxSpreadPct: 0.15,
  requireQuote: 'USDC',
});

function quoteAssetOf(m) {
  if (m && m.quoteAsset) return String(m.quoteAsset).toUpperCase();
  const sym = String((m && m.symbol) || '').toUpperCase();
  if (sym.endsWith('USDC')) return 'USDC';
  if (sym.endsWith('USDT')) return 'USDT';
  if (sym.endsWith('BTC')) return 'BTC';
  return '';
}
function baseAssetOf(m) {
  if (m && m.baseAsset) return String(m.baseAsset).toUpperCase();
  const sym = String((m && m.symbol) || '').toUpperCase();
  const q = quoteAssetOf(m);
  return q && sym.endsWith(q) ? sym.slice(0, -q.length) : sym;
}

// Build the candidate universe. `mode` is shadow|paper|live_spot. In live_spot the
// result is restricted to `liveAllowedSymbols` (the only symbols live can trade).
export function buildUniverse({
  markets = [],
  mode = 'shadow',
  liveAllowedSymbols = ['BTCUSDC'],
  filters = {},
} = {}) {
  const f = { ...DEFAULT_UNIVERSE_FILTERS, ...filters };
  const requireQuote = String(f.requireQuote || 'USDC').toUpperCase();
  const allow = new Set((liveAllowedSymbols || []).map((s) => String(s).toUpperCase()));
  const universe = [];
  const rejected = [];
  const reject = (symbol, reason) => rejected.push({ symbol, reason });

  for (const m of markets) {
    const symbol = String((m && m.symbol) || '').toUpperCase();
    if (!symbol) { reject('', 'missing symbol'); continue; }
    const quote = quoteAssetOf(m);
    const base = baseAssetOf(m);
    // Spot-only / non-leveraged.
    if (LEVERAGE_TOKEN_RE.test(base) || LEVERAGE_TOKEN_RE.test(symbol)) { reject(symbol, 'leveraged token'); continue; }
    if (m && (m.leveraged === true || m.isLeveraged === true)) { reject(symbol, 'leveraged token'); continue; }
    // Delisted / not trading.
    if (m && m.delisted === true) { reject(symbol, 'delisted'); continue; }
    if (m && m.status && String(m.status).toUpperCase() !== 'TRADING') { reject(symbol, 'not trading'); continue; }
    // Quote asset gate (live MUST be USDC).
    if (quote !== requireQuote) { reject(symbol, `quote ${quote || '?'} != ${requireQuote}`); continue; }
    // Liquidity / spread.
    const vol = Number(m && (m.volume24hUsd != null ? m.volume24hUsd : m.quoteVolume24h));
    if (!(Number.isFinite(vol) && vol >= f.minVolume24hUsd)) { reject(symbol, `low volume (${Number.isFinite(vol) ? vol : 'n/a'} < ${f.minVolume24hUsd})`); continue; }
    const spread = Number(m && m.spreadPct);
    if (Number.isFinite(spread) && spread > f.maxSpreadPct) { reject(symbol, `wide spread (${spread} > ${f.maxSpreadPct})`); continue; }
    // Live allowlist intersection — the hard symbol boundary for live trading.
    if (mode === 'live_spot' && !allow.has(symbol)) { reject(symbol, 'not in live allowlist'); continue; }
    universe.push({ ...m, symbol, baseAsset: base, quoteAsset: quote, volume24hUsd: vol, spreadPct: Number.isFinite(spread) ? spread : null });
  }
  return { universe, rejected };
}
