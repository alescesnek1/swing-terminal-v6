// ─────────────────────────────────────────────────────────────
// Swing Terminal v3.0 — AI Analysis Client (SSE streaming)
//
// Talks to /api/analyze with `Accept: text/event-stream`. The edge
// function emits three SSE events:
//   • meta   { model, cached, binance_fetch_ms, … }
//   • chunk  { text }                              (0..N times)
//   • done   { cache_ttl_seconds, total_latency_ms } | { error, … }
//   • error  { error, detail, upstream_status, stage }
//
// We render the analysis incrementally, so the user sees text as
// soon as Gemini emits its first token. Markdown is re-rendered on
// every chunk via formatAnalysis().
// ─────────────────────────────────────────────────────────────

const API_URL = '/api/analyze';
const BRIEFING_URL = '/api/briefing';
const MKT_BRIEFING_URL = '/api/market-briefing';

const modal = document.getElementById('ai-modal');
const modalSymbol = document.getElementById('ai-modal-symbol');
const modalBody = document.getElementById('ai-modal-body');
const modalMeta = document.getElementById('ai-modal-meta');
const closeButtons = modal?.querySelectorAll('[data-close]') || [];

// Briefing modal (added in Module 4)
const briefingModal = document.getElementById('briefing-modal');
const briefingBody = document.getElementById('briefing-modal-body');
const briefingMeta = document.getElementById('briefing-modal-meta');
const briefingCloseButtons = briefingModal?.querySelectorAll('[data-close]') || [];

// ── Modal control ──

function openModal(symbol) {
  if (!modal) return;
  modalSymbol.textContent = symbol;
  modalBody.innerHTML = '';
  modalMeta.textContent = '';
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  modalBody.innerHTML = `
    <div class="ai-loading">
      <div class="ai-loading__spinner"></div>
      <p class="ai-loading__text">Stahuji čerstvá data z Binance…</p>
      <p class="ai-loading__sub">Ticker, order book, klines (7d/30d), funding, OI, BTC benchmark — paralelně.</p>
      <p class="ai-loading__sub" id="ai-loading-step">Krok 1/2 · Binance snapshot</p>
    </div>
  `;
}

function closeModal() {
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function openBriefingModal() {
  if (!briefingModal) return;
  briefingBody.innerHTML = `
    <div class="ai-loading">
      <div class="ai-loading__spinner"></div>
      <p class="ai-loading__text">Skládám syntézu trhu…</p>
      <p class="ai-loading__sub">Top 3 setupy podle interního skóre + makro kontext.</p>
    </div>
  `;
  briefingMeta.textContent = '';
  briefingModal.hidden = false;
  briefingModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeBriefingModal() {
  if (!briefingModal) return;
  briefingModal.hidden = true;
  briefingModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

// ── Renderers ──

function setupResultDom(bodyEl, cached) {
  // Stable wrapper that we mutate in place as chunks arrive — no
  // innerHTML thrash on every byte, just one .innerHTML on the
  // content slot per chunk.
  bodyEl.innerHTML = `
    <div class="ai-result">
      <div class="ai-result__topline" id="ai-result-topline">
        ${cached
          ? '<span class="ai-cache-badge" title="Odpověď z cache (Upstash Redis)">⚡ CACHED</span>'
          : '<span class="ai-fresh-badge ai-fresh-badge--streaming" title="Streamuji z Gemini živě">🟢 STREAMING…</span>'
        }
      </div>
      <div class="ai-result__content" id="ai-result-content"></div>
    </div>
  `;
  return {
    contentEl: bodyEl.querySelector('#ai-result-content'),
    toplineEl: bodyEl.querySelector('#ai-result-topline'),
  };
}

function renderMeta(metaEl, m, prefix = '') {
  if (!metaEl) return;
  const parts = [];
  if (prefix) parts.push(prefix);
  if (m.model) parts.push(`Model: ${m.model}`);
  if (m.binance_fetch_ms != null) parts.push(`Binance: ${m.binance_fetch_ms}ms`);
  if (m.total_latency_ms != null) parts.push(`Total: ${m.total_latency_ms}ms`);
  if (m.cache_ttl_seconds && !m.cached) parts.push(`TTL: ${Math.round(m.cache_ttl_seconds / 60)} min`);
  if (m.partial_data) parts.push('partial');
  if (m.tried_models?.length > 1) parts.push(`tried: ${m.tried_models.join('→')}`);
  metaEl.textContent = parts.join(' │ ');
}

function renderError(bodyEl, metaEl, error, status) {
  if (!bodyEl) return;
  let icon = '❌';
  let title = 'Chyba';
  let detail = error?.error || error?.detail || 'Neznámá chyba';
  let hint = error?.detail && error?.error && error.detail !== error.error ? error.detail : '';

  if (status === 401) {
    icon = '🔒'; title = 'Neautorizovaný přístup';
    detail = error?.detail || 'Vaše relace vypršela.';
    hint = 'Stránka se za chvíli automaticky obnoví.';
    setTimeout(() => window.location.reload(), 3000);
  } else if (status === 429) {
    icon = '⏳'; title = 'Rate Limit';
    detail = 'Příliš mnoho požadavků.';
    if (error?.retry_after_seconds) {
      hint = `Další analýza dostupná za ~${Math.ceil(error.retry_after_seconds / 60)} min.`;
    }
  } else if (status === 403) {
    icon = '🚫'; title = 'Zakázáno';
    detail = error?.detail || 'Žádost přišla z neoprávněného původu.';
  } else if (status === 503) {
    icon = '📡'; title = 'Binance nedostupné';
    detail = error?.error || 'Nepodařilo se stáhnout data z Binance.';
    hint = error?.hint || error?.detail || 'Zkuste to prosím znovu za chvíli.';
  } else if (status === 502) {
    icon = '🤖'; title = 'AI selhala';
    detail = error?.error || 'Gemini neodpověděl ani po retry.';
    hint = error?.detail || (error?.tried_models ? `Tried: ${error.tried_models.join(' → ')}` : 'Zkuste to prosím znovu.');
  } else if (status === 500) {
    icon = '💥'; title = 'Interní chyba serveru';
    detail = error?.detail || error?.error || 'Edge funkce hodila výjimku.';
    if (error?.stage) hint = `stage: ${error.stage}`;
  } else if (status === 0) {
    icon = '🌐'; title = 'Síťová chyba';
    detail = error?.detail || error?.error || 'Nepodařilo se kontaktovat server.';
  }

  if (!detail) detail = `HTTP ${status}`;

  bodyEl.innerHTML = `
    <div class="ai-error">
      <div class="ai-error__icon">${icon}</div>
      <h4 class="ai-error__title">${escapeText(title)}</h4>
      <p class="ai-error__detail">${escapeText(detail)}</p>
      ${hint ? `<p class="ai-error__hint">${escapeText(hint)}</p>` : ''}
    </div>
  `;
  if (metaEl) metaEl.textContent = `Status: ${status}${error?.stage ? ' · ' + error.stage : ''}`;

  // V5 (hotfix): ALWAYS surface a toast for AI errors, even if Toast
  // didn't exist when the script first loaded (race) or detail strings
  // are missing. Retries once via setTimeout if window.Toast isn't
  // ready yet — covers a very rare edge case where the modal opens
  // before toast.js finishes its IIFE.
  const _doToast = () => {
    if (!window.Toast) return false;
    try {
      const lvl = (status >= 500 || status === 0) ? 'error'
        : (status === 429 || status === 401) ? 'warn'
        : 'error';
      const toastTitle = `AI ${status || 'ERR'}: ${title || 'Chyba'}`;
      const toastDetail = detail || hint || `Status ${status}`;
      window.Toast[lvl](toastTitle, toastDetail, { code: status, endpoint: '/api/analyze' });
      return true;
    } catch (e) {
      console.warn('[AI] Toast call threw:', e?.message);
      return false;
    }
  };
  if (!_doToast()) {
    // Toast isn't ready yet — retry once after a tick.
    setTimeout(_doToast, 50);
  }
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatAnalysis(text) {
  if (!text) return '';
  return text
    .replace(/^### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

function extractBriefingText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const direct = [
    payload.analysis,
    payload.briefing,
    payload.text,
    payload.content,
    payload.markdown,
    payload.message,
  ];
  for (const v of direct) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  const nested = [
    payload.data,
    payload.result,
    payload.output,
    payload.response,
  ];
  for (const obj of nested) {
    if (obj && typeof obj === 'object') {
      const text = extractBriefingText(obj);
      if (text) return text;
    }
  }
  return '';
}

// ── Auth ──

async function getAccessToken() {
  try {
    const sb = window.__supabase;
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    return session?.access_token || null;
  } catch (err) {
    console.error('[AI] Failed to get session:', err);
    return null;
  }
}

// ── SSE stream consumption ──

/**
 * Open an SSE connection via fetch (so we can send Authorization
 * header — EventSource can't). Yields parsed { event, data } pairs.
 */
async function* sseFetch(url, init) {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) {
    let parsed;
    try { parsed = await res.clone().json(); }
    catch { parsed = { error: (await res.text()).slice(0, 240) || `HTTP ${res.status}` }; }
    const err = new Error(parsed.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        try {
          const data = JSON.parse(dataLines.join(''));
          yield { event, data };
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* */ }
  }
}

// ── Public: single-coin analysis ──

export async function requestAnalysis(symbol, _id, context) {
  openModal(symbol);

  const accessToken = await getAccessToken();
  if (!accessToken) {
    renderError(modalBody, modalMeta, { error: 'No active session' }, 401);
    return;
  }

  let dom = null;
  let buffered = '';
  let metaSeen = null;

  // Pull context from the global stash if the caller didn't pass one
  // explicitly. The wrapper in terminal.js sets this before invoking us.
  const ctx = context || (typeof window !== 'undefined' ? window.__lastAnalyzeCtx : null) || null;

  try {
    const it = sseFetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        symbol,
        lang: document.documentElement.lang || 'cs',
        context: ctx,
      }),
    });

    let chunkCount = 0;
    for await (const { event, data } of it) {
      console.log('[AI/SSE] event:', event, 'data:', data);

      if (event === 'meta') {
        metaSeen = { ...(metaSeen || {}), ...data };
        if (!dom) dom = setupResultDom(modalBody, !!data.cached);
        renderMeta(modalMeta, metaSeen, '');
      } else if (event === 'chunk') {
        if (!dom) dom = setupResultDom(modalBody, false);
        const t = data?.text || '';
        if (!t) {
          console.warn('[AI/SSE] chunk had no text payload:', data);
          continue;
        }
        chunkCount++;
        buffered += t;
        // Re-render incrementally. innerHTML is fine here — we're
        // markdown-formatting a string we control.
        if (dom.contentEl) {
          dom.contentEl.innerHTML = formatAnalysis(buffered);
        } else {
          console.error('[AI/SSE] contentEl missing — DOM was not set up before first chunk!');
        }
      } else if (event === 'error') {
        console.error('[AI/SSE] error event:', data);
        renderError(modalBody, modalMeta, data, data.upstream_status || 502);
        return;
      } else if (event === 'done') {
        if (dom?.toplineEl) {
          dom.toplineEl.innerHTML = data.cached
            ? '<span class="ai-cache-badge" title="Odpověď z cache">⚡ CACHED</span>'
            : '<span class="ai-fresh-badge" title="Vygenerováno právě teď">🟢 FRESH</span>';
        }
        renderMeta(modalMeta, { ...(metaSeen || {}), ...data, cached: !!data.cached });
      }
    }
    console.log(`[AI/SSE] stream closed. chunks=${chunkCount} buffered=${buffered.length}`);

    // Frontend safety net: if the stream closed without ever painting
    // text (extreme edge case where backend safety brake also misfires),
    // surface a clear error rather than leaving the user with a blank
    // modal and a green "FRESH" badge.
    if (chunkCount === 0 && !buffered) {
      renderError(modalBody, modalMeta, {
        error: 'Stream produced no text chunks',
        detail: 'Backend safety brake also returned empty. Zkuste to znovu.',
      }, 502);
    }
  } catch (err) {
    console.error('[AI] stream failed:', err);
    renderError(modalBody, modalMeta, err.payload || { error: err.message }, err.status || 0);
  }
}

// ── Public: market briefing ──

export async function requestBriefing(symbols) {
  if (!Array.isArray(symbols) || !symbols.length) {
    console.warn('[BRIEFING] No symbols provided');
    return;
  }
  openBriefingModal();

  const accessToken = await getAccessToken();
  if (!accessToken) {
    renderError(briefingBody, briefingMeta, { error: 'No active session' }, 401);
    return;
  }

  let dom = null;
  let buffered = '';
  let metaSeen = null;

  try {
    const it = sseFetch(BRIEFING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ symbols, lang: document.documentElement.lang || 'cs' }),
    });

    let chunkCount = 0;
    for await (const { event, data } of it) {
      console.log('[BRIEFING/SSE] event:', event, 'data:', data);

      if (event === 'meta') {
        metaSeen = { ...(metaSeen || {}), ...data };
        if (!dom) dom = setupResultDom(briefingBody, !!data.cached);
        renderMeta(briefingMeta, metaSeen);
      } else if (event === 'chunk') {
        if (!dom) dom = setupResultDom(briefingBody, false);
        const t = data?.text || '';
        if (!t) {
          console.warn('[BRIEFING/SSE] chunk had no text payload:', data);
          continue;
        }
        chunkCount++;
        buffered += t;
        if (dom.contentEl) {
          dom.contentEl.innerHTML = formatAnalysis(buffered);
        } else {
          console.error('[BRIEFING/SSE] contentEl missing!');
        }
      } else if (event === 'error') {
        console.error('[BRIEFING/SSE] error event:', data);
        renderError(briefingBody, briefingMeta, data, data.upstream_status || 502);
        return;
      } else if (event === 'done') {
        if (dom?.toplineEl) {
          dom.toplineEl.innerHTML = data.cached
            ? '<span class="ai-cache-badge">⚡ CACHED</span>'
            : '<span class="ai-fresh-badge">🟢 FRESH</span>';
        }
        renderMeta(briefingMeta, { ...(metaSeen || {}), ...data, cached: !!data.cached });
      }
    }
    console.log(`[BRIEFING/SSE] stream closed. chunks=${chunkCount} buffered=${buffered.length}`);

    if (chunkCount === 0 && !buffered) {
      renderError(briefingBody, briefingMeta, {
        error: 'Briefing stream produced no text chunks',
        detail: 'Backend safety brake also returned empty. Zkuste to znovu.',
      }, 502);
    }
  } catch (err) {
    console.error('[BRIEFING] stream failed:', err);
    renderError(briefingBody, briefingMeta, err.payload || { error: err.message }, err.status || 0);
  }
}

// ── Wire up ──

closeButtons.forEach((btn) => btn.addEventListener('click', closeModal));
briefingCloseButtons.forEach((btn) => btn.addEventListener('click', closeBriefingModal));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modal && !modal.hidden) closeModal();
  if (briefingModal && !briefingModal.hidden) closeBriefingModal();
});

// Global handler so a stream-side throw can never bubble to a
// blank console — surface it instead.
window.addEventListener('unhandledrejection', (e) => {
  console.warn('[AI] unhandled rejection:', e.reason);
});

// ─────────────────────────────────────────────────────────────
// V4 Premium: global Market Briefing
//
// Atomic JSON (not SSE) — backend caches the whole response for
// 45 minutes globally, so streaming gives no UX win and complicates
// the cache layer. Instead we just JSON-decode and paint once.
//
// V4.1 hardening — backend NEVER throws "AI selhala" anymore. On a
// Gemini 429 it serves either:
//   • a stale cached briefing (cache_layer = redis-stale / memory-stale)
//   • a synthetic raw-data snapshot (cache_layer = snapshot)
// Either way we get a 200 with degraded payload — UI just shows a
// soft banner. Hard errors only happen on auth (401) or no-source
// (502 with no cache anywhere).
// ─────────────────────────────────────────────────────────────

function fmtAge(ageSec) {
  if (!Number.isFinite(ageSec) || ageSec < 0) return '?';
  if (ageSec < 60) return ageSec + 's';
  if (ageSec < 3600) return Math.round(ageSec / 60) + ' min';
  if (ageSec < 86400) return Math.round(ageSec / 3600) + ' h';
  return Math.round(ageSec / 86400) + ' d';
}

function renderBriefingTopline(m) {
  // Decide the badge from cache_layer (server-authoritative) — falls
  // back to `cached` for older payloads.
  const layer = m.cache_layer || (m.cached ? 'cache' : 'live');
  if (layer === 'snapshot') {
    return '<span class="ai-fresh-badge ai-fresh-badge--streaming" title="Briefing se právě generuje, zatím vidíš čistá data">⏳ GENERATING…</span>';
  }
  if (layer === 'redis-stale' || layer === 'memory-stale') {
    const age = m.stale_age_seconds != null ? fmtAge(m.stale_age_seconds) : 'old';
    return `<span class="ai-stale-badge" title="Stará verze briefingu — Gemini je momentálně přetížen">📦 STALE · ${age}</span>`;
  }
  if (m.cached) {
    return `<span class="ai-cache-badge" title="Sdílená cache (${layer}) — neúčtuje se Gemini call">⚡ CACHED · ${layer}</span>`;
  }
  return '<span class="ai-fresh-badge" title="Vygenerováno právě teď, 45 min cache">🟢 FRESH</span>';
}

function renderBriefingBanner(m) {
  const layer = m.cache_layer;
  const reason = m.fallback_reason;

  // Synthetic raw-data snapshot — AI commentary unavailable.
  if (layer === 'snapshot') {
    const why = reason === 'gemini-rate-limited'
      ? 'Gemini je momentálně rate-limited.'
      : 'AI engine je dočasně nedostupný.';
    return `
      <div class="briefing-notice briefing-notice--warn">
        <span class="briefing-notice__icon">⏳</span>
        <div class="briefing-notice__body">
          <div class="briefing-notice__title">Briefing se generuje, prosím čekej…</div>
          <div class="briefing-notice__sub">${escapeText(why)} Zatím zobrazujeme čistá tržní data (top gainers / losers / volume) bez AI komentáře. Zkus to znovu za pár minut.</div>
        </div>
      </div>
    `;
  }

  // Stale cache — older successful briefing.
  if (layer === 'redis-stale' || layer === 'memory-stale') {
    const age = m.stale_age_seconds != null ? fmtAge(m.stale_age_seconds) : 'starší';
    const why = reason === 'gemini-rate-limited'
      ? 'Gemini je momentálně rate-limited (vysoký provoz).'
      : reason === 'source-fetch-failed'
        ? 'Zdrojová data (CoinGecko) jsou dočasně nedostupná.'
        : 'AI engine je dočasně nedostupný.';
    return `
      <div class="briefing-notice briefing-notice--info">
        <span class="briefing-notice__icon">📦</span>
        <div class="briefing-notice__body">
          <div class="briefing-notice__title">Používáme cachovaná data kvůli vysoké poptávce</div>
          <div class="briefing-notice__sub">${escapeText(why)} Zobrazujeme poslední úspěšný briefing (stáří: ${age}). Čerstvý briefing vygenerujeme automaticky až se Gemini rozblokuje.</div>
        </div>
      </div>
    `;
  }

  return '';
}

export async function requestMarketBriefing(opts = {}) {
  const { force = false, target } = opts;
  const contentEl = target?.contentEl || document.getElementById('mkt-briefing-content');
  const toplineEl = target?.toplineEl || document.getElementById('mkt-briefing-topline');
  const footerEl = target?.footerEl || document.getElementById('mkt-briefing-footer');
  const subEl = document.getElementById('mkt-briefing-sub');
  const metaInlineEl = document.getElementById('mkt-briefing-meta-inline');

  if (!contentEl) {
    console.warn('[MKT-BRIEFING] No content target found');
    return;
  }

  // Loading state
  contentEl.innerHTML = `
    <div class="ai-loading">
      <div class="ai-loading__spinner"></div>
      <p class="ai-loading__text">Skládám Market Briefing…</p>
      <p class="ai-loading__sub">Top 100 coinů + CryptoPanic news → Gemini (Macro / Meta / Opportunities).</p>
    </div>
  `;
  if (toplineEl) toplineEl.innerHTML = '<span class="ai-fresh-badge ai-fresh-badge--streaming">🟢 GENERATING…</span>';
  if (footerEl) footerEl.textContent = '';
  if (metaInlineEl) metaInlineEl.textContent = '';

  const accessToken = await getAccessToken();
  if (!accessToken) {
    renderError(contentEl, footerEl, { error: 'No active session' }, 401);
    return;
  }

  // Soft-degradation banner shown when JSON parse OR UI render fails.
  // Keeps the panel populated rather than letting the user stare at a
  // blank screen or a crashed console error.
  const degradedBanner = (subtitle) => `
    <div class="briefing-notice briefing-notice--warn">
      <span class="briefing-notice__icon">⚠️</span>
      <div class="briefing-notice__body">
        <div class="briefing-notice__title">Market data degraded</div>
        <div class="briefing-notice__sub">${escapeText(subtitle || 'Briefing response was malformed. Zkus to znovu za chvíli.')}</div>
      </div>
    </div>
  `;

  try {
    const res = await fetch(MKT_BRIEFING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        lang: document.documentElement.lang || 'cs',
        force: !!force,
      }),
    });

    // RESILIENT PARSE: any malformed JSON (truncated body, HTML error
    // page from a CDN, empty response) falls through to a degraded
    // banner rather than throwing into the outer catch.
    let payload = null;
    let rawBody = '';
    try {
      rawBody = await res.text();
      payload = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error('[MKT-BRIEFING] JSON parse failed:', parseErr);
      const rawText = String(rawBody || '').replace(/<[^>]*>/g, '').trim();
      if (rawText) {
        contentEl.innerHTML = degradedBanner('Server returned text instead of JSON; rendering the response body.') + formatAnalysis(rawText);
        if (toplineEl) toplineEl.innerHTML = '<span class="ai-stale-badge">DEGRADED</span>';
        return;
      }
      contentEl.innerHTML = degradedBanner('Server vrátil neplatnou odpověď. Zkus to za chvíli.');
      if (toplineEl) toplineEl.innerHTML = '<span class="ai-stale-badge">⚠️ DEGRADED</span>';
      return;
    }

    if (!res.ok) {
      renderError(contentEl, footerEl, payload || { error: `HTTP ${res.status}` }, res.status);
      if (toplineEl) toplineEl.innerHTML = '';
      return;
    }

    // RESILIENT RENDER: the backend now always returns a degraded
    // payload on Gemini failures, but a shape mismatch (e.g. payload
    // is null, analysis is non-string, meta is missing) must not crash
    // the UI. Wrap everything that touches payload in a try/catch.
    try {
      if (!payload || typeof payload !== 'object') {
        throw new Error('payload is not an object');
      }
      let text = extractBriefingText(payload);
      const m = (payload.meta && typeof payload.meta === 'object') ? payload.meta : {};
      if (!text && (m.cache_layer === 'degraded' || payload.error || payload.detail)) {
        text = [
          '## MARKET BRIEFING',
          '',
          String(payload.detail || payload.error || 'Market data is temporarily degraded.'),
        ].join('\n');
      }

      const banner = renderBriefingBanner(m);
      contentEl.innerHTML = banner + formatAnalysis(text);

      if (toplineEl) {
        toplineEl.innerHTML = renderBriefingTopline(m);
      }
      if (footerEl) {
        const parts = [];
        if (m.model) parts.push(`Model: ${m.model}`);
        if (m.top_100_count) parts.push(`Top: ${m.top_100_count}`);
        if (m.news_count != null) parts.push(`News: ${m.news_count}`);
        if (m.latency_ms) parts.push(`Gen: ${m.latency_ms}ms`);
        if (m.total_latency_ms) parts.push(`Total: ${m.total_latency_ms}ms`);
        if (m.cache_ttl_seconds && !m.cached) parts.push(`TTL: ${Math.round(m.cache_ttl_seconds / 60)} min`);
        footerEl.textContent = parts.join(' │ ');
      }
      if (metaInlineEl) {
        const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('cs-CZ') : '';
        metaInlineEl.textContent = m.cached
          ? `cached · ${ts}`
          : `fresh · ${ts}`;
      }
      if (subEl && text) {
        if (m.cache_layer === 'snapshot' || m.cache_layer === 'degraded') {
          subEl.textContent = '⏳ Briefing se generuje — zobrazena degradovaná data';
        } else if (m.cache_layer === 'redis-stale' || m.cache_layer === 'memory-stale') {
          const age = m.stale_age_seconds != null ? fmtAge(m.stale_age_seconds) : 'starší';
          subEl.textContent = `📦 Cached briefing (stáří ${age}) — Gemini momentálně přetížen`;
        } else if (m.cached) {
          subEl.textContent = 'Cached briefing — klikni ↻ pro vynucenou obnovu';
        } else {
          subEl.textContent = 'Fresh briefing — držíme 45 min v cache';
        }
      }
    } catch (renderErr) {
      console.error('[MKT-BRIEFING] render failed:', renderErr, 'payload:', payload);
      contentEl.innerHTML = degradedBanner('Briefing data má neočekávaný formát. Zkus to za chvíli.');
      if (toplineEl) toplineEl.innerHTML = '<span class="ai-stale-badge">⚠️ DEGRADED</span>';
    }
  } catch (err) {
    console.error('[MKT-BRIEFING] fetch failed:', err);
    contentEl.innerHTML = degradedBanner(err?.message || 'Síťová chyba — zkus to za chvíli.');
    if (toplineEl) toplineEl.innerHTML = '<span class="ai-stale-badge">⚠️ DEGRADED</span>';
  }
}

window.requestAnalysis = requestAnalysis;
window.requestBriefing = requestBriefing;
window.requestMarketBriefing = requestMarketBriefing;
window.closeAiModal = closeModal;
window.closeBriefingModal = closeBriefingModal;
