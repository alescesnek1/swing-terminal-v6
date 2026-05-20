// ─────────────────────────────────────────────────────────────
// Swing Terminal V6.2 — /api/news Edge Function (Deno)
//
// LIVE FEED SOURCE: public Telegram preview at https://t.me/s/excavonews
// The browser cannot fetch t.me directly (CORS + bot-detection cookie),
// so we scrape it edge-side and return a CryptoPanic-shaped payload
// — same fields the UI already renders, but the rows come from the
// last 10 messages in the channel preview.
//
// CryptoPanic remains a last-resort fallback when the Telegram preview
// is blocked / unreachable, so the news tab never goes blank.
// ─────────────────────────────────────────────────────────────

import { logWarn } from './lib/log.js';
import { pickAllowOrigin } from './lib/security.js';

const CDN_MAX_AGE_SEC = 90;
const CDN_SWR_SEC = 240;
const MEMORY_TTL_MS = 45 * 1000;

const TG_CHANNEL = 'excavonews';
const TG_PREVIEW_URL = `https://t.me/s/${TG_CHANNEL}`;
const TG_MAX_MESSAGES = 10;
const TG_FETCH_TIMEOUT_MS = 10_000;

// CryptoPanic fallback (only used if the TG preview is unreachable).
const FALLBACK_CURRENCIES = 'BTC,ETH,SOL,XRP,ADA,AVAX,DOT,LINK,UNI,DOGE';

let _cache = null; // { at, body }

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': pickAllowOrigin(req),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function jsonHeaders(req) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': `public, s-maxage=${CDN_MAX_AGE_SEC}, stale-while-revalidate=${CDN_SWR_SEC}`,
    ...corsHeaders(req),
  };
}

// ── Minimal HTML utilities — Deno has no DOM, so we go regex + decode.
// We don't need a full HTML parser; the t.me/s/ page is server-rendered
// and stable. We only extract the parts we care about.
function decodeHtmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  if (!s) return '';
  // Convert <br> to newlines first so multi-line text reads correctly.
  return String(s)
    .replace(/<br\s*\/?>(?:\s*)/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Crude title extractor — the first non-empty line of the message body.
function deriveTitle(text) {
  if (!text) return '';
  const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) || '';
  // Cap title length so long copy doesn't blow out the UI.
  if (firstLine.length <= 180) return firstLine;
  return firstLine.slice(0, 177) + '…';
}

// Heuristic ticker detector — surface tags like $BTC / #ETH / SOL so the
// existing UI link-renderer can highlight them.
function extractCurrencies(text) {
  if (!text) return [];
  const out = new Set();
  const rx = /(?:^|[\s\$#])([A-Z]{2,6})(?=\b)/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const t = m[1];
    if (t.length >= 2 && t.length <= 6) out.add(t);
  }
  // Reject obvious English caps that aren't tickers.
  const blacklist = new Set(['THE','AND','FOR','WITH','THIS','THAT','FROM','HAS','HAVE','ARE','WAS','BE','TO','OF','ON','AT','IN','BY','OR','SO','IF','AS','IS','IT','A','I','AN','US','UK','EU','UN','CEO','NEW','OLD','CPI','FOMC','ETF','GDP','ATH','ATL','API','XYZ','AI','ML']);
  return [...out].filter(t => !blacklist.has(t)).slice(0, 8);
}

// ── Telegram preview parser ─────────────────────────────────────
//
// The t.me/s/<channel> page renders the last ~20 messages as a stream
// of `<div class="tgme_widget_message_wrap ...">` blocks. Each wrap
// carries one or two interesting children:
//   • <div class="tgme_widget_message_text" ...>...</div>  ← the body
//   • <a class="tgme_widget_message_date" href="https://t.me/<ch>/<n>">
//       <time datetime="...">...</time>
//     </a>
//
// We extract the last 10 message-text blocks (most recent shown LAST in
// the page, so we reverse to make the newest first) and pair each with
// the corresponding date + permalink scanned from the SAME wrap when
// available. If pairing fails for a single message we still ship the
// text — partial > nothing.
function parseTelegramPreview(html) {
  if (typeof html !== 'string' || !html.length) return [];

  // Slice the doc into wrap blocks so per-message context (date + url)
  // can be resolved alongside the body text. The wrap div opener varies
  // (multiple class modifiers), so we anchor on the class token.
  const wraps = [];
  const wrapOpenRx = /<div\s+class="tgme_widget_message_wrap[^"]*"[\s\S]*?(?=<div\s+class="tgme_widget_message_wrap|<\/main>|<\/section>|$)/gi;
  let m;
  while ((m = wrapOpenRx.exec(html)) !== null) {
    wraps.push(m[0]);
    if (wraps.length > 60) break; // hard ceiling
  }

  // Fallback: if the wrap pattern didn't match (Telegram tweaked their
  // markup), we still try to pull message-text blocks raw.
  if (!wraps.length) {
    const out = [];
    const textRx = /<div\s+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let t;
    while ((t = textRx.exec(html)) !== null) {
      const body = decodeHtmlEntities(stripTags(t[1]));
      if (body) out.push({ text: body, permalink: '', published_at: null });
      if (out.length >= TG_MAX_MESSAGES * 2) break;
    }
    return out.reverse().slice(0, TG_MAX_MESSAGES);
  }

  const messages = [];
  for (const wrap of wraps) {
    const textMatch = /<div\s+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(wrap);
    if (!textMatch) continue;
    const body = decodeHtmlEntities(stripTags(textMatch[1]));
    if (!body) continue;

    const dateMatch = /<a\s+class="tgme_widget_message_date"[^>]*href="([^"]+)"[\s\S]*?<time[^>]*datetime="([^"]+)"/i.exec(wrap);
    const permalink = dateMatch ? dateMatch[1] : '';
    const published_at = dateMatch ? dateMatch[2] : null;
    messages.push({ text: body, permalink, published_at });
    if (messages.length >= TG_MAX_MESSAGES * 2) break;
  }
  // t.me/s renders oldest → newest; reverse to put newest first.
  return messages.reverse().slice(0, TG_MAX_MESSAGES);
}

async function fetchTelegramChannel() {
  let r;
  try {
    r = await fetch(TG_PREVIEW_URL, {
      headers: {
        // Identify as a vanilla browser; Telegram returns the same
        // server-rendered preview for any UA. Accept-Language steers
        // the date format toward English for stable parsing.
        'User-Agent': 'Mozilla/5.0 (compatible; SwingTerminal/6.2; +https://swing-terminal-v5.netlify.app)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    logWarn({ location: 'news/telegram', message: `fetch failed: ${e.message}` });
    return { results: [], source: 'telegram', note: 'Telegram feed temporarily unavailable (network error).' };
  }

  if (!r.ok) {
    logWarn({ location: 'news/telegram', message: `telegram HTTP ${r.status}` });
    return { results: [], source: 'telegram', note: `Telegram feed temporarily unavailable (HTTP ${r.status}).` };
  }

  const html = await r.text();
  const parsed = parseTelegramPreview(html);
  const results = parsed.map((p, i) => {
    const title = deriveTitle(p.text);
    return {
      // Preserve CryptoPanic-compatible shape so the existing renderer
      // works unchanged. Extra `text` field carries the full body for
      // any future UI that wants the long-form post.
      title,
      text: p.text,
      url: p.permalink || `https://t.me/${TG_CHANNEL}`,
      source: { title: `Telegram · @${TG_CHANNEL}`, domain: 't.me' },
      published_at: p.published_at || new Date(Date.now() - i * 60_000).toISOString(),
      currencies: extractCurrencies(p.text),
      votes: null,
    };
  });

  return { results, source: 'telegram', channel: TG_CHANNEL };
}

// CryptoPanic fallback — only invoked if Telegram returns 0 results.
// Kept defensive: never throws, returns graceful empty payload.
async function fetchCryptoPanicFallback() {
  const token = (Deno.env.get('CRYPTOPANIC_TOKEN') || 'free');
  const url = `https://cryptopanic.com/api/free/v1/posts/?auth_token=${encodeURIComponent(token)}&public=true&kind=news&filter=important&currencies=${FALLBACK_CURRENCIES}`;
  try {
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SwingTerminal/6.2' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return { results: [], source: 'cryptopanic-fallback', note: `Fallback news upstream HTTP ${r.status}.` };
    }
    const data = await r.json();
    const rows = Array.isArray(data?.results) ? data.results : [];
    const results = rows.slice(0, 25).map((p) => ({
      title: p.title || '',
      url: p.url || p.original_url || '',
      source: { title: p.source?.title || p.domain || 'CryptoPanic', domain: p.source?.domain || p.domain || '' },
      published_at: p.published_at || p.created_at || new Date().toISOString(),
      currencies: Array.isArray(p.currencies) ? p.currencies.map((c) => c.code).filter(Boolean) : [],
      votes: p.votes || null,
    }));
    return { results, source: 'cryptopanic-fallback' };
  } catch (e) {
    logWarn({ location: 'news/cryptopanic-fallback', message: e.message });
    return { results: [], source: 'cryptopanic-fallback', note: 'Fallback news temporarily unavailable.' };
  }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed', results: [] }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const now = Date.now();
  if (_cache && now - _cache.at < MEMORY_TTL_MS) {
    return new Response(_cache.body, { status: 200, headers: jsonHeaders(request) });
  }

  let payload;
  try {
    payload = await fetchTelegramChannel();
  } catch (err) {
    logWarn({ location: 'news/handler', message: `unexpected throw: ${err.message}` });
    payload = { results: [], source: 'telegram', note: 'News temporarily unavailable.' };
  }

  if (!payload.results || !payload.results.length) {
    // Telegram returned nothing — try CryptoPanic as a graceful last
    // resort so the UI never shows an empty feed when at least one
    // upstream is up.
    const fallback = await fetchCryptoPanicFallback();
    if (fallback.results && fallback.results.length) {
      payload = fallback;
    } else if (_cache) {
      return new Response(_cache.body, {
        status: 200,
        headers: { ...jsonHeaders(request), 'X-Served-From': 'stale-memory' },
      });
    } else {
      payload = { results: [], source: 'telegram', note: payload.note || 'News temporarily unavailable.' };
    }
  }

  const body = JSON.stringify(payload);
  if (payload.results && payload.results.length) {
    _cache = { at: now, body };
  }
  return new Response(body, { status: 200, headers: jsonHeaders(request) });
}
