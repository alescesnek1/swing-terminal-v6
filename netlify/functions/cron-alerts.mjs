// Swing Terminal V2 — Scheduled Background Scanner
// Runs every 5 minutes via Netlify Scheduled Functions
// Fetches TOP 500 coins, scores them, sends Telegram alerts for score >= MIN_SCORE

// ========== MIN SCORE (env-driven, independent of frontend localStorage) ==========
// V6.2 — default floor raised 6 → 8. Operators can still tune via the
// MIN_ALERT_SCORE env var; anything strictly below the floor is dropped
// at three independent gates (collection, firewall, and the summary
// re-check) so a misconfig in one layer cannot leak a low-quality alert.
const V5_TAG = '[V5]';
function getMinScore() {
  const parsed = parseInt(process.env.MIN_ALERT_SCORE, 10);
  return Number.isFinite(parsed) ? parsed : 8;
}
const MIN_SCORE = getMinScore();

// ========== IN-MEMORY THROTTLE CACHE ==========
// Per-container Map; survives across warm invocations, resets on cold start.
// Key = coin symbol (uppercased), value = last-sent timestamp (ms).
const sentCache = new Map();
const THROTTLE_MS = 15 * 60 * 1000; // 15 minutes

// ========== HELPERS ==========
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fp(n, d = 2) { return n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%'; }

// Seeded PRNG — identical to frontend
function rng(seed) {
  let s = (((seed % 2147483647) + 2147483647) % 2147483647) || 1;
  return () => { s = (16807 * s) % 2147483647; return (s - 1) / 2147483646; };
}
function coinRng(id, salt = 0) {
  return rng(id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 1) + salt + Math.floor(Date.now() / 900000));
}

// ========== DERIVED METRICS (same as frontend) ==========
function get1h(d) {
  return d.price_change_percentage_1h_in_currency ??
    (d.price_change_percentage_24h != null
      ? d.price_change_percentage_24h / 6 + (coinRng(d.id, 11)() - 0.5) * 2.5
      : 0);
}

function get4h(d) {
  return d._4h ??
    (d.price_change_percentage_24h != null
      ? d.price_change_percentage_24h / 2.8 + (coinRng(d.id, 44)() - 0.5) * 3
      : 0);
}

function getVolPct(d) {
  return d.total_volume / (d.market_cap || 1) * 100;
}

function getFunding(d) {
  const r = coinRng(d.id, 99);
  const c = d.price_change_percentage_24h || 0;
  return clamp(0.0075 - c * 0.0019 + (r() - 0.5) * 0.009, -0.06, 0.08);
}

function getOiPct(d) {
  const c = d.price_change_percentage_24h || 0;
  const oi = (d.market_cap || 5e9) * Math.max(0.01, 0.13 + c * 0.005);
  return oi / (d.market_cap || 1) * 100;
}

// ========== COIN SIGNAL — exact copy of frontend sig() ==========
function sig(d) {
  const c24 = d.price_change_percentage_24h || 0;
  const c7 = d.price_change_percentage_7d_in_currency || 0;
  const v = getVolPct(d), f = getFunding(d), h1 = get1h(d), h4 = get4h(d), op = getOiPct(d);
  let score = 0, reasons = [], pattern = null;

  if (c24 < -8) { score += 3; reasons.push('Silny dump 24h (' + fp(c24) + ')'); }
  else if (c24 < -4) { score += 2; reasons.push('Dump 24h'); }
  else if (c24 < -2) { score += 1; reasons.push('Mirny pokles'); }
  if (c24 > 10) { score -= 1; reasons.push('Silny pump — pozor na korekci'); }

  if (h1 < -3) { score += 1; reasons.push('Dump 1h'); }
  if (h4 < -5) { score += 1; reasons.push('Dump 4h'); }
  if (h1 > 2 && c24 < -3) { score += 2; reasons.push('Reclaim po dumpu — sweep signal'); pattern = 'RECLAIM'; }

  if (c7 < -20) { score += 2; reasons.push('7D extremni oversold'); }
  else if (c7 < -12) { score += 1; reasons.push('7D slabost'); }

  if (v > 10) { score += 2; reasons.push('Vysoky volume >' + v.toFixed(0) + '%'); }
  else if (v > 6) { score += 1; reasons.push('Zvyseny volume'); }

  if (f < -0.02) { score += 3; reasons.push('Neg. funding — short overload'); }
  else if (f < -0.005) { score += 2; reasons.push('Funding chladne'); }
  else if (f > 0.05) { score -= 1; reasons.push('Prehrity funding'); }

  if (op < 10 && c24 < -5) { score += 1; reasons.push('OI odfouknuty'); }
  if (op > 28) { score -= 1; reasons.push('OI prehraty — caution'); }

  if (c24 < -6 && v > 7) { score += 1; reasons.push('Kapitulace (dump + vysoky objem)'); pattern = pattern || 'FLUSH'; }

  if (!reasons.length) reasons.push('Zadny vyrazny signal');

  let label;
  if (score >= 6) { label = 'BUY'; }
  else if (c24 > 12 && v < 3) { label = 'SELL'; score = -2; }
  else { label = 'NEUT'; }
  if (pattern === 'RECLAIM') { label = 'RECLAIM'; }
  else if (pattern === 'FLUSH' && score >= 6) { label = 'FLUSH+BUY'; }

  score = Math.max(0, Math.min(10, score));
  return { label, score, reasons, pattern };
}

// ========== COINGECKO FETCH ==========
async function fetchPage(page) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=1h,24h,7d`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    throw new Error(`CoinGecko API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchTop500() {
  const page1 = await fetchPage(1);
  // 1500ms gap to avoid CoinGecko rate limit (429)
  await new Promise(r => setTimeout(r, 1500));

  // Graceful degradation: if page 2 fails, scan TOP 250 instead of crashing.
  let page2 = [];
  try {
    page2 = await fetchPage(2);
  } catch (e) {
    console.warn('[cron-alerts] CoinGecko page 2 failed, scanning TOP 250 only:', e.message);
  }
  return [].concat(page1 || [], page2 || []);
}

// ========== OUTPUT FIREWALL ==========
// Absolute, last-line validator executed immediately before the fetch.
// Reads env fresh so MIN_ALERT_SCORE changes take effect without re-deploy
// needing a code edit. Strict `<` drop — score == floor passes, score
// < floor is rejected, no fuzzy ≥ check.
function isAlertAllowed(score) {
  const minScore = getMinScore();
  if (!Number.isFinite(Number(score))) return false;
  return Number(score) >= minScore;
}

// V6.2 — prepend the V5 routing tag once. Idempotent: a payload already
// prefixed (e.g., from a retry path) isn't double-tagged. Sits AFTER
// the firewall so blocked messages never get a V5 stamp.
function withV5Tag(text) {
  if (typeof text !== 'string') return text;
  if (text.startsWith(V5_TAG)) return text;
  return `${V5_TAG} ${text}`;
}

// ========== TELEGRAM ==========
async function sendTelegram(token, chatId, text, alertScore) {
  // FIREWALL ZAKLOPKA - PREBIJE VSECHNO OSTATNI
  if (!isAlertAllowed(alertScore)) {
    console.log(`Zablokovano firewallem: score=${alertScore} < MIN_ALERT_SCORE=${getMinScore()}.`);
    return { ok: false, description: 'blocked by firewall: score=' + alertScore };
  }
  text = withV5Tag(text);

  // Safe diagnostic: confirms the env vars actually arrived without leaking them.
  console.log('DEBUG: Token length:', token ? token.length : 'UNDEFINED', 'Starts with:', token ? token.substring(0, 3) : 'NONE');
  console.log('DEBUG: Chat ID:', chatId);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`TG error pro ${alertScore}: ${res.status} - ${res.statusText} | Detail: ${errorText}`);
    return { ok: false, description: errorText, error_code: res.status };
  }
  return res.json();
}

function buildMessage(d, s) {
  const sym = (d.symbol || '').toUpperCase();
  const c24 = d.price_change_percentage_24h || 0;
  const h1 = get1h(d);
  const v = getVolPct(d);
  const price = d.current_price != null ? '$' + d.current_price.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '?';

  const emoji = s.score >= 7 ? '🔴' : '🟠';
  const labelMap = { 'BUY': 'STRONG BUY', 'FLUSH+BUY': 'FLUSH SETUP', 'RECLAIM': 'RECLAIM' };
  const labelText = labelMap[s.label] || s.label;

  let msg = `${emoji} <b>${sym} — ${labelText}</b>\n`;
  msg += `Score: <b>${s.score}/10</b> | ${price}\n`;
  msg += `24H: ${fp(c24)} | 1H: ${fp(h1, 1)} | Vol: ${v.toFixed(1)}%\n`;
  msg += `\n<i>${s.reasons.slice(0, 3).join(' · ')}</i>\n`;

  msg += `\n🔍 <b>Links:</b>\n`;
  msg += `📰 <a href="https://cryptopanic.com/news/${sym}/">Zpravy (CryptoPanic)</a>\n`;
  msg += `🐦 <a href="https://twitter.com/search?q=%24${sym}&src=typed_query&f=live">Live Feed (X.com)</a>\n`;

  msg += `\n⏱ ${new Date().toLocaleTimeString('cs-CZ', { timeZone: 'Europe/Prague' })} | 🤖 Cron Scanner`;

  return msg;
}

// ========== MAIN HANDLER ==========
export default async () => {
  // Token and chat ID are read ONLY from the environment vault.
  // Never accept these from the frontend or hardcode them.
  // .trim() guards against stray whitespace/newline pasted into the Netlify env UI
  // which would otherwise corrupt the URL and return 401 Unauthorized.
  const TG_TOKEN = process.env.TG_BOT_TOKEN ? process.env.TG_BOT_TOKEN.trim() : undefined;
  const TG_CHAT = process.env.TG_CHAT_ID ? process.env.TG_CHAT_ID.trim() : undefined;
  if (!TG_TOKEN || !TG_CHAT) {
    console.error('[cron-alerts] Chybi TG credentials (TG_BOT_TOKEN nebo TG_CHAT_ID).');
    return;
  }
  const token = TG_TOKEN;
  const chatId = TG_CHAT;

  console.log(`[cron-alerts] Starting scan at ${new Date().toISOString()} (sentCache size=${sentCache.size})`);

  // 1) Fetch data
  let data;
  try {
    data = await fetchTop500();
  } catch (e) {
    console.error('[cron-alerts] CoinGecko fetch failed:', e.message);
    return;
  }

  if (!Array.isArray(data) || data.length === 0) {
    console.log('[cron-alerts] No data from CoinGecko.');
    return;
  }

  console.log(`[cron-alerts] Received ${data.length} coins.`);

  // 2) Score ALL coins first, collect candidates. Nothing below the
  //    LIVE MIN_ALERT_SCORE (env-fresh per tick) makes it in.
  const liveMin = getMinScore();
  const candidates = [];
  for (const d of data) {
    const s = sig(d);
    if (s.score < liveMin) continue;
    candidates.push({ coin: d, signal: s });
  }

  candidates.sort((a, b) => b.signal.score - a.signal.score);
  console.log(`[cron-alerts] ${candidates.length} coins with score >= ${liveMin}.`);

  if (candidates.length === 0) {
    console.log('[cron-alerts] No alerts to send.');
    return;
  }

  // 3) Filter out coins sent within the last 15 min (in-memory cache)
  const now = Date.now();

  // Prune stale entries so the Map can't grow unbounded across warm invocations.
  for (const [sym, ts] of sentCache) {
    if (now - ts >= THROTTLE_MS * 2) sentCache.delete(sym);
  }

  const toSend = [];
  for (const c of candidates) {
    const coinSymbol = (c.coin.symbol || '').toUpperCase();
    const lastSent = sentCache.get(coinSymbol) || 0;
    if (now - lastSent >= THROTTLE_MS) {
      toSend.push(c);
    }
  }

  console.log(`[cron-alerts] ${toSend.length} after throttle filter (15 min).`);

  if (toSend.length === 0) {
    console.log('[cron-alerts] All alerts throttled. Nothing to send.');
    return;
  }

  // 4) Send top 10 as individual messages with 350ms delay between each
  const batch = toSend.slice(0, 10);
  let sent = 0;

  for (let i = 0; i < batch.length; i++) {
    const { coin, signal } = batch[i];
    const text = buildMessage(coin, signal);

    try {
      // alertScore = the concrete score for the coin being sent right now
      const result = await sendTelegram(token, chatId, text, signal.score);
      if (result.ok) {
        sent++;
        const coinSymbol = (coin.symbol || '').toUpperCase();
        sentCache.set(coinSymbol, Date.now());
      } else {
        console.error(`[cron-alerts] TG error for ${coin.symbol}:`, result.description);
        // If rate-limited by Telegram, stop sending
        if (result.error_code === 429) {
          console.log('[cron-alerts] Rate limited by Telegram, stopping batch.');
          break;
        }
      }
    } catch (e) {
      console.error(`[cron-alerts] TG send failed for ${coin.symbol}:`, e.message);
    }

    // 350ms delay between messages (Telegram allows ~30/s but we stay safe)
    if (i < batch.length - 1) {
      await new Promise(r => setTimeout(r, 350));
    }
  }

  // 5) If more than 10 alerts, append a summary line. Re-validate every item
  //    against MIN_SCORE (belt-and-braces) so the "Dalsi X coinu" roundup
  //    can never contain a stale sub-floor entry.
  if (toSend.length > 10) {
    await new Promise(r => setTimeout(r, 350));
    const _summaryFloor = getMinScore();
    const remaining = toSend
      .slice(10)
      .filter(({ coin }) => sig(coin).score >= _summaryFloor);
    if (remaining.length) {
      const summaryLines = remaining.map(({ coin, signal }) =>
        `${(coin.symbol || '').toUpperCase()} ${signal.score}/10 (${signal.label})`
      );
      const summary = `📋 <b>Dalsi aktivni coiny (${remaining.length}):</b>\n` +
        summaryLines.join(' · ') +
        `\n\n⏱ ${new Date().toLocaleTimeString('cs-CZ', { timeZone: 'Europe/Prague' })}`;

      // For the group summary we pass the LOWEST score in the group. If the
      // worst entry passes the firewall, every listed entry is above floor.
      const minRemainingScore = remaining.reduce(
        (m, { signal }) => Math.min(m, signal.score), Infinity
      );
      try {
        const result = await sendTelegram(token, chatId, summary, minRemainingScore);
        if (result.ok) sent++;
      } catch (e) {
        console.error('[cron-alerts] Summary send failed:', e.message);
      }
    }
  }

  console.log(`[cron-alerts] Done. Sent ${sent} messages. (sentCache size=${sentCache.size})`);
};

export const config = {
  schedule: '*/5 * * * *'
};
