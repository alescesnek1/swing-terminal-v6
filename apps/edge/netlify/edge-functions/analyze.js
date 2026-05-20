// ─────────────────────────────────────────────────────────────
// Swing Terminal v3.0 — /api/analyze Edge Function (Deno)
//
// Two response modes:
//   • Default (Accept: application/json) → JSON, atomic, cached.
//   • Streaming (Accept: text/event-stream) → SSE, chunk-by-chunk
//     from Gemini; the assembled text is cached at end-of-stream.
//
// Pipeline per request:
//   1. CORS / preflight
//   2. Origin allowlist (hard reject 403)
//   3. Supabase JWT verify (cryptographic + claim checks)
//   4. Body parse + symbol normalization
//   5. AI cache lookup (HIT short-circuits; in stream mode we replay
//      cached text as a single chunk + meta event)
//   6. Rate limit (Lua, only after a cache miss)
//   7. Parallel Binance fetch (ticker + depth + klines + funding + OI + BTC)
//   8. Gemini orchestrator with retry / multi-family fallback / discovery
//   9. Cache the AI result (TTL configurable, default 12 min)
//  10. Respond
// ─────────────────────────────────────────────────────────────

import {
  checkRateLimit,
  aiCacheGet,
  aiCacheSet,
  getAiCacheTtlSeconds,
} from './lib/redis.js';
import {
  orchestrate,
  generateAtomic,
  streamWithFallback,
  discoverFlashModel,
  DEFAULT_MODEL_CHAIN,
  GeminiApiError,
} from './lib/orchestrator.js';
import { normalizeBinanceSymbol, fetchBinanceSnapshot } from './lib/binance.js';
import { fetchDexSnapshot } from './lib/geckoterminal.js';
import { checkOrigin, pickAllowOrigin, verifyAuth } from './lib/security.js';
import { logFatal, logWarn } from './lib/log.js';
import { getTier, tierCanUseAi, tierSeesDex, isAdminUser } from './lib/tier.js';

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': pickAllowOrigin(request),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(request, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────
// V4: build a snapshot for coins that AREN'T on Binance using
// whatever CoinGecko-derived context the frontend forwarded.
// Shape mirrors fetchBinanceSnapshot() output so the orchestrator
// branch logic (`futures.available === false` etc.) keeps working.
// ─────────────────────────────────────────────────────────────
function buildNonBinanceSnapshot(norm, ctx) {
  const safe = (v, dflt = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const c = ctx || {};
  const price = safe(c.current_price);
  const c24 = safe(c.price_change_percentage_24h);
  const high = safe(c.high_24h);
  const low = safe(c.low_24h);
  const qVol = safe(c.total_volume);

  const snapshot = {
    pair: norm.pair,
    futures_pair: null,
    base: norm.base,
    quote: norm.quote,
    fetched_at: new Date().toISOString(),
    fetch_ms: 0,
    binance_available: false,
    source: 'coingecko-fallback',
    asset_meta: {
      name: c.name || norm.base,
      market_cap: safe(c.market_cap),
      market_cap_rank: safe(c.market_cap_rank, 0),
    },
    spot: {
      last_price: price,
      open_price: c24 !== 0 && price ? +(price / (1 + c24 / 100)).toFixed(8) : price,
      high_24h: high,
      low_24h: low,
      price_change_pct_24h: c24,
      base_volume_24h: 'N/A',
      quote_volume_24h: qVol,
      trades_24h: 'N/A',
      weighted_avg_price: 'N/A',
      note: 'Spot data sourced from CoinGecko — pair NOT listed on Binance.',
    },
    multi_timeframe: { note: 'N/A — coin není listován na Binance, multi-TF klines nejsou k dispozici.' },
    orderbook: { note: 'N/A — coin není listován na Binance, order book nedostupný.' },
    futures: {
      available: false,
      mark_price: 'N/A',
      index_price: 'N/A',
      funding_rate: 'N/A',
      next_funding_time: 'N/A',
      open_interest_base: 'N/A',
      note: 'Pár NENÍ na Binance Futures — funding/OI data nejsou k dispozici.',
    },
    macro: {
      btc_benchmark: { note: 'N/A — fallback path skips Binance benchmark fetch.' },
      relative_strength_vs_btc_24h: 'N/A',
    },
  };

  return {
    snapshot,
    partial: true,
    errors: undefined,
    fetch_ms: 0,
    futuresAvailable: false,
    binance_available: false,
  };
}

// ─────────────────────────────────────────────────────────────
// SSE helpers
// ─────────────────────────────────────────────────────────────

function sseLine(event, data) {
  // Spec: each event is `event: NAME\ndata: JSON\n\n`.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function clientWantsStream(request) {
  const accept = (request.headers.get('accept') || '').toLowerCase();
  return accept.includes('text/event-stream');
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export default async function handler(request) {
  try {
    const startTime = Date.now();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'POST') {
      return jsonResponse(request, { error: 'Method Not Allowed' }, 405);
    }

    // ── 0. Safeguard: AI Engine Key Check ──
    if (!Deno.env.get('GEMINI_API_KEY')) {
      console.error('[CRITICAL] GEMINI_API_KEY is missing or undefined in the edge environment.');
      return jsonResponse(request, { error: 'AI Engine offline - Configuration missing' }, 503);
    }

    // ── 1. Origin lockdown ──
    const originCheck = checkOrigin(request);
    if (!originCheck.ok) {
      console.warn('[ANALYZE] Origin rejected:', originCheck.reason, originCheck.origin);
      return jsonResponse(request, {
        error: 'Forbidden origin',
        detail: originCheck.reason,
      }, 403);
    }

    // ── 2. JWT verify (signature + claims) ──
    const auth = await verifyAuth(request);
    if (!auth.ok) {
      console.warn('[ANALYZE] Auth rejected:', auth.reason);
      return jsonResponse(request, { error: 'Unauthorized', detail: auth.reason }, auth.status);
    }
    const userId = auth.user.id;
    // Phase 3: resolve tier for rate-limit + DEX gating
    const tier = getTier(auth.user);
    if (!tierCanUseAi(tier)) {
      return jsonResponse(request, { error: 'Tier does not include AI access', tier }, 403);
    }

    // ── 3. Body parse + symbol normalization ──
    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return jsonResponse(request, { error: 'Invalid JSON body' }, 400);
    }
    const rawSymbol = body?.symbol;
    if (!rawSymbol || typeof rawSymbol !== 'string' || rawSymbol.length > 20) {
      return jsonResponse(request, { error: 'Missing or invalid "symbol" field' }, 400);
    }
    const norm = normalizeBinanceSymbol(rawSymbol);
    if (!norm) return jsonResponse(request, { error: 'Invalid symbol format' }, 400);
    const lang = body.lang === 'en' ? 'en' : 'cs';
    // V4: optional CoinGecko-derived context the frontend forwards so
    // we can analyze DEX-only coins that aren't listed on Binance.
    const ctx = (body && typeof body.context === 'object' && body.context) ? body.context : null;
    const isBinanceCoin = !ctx || ctx.binance_available !== false;
    // Phase 3: gate DEX analysis behind PRO tier. Free users get told
    // why; this prevents free-tier users from racing through the
    // expensive CoinGecko-fallback path 5×/hr.
    if (!isBinanceCoin && !tierSeesDex(tier)) {
      return jsonResponse(request, {
        error: 'DEX coin analysis requires PRO tier',
        tier,
        symbol: norm.pair,
      }, 403);
    }
    // V4 Premium: ALPHA = listed on Binance Futures (USDⓈ-M perpetual)
    // but NOT on Binance Spot. We hit the futures API directly instead
    // of falling through to the CoinGecko-only fallback.
    //
    // V5 hotfix: accept the ALPHA signal from EITHER `binance_market`
    // OR `exchange`. Older frontend payloads / stale DATA rows may set
    // one and not the other; production saw VVV / USELESS / SKYAI 503
    // because their ctx had exchange='ALPHA' but binance_market was
    // null after a refresh race. We OR the two so a single venue signal
    // is enough to route to /fapi.
    const _ctxVenueIsFutures = !!(ctx && (
      ctx.binance_market === 'futures' ||
      String(ctx.exchange || '').toUpperCase() === 'ALPHA'
    ));
    const isAlphaCoin = !!(ctx && ctx.binance_available !== false && _ctxVenueIsFutures);
    // Namespace the cache so each path's snapshot shape (spot, futures-
    // only ALPHA, or CoinGecko fallback for true DEX coins) keeps its
    // own bucket and never collides on a venue migration.
    const cacheKeySymbol = !isBinanceCoin
      ? `dex:${norm.pair}`
      : isAlphaCoin
        ? `alpha:${norm.pair}`
        : norm.pair;
    const wantsStream = clientWantsStream(request);

    // ── 4. AI cache lookup ──
    const cached = await aiCacheGet(cacheKeySymbol, lang);
    if (cached) {
      const totalMs = Date.now() - startTime;
      const payload = {
        ...cached,
        meta: {
          ...cached.meta,
          cached: true,
          total_latency_ms: totalMs,
        },
      };
      if (wantsStream) {
        return streamCachedResponse(request, payload);
      }
      return jsonResponse(request, payload);
    }

    // ── 5. Rate limit (cache miss only) ──
    // V5 hotfix: admin emails bypass all rate limits.
    let rate;
    if (isAdminUser(auth.user)) {
      rate = { allowed: true, remaining: -1, reset_ms: 0, scope: 'admin', tier: 'pro' };
    } else {
      rate = await checkRateLimit(userId, norm.pair, tier);
      if (!rate.allowed) {
        const retryAfterSec = Math.ceil(rate.reset_ms / 1000);
        return jsonResponse(request, {
          error: 'Rate limit exceeded',
          scope: rate.scope,
          retry_after_seconds: retryAfterSec,
        }, 429, { 'Retry-After': String(retryAfterSec) });
      }
    }

    // ── 6. Parallel Binance fetch ──
    // V4: Binance is no longer authoritative — for DEX-only / non-listed
    // coins we skip the Binance fetch entirely and build a CoinGecko-only
    // snapshot so Gemini can still produce a fundamentals + news analysis.
    let fetched;
    if (!isBinanceCoin) {
      console.log('[ANALYZE] DEX/non-Binance coin — skipping Binance fetch:', norm.pair);
      fetched = buildNonBinanceSnapshot(norm, ctx);
      // V5 (Phase 3): enrich the CoinGecko fallback with live DEX data
      // (GeckoTerminal — Solana + Ethereum L1, 60s Redis cache). Soft-
      // fail: if the coin isn't on a supported chain or GT is down,
      // we fall through to the bare CoinGecko snapshot.
      try {
        const dex = ctx?.id ? await fetchDexSnapshot(ctx.id) : null;
        if (dex && fetched.snapshot) {
          fetched.snapshot.dex = dex;
          fetched.snapshot.source = 'geckoterminal+coingecko';
        }
      } catch (e) {
        console.warn('[ANALYZE] DEX enrichment failed:', e.message);
      }
    } else {
      // ALPHA = futures-only listing → hit /fapi instead of /api/v3.
      // The base/pair we send to fetchBinanceSnapshot has to be the
      // FUTURES pair (e.g. "1000PEPEUSDT") not whatever the user typed.
      const fetchArgs = isAlphaCoin
        ? {
            pair: ctx?.pair || ctx?.futures_pair || norm.pair,
            base: norm.base,
            quote: ctx?.quote || ctx?.futures_quote || 'USDT',
            market: 'futures',
          }
        : {
            ...norm,
            futures_pair: ctx?.futures_pair || null,
          };
      if (isAlphaCoin) {
        console.log('[ANALYZE] ALPHA coin — fetching from Binance Futures:', fetchArgs.pair);
      }
      try {
        fetched = await fetchBinanceSnapshot(fetchArgs);
      } catch (e) {
        console.warn('[ANALYZE] Binance fetch threw, falling back to context snapshot:', e.message);
        fetched = buildNonBinanceSnapshot(norm, ctx);
      }
      if (!fetched.snapshot) {
        // Binance could not deliver a usable snapshot. If the frontend
        // gave us context, fall back gracefully instead of 503ing.
        if (ctx) {
          console.warn('[ANALYZE] Binance snapshot empty, using context fallback for', norm.pair, '| errors:', JSON.stringify(fetched.errors));
          fetched = buildNonBinanceSnapshot(norm, ctx);
        } else {
          // Surface the upstream rejection BEFORE we send a generic 503
          // so we can read Binance's exact "Invalid symbol" / 451 / 418
          // reason in the edge logs.
          logWarn({ location: 'analyze/binance-503', payload: { pair: norm.pair, isAlphaCoin, isBinanceCoin, fetchArgs, errors: fetched.errors } });
          return jsonResponse(request, {
            error: 'Binance data unavailable',
            hint: 'Pair may not exist on Binance or upstream is down.',
            symbol: norm.pair,
            detail: fetched.errors,
          }, 503);
        }
      }
    }

    // ── 7. Either stream or atomic JSON ──
    if (wantsStream) {
      return streamLiveResponse(request, {
        norm,
        lang,
        fetched,
        rate,
        startTime,
        cacheKeySymbol,
      });
    }

    return await atomicJsonResponse(request, {
      norm,
      lang,
      fetched,
      rate,
      startTime,
      cacheKeySymbol,
    });
  } catch (fatalErr) {
    logFatal({ location: 'analyze/fatal', error: fatalErr, payload: { url: request.url, method: request.method } });
    const detail = fatalErr instanceof Error ? `${fatalErr.name}: ${fatalErr.message}` : String(fatalErr);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      detail,
      stage: 'fatal',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Atomic JSON path (no streaming)
// ─────────────────────────────────────────────────────────────

async function atomicJsonResponse(request, { norm, lang, fetched, rate, startTime, cacheKeySymbol }) {
  let result = null;
  let lastErr = null;
  const triedModels = [];

  const envOverride = Deno.env.get('GEMINI_MODEL');
  const baseChain = envOverride
    ? [envOverride, ...DEFAULT_MODEL_CHAIN.filter((m) => m !== envOverride)]
    : [...DEFAULT_MODEL_CHAIN];

  for (const model of baseChain) {
    triedModels.push(model);
    try {
      result = await orchestrate(norm.pair, fetched.snapshot, lang, model, fetched.partial);
      break;
    } catch (e) {
      lastErr = e;
      const status = e instanceof GeminiApiError ? e.status : 0;
      console.warn(`[ANALYZE] ${model} failed (status=${status}):`, e.message);
      if (status === 404) continue;
      if (status === 429 || (status >= 500 && status < 600)) {
        await delay(500);
        try {
          result = await orchestrate(norm.pair, fetched.snapshot, lang, model, fetched.partial);
          break;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
  }

  if (!result && lastErr instanceof GeminiApiError && lastErr.status === 404) {
    try {
      const discovered = await discoverFlashModel(Deno.env.get('GEMINI_API_KEY'));
      if (discovered && !triedModels.includes(discovered)) {
        triedModels.push(discovered);
        result = await orchestrate(norm.pair, fetched.snapshot, lang, discovered, fetched.partial);
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!result) {
    const status = lastErr instanceof GeminiApiError ? lastErr.status : 0;
    return jsonResponse(request, {
      error: 'AI analysis failed',
      detail: lastErr?.message || 'Gemini did not return a valid response after retries.',
      upstream_status: status,
      tried_models: triedModels,
      symbol: norm.pair,
      stage: 'gemini',
    }, 502);
  }

  const ttlSec = await aiCacheSet(cacheKeySymbol || norm.pair, lang, result);
  result.meta.cached = false;
  result.meta.cache_ttl_seconds = ttlSec || getAiCacheTtlSeconds();
  result.meta.binance_fetch_ms = fetched.fetch_ms;
  result.meta.partial_data = fetched.partial;
  result.meta.tried_models = triedModels;
  result.meta.rate_limit = { remaining: rate.remaining, reset_ms: rate.reset_ms };
  result.meta.total_latency_ms = Date.now() - startTime;
  return jsonResponse(request, result);
}

// ─────────────────────────────────────────────────────────────
// SSE streaming paths
// ─────────────────────────────────────────────────────────────

function streamCachedResponse(request, payload) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      try {
        controller.enqueue(enc.encode(sseLine('meta', payload.meta)));
        controller.enqueue(enc.encode(sseLine('chunk', { text: payload.analysis })));
        controller.enqueue(enc.encode(sseLine('done', { cached: true, symbol: payload.symbol })));
      } catch (e) {
        try { controller.enqueue(enc.encode(sseLine('error', { error: e.message }))); } catch { /* */ }
      } finally {
        try { controller.close(); } catch { /* */ }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(request),
    },
  });
}

function streamLiveResponse(request, { norm, lang, fetched, rate, startTime, cacheKeySymbol }) {
  const enc = new TextEncoder();
  let assembled = '';
  // V5 (D-4): abort the Gemini fetch when the client cancels the
  // response (e.g. closes the modal). Without this we keep paying
  // model tokens for output nobody will see.
  const abortCtl = new AbortController();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk) => {
        if (cancelled) return;
        try { controller.enqueue(enc.encode(chunk)); } catch (e) {
          console.warn('[ANALYZE/STREAM] enqueue failed:', e.message);
        }
      };
      const safeClose = () => { try { controller.close(); } catch { /* */ } };

      // V5 (D-3): TOP-LEVEL try/catch wrapping the entire async start
      // body. Without this an unexpected throw (e.g. fetch DNS error
      // before our inner try) propagates as an unhandled rejection and
      // the SSE response hangs forever from the client's perspective.
      try {
        // Open Gemini stream with full fallback chain.
        let opened;
        try {
          opened = await streamWithFallback({
            kind: 'analysis',
            symbol: norm.pair,
            snapshot: fetched.snapshot,
            userLang: lang,
            partial: fetched.partial,
            signal: abortCtl.signal,
          });
        } catch (e) {
        const status = e instanceof GeminiApiError ? e.status : 0;
        safeEnqueue(sseLine('error', {
          error: 'AI analysis failed',
          detail: e.message,
          upstream_status: status,
          stage: 'gemini',
        }));
        safeClose();
        return;
      }

      const { iter, primed, model, triedModels } = opened;
      safeEnqueue(sseLine('meta', {
        model,
        tried_models: triedModels,
        binance_fetch_ms: fetched.fetch_ms,
        partial_data: fetched.partial,
        rate_limit: { remaining: rate.remaining, reset_ms: rate.reset_ms },
        cached: false,
        symbol: norm.pair,
      }));

      // Drain primed first chunk, then continue.
      let chunkCount = 0;
      const handleChunk = (chunk) => {
        if (chunk?.text) {
          assembled += chunk.text;
          chunkCount++;
          safeEnqueue(sseLine('chunk', { text: chunk.text }));
        }
      };

      try {
        if (primed && !primed.done) handleChunk(primed.value);
        for await (const chunk of iter) handleChunk(chunk);
      } catch (e) {
        // Mid-stream upstream failure — we tell the client what we
        // have and stop. Never throw out of the stream.
        console.warn('[ANALYZE/STREAM] mid-stream error:', e.message);
        safeEnqueue(sseLine('error', { error: 'Stream interrupted', detail: e.message }));
        safeClose();
        return;
      }

      // ── SAFETY BRAKE ──
      // Stream ended cleanly but no text chunks came through — the
      // wire format must have shifted out from under our extractor.
      // Fall back to non-streaming :generateContent and ship the
      // result as one chunk so the user always sees text on screen.
      if (chunkCount === 0) {
        console.warn(`[ANALYZE/STREAM] Zero chunks from ${model}, engaging atomic fallback`);
        try {
          const atomic = await generateAtomic({
            kind: 'analysis',
            symbol: norm.pair,
            snapshot: fetched.snapshot,
            userLang: lang,
            model,
            partial: fetched.partial,
          });
          if (atomic?.analysis) {
            assembled = atomic.analysis;
            safeEnqueue(sseLine('chunk', { text: atomic.analysis }));
            safeEnqueue(sseLine('meta', { ...atomic.meta, fallback: 'atomic-after-empty-stream' }));
          } else {
            safeEnqueue(sseLine('error', {
              error: 'Stream produced no chunks and atomic fallback returned no text',
              stage: 'gemini-fallback',
            }));
            safeClose();
            return;
          }
        } catch (e) {
          console.warn('[ANALYZE/STREAM] atomic fallback failed:', e.message);
          safeEnqueue(sseLine('error', {
            error: 'Stream produced no chunks',
            detail: e.message,
            stage: 'gemini-fallback',
          }));
          safeClose();
          return;
        }
      }

      // Cache assembled response (best-effort, never blocks close).
      const finalPayload = {
        symbol: norm.pair,
        analysis: assembled,
        meta: {
          model,
          tried_models: triedModels,
          partial: fetched.partial,
          timestamp: new Date().toISOString(),
        },
      };
      let ttlSec = 0;
      try {
        ttlSec = await aiCacheSet(cacheKeySymbol || norm.pair, lang, finalPayload);
      } catch (e) {
        console.warn('[ANALYZE/STREAM] cache write failed:', e.message);
      }

      safeEnqueue(sseLine('done', {
        symbol: norm.pair,
        cache_ttl_seconds: ttlSec || getAiCacheTtlSeconds(),
        total_latency_ms: Date.now() - startTime,
        chunks: chunkCount,
      }));
      safeClose();
      } catch (outerErr) {
        // V5 (D-3): final net for any throw that escaped the inner
        // try blocks. Surface as a structured SSE error and close so
        // the client never sees a hanging stream.
        console.error('[ANALYZE/STREAM] outer fatal:', outerErr?.stack || outerErr);
        safeEnqueue(sseLine('error', {
          error: 'Stream handler crashed',
          detail: outerErr instanceof Error ? `${outerErr.name}: ${outerErr.message}` : String(outerErr),
          stage: 'stream-outer',
        }));
        safeClose();
      }
    },
    cancel(reason) {
      // V5 (D-4): client disconnected (modal closed, tab killed). Abort
      // the upstream Gemini fetch so we stop paying for tokens nobody
      // will see and don't hold the isolate open for an idle stream.
      cancelled = true;
      try { abortCtl.abort(reason || 'client-cancelled'); } catch { /* */ }
      console.log('[ANALYZE/STREAM] cancelled by client:', String(reason || '').slice(0, 80));
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(request),
    },
  });
}
