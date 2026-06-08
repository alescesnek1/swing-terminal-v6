// Market risk-regime engine for the Bot Fleet Manager.
//
// Pure function over /api/markets rows. Classifies the overall tape into
// RISK_ON / NEUTRAL / RISK_OFF / CRASH. CRASH hard-blocks entries; RISK_OFF is
// advisory only for this phase (entries still allowed, UI warns).

// Tunable thresholds, centralized for later calibration.
export const REGIME_THRESHOLDS = {
  TOP_N: 100,
  MIN_SAMPLE: 10,
  CRASH_PCT_RED: 85,
  CRASH_MEDIAN_24H: -7,
  CRASH_BTC_24H: -8,
  CRASH_FLUSH_RATIO: 0.5, // share of top-N with 24h <= -8%
  FLUSH_24H: -8,
  RISKOFF_PCT_RED: 65,
  RISKOFF_MEDIAN_24H: -3,
  RISKOFF_BTC_1H: -2,
  RISKON_PCT_RED: 40,
  RISKON_MEDIAN_24H: 1,
};

function num(row, keys) {
  for (const k of keys) {
    const v = Number(row && row[k]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

function round(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

function median(values) {
  const s = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeMarketRegime(markets) {
  const T = REGIME_THRESHOLDS;
  const updatedAt = new Date().toISOString();
  const rows = Array.isArray(markets) ? markets : [];

  const parsed = rows
    .map((r) => ({
      symbol: String((r && r.symbol) || '').toUpperCase(),
      rank: num(r, ['market_cap_rank', 'rank']),
      c24: num(r, ['price_change_percentage_24h', '_c24', 'c24']),
      c1: num(r, ['price_change_percentage_1h_in_currency', '_c1', 'c1']),
    }))
    .filter((r) => Number.isFinite(r.c24));

  parsed.sort((a, b) => (Number.isFinite(a.rank) ? a.rank : 9999) - (Number.isFinite(b.rank) ? b.rank : 9999));
  const top = parsed.slice(0, T.TOP_N);
  const n = top.length;

  if (n < T.MIN_SAMPLE) {
    return { regime: 'NEUTRAL', entriesAllowed: true, reason: ['insufficient market data'], metrics: { count: n }, updatedAt };
  }

  const red = top.filter((r) => r.c24 < 0).length;
  const pctRed = Math.round((red / n) * 100);
  const median24 = round(median(top.map((r) => r.c24)));
  const median1 = round(median(top.map((r) => r.c1)));
  const flush = top.filter((r) => r.c24 <= T.FLUSH_24H).length;
  const flushPct = Math.round((flush / n) * 100);
  const volProxy = round(top.reduce((acc, r) => acc + Math.abs(Number.isFinite(r.c1) ? r.c1 : 0), 0) / n);

  const findSym = (sym) => parsed.find((r) => r.symbol === sym) || null;
  const btc = findSym('BTC');
  const eth = findSym('ETH');
  const btc24 = btc ? round(btc.c24) : null;
  const btc1 = btc ? round(btc.c1) : null;
  const eth24 = eth ? round(eth.c24) : null;

  const metrics = { count: n, pctRed, median24, median1, flush, flushPct, volProxy, btc24, btc1, eth24 };

  // ── CRASH (hard block) ──
  const crashByBreadth = pctRed >= T.CRASH_PCT_RED && (median24 <= T.CRASH_MEDIAN_24H || (btc24 !== null && btc24 <= T.CRASH_BTC_24H));
  const crashByFlush = flush / n >= T.CRASH_FLUSH_RATIO;
  if (crashByBreadth || crashByFlush) {
    const reason = [];
    reason.push(`${pctRed}% of top ${n} red`);
    if (median24 <= T.CRASH_MEDIAN_24H) reason.push(`median 24h ${median24}%`);
    if (btc24 !== null && btc24 <= T.CRASH_BTC_24H) reason.push(`BTC ${btc24}% 24h`);
    if (crashByFlush) reason.push(`${flushPct}% flushing (<= ${T.FLUSH_24H}% 24h)`);
    return { regime: 'CRASH', entriesAllowed: false, reason, metrics, updatedAt };
  }

  // ── RISK_OFF (advisory; entries still allowed this phase) ──
  if (pctRed >= T.RISKOFF_PCT_RED || median24 <= T.RISKOFF_MEDIAN_24H || (btc1 !== null && btc1 <= T.RISKOFF_BTC_1H)) {
    const reason = [];
    if (pctRed >= T.RISKOFF_PCT_RED) reason.push(`${pctRed}% of top ${n} red`);
    if (median24 <= T.RISKOFF_MEDIAN_24H) reason.push(`median 24h ${median24}%`);
    if (btc1 !== null && btc1 <= T.RISKOFF_BTC_1H) reason.push(`BTC ${btc1}% 1h`);
    if (!reason.length) reason.push(`${pctRed}% red, median 24h ${median24}%`);
    return { regime: 'RISK_OFF', entriesAllowed: true, advisory: true, reason, metrics, updatedAt };
  }

  // ── RISK_ON ──
  if (pctRed <= T.RISKON_PCT_RED && median24 >= T.RISKON_MEDIAN_24H && (btc24 === null || btc24 >= 0)) {
    return { regime: 'RISK_ON', entriesAllowed: true, reason: [`${pctRed}% red, median 24h ${median24}%`], metrics, updatedAt };
  }

  // ── NEUTRAL ──
  return { regime: 'NEUTRAL', entriesAllowed: true, reason: [`${pctRed}% red, median 24h ${median24}%`], metrics, updatedAt };
}
