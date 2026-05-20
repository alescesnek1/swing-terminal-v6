// ─────────────────────────────────────────────────────────────
// Swing Terminal v3.0 — /api/briefing Edge Function (Deno)
//
// Executive morning briefing. The frontend sends the top 3 symbols
// it computed locally (by score). We:
//   1. Origin lockdown + JWT verify (same as /api/analyze)
//   2. Cache lookup (key = sorted-symbols + lang)
//   3. Rate limit (per user, single bucket — briefings are big)
//   4. Parallel snapshot fetch for the 3 symbols
//   5. Stream Gemini with the briefing prompt
//   6. Cache assembled text on completion
//
// Always streams (Accept: text/event-stream is the assumed contract).
// ─────────────────────────────────────────────────────────────

import {
  aiCacheGet,
  aiCacheSet,
  getAiCacheTtlSeconds,
  checkRateLimit,
} from './lib/redis.js';
import { streamWithFallback, generateAtomic, GeminiApiError } from './lib/orchestrator.js';
import { normalizeBinanceSymbol, fetchBinanceSnapshot } from './lib/binance.js';
import { checkOrigin, pickAllowOrigin, verifyAuth } from './lib/security.js';
import { logFatal } from './lib/log.js';
import { getTier, tierCanUseAi, isAdminUser } from './lib/tier.js';

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

function sseLine(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MAX_SYMBOLS = 3;

export default async function handler(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'POST') {
      return jsonResponse(request, { error: 'Method Not Allowed' }, 405);
    }

    // Origin + JWT
    const originCheck = checkOrigin(request);
    if (!originCheck.ok) {
      return jsonResponse(request, { error: 'Forbidden origin', detail: originCheck.reason }, 403);
    }
    const auth = await verifyAuth(request);
    if (!auth.ok) {
      return jsonResponse(request, { error: 'Unauthorized', detail: auth.reason }, auth.status);
    }
    const userId = auth.user.id;
    const tier = getTier(auth.user);
    if (!tierCanUseAi(tier)) {
      return jsonResponse(request, { error: 'Tier does not include AI briefings', tier }, 403);
    }

    // Body
    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return jsonResponse(request, { error: 'Invalid JSON body' }, 400);
    }
    const rawSymbols = Array.isArray(body?.symbols) ? body.symbols : [];
    // V5 hotfix: optional parallel `contexts` array (1-to-1 with `symbols`)
    // forwards the venue hint per symbol. Each entry is either null or
    // `{ exchange?, binance_market?, pair?, futures_pair? }`. Older
    // frontends that don't send `contexts` still work — those symbols
    // route through the spot path, and lib/binance.js's auto-fallback
    // catches the futures-only ones.
    const rawContexts = Array.isArray(body?.contexts) ? body.contexts : [];
    const lang = body?.lang === 'en' ? 'en' : 'cs';
    if (!rawSymbols.length) {
      return jsonResponse(request, { error: 'symbols[] required' }, 400);
    }

    const normSymbols = [];
    const symbolContexts = [];
    for (let i = 0; i < Math.min(rawSymbols.length, MAX_SYMBOLS); i++) {
      const n = normalizeBinanceSymbol(rawSymbols[i]);
      if (!n) continue;
      normSymbols.push(n);
      symbolContexts.push(rawContexts[i] || null);
    }
    if (!normSymbols.length) {
      return jsonResponse(request, { error: 'No valid symbols after normalization' }, 400);
    }

    const cacheKey = `briefing:${normSymbols.map((n) => n.pair).sort().join(',')}`;
    const startTime = Date.now();

    // Cache hit → replay as a single chunk.
    const cached = await aiCacheGet(cacheKey, lang);
    if (cached) {
      return streamCachedBriefing(request, cached, startTime);
    }

    // Rate limit (briefings are expensive — lump them on one bucket
    // per user so a user can't bypass /api/analyze limits via here).
    // V5 hotfix: admin emails skip the gate entirely.
    let rate;
    if (isAdminUser(auth.user)) {
      rate = { allowed: true, remaining: -1, reset_ms: 0, scope: 'admin', tier: 'pro' };
    } else {
      rate = await checkRateLimit(userId, 'briefing', tier);
      if (!rate.allowed) {
        const retryAfterSec = Math.ceil(rate.reset_ms / 1000);
        return jsonResponse(request, {
          error: 'Rate limit exceeded',
          scope: rate.scope,
          retry_after_seconds: retryAfterSec,
        }, 429, { 'Retry-After': String(retryAfterSec) });
      }
    }

    // Parallel snapshot fetch for all symbols. Per-symbol venue routing:
    // if the caller marked a coin as ALPHA / futures (or just passed the
    // exchange badge), we route to /fapi. Otherwise the default 'spot'
    // path runs and lib/binance.js's auto-fallback catches futures-only
    // pairs the caller didn't explicitly mark.
    const fetchedAll = await Promise.allSettled(
      normSymbols.map((n, i) => {
        const ctx = symbolContexts[i];
        const isFutures = !!(ctx && (
          ctx.binance_market === 'futures' ||
          String(ctx.exchange || '').toUpperCase() === 'ALPHA'
        ));
        if (isFutures) {
          return fetchBinanceSnapshot({
            pair: ctx.pair || ctx.futures_pair || n.pair,
            base: n.base,
            quote: ctx.quote || ctx.futures_quote || n.quote || 'USDT',
            market: 'futures',
          });
        }
        return fetchBinanceSnapshot({ ...n, futures_pair: ctx?.futures_pair || null });
      }),
    );
    const snapshots = [];
    for (let i = 0; i < normSymbols.length; i++) {
      const f = fetchedAll[i];
      if (f.status === 'fulfilled' && f.value.snapshot) {
        snapshots.push({ symbol: normSymbols[i].pair, ...f.value.snapshot });
      } else {
        snapshots.push({
          symbol: normSymbols[i].pair,
          note: 'N/A — Binance fetch failed for this symbol.',
          error: f.status === 'fulfilled' ? f.value.errors : String(f.reason?.message || f.reason),
        });
      }
    }

    return streamLiveBriefing(request, {
      cacheKey,
      lang,
      snapshots,
      rate,
      startTime,
    });
  } catch (fatalErr) {
    logFatal({ location: 'briefing/fatal', error: fatalErr, payload: { url: request.url, method: request.method } });
    const detail = fatalErr instanceof Error ? `${fatalErr.name}: ${fatalErr.message}` : String(fatalErr);
    return new Response(JSON.stringify({ error: 'Internal Server Error', detail, stage: 'fatal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}

function streamCachedBriefing(request, payload, startTime) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      try {
        controller.enqueue(enc.encode(sseLine('meta', {
          ...(payload.meta || {}),
          cached: true,
          total_latency_ms: Date.now() - startTime,
        })));
        controller.enqueue(enc.encode(sseLine('chunk', { text: payload.analysis })));
        controller.enqueue(enc.encode(sseLine('done', { cached: true })));
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

function streamLiveBriefing(request, { cacheKey, lang, snapshots, rate, startTime }) {
  const enc = new TextEncoder();
  let assembled = '';
  // V5 (D-4): plumb a cancellation signal so client disconnect aborts the Gemini fetch.
  const abortCtl = new AbortController();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk) => {
        if (cancelled) return;
        try { controller.enqueue(enc.encode(chunk)); } catch (e) {
          console.warn('[BRIEFING/STREAM] enqueue failed:', e.message);
        }
      };
      const safeClose = () => { try { controller.close(); } catch { /* */ } };

      // V5 (D-3): outer try around the entire start body.
      try {
      let opened;
      try {
        opened = await streamWithFallback({
          kind: 'briefing',
          snapshots,
          userLang: lang,
          signal: abortCtl.signal,
        });
      } catch (e) {
        const status = e instanceof GeminiApiError ? e.status : 0;
        safeEnqueue(sseLine('error', {
          error: 'Briefing AI failed',
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
        symbols: snapshots.map((s) => s.symbol),
        rate_limit: { remaining: rate.remaining, reset_ms: rate.reset_ms },
        cached: false,
      }));

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
        console.warn('[BRIEFING/STREAM] mid-stream error:', e.message);
        safeEnqueue(sseLine('error', { error: 'Stream interrupted', detail: e.message }));
        safeClose();
        return;
      }

      // Safety brake — same logic as /api/analyze.
      if (chunkCount === 0) {
        console.warn(`[BRIEFING/STREAM] Zero chunks from ${model}, engaging atomic fallback`);
        try {
          const atomic = await generateAtomic({
            kind: 'briefing',
            snapshots,
            userLang: lang,
            model,
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
          console.warn('[BRIEFING/STREAM] atomic fallback failed:', e.message);
          safeEnqueue(sseLine('error', {
            error: 'Stream produced no chunks',
            detail: e.message,
            stage: 'gemini-fallback',
          }));
          safeClose();
          return;
        }
      }

      const finalPayload = {
        symbols: snapshots.map((s) => s.symbol),
        analysis: assembled,
        meta: { model, tried_models: triedModels, timestamp: new Date().toISOString() },
      };
      let ttlSec = 0;
      try { ttlSec = await aiCacheSet(cacheKey, lang, finalPayload); }
      catch (e) { console.warn('[BRIEFING/STREAM] cache write failed:', e.message); }

      safeEnqueue(sseLine('done', {
        cache_ttl_seconds: ttlSec || getAiCacheTtlSeconds(),
        total_latency_ms: Date.now() - startTime,
        chunks: chunkCount,
      }));
      safeClose();
      } catch (outerErr) {
        // V5 (D-3): catch-all so unexpected throws never hang the stream.
        console.error('[BRIEFING/STREAM] outer fatal:', outerErr?.stack || outerErr);
        safeEnqueue(sseLine('error', {
          error: 'Stream handler crashed',
          detail: outerErr instanceof Error ? `${outerErr.name}: ${outerErr.message}` : String(outerErr),
          stage: 'stream-outer',
        }));
        safeClose();
      }
    },
    cancel(reason) {
      cancelled = true;
      try { abortCtl.abort(reason || 'client-cancelled'); } catch { /* */ }
      console.log('[BRIEFING/STREAM] cancelled by client:', String(reason || '').slice(0, 80));
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
