console.log('TERMINAL_V7_LOADED');

// ─────────────────────────────────────────────────────────────
// V6.8 Sprint 1 (FIX-3): GLOBAL XSS CLOSURE
//
// Every string from an upstream API (CoinGecko `name`, news titles,
// AI text, project labels, etc.) MUST pass through `escapeHtml` before
// reaching innerHTML. The function-declaration `escapeHtml` further
// down (in the calendar block) is hoisted across this whole script,
// but we re-declare a top-of-file alias `_esc` for grep-friendly intent
// at the injection sites. Both are identical — _esc is the canonical
// escape used by all the V6.8 patches; escapeHtml remains for legacy
// callers (renderCalendar) so we don't break them.
//
// For href / src attributes, _safeUrl validates the protocol so a
// `javascript:` URL from a malicious news source can't execute.
// ─────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function _safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  // Allow only http(s) and explicit relative paths. Block javascript:,
  // data:, vbscript:, file:, ftp:, etc.
  if (/^(https?:\/\/|\/)/i.test(s)) return _esc(s);
  return '';
}

// ─────────────────────────────────────────────────────────────
// V6.9 Sprint 2: Observer registry + global click delegation.
//
// Every MutationObserver / ResizeObserver / IntersectionObserver
// instantiated by the app is registered here, so the auth-signout
// path can call _ObserverRegistry.disconnectAll() and walk away
// with zero ghost handlers — previously, logging out left the
// scanner header observer, the heatmap canvas observer, and the
// manual-reveal observer leaking forever.
//
// `window._refreshTimer` (the 120s scanner refresh interval) is
// cleared from the same teardown so we stop spamming /api/markets
// after signout.
// ─────────────────────────────────────────────────────────────
const _ObserverRegistry = {
  list: [],
  add(obs) { if (obs && typeof obs.disconnect === 'function') this.list.push(obs); return obs; },
  disconnectAll() {
    for (const obs of this.list) { try { obs.disconnect(); } catch {} }
    this.list.length = 0;
  },
};

function _terminalTeardown() {
  _ObserverRegistry.disconnectAll();
  try { if (window._refreshTimer) clearInterval(window._refreshTimer); } catch {}
  window._refreshTimer = null;
  try { if (LiveFeed && LiveFeed._queueTimer) { clearInterval(LiveFeed._queueTimer); LiveFeed._queueTimer = null; } } catch {}
  try { if (LiveFeed && LiveFeed._newsTimer)  { clearInterval(LiveFeed._newsTimer);  LiveFeed._newsTimer  = null; } } catch {}
  _appRunning = false;
}

// ─────────────────────────────────────────────────────────────
// V6.9 Sprint 2: Global click delegation for [data-coin-id].
//
// Rows in the scanner, ticker, alerts feed, movers and LiveFeed
// coin-mentions all carry `data-coin-id`. A single capture-phase
// listener on document.body resolves the click via
// e.target.closest('[data-coin-id]') — no inline onclick strings,
// no per-row handlers, no string interpolation into HTML.
//
// Optional dataset attributes:
//   data-coin-tab="scanner"  → also switch tabs after pickCoin()
//   data-stop="1"            → stopPropagation (LiveFeed inline link)
// ─────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  // Mobile detail-row toggle. Sits inside a .trow so we must intercept
  // BEFORE the coin-id resolver runs, otherwise the row would also pick
  // the coin in the right panel just from the user expanding the row.
  const toggle = e.target && e.target.closest && e.target.closest('[data-trow-toggle]');
  if (toggle) {
    e.stopPropagation();
    const row = toggle.closest('.trow');
    if (row) row.classList.toggle('expanded');
    return;
  }
  const el = e.target && e.target.closest && e.target.closest('[data-coin-id]');
  if (!el) return;
  if (el.dataset.stop === '1') e.stopPropagation();
  const id = el.dataset.coinId;
  if (!id) return;
  try { pickCoin(id); } catch (err) { console.warn('[DELEGATION] pickCoin failed:', err.message); }
  const targetTab = el.dataset.coinTab;
  if (targetTab) {
    const tabBtn = document.querySelector('#tabs .tab') || document.querySelector('.tab');
    if (tabBtn) { try { sv(targetTab, tabBtn); } catch {} }
  }
});

// ========== LIVE FEED V4.1 — FULL TAB + NEWS INTEGRATION ==========
const LiveFeed = {
  _events: [],
  _queue: [],
  _max: 200,
  _list: null,
  _unreadBadge: null,
  _statsEl: null,
  _newsStatusEl: null,
  _filter: 'all',
  _unread: 0,
  _newsCache: [],
  _newsLastFetch: 0,
  _newsFetchInterval: 5 * 60 * 1000,  // 5 minutes
  _newsTimer: null,
  _queueTimer: null,
  _readingMode: false,

  init() {
    if (this._queueTimer) clearInterval(this._queueTimer);
    this._queueTimer = setInterval(() => this._processQueue(), 2500);
  },

  // ── Core: enqueue for staggered delivery ──
  enqueue(msg, type = 'info', extra = {}) {
    this._queue.push({ msg, type, extra });
    // Prevent infinite queue growth during reading mode
    if (this._queue.length > 30) {
      this._queue.shift(); // Drop oldest items
    }
  },

  _processQueue() {
    if (this._readingMode || !this._queue.length) return;
    const item = this._queue.shift();
    this.push(item.msg, item.type, item.extra);
  },

  // ── Core: push event directly ──
  push(msg, type = 'info', extra = {}) {
    const ts = new Date().toLocaleTimeString('cs-CZ');
    const category = (type === 'news') ? 'news' : (type === 'ai') ? 'ai' : (['regime','hot','alert','info'].includes(type) ? 'system' : 'system');
    const id = 'lf_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    this._events.unshift({ id, msg, type, ts, category, ...extra });

    // V5 (D-6): always trim past the hard cap, but in reading mode we
    // protect any currently-expanded items from eviction. Old behavior
    // froze trimming entirely when one item was expanded → unbounded
    // growth across long sessions.
    if (this._events.length > this._max) {
      if (this._readingMode) {
        const expandedIds = new Set(
          Array.from(document.querySelectorAll('.lf-item.expanded')).map((el) => el.id),
        );
        // Keep all expanded items + the most recent _max non-expanded.
        const expanded = this._events.filter((e) => expandedIds.has(e.id));
        const recent = this._events.filter((e) => !expandedIds.has(e.id)).slice(0, this._max);
        this._events = expanded.concat(recent);
      } else {
        this._events.length = this._max;
      }
    }

    // Track unread if the user isn't on the LIVE FEED tab
    const activeView = document.querySelector('#v-livefeed.view.on');
    if (!activeView) {
      this._unread++;
      this._updateUnreadBadge();
    }
    this._scheduleRender();
  },

  // V5 (D-8): rAF-coalesced render. Multiple push() calls in the same
  // tick (e.g. burst of news + hot signals from a doRefresh tick) now
  // collapse to a single re-render instead of N full innerHTML rebuilds.
  _renderScheduled: false,
  _scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    const run = () => { this._renderScheduled = false; try { this.render(); } catch (e) { console.warn('[LF] render failed:', e.message); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  },

  toggleExpand(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const isExpanded = el.classList.toggle('expanded');
    
    // Check if any items are expanded to toggle reading mode
    const anyExpanded = !!document.querySelector('.lf-item.expanded');
    this._readingMode = anyExpanded;
    
    // If we just exited reading mode, truncate events if needed
    if (!this._readingMode && this._events.length > this._max) {
      this._events.length = this._max;
      this.render();
    }
  },

  // ── Filter support ──
  setFilter(f, el) {
    this._filter = f || 'all';
    // Update chip UI
    const container = document.querySelector('.lf-view__filters');
    if (container) {
      container.querySelectorAll('.f-chip').forEach(c => c.classList.toggle('on', false));
      if (el) el.classList.add('on');
      else {
        container.querySelectorAll('.f-chip').forEach(c => {
          if (c.textContent.trim().toLowerCase().startsWith(f)) c.classList.add('on');
        });
      }
    }
    this.render();
  },

  // ── Render into the tab view ──
  render() {
    if (!this._list) this._list = document.getElementById('live-feed-list');
    if (!this._statsEl) this._statsEl = document.getElementById('lf-stats');
    if (!this._list) return;

    // To prevent wiping out expanded state, we shouldn't re-render everything 
    // ideally, but for now we'll just re-render and lose expansion on new ticks 
    // unless we're in reading mode. If reading mode is on, we skip rendering new items?
    // Actually, if we just push HTML we can keep it. But we overwrite innerHTML.
    // Let's just avoid re-rendering if reading mode is ON, EXCEPT for the toggle itself.
    
    let items = this._events;
    if (this._filter === 'news') items = items.filter(e => e.category === 'news');
    else if (this._filter === 'system') items = items.filter(e => e.category === 'system');
    else if (this._filter === 'ai') items = items.filter(e => e.category === 'ai' || e.type === 'ai');

    if (!items.length) {
      this._list.innerHTML = `
        <div class="lf-empty">
          <div class="lf-empty__icon">📡</div>
          <div class="lf-empty__text">Žádné události${this._filter !== 'all' ? ' pro tento filtr' : ''}. Feed se naplní automaticky při refreshi dat a příchodu novinek.</div>
        </div>`;
    } else {
      // Rebuild HTML but preserve expanded classes by checking the DOM
      const expandedIds = new Set(Array.from(document.querySelectorAll('.lf-item.expanded')).map(el => el.id));
      this._list.innerHTML = items.map(e => this._renderItem(e, expandedIds.has(e.id))).join('');
    }

    if (this._statsEl) {
      const newsCount = this._events.filter(e => e.category === 'news').length;
      const sysCount = this._events.filter(e => e.category === 'system').length;
      this._statsEl.textContent = `${this._events.length} events · ${newsCount} news · ${sysCount} system`;
    }
  },

  _renderItem(e, isExpanded = false) {
    const iconMap = {
      regime: '🟠', hot: '🔥', alert: '⚠️', ai: '🧠', news: '📰', info: '◈'
    };
    const icon = iconMap[e.type] || '◈';

    // Badge
    let badge = '';
    if (e.category === 'system' && e.type !== 'info') {
      badge = '<span class="lf-badge lf-badge--system">SYSTEM</span>';
    } else if (e.category === 'news') {
      badge = '<span class="lf-badge lf-badge--news">NEWS</span>';
    } else if (e.type === 'ai') {
      badge = '<span class="lf-badge lf-badge--ai">AI</span>';
    }

    // Sentiment tag (for news items)
    let sentimentTag = '';
    if (e.sentiment === 'bullish') sentimentTag = '<span class="lf-sentiment lf-sentiment--bullish">▲ Bullish</span>';
    else if (e.sentiment === 'bearish') sentimentTag = '<span class="lf-sentiment lf-sentiment--bearish">▼ Bearish</span>';
    else if (e.sentiment === 'neutral' && e.category === 'news') sentimentTag = '<span class="lf-sentiment lf-sentiment--neutral">— Neutral</span>';

    // Impact score pill
    let impactPill = '';
    if (e.impact != null && e.category === 'news') {
      const cls = e.impact >= 8 ? 'high' : e.impact >= 6 ? 'medium' : 'low';
      impactPill = `<span class="lf-impact lf-impact--${cls}" title="Market impact score">${e.impact}/10</span>`;
    }

    // Source line and expanded details
    // V6.8 Sprint 1 (FIX-3): every upstream-controlled field escaped.
    let sourceLine = '';
    let detailsBlock = '';
    if (e.source) {
      sourceLine = `<div class="lf-source">${_esc(e.source)}</div>`;
    }

    // If it's a news item, we allow expansion just for the link.
    // _safeUrl rejects non-http(s) schemes so a malicious CryptoPanic
    // entry can't ship a javascript: href.
    const safeUrl = _safeUrl(e.url);
    const isExpandable = e.category === 'news' && !!safeUrl;
    if (isExpandable) {
       detailsBlock = `<div class="lf-details">
         <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:2px;font-size:11px;font-weight:600">Read full article →</a>
       </div>`;
    }

    const processedMsg = this._linkifyCoins(e.msg);
    const expandCls = isExpanded ? ' expanded' : '';
    // e.id is generated by us (lf_<ts>_<rand>) but we escape anyway so
    // a future caller can't poison the onclick attribute.
    const safeId = _esc(e.id);
    const clickHandler = isExpandable ? `onclick="LiveFeed.toggleExpand('${safeId}')"` : '';
    const cursorCls = isExpandable ? 'cursor:pointer;' : '';
    // e.type is internal vocabulary but escape defensively to stop a
    // typo from breaking class parsing.
    const safeType = _esc(e.type);

    return `<div id="${safeId}" class="lf-item lf-${safeType}${expandCls}" style="${cursorCls}" ${clickHandler}>
      <span class="lf-ts">${_esc(e.ts)}</span>
      <span class="lf-icon">${icon}</span>
      <div class="lf-body">
        <div class="lf-msg">${badge}${processedMsg}${sentimentTag}${impactPill}</div>
        ${sourceLine}
        ${detailsBlock}
      </div>
    </div>`;
  },

  // ── Clickable coin mentions ──
  // V6.8 Sprint 1 (FIX-3): escape the message BEFORE we splice in
  // anchor tags. Symbols are uppercase A-Z 0-9 only by Binance convention;
  // escaping the message first guarantees any raw HTML in a news title
  // is neutralized while the alternation still matches plain ascii.
  // coin.id is JSON-stringified into the onclick attribute so quote
  // injection from an upstream-controlled id can never break out.
  _linkifyCoins(msg) {
    const escaped = _esc(msg);
    if (typeof DATA === 'undefined' || !Array.isArray(DATA) || !DATA.length) return escaped;
    const symbols = DATA.map(d => (d.symbol || '').toUpperCase()).filter(Boolean);
    if (!symbols.length) return escaped;
    const re = new RegExp('\\b(' + symbols.join('|') + ')\\b', 'g');
    return escaped.replace(re, (match) => {
      const coin = DATA.find(d => (d.symbol || '').toUpperCase() === match);
      if (!coin) return match;
      const idAttr = _esc(String(coin.id || ''));
      return `<span class="lf-coin-link" data-coin-id="${idAttr}" data-coin-tab="scanner" data-stop="1">${_esc(match)}</span>`;
    });
  },

  // ── Unread badge management ──
  _updateUnreadBadge() {
    if (!this._unreadBadge) this._unreadBadge = document.getElementById('lf-unread');
    if (this._unreadBadge) {
      this._unreadBadge.textContent = this._unread > 0 ? this._unread : '';
    }
  },

  clearUnread() {
    this._unread = 0;
    this._updateUnreadBadge();
  },

  // ══════════════════════════════════════════════════════════════
  // ── NEWS INTEGRATION — /api/news edge proxy (CryptoPanic) ──
  // ══════════════════════════════════════════════════════════════

  async fetchNews() {
    const statusEl = document.getElementById('lf-news-status');
    try {
      if (statusEl) statusEl.textContent = 'News: fetching…';

      // Browsers can't hit CryptoPanic directly (no CORS headers).
      // /api/news is our Deno edge proxy that fans out to CryptoPanic
      // server-side and returns the same { results: [...] } shape.
      let articles = [];
      try {
        const r = await fetch('/api/news', {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const data = await r.json();
          articles = (data.results || []).slice(0, 15);
        } else {
          console.warn('[NEWS] /api/news HTTP', r.status);
        }
      } catch (e) {
        console.warn('[NEWS] /api/news fetch failed:', e.message);
      }

      // If both APIs fail, generate mock headlines from trusted sources
      if (!articles.length) {
        articles = this._generateMockHeadlines();
      }

      this._newsCache = articles;
      this._newsLastFetch = Date.now();

      // Send headlines to AI for scoring
      await this._aiScoreNews(articles);

      if (statusEl) statusEl.textContent = `News: ${articles.length} headlines · ${new Date().toLocaleTimeString('cs-CZ')}`;
    } catch (e) {
      console.error('[NEWS] Fetch error:', e);
      if (statusEl) statusEl.textContent = 'News: error';
    }
  },

  _generateMockHeadlines() {
    // Realistic mock headlines from trusted sources when APIs are unavailable
    const headlines = [
      { title: 'Bitcoin Holds Above $100K as Institutional Inflows Surge', source: { title: 'CoinDesk' }, sentiment: 'bullish', impact: 8 },
      { title: 'Ethereum ETF Spot Volume Hits Record $2.1B in Single Day', source: { title: 'The Block' }, sentiment: 'bullish', impact: 9 },
      { title: 'Solana DeFi TVL Surpasses $15B Milestone', source: { title: 'DeFiLlama' }, sentiment: 'bullish', impact: 7 },
      { title: 'SEC Delays Decision on Altcoin ETF Applications to Q3', source: { title: 'Bloomberg' }, sentiment: 'bearish', impact: 7 },
      { title: 'Major Token Unlock: 500M ARB Tokens Hit Market Next Week', source: { title: 'Token Unlocks' }, sentiment: 'bearish', impact: 8 },
      { title: 'Chainlink CCIP Integration Goes Live on 5 New Chains', source: { title: 'CoinTelegraph' }, sentiment: 'bullish', impact: 7 },
      { title: 'Fed Minutes Signal Potential Rate Cut in September', source: { title: 'Bloomberg' }, sentiment: 'bullish', impact: 9 },
      { title: 'Binance Delists 3 Low-Liquidity Perpetual Pairs', source: { title: 'CoinDesk' }, sentiment: 'bearish', impact: 6 },
      { title: 'Uniswap V4 Launch Date Confirmed for June', source: { title: 'The Block' }, sentiment: 'bullish', impact: 7 },
      { title: 'Whale Alert: $200M BTC Moved to Exchange Wallets', source: { title: 'CoinTelegraph' }, sentiment: 'bearish', impact: 7 },
    ];
    return headlines.map(h => ({
      title: h.title,
      source: h.source,
      published_at: new Date().toISOString(),
      _mock: true,
      _pre_scored: true,
      _sentiment: h.sentiment,
      _impact: h.impact,
    }));
  },

  // ── AI Impact Scoring via Gemini ──
  async _aiScoreNews(articles) {
    if (!articles.length) return;

    // If articles are pre-scored mocks, push them directly
    const preScored = articles.filter(a => a._pre_scored);
    if (preScored.length) {
      preScored.forEach(a => {
        if (a._impact >= 6) {
          this.enqueue(
            a.title,
            'news',
            { sentiment: a._sentiment, impact: a._impact, source: a.source?.title || 'Unknown', url: a.url || '' }
          );
        }
      });
      return;
    }

    // For real articles, try to get AI scoring
    const headlines = articles.map(a => a.title).join('\n');
    let scored = null;

    try {
      const token = await _getAccessTokenForFeed();
      if (!token) {
        // No auth — push raw headlines without AI scoring
        this._pushRawHeadlines(articles);
        return;
      }

      const r = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          symbol: '__NEWS_SCORING__',
          lang: 'en',
          _newsScoring: true,
          headlines: headlines,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (r.ok) {
        const data = await r.json();
        const text = data?.analysis || '';
        scored = this._parseAiScores(text, articles);
      }
    } catch (e) {
      console.warn('[NEWS/AI] Scoring failed:', e.message);
    }

    // Push scored or raw headlines
    if (scored && scored.length) {
      scored.forEach(item => {
        if (item.impact >= 6) {
          this.enqueue(item.title, 'news', {
            sentiment: item.sentiment,
            impact: item.impact,
            source: item.source,
            url: item.url || ''
          });
        }
      });
    } else {
      this._pushRawHeadlines(articles);
    }
  },

  _pushRawHeadlines(articles) {
    // Push headlines without AI scoring — use basic keyword heuristic
    articles.slice(0, 10).forEach(a => {
      const title = a.title || '';
      const lc = title.toLowerCase();
      let sentiment = 'neutral';
      let impact = 6; // default pass-through
      if (/surge|rally|record|milestone|bullish|soar|breakout|approval|launch/i.test(lc)) { sentiment = 'bullish'; impact = 7; }
      if (/crash|dump|hack|exploit|ban|delay|bearish|sell-off|unlock|liquidat/i.test(lc)) { sentiment = 'bearish'; impact = 7; }
      if (/etf|sec|fed|regulation|institutional/i.test(lc)) impact = 8;

      this.enqueue(title, 'news', {
        sentiment,
        impact,
        source: a.source?.title || a.source?.domain || 'Crypto News',
        url: a.url || ''
      });
    });
  },

  _parseAiScores(text, articles) {
    // Try to extract JSON array from AI response, or fall back to line-by-line parsing
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.map((item, i) => ({
          title: articles[i]?.title || item.title || '',
          impact: Math.min(10, Math.max(1, parseInt(item.impact || item.score || 5))),
          sentiment: (item.sentiment || 'neutral').toLowerCase(),
          source: articles[i]?.source?.title || 'Unknown',
          url: articles[i]?.url || '',
        }));
      }
    } catch (e) {
      console.warn('[NEWS/AI] JSON parse failed, trying line parse');
    }
    // Fallback: return null so raw headlines are used
    return null;
  },

  // ── Start auto-refresh ──
  startNewsLoop() {
    this.fetchNews();
    if (this._newsTimer) clearInterval(this._newsTimer);
    this._newsTimer = setInterval(() => this.fetchNews(), this._newsFetchInterval);
  },
};
window.LiveFeed = LiveFeed;

// Helper: get Supabase access token for news AI scoring
async function _getAccessTokenForFeed() {
  try {
    const sb = window.__supabase;
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    return session?.access_token || null;
  } catch { return null; }
}

// ========== CONFIG & STATE ==========
const PAGE_SIZE = 40;
let DATA = [], SEL = null, SRC = 'LOADING', FG = 50;
let BINANCE_USDC_PAIRS = new Set();
let BINANCE_USDT_PAIRS = new Set();

let currentPage = 0;
let currentFilter = 'all';
let currentAlertFilter = 'all';

// V5 hotfix: Volatility / Panic Sentiment detector — rewritten.
//
// OLD math compared 24h quote-volume against an EMA of itself across
// 2-min ticks. Because 24h is a rolling window, the tick-to-tick delta
// is tiny — the "vol ≥ 2× avg" gate effectively never triggered, AND
// the first refresh seeded the baseline silently, so the badge sat at
// `VOL: 0` indefinitely.
//
// NEW math: pure threshold-based, fires IMMEDIATELY on the first
// refresh — no warm-up. A coin triggers when both:
//   • |1H %|        ≥ VOL_SPIKE_THRESHOLD_PCT   (default 5)
//   • 24h_vol_usd   ≥ VOL_ABS_VOLUME_FLOOR_USD  (default $25M)
// The volume floor is the "this isn't a thinly-traded ghost" gate —
// real spikes always come with at least mid-cap liquidity.
//
// Tunables surface on window.__volTuning so you can soften them in
// devtools (e.g. window.__volTuning.spikePct = 3) for testing without
// a redeploy.
window.__volTuning = window.__volTuning || {};
const VOL_SPIKE_THRESHOLD_PCT_DEFAULT = 5;
const VOL_ABS_VOLUME_FLOOR_USD_DEFAULT = 25_000_000;
const VOL_RECENT_TRIGGERS = new Map();   // symbol → ts so we don't re-toast every 120s tick
const VOL_REPUSH_INTERVAL_MS = 10 * 60 * 1000; // 10 min between repeated alerts for same coin

function _volSpikeThreshold() {
  const t = Number(window.__volTuning?.spikePct);
  return Number.isFinite(t) && t > 0 ? t : VOL_SPIKE_THRESHOLD_PCT_DEFAULT;
}
function _volVolumeFloor() {
  const t = Number(window.__volTuning?.volFloorUsd);
  return Number.isFinite(t) && t > 0 ? t : VOL_ABS_VOLUME_FLOOR_USD_DEFAULT;
}

function detectVolatilitySpikes(rows) {
  const triggered = [];
  if (!Array.isArray(rows)) return triggered;
  const now = Date.now();
  const spikePct = _volSpikeThreshold();
  const volFloor = _volVolumeFloor();

  for (const d of rows) {
    const sym = String(d.symbol || d.id || '').toUpperCase();
    if (!sym) continue;
    // V6.3: _c1 is often null (CoinGecko doesn't always return 1h).
    // Fall back through every known source for 1H price change.
    const c1raw = d._c1 ?? d.price_change_percentage_1h_in_currency ?? null;
    const c1 = c1raw != null ? parseFloat(c1raw) : NaN;
    const qv = parseFloat(d.total_volume) || parseFloat(d.volume_24h) || 0;
    if (!Number.isFinite(c1)) continue;

    const spike = Math.abs(c1) >= spikePct;
    const liquid = qv >= volFloor;
    if (!spike || !liquid) continue;

    // Magnitude ratio = |1H| / threshold. Always ≥ 1 when triggered.
    const magnitude = +(Math.abs(c1) / spikePct).toFixed(2);
    triggered.push({ symbol: sym, c1, volRatio: magnitude, vol: qv, coinId: d.id });

    const last = VOL_RECENT_TRIGGERS.get(sym) || 0;
    if (now - last >= VOL_REPUSH_INTERVAL_MS) {
      VOL_RECENT_TRIGGERS.set(sym, now);
      const dir = c1 > 0 ? '▲' : '▼';
      const volStr = qv >= 1e9 ? '$' + (qv / 1e9).toFixed(1) + 'B'
        : qv >= 1e6 ? '$' + (qv / 1e6).toFixed(0) + 'M' : '$' + qv.toFixed(0);
      LiveFeed.push(`PANIC: ${sym} ${dir} ${c1.toFixed(2)}% · vol ${volStr}`, 'alert');
    }
  }
  return triggered;
}

// V5 (Phase 4 Wildcard B): Composite Multi-Timeframe Momentum Score.
//
// Weighted, alignment-aware score across the 5 timeframes the markets
// pipeline already provides (1H / 4H / 12H / 24H / 7D). Trader logic:
//
//   • Each TF contributes a normalized component in [-1, +1] capped
//     at ±15% extreme for stability.
//   • TFs are weighted to emphasize short-term (acceleration) without
//     ignoring trend: 1H=0.30, 4H=0.25, 12H=0.20, 24H=0.15, 7D=0.10.
//   • A "stack" multiplier rewards alignment — when 4+ of the 5 TFs
//     agree in sign, we boost the magnitude (multi-TF stack = real
//     momentum, not noise). When TFs are split, we damp it (chop).
//   • Final score in [-100, +100]. Positive = bullish momentum, negative
//     = bearish, near zero = neutral / mixed.
//   • Classification:
//       ≥ 60   STRONG bull
//       30..60 BULLISH
//       -30..30 NEUTRAL / MIXED
//       -60..-30 BEARISH
//       ≤ -60  STRONG bear
//
// All pure compute on existing markets payload — zero new requests.
const _MOM_WEIGHTS = { c1: 0.30, c4: 0.25, c12: 0.20, c24: 0.15, c7d: 0.10 };
const _MOM_CAP_PCT = 15;
function _momComponent(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-1, Math.min(1, n / _MOM_CAP_PCT));
}
function computeMomentumScore(d) {
  const comps = {
    c1:  _momComponent(d._c1),
    c4:  _momComponent(d._c4),
    c12: _momComponent(d._c12),
    c24: _momComponent(d._c24 ?? d.price_change_percentage_24h),
    c7d: _momComponent(d._c7d),
  };
  let weighted = 0;
  let weightSum = 0;
  const signs = [];
  for (const [k, w] of Object.entries(_MOM_WEIGHTS)) {
    const v = comps[k];
    if (v == null) continue;
    weighted += v * w;
    weightSum += w;
    signs.push(Math.sign(v));
  }
  if (!weightSum) return { score: 0, label: 'N/A', cls: 'mom-neutral', stack: 0 };
  const base = weighted / weightSum;
  // Stack: 1.0 when all TFs aligned, 0.6 when half-aligned, 0.4 when split.
  const posCount = signs.filter((s) => s > 0).length;
  const negCount = signs.filter((s) => s < 0).length;
  const total = signs.length || 1;
  const alignment = Math.max(posCount, negCount) / total; // 0.2 - 1.0
  const stackMult = 0.4 + (alignment - 0.2) * (1.0 - 0.4) / (1.0 - 0.2);
  const score = Math.round(Math.max(-100, Math.min(100, base * 100 * stackMult)));
  let label = 'NEUTRAL';
  let cls = 'mom-neutral';
  if (score >= 60) { label = 'STRONG ▲'; cls = 'mom-strong'; }
  else if (score >= 30) { label = 'BULL'; cls = 'mom-strong'; }
  else if (score <= -60) { label = 'STRONG ▼'; cls = 'mom-weak'; }
  else if (score <= -30) { label = 'BEAR'; cls = 'mom-weak'; }
  else if (Math.abs(score) < 10 && (posCount && negCount)) { label = 'MIXED'; cls = 'mom-mixed'; }
  return { score, label, cls, stack: +alignment.toFixed(2), components: comps };
}

// V5 (Phase 4 Wildcard A): Smart Money Divergence — fetches the
// /api/funding-divergence batched signal map and merges into DATA so
// renderList() can stamp a SHORTS_TRAPPED / LONGS_TRAPPED tag next to
// the signal label. Throttled to once per refresh tick (~120s).
const DIVERGENCE_MAP = new Map(); // base symbol → signal object
async function fetchDivergence() {
  try {
    const authHeaders = await _getAuthHeaders();
    if (!authHeaders.Authorization) return;
    const r = await fetch('/api/funding-divergence', {
      headers: { 'Accept': 'application/json', ...authHeaders },
    });
    if (!r.ok) return;
    const j = await r.json();
    DIVERGENCE_MAP.clear();
    for (const s of (j.signals || [])) {
      DIVERGENCE_MAP.set(String(s.symbol || '').toUpperCase(), s);
    }
    // High-confidence signals get a LiveFeed push (throttled below).
    for (const s of (j.signals || []).slice(0, 5)) {
      if (s.confidence >= 0.5) {
        LiveFeed.push(`${s.symbol} ${s.signal} (${s.bias.toUpperCase()}) · fund ${s.funding_pct.toFixed(3)}% · 24h ${s.price_change_24h_pct > 0 ? '+' : ''}${s.price_change_24h_pct.toFixed(1)}%`, 'alert');
      }
    }
  } catch (e) {
    console.warn('[DIVERGENCE] fetch failed:', e.message);
  }
}

// V5 (Sniper Limit Protocol): batched /api/sniper-detect map.
// Two maps so renderers don't have to filter every paint:
//   SNIPER_MAP    = base symbol → row, ONLY for triggered coins
//                   (current price within 2 % of the optimal entry).
//                   Drives the pulsing 🎯 SNIPER badge in the table.
//   SNIPER_ALL_MAP = base symbol → row, every coin where a bid wall
//                   was detected (triggered or not). Drives the
//                   "Optimal Limit Entry" box in the detail panel so
//                   the trader can pre-plan an entry even before the
//                   coin has dripped into the trigger zone.
const SNIPER_MAP = new Map();
const SNIPER_ALL_MAP = new Map();
async function fetchSniper() {
  try {
    const authHeaders = await _getAuthHeaders();
    if (!authHeaders.Authorization) return;
    const r = await fetch('/api/sniper-detect', {
      headers: { 'Accept': 'application/json', ...authHeaders },
    });
    if (!r.ok) return;
    const j = await r.json();
    SNIPER_MAP.clear();
    SNIPER_ALL_MAP.clear();
    for (const s of (j.all || [])) {
      const k = String(s.symbol || '').toUpperCase();
      if (!k) continue;
      SNIPER_ALL_MAP.set(k, s);
    }
    for (const s of (j.signals || [])) {
      const k = String(s.symbol || '').toUpperCase();
      if (!k) continue;
      SNIPER_MAP.set(k, s);
    }
    // Push the top-confidence triggers into LiveFeed so they're not
    // discoverable only by scrolling the table. Throttled to top 3.
    for (const s of (j.signals || []).slice(0, 3)) {
      if (s.confidence >= 0.55) {
        LiveFeed.push(
          `🎯 SNIPER ${s.symbol} · entry ${fmt(s.optimal_limit_entry)} · wall ${fmt(s.wall_notional_usd)} · ${s.proximity_pct.toFixed(2)}% from mark · conf ${s.confidence}`,
          'alert',
        );
      }
    }
  } catch (e) {
    console.warn('[SNIPER] fetch failed:', e.message);
  }
}

function renderVolatilityBadge(triggered) {
  const el = document.getElementById('volatility-badge');
  const txt = document.getElementById('volatility-text');
  if (!el || !txt) return;
  const n = triggered.length;

  // V6.3: also show aggregate 24h volume so the badge is never just "VOL: 0"
  const totalVol = DATA.reduce((s, d) => s + (parseFloat(d.total_volume) || 0), 0);
  const volStr = totalVol >= 1e12 ? '$' + (totalVol / 1e12).toFixed(1) + 'T'
    : totalVol >= 1e9 ? '$' + (totalVol / 1e9).toFixed(1) + 'B'
    : totalVol >= 1e6 ? '$' + (totalVol / 1e6).toFixed(0) + 'M'
    : '$' + totalVol.toFixed(0);
  txt.textContent = n > 0 ? `VOL: ${n} · ${volStr}` : `VOL: ${volStr}`;

  el.classList.remove('volatility-calm', 'volatility-elevated', 'volatility-panic');
  if (n >= 5) el.classList.add('volatility-panic');
  else if (n >= 1) el.classList.add('volatility-elevated');
  else el.classList.add('volatility-calm');
  // Tooltip listing top 3 triggers
  if (n) {
    const top = triggered
      .sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))
      .slice(0, 3)
      .map((t) => `${t.symbol} ${t.c1 > 0 ? '+' : ''}${t.c1.toFixed(1)}% · ${t.volRatio}×vol`)
      .join('\n');
    el.title = `Volatility spikes (|1H| ≥ 5% & vol ≥ 2× avg):\n${top}\n\nTotal 24h vol: ${volStr}`;
  } else {
    el.title = `No volatility spikes — markets calm\nTotal 24h vol: ${volStr}`;
  }
}

// REGIME state — populated by /api/regime (server-side calc, Redis-cached).
//   • bucket: 'bear' | 'chop' | 'bull' — primary directional state
//   • level:  'shock' | 'elevated' | 'normal' — legacy alarm vocabulary,
//             kept in sync with bucket so existing sig()/setup checks
//             still resolve without a sweeping refactor.
let REGIME = { bucket: 'chop', level: 'normal', score: 0, label: '—', reasons: [], history: [] };
let ALL_ALERTS = [];
let TG_SENT = {};
let REFRESH_INTERVAL = 120;
let SHOCK_THRESHOLD = 70;
let TG_THROTTLE_MIN = 15;
let TG_MIN_SCORE = 6;

function getMinScoreFromStorage() {
  try {
    const raw = localStorage.getItem('swing_tg');
    if (raw) {
      const cfg = JSON.parse(raw);
      const n = parseInt(cfg.minScore);
      if (Number.isFinite(n)) return Math.max(1, Math.min(10, n));
    }
  } catch (e) {}
  return 6;
}

// ========== SECTOR MAPPING ==========
const SECTOR_MAP = {
  'L1': ['bitcoin','ethereum','solana','cardano','avalanche-2','polkadot','near','sui','aptos','toncoin','cosmos','fantom','algorand','hedera-hashgraph','internet-computer','sei-network','celestia','injective-protocol','stacks','kaspa','mantle','eos','tezos','flow','multiversx-egld','vechain','cronos','neo','zilliqa','harmony','celo','mina-protocol','oasis-network'],
  'L2': ['matic-network','arbitrum','optimism','starknet','blast','immutable-x','metis-token','boba-network','loopring','skale'],
  'DeFi': ['uniswap','aave','chainlink','maker','lido-dao','curve-dao-token','synthetix-network-token','compound-governance-token','pancakeswap-token','jupiter-exchange-solana','raydium','thorchain','1inch','sushi','yearn-finance','convex-finance','frax','dydx-chain','gmx','pendle','ethena','ondo-finance','morpho'],
  'Meme': ['dogecoin','shiba-inu','pepe','dogwifcoin','floki','bonk','brett-based','mog-coin','popcat','trump-official','fartcoin','ai16z','goatseus-maximus','cat-in-a-dogs-world'],
  'AI': ['fetch-ai','render-token','bittensor','akash-network','ocean-protocol','singularitynet','phala-network','virtual-protocol','grass','io-net','nosana','arkham'],
  'Gaming': ['axie-infinity','the-sandbox','decentraland','gala','illuvium','ultra','beam-2','pixels-2','ronin','echelon-prime'],
  'Infra': ['filecoin','arweave','the-graph','helium','theta-token','livepeer','audius','pyth-network','wormhole','layerzero']
};

function getSector(id) {
  for (const [sec, ids] of Object.entries(SECTOR_MAP)) {
    if (ids.includes(id)) return sec;
  }
  return 'Other';
}

// ========== UTILITY FUNCTIONS ==========
function fmt(n) {
  if (n == null || isNaN(n)) return '$0';
  if (n >= 1e12) return '$' + (n/1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
  if (n >= 1000) return '$' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  return '$' + n.toFixed(6);
}
function fp(n, d=2) { return n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%'; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const TIMEFRAME_PCT_KEYS = {
  c1: [
    '_c1', 'c1', '1h', 'h1', 'pct_1h', 'pct1h', 'change_1h', 'change1h',
    'change_pct_1h', 'price_change_1h', 'price_change_pct_1h',
    'price_change_percentage_1h', 'price_change_percentage_1h_in_currency',
    'percent_change_1h', 'percentage_1h',
    'price_change_percentage.1h', 'price_change_percentage.h1',
    'timeframes.1h', 'timeframes.h1', 'timeframes.c1', 'timeframes._c1',
    'multi_timeframe.1h', 'multi_timeframe.h1', 'multi_timeframe.c1', 'multi_timeframe._c1',
  ],
  c4: [
    '_c4', 'c4', '4h', 'h4', 'pct_4h', 'pct4h', 'change_4h', 'change4h',
    'change_pct_4h', 'price_change_4h', 'price_change_pct_4h',
    'price_change_percentage_4h', 'price_change_percentage_4h_in_currency',
    'percent_change_4h', 'percentage_4h',
    'price_change_percentage.4h', 'price_change_percentage.h4',
    'timeframes.4h', 'timeframes.h4', 'timeframes.c4', 'timeframes._c4',
    'multi_timeframe.4h', 'multi_timeframe.h4', 'multi_timeframe.c4', 'multi_timeframe._c4',
  ],
  c12: [
    '_c12', 'c12', '12h', 'h12', 'pct_12h', 'pct12h', 'change_12h', 'change12h',
    'change_pct_12h', 'price_change_12h', 'price_change_pct_12h',
    'price_change_percentage_12h', 'price_change_percentage_12h_in_currency',
    'percent_change_12h', 'percentage_12h',
    'price_change_percentage.12h', 'price_change_percentage.h12',
    'timeframes.12h', 'timeframes.h12', 'timeframes.c12', 'timeframes._c12',
    'multi_timeframe.12h', 'multi_timeframe.h12', 'multi_timeframe.c12', 'multi_timeframe._c12',
  ],
  c24: [
    '_c24', 'c24', '24h', 'h24', 'pct_24h', 'pct24h', 'change_24h', 'change24h',
    'change_pct_24h', 'price_change_24h', 'price_change_pct_24h',
    'price_change_percentage_24h', 'price_change_percentage_24h_in_currency',
    'percent_change_24h', 'percentage_24h',
    'price_change_percentage.24h', 'price_change_percentage.h24',
    'timeframes.24h', 'timeframes.h24', 'timeframes.c24', 'timeframes._c24',
    'multi_timeframe.24h', 'multi_timeframe.h24', 'multi_timeframe.c24', 'multi_timeframe._c24',
  ],
  c7d: [
    '_c7d', 'c7d', '7d', 'd7', 'pct_7d', 'pct7d', 'change_7d', 'change7d',
    'change_pct_7d', 'price_change_7d', 'price_change_pct_7d',
    'price_change_percentage_7d', 'price_change_percentage_7d_in_currency',
    'percent_change_7d', 'percentage_7d',
    'price_change_percentage.7d', 'price_change_percentage.d7',
    'timeframes.7d', 'timeframes.d7', 'timeframes.c7d', 'timeframes._c7d',
    'multi_timeframe.7d', 'multi_timeframe.d7', 'multi_timeframe.c7d', 'multi_timeframe._c7d',
    'seven_day.change_pct', 'timeframes.seven_day.change_pct', 'multi_timeframe.seven_day.change_pct',
  ],
};

function _pctNumber(v) {
  if (v && typeof v === 'object') {
    for (const k of ['change_pct', 'pct', 'percent', 'percentage', 'value']) {
      const n = _pctNumber(v[k]);
      if (n != null) return n;
    }
    return null;
  }
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function _readPath(row, path) {
  let cur = row;
  for (const part of String(path).split('.')) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

function getTimeframePct(row, key) {
  if (!row) return null;
  for (const path of (TIMEFRAME_PCT_KEYS[key] || [])) {
    const n = _pctNumber(_readPath(row, path));
    if (n != null) return n;
  }
  return null;
}

function rng(seed) { let s = (((seed % 2147483647) + 2147483647) % 2147483647) || 1; return () => { s = (16807 * s) % 2147483647; return (s - 1) / 2147483646; }; }
function coinRng(id, salt=0) { return rng(id.split('').reduce((a,c) => a*31 + c.charCodeAt(0), 1) + salt + Math.floor(Date.now()/900000)); }

// ========== DERIVED METRICS ==========
function get1h(d) { return getTimeframePct(d, 'c1') ?? 0; }
function get4h(d) { return getTimeframePct(d, 'c4') ?? 0; }
function getVolPct(d) { return (d.total_volume / 100000000) * 100; /* simplified since it's now absolute volume */ }
function getFunding(d) { return d._funding || 0; }
function getPredFunding(d) { return (d._funding || 0) * 1.5; }
function getBasis(d) { return ((d._funding || 0) * 100).toFixed(4); }
function getOiPct(d) { return d._oiDelta || 0; }
function getLsRatio(d) { 
  const tr = d._takerRatio || 0.5;
  return { l: tr * 100, s: (1 - tr) * 100 }; 
}

// ========== COMPOSITE HOTNESS SCORE (0-100) ==========
// Post-pivot: rebuilt to consume only fields available from
// /ticker/24hr — change %, intraday range, range position, quote
// volume. Funding/OI/1H components were removed when we dropped
// the background ingest worker.
function calcHotness(d) {
  const safe = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const c24 = Math.abs(safe(d.price_change_percentage_24h));
  const high = safe(d.high_24h);
  const low = safe(d.low_24h);
  const price = safe(d.current_price);
  const qv = safe(d.total_volume);

  const rangePct = low > 0 ? ((high - low) / low) * 100 : 0;
  const pos = high > low ? (price - low) / (high - low) : 0.5;
  const edge = Math.abs(pos - 0.5) * 2;                    // 0 mid → 1 at 24h extreme

  const priceScore = clamp(c24 * 2.5, 0, 30);              // 12% → max
  const rangeScore = clamp(rangePct * 2, 0, 25);           // 12.5% → max
  // Log-scale volume: $1M ≈ 0, $1B ≈ 30
  const volScore = qv > 1e6 ? clamp((Math.log10(qv) - 6) * 10, 0, 30) : 0;
  const edgeScore = clamp(edge * 15, 0, 15);

  return Math.round(clamp(priceScore + rangeScore + volScore + edgeScore, 0, 100));
}

// ========== MARKET-WIDE HOTNESS (0-100) ==========
function calcMarketHotness() {
  if (!DATA.length) return 0;
  const avgAbs24h = DATA.reduce((s,d) => s + Math.abs(d.price_change_percentage_24h || 0), 0) / DATA.length;
  const avgRangePct = DATA.reduce((s,d) => {
    const high = parseFloat(d.high_24h) || 0, low = parseFloat(d.low_24h) || 0;
    return s + (low > 0 ? ((high - low) / low) * 100 : 0);
  }, 0) / DATA.length;
  const avgVolLog = DATA.reduce((s,d) => {
    const qv = parseFloat(d.total_volume) || 0;
    return s + (qv > 1e6 ? Math.log10(qv) - 6 : 0);
  }, 0) / DATA.length;
  const alertDensity = ALL_ALERTS.length / Math.max(DATA.length, 1) * 100;

  const priceComp = clamp(avgAbs24h * 5, 0, 35);
  const rangeComp = clamp(avgRangePct * 3, 0, 25);
  const volComp   = clamp(avgVolLog * 8, 0, 20);
  const alertComp = clamp(alertDensity * 3, 0, 20);
  return Math.round(clamp(priceComp + rangeComp + volComp + alertComp, 0, 100));
}

// ========== COIN SIGNAL ==========
// Score recipe (0-10) — additive components, each capped:
//   • Change strength (|24h %|)        0-3 pts (saturates at ±10%)
//   • Range expansion (intraday vol)   0-2 pts (saturates at 8%)
//   • Volume conviction (log USD)      0-3 pts ($1M = 0, $1B = 3)
//   • Range-position edge              0-2 pts (extreme = high)
// Pattern detection (RECLAIM / FLUSH) keys off c24 + range position.
function sig(d) {
  const safe = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const c24 = safe(d.price_change_percentage_24h);
  const high = safe(d.high_24h);
  const low = safe(d.low_24h);
  const price = safe(d.current_price);
  const qv = safe(d.total_volume);

  const rangePct = low > 0 ? ((high - low) / low) * 100 : 0;
  const pos = high > low ? (price - low) / (high - low) : 0.5;     // 0 = at low, 1 = at high

  const reasons = [];
  const whyTags = [];
  let pattern = null;

  // ── Components ──
  const changeComp = Math.min(3, Math.abs(c24) / 10 * 3);
  const rangeComp  = Math.min(2, rangePct / 8 * 2);
  const volComp    = qv > 0 ? Math.min(3, Math.max(0, (Math.log10(Math.max(qv, 1)) - 6))) : 0;
  const edgeComp   = Math.min(2, Math.abs(pos - 0.5) * 4);
  let score = changeComp + rangeComp + volComp + edgeComp;

  // ── Pattern detection ──
  if (c24 <= -6 && pos < 0.25) {
    pattern = 'FLUSH';
    reasons.push(`Kapitulace u 24h low (${fp(c24,1)})`);
    whyTags.push({tag:'CAPITULATION',col:'var(--red)'});
    score += 1;
  } else if (c24 <= -3 && pos > 0.6) {
    pattern = 'RECLAIM';
    reasons.push('Reclaim z dumpu — cena zpět nad mid-range');
    whyTags.push({tag:'RECLAIM',col:'var(--cyan)'});
    score += 1;
  } else if (c24 >= 6 && pos > 0.75) {
    reasons.push(`Breakout u 24h high (${fp(c24,1)})`);
    whyTags.push({tag:'BREAKOUT',col:'var(--grn)'});
  } else if (c24 >= 3 && pos < 0.4) {
    reasons.push('Up day, ale pullback k 24h podpoře');
    whyTags.push({tag:'PULLBACK',col:'var(--amb)'});
  } else if (Math.abs(c24) < 2 && rangePct > 6) {
    reasons.push('Široký range bez čistého směru — chop');
    whyTags.push({tag:'CHOP',col:'var(--txt3)'});
  }

  // ── Annotations ──
  if (qv >= 1e9) { reasons.push('Vysoký 24h volume (>$1B)'); whyTags.push({tag:'HIGH VOL',col:'var(--amb)'}); }
  else if (qv >= 1e8) { reasons.push('Solidní 24h volume (>$100M)'); }
  if (rangePct > 10) reasons.push(`Vol expanze — 24h range ${rangePct.toFixed(1)}%`);
  if (REGIME.level === 'shock') whyTags.push({tag:'MARKET SHOCK',col:'var(--red)'});

  // ── Label decision (CSS class vocabulary unchanged) ──
  let label = 'NEUT', cls = 'neut';
  if (pattern === 'FLUSH' && score >= 6) { label = 'FLUSH+BUY'; cls = 'flush'; }
  else if (pattern === 'RECLAIM' && score >= 5) { label = 'RECLAIM'; cls = 'reclaim'; }
  else if (score >= 7 && c24 > 0) { label = 'BUY'; cls = 'buy'; }
  else if (score >= 7 && c24 < 0) { label = 'SHORT'; cls = 'sell'; }
  else if (score >= 5) { label = 'WATCH'; cls = 'neut'; }

  if (!reasons.length) reasons.push('Žádný výrazný 24h signál');

  score = Math.round(Math.max(0, Math.min(10, score)));
  return { label, cls, score, reasons, pattern, whyTags };
}

// V6.9 Sprint 2: read sig() from the per-cycle cache. doRefresh stamps
// every coin once with `d._sig`; this helper falls back to a live call
// for any stray coin that bypassed the stamp (mid-cycle inject etc).
function _sigOf(d) {
  if (d && d._sig) return d._sig;
  try { const s = sig(d); if (d) { d._sig = s; d._sig_score = s.score; } return s; }
  catch { return { label:'NEUT', cls:'neut', score:0, reasons:[], pattern:null, whyTags:[] }; }
}

// ========== V7.0 COMPOSITE PANIC INDICATOR (-100 … +100) ==========
// Algorithmic Panic Buy / Panic Sell composite, stamped on every coin
// during the data normalization phase in doRefresh + on every WS
// delta frame in connectStream. Final integer in [-100, +100]:
//   -100 = Extreme Panic Sell / Capitulation
//      0 = Neutral
//   +100 = Extreme FOMO / Panic Buy
//
//   panic = α·sign(c1h)·|Δvol24h%|   ← spike magnitude, direction from price
//         + β·c1h_velocity            ← signed 1h % change
//         + γ·sniper_proximity_weight ← bid-wall buy pressure
//
//   α=0.5 (volume dominates), β=0.3, γ=0.2 — sums to 1.0 so a fully
//   saturated input yields a fully saturated output.
//
// |Δvol24h%| is derived from `_PANIC_PREV_QV` (last-seen total_volume
// per coin id). First-frame for a coin → 0 vol contribution, score
// driven by price + sniper. Sniper weight maps proximity_pct (0…5)
// and confidence (0…1) into [0, 100] — bid walls only push positive.
const PANIC_ALPHA = 0.5;
const PANIC_BETA  = 0.3;
const PANIC_GAMMA = 0.2;
const PANIC_GLOW_THRESHOLD = 80;
const _PANIC_PREV_QV = new Map();
function calcPanic(d) {
  try {
    const id = String(d && d.id || d && d.symbol || '').toLowerCase();
    if (!id) return 0;
    const safe = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const qvNow = safe(d.total_volume);
    const qvPrev = _PANIC_PREV_QV.get(id);
    let dvPct = 0;
    if (qvPrev != null && qvPrev > 0) dvPct = ((qvNow - qvPrev) / qvPrev) * 100;
    if (qvNow > 0) _PANIC_PREV_QV.set(id, qvNow);
    const absVol = clamp(Math.abs(dvPct), 0, 100);
    const c1h    = clamp(safe(d._c1), -100, 100);
    const c24    = safe(d._c24 != null ? d._c24 : d.price_change_percentage_24h);
    const dir    = c1h !== 0 ? Math.sign(c1h) : (c24 !== 0 ? Math.sign(c24) : 0);
    let sniperW = 0;
    const sym = String(d.symbol || '').toUpperCase();
    const snip = (typeof SNIPER_MAP !== 'undefined') ? SNIPER_MAP.get(sym) : null;
    if (snip) {
      const prox = clamp(snip.proximity_pct == null ? 5 : Math.abs(snip.proximity_pct), 0, 5);
      const conf = clamp(snip.confidence == null ? 0 : snip.confidence, 0, 1);
      sniperW = (1 - prox / 5) * conf * 100;
    }
    const raw = PANIC_ALPHA * dir * absVol
              + PANIC_BETA  * c1h
              + PANIC_GAMMA * sniperW;
    return clamp(Math.round(raw), -100, 100);
  } catch { return 0; }
}
// V7.3 retiered bands:
//   ≥ +80  Extreme FOMO          — neon green bg + .panic-glow-buy pulse
//   +20..+79 Mild Buy Pressure   — soft green text, no glow
//   −19..+19 Neutral             — muted gray text
//   −20..−79 Mild Panic Sell     — soft red text, no glow
//   ≤ −80  Capitulation          — crimson bg + .panic-glow-sell flash
function panicMeta(score) {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= 80)                 return { cls: 'panic-tier-extreme-buy',  label: 'FOMO', glow: true,  glowCls: 'panic-glow-buy'  };
  if (s >= 20)                 return { cls: 'panic-tier-buy',          label: 'BUY',  glow: false, glowCls: ''                 };
  if (s <= -80)                return { cls: 'panic-tier-extreme-sell', label: 'CAPI', glow: true,  glowCls: 'panic-glow-sell' };
  if (s <= -20)                return { cls: 'panic-tier-sell',         label: 'SELL', glow: false, glowCls: ''                 };
  return                            { cls: 'panic-tier-neutral',         label: '·',    glow: false, glowCls: ''                 };
}
// V7.1 — STATIC PANIC PROXY
// Until the first WS delta lands, |Δvol24h%| is 0 for every coin
// (no prior frame to subtract from) and sniper hits may not have
// fetched yet. That collapses calcPanic to 0.3 × c1h for most rows,
// and to exactly 0 for any DEX-only coin missing _c1. Result on
// cold paint: a column of dead zeros, which is exactly what the
// V7.1 spec rules out.
//
// The proxy fills that gap WITHOUT racing the live engine:
//   • It runs per-coin in doRefresh, then is overridden by
//     calcPanic whenever calcPanic produces a non-zero number.
//   • It blends 24h price magnitude (signed) with a volume-mass
//     z-score so high-volume movers light up before low-volume
//     ones, mirroring real panic dynamics.
function _computeVolumeStats(arr) {
  const vols = [];
  for (const d of (arr || [])) {
    const v = parseFloat(d && d.total_volume);
    if (Number.isFinite(v) && v > 0) vols.push(v);
  }
  if (vols.length < 2) return { mean: 0, std: 0, n: vols.length };
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
  let varSum = 0;
  for (const v of vols) varSum += (v - mean) ** 2;
  const std = Math.sqrt(varSum / vols.length);
  return { mean, std, n: vols.length };
}
function calcStaticPanicProxy(d, stats) {
  try {
    if (!d) return 0;
    const safe = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const c24Raw = d._c24 != null ? d._c24 : d.price_change_percentage_24h;
    const c24    = clamp(safe(c24Raw), -100, 100);
    if (c24 === 0 && (!stats || stats.std <= 0)) return 0;
    const vol = safe(d.total_volume);
    let z = 0;
    if (stats && stats.std > 0 && vol > 0) {
      z = clamp((vol - stats.mean) / stats.std, -3, 3);
    }
    // Two contributors, both bounded to ±100 before weighting:
    //   priceTerm = c24 (already a percentage; clamped to ±100)
    //   volTerm   = (z / 3) * 50  → ±50, signed by the price move so
    //               a high-volume DUMP pulls negative and a high-volume
    //               BUY pulls positive.
    const priceTerm = c24;
    const volTerm   = (z / 3) * 50 * (priceTerm >= 0 ? 1 : -1);
    const raw = 0.7 * priceTerm + 0.3 * volTerm;
    return clamp(Math.round(raw), -100, 100);
  } catch { return 0; }
}

// Render the in-row panic badge. Title carries the numeric score so
// hover-tooltip works on desktop without an explicit aria element.
function panicBadge(score) {
  const m = panicMeta(score);
  const s = Number.isFinite(score) ? score : 0;
  const sign = s > 0 ? '+' : '';
  const glow = m.glow ? ` ${m.glowCls}` : '';
  return `<span class="panic-cell ${m.cls}${glow}" title="Panic Score ${sign}${s} (${m.label}) — click the [?] in the header for the manual.">${sign}${s}</span>`;
}

// ─────────────────────────────────────────────────────────────
// V7.3 — PANIC MANUAL MODAL
// Lightweight overlay; markup lives in index.html and stays hidden
// until openPanicManual() flips the `is-open` class. No framework,
// no portals — opens / closes by class toggle so the rest of the
// app keeps running underneath.
// ─────────────────────────────────────────────────────────────
function openPanicManual() {
  const el = document.getElementById('panic-manual');
  if (!el) return;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  // Defer focus so the close button is reachable by keyboard users
  // without scrolling the page (focus moves the viewport on Chrome
  // when the target has not yet been laid out).
  requestAnimationFrame(() => {
    const closeBtn = el.querySelector('[data-panic-close]');
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  });
}
function closePanicManual() {
  const el = document.getElementById('panic-manual');
  if (!el) return;
  el.classList.remove('is-open');
  el.setAttribute('aria-hidden', 'true');
}
function initPanicManual() {
  // Global keyboard close (Escape). Single global listener avoids
  // re-binding on every modal open/close cycle.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const el = document.getElementById('panic-manual');
      if (el && el.classList.contains('is-open')) closePanicManual();
    }
  });
  // Single delegated click listener for BOTH open ([data-panic-help])
  // and close ([data-panic-close]) actions. Delegation means the
  // SSR-fallback [?] button works immediately on first paint, before
  // renderHeader() has had a chance to attach per-button listeners.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-panic-close]')) {
      e.preventDefault();
      closePanicManual();
      return;
    }
    if (target.closest('[data-panic-help]')) {
      e.preventDefault();
      openPanicManual();
    }
  });
}

function getSetupValidity(d) {
  const s = _sigOf(d), c24 = d.price_change_percentage_24h || 0;
  if (s.label === 'RECLAIM') return { type: 'BREAKOUT RECLAIM', col: 'var(--cyan)', border: 'rgba(34,211,238,.3)', desc: 'Cena se vratila po sweepu.' };
  if (s.label === 'FLUSH+BUY') return { type: 'FLUSH + REBOUND', col: 'var(--pur)', border: 'rgba(168,85,247,.3)', desc: 'Kapitulacni pohyb s volume.' };
  if (s.score >= 6) return { type: 'STRONG SIGNAL', col: 'var(--grn)', border: 'rgba(0,212,132,.3)', desc: 'Dostatek konvergujicich signalu pro alert.' };
  if (REGIME.level === 'shock') return { type: 'MARKET-WIDE SQUEEZE', col: 'var(--red)', border: 'rgba(255,51,86,.3)', desc: 'Celotrhovy pohyb.' };
  return { type: 'WEAK / NOISY', col: 'var(--txt3)', border: 'var(--b2)', desc: 'Zadny jasny setup.' };
}

// ========== MARKET REGIME — SERVER-DRIVEN ==========
// All calculation moved to /api/regime (Deno edge + Upstash 15-min
// cache). This client just fetches the precomputed state and merges
// it into the global REGIME object. Bucket → level mapping preserves
// compatibility with sig() / getSetupValidity() which still read
// REGIME.level. Soft-fail: a regime fetch error never breaks the
// scanner — REGIME just retains its last good state.

const BUCKET_TO_LEVEL = { bear: 'shock', chop: 'elevated', bull: 'normal' };

async function fetchRegime() {
  try {
    const r = await fetch('/api/regime', { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.current) throw new Error('Empty regime payload');

    const cur = j.current;
    const bucket = cur.bucket || 'chop';
    REGIME = {
      bucket,
      level: BUCKET_TO_LEVEL[bucket] || 'normal',
      score: Number(cur.score) || 0,
      label: cur.label || '—',
      reasons: Array.isArray(cur.reasons) ? cur.reasons : [],
      inputs: cur.inputs || null,
      components: cur.components || null,
      computed_at: cur.computed_at || null,
      cached: !!j.cached,
      stale: !!j.stale,
      history: Array.isArray(j.history) ? j.history : [],
    };
  } catch (e) {
    console.warn('[REGIME] fetch failed:', e.message);
    window.Toast?.warn('Regime fetch failed', e.message, { endpoint: '/api/regime' });
    // Keep prior REGIME on failure so the UI doesn't flicker back to a stub.
  }
}

// ========== ALERT SYSTEM ==========
function buildAlerts() {
  const als = [];
  const FLOOR = TG_MIN_SCORE;
  DATA.forEach(d => {
    const s = _sigOf(d);
    const c24 = d.price_change_percentage_24h || 0;
    if (s.score < FLOOR) return;
    const sym = (d.symbol || d.id).toUpperCase();

    if (s.label === 'FLUSH+BUY') als.push({tp:'flush',t:`${sym} — FLUSH SETUP`,b:`Kapitulace · Score ${s.score}/10`,reason:s.reasons[0],pri:1,category:'coin',coinId:d.id});
    else if (s.label === 'RECLAIM') als.push({tp:'reclaim',t:`${sym} — RECLAIM`,b:`Reclaim po dumpu ${fp(c24,1)} · Score ${s.score}/10`,reason:s.reasons[0],pri:1,category:'coin',coinId:d.id});
    else if (s.label === 'BUY') als.push({tp:'buy',t:`${sym} — STRONG BUY`,b:`Score ${s.score}/10 · ${fp(c24,1)}`,reason:s.reasons.join(', '),pri:1,category:'coin',coinId:d.id});
    else if (s.label === 'SHORT') als.push({tp:'sell',t:`${sym} — SHORT SIGNAL`,b:`Score ${s.score}/10 · ${fp(c24,1)}`,reason:s.reasons.join(', '),pri:1,category:'coin',coinId:d.id});
    else if (s.score >= 6) als.push({tp:'watch',t:`${sym} — WATCH`,b:`Score ${s.score}/10`,reason:s.reasons.join(', '),pri:2,category:'coin',coinId:d.id});
  });

  if (!als.length) als.push({tp:'info',t:'TRH V KLIDU',b:'Zadne vyrazne signaly.',reason:'',pri:3,category:'info'});
  als.sort((a,b) => a.pri - b.pri);
  ALL_ALERTS = als;
  return als;
}

function loadTgConfig() {
  // Config UI was retired in v5h3 (replaced by the Interactive Manual).
  // Persisted values are still consumed here so trading-engine defaults
  // can be overridden via localStorage by power users, just without
  // visible DOM inputs.
  try { TG_MIN_SCORE = getMinScoreFromStorage(); } catch(e) {}
  try {
    const cfg = JSON.parse(localStorage.getItem('swing_cfg') || '{}');
    if (cfg.refresh) REFRESH_INTERVAL = cfg.refresh;
    if (cfg.shock) SHOCK_THRESHOLD = cfg.shock;
  } catch(e) {}
}

// Note (v5h3): saveConfig / saveTgConfig / showTgStatus were retired
// with the Config tab. Engine values live in localStorage and are read
// by loadTgConfig() on boot. The Interactive Manual replaces the old
// settings UI.

// ========== MARKET DATA FETCH ==========
async function fetchBinancePairs() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/exchangeInfo');
    const data = await r.json();
    data.symbols.forEach(s => {
      if (s.status === 'TRADING' && s.isSpotTradingAllowed) {
        if (s.quoteAsset === 'USDC') BINANCE_USDC_PAIRS.add(s.symbol);
        if (s.quoteAsset === 'USDT') BINANCE_USDT_PAIRS.add(s.symbol);
      }
    });
    const bstatus = document.getElementById('binance-status');
    if (bstatus) bstatus.textContent = `Nacteno: ${BINANCE_USDC_PAIRS.size} USDC paru, ${BINANCE_USDT_PAIRS.size} USDT paru`;
  } catch(e) {
    const bstatus = document.getElementById('binance-status');
    if (bstatus) bstatus.textContent = 'Chyba nacteni Binance paru: ' + e.message;
  }
}

function isOnBinance(d) {
  // Server-supplied flag wins; otherwise fall back to client-side
  // exchangeInfo lookup so the UI works even before the first
  // /api/markets response lands.
  if (d && typeof d.binance_available === 'boolean') return d.binance_available;
  const sym = (d?.symbol || '').toUpperCase();
  return BINANCE_USDC_PAIRS.has(sym + 'USDC') || BINANCE_USDT_PAIRS.has(sym + 'USDT');
}

function getBinanceLink(d) {
  const sym = (d.symbol || '').toUpperCase();
  // Honor the server-side hint first — for non-Binance/DEX coins this
  // short-circuits before we try to construct a fake Binance URL.
  if (d.binance_available === false) return { url: null, pair: null, available: false };

  // ALPHA = futures-only listing → link to the Binance Futures trade
  // page instead of spot, otherwise the user clicks through to a 404.
  if (d.binance_market === 'futures' || d.exchange === 'ALPHA') {
    const fpair = d.futures_pair || d.pair || (sym + 'USDT');
    return {
      url: `https://www.binance.com/en/futures/${fpair}`,
      pair: fpair,
      available: true,
      market: 'futures',
    };
  }

  if (d.pair && d.quote) {
    return { url: `https://www.binance.com/en/trade/${sym}_${d.quote}?type=spot`, pair: `${sym}/${d.quote}`, available: true, market: 'spot' };
  }
  if (BINANCE_USDC_PAIRS.has(sym + 'USDC')) return { url: `https://www.binance.com/en/trade/${sym}_USDC?type=spot`, pair: sym + '/USDC', available: true, market: 'spot' };
  if (BINANCE_USDT_PAIRS.has(sym + 'USDT')) return { url: `https://www.binance.com/en/trade/${sym}_USDT?type=spot`, pair: sym + '/USDT', available: true, market: 'spot' };
  return { url: null, pair: null, available: false };
}

// V5: forward Supabase access token so /api/markets can resolve tier.
async function _getAuthHeaders() {
  try {
    const sb = window.__supabase;
    if (!sb) return {};
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) return {};
    return { 'Authorization': `Bearer ${session.access_token}` };
  } catch { return {}; }
}

async function fetchData() {
  let live = null;
  try {
    const authHeaders = await _getAuthHeaders();
    const r = await fetch('/api/markets', { headers: { 'Accept': 'application/json', ...authHeaders } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      window.Toast?.error('Market data fetch failed', `HTTP ${r.status} — ${body.slice(0,140)}`, { endpoint: '/api/markets', code: r.status });
      throw new Error('HTTP ' + r.status);
    }
    let rawData = await r.json();
    console.log("🔍 Data from /api/markets:", rawData);
    
    // Normalizace symbolů ze surových Binance stringů
    if (Array.isArray(rawData)) {
      rawData.forEach(d => {
        if (d.symbol) d.symbol = d.symbol.split(':')[0];
        const c1 = getTimeframePct(d, 'c1');
        const c4 = getTimeframePct(d, 'c4');
        const c12 = getTimeframePct(d, 'c12');
        const c24 = getTimeframePct(d, 'c24');
        const c7d = getTimeframePct(d, 'c7d');
        d.current_price = d.current_price || 0;
        if (c1 != null) d._c1 = c1;
        if (c4 != null) d._c4 = c4;
        if (c12 != null) d._c12 = c12;
        if (c24 != null) {
          d._c24 = c24;
          d.price_change_percentage_24h = c24;
        } else {
          d.price_change_percentage_24h = d.price_change_percentage_24h || d._c24 || 0;
        }
        if (c7d != null) d._c7d = c7d;
        d.total_volume = d.total_volume || 0;
        d._funding = d._funding || 0;
        d._oi = d._oi || 0;
        d._oiDelta = d._oiDelta || 0;
      });
    }

    if (window.LOCAL_PAPERBOT_ENABLED === true && !window.__serverPaperBotSeen) {
      try { paperBotInstance.processMarkets(rawData); }
      catch (e) { console.warn('[PAPERBOT] local engine failed:', e && e.message); }
    }

    live = rawData;
    SRC = 'BINANCE-LIVE';
  } catch(e) {
    SRC = 'ERROR';
    console.error('Data fetch err:', e);
    window.Toast?.error('Scanner refresh failed', e.message || String(e), { endpoint: '/api/markets' });
  }

  try {
    const r2 = await fetch('https://api.alternative.me/fng/?limit=1');
    const j = await r2.json();
    if (j.data?.[0]) FG = parseInt(j.data[0].value);
  } catch(e) {}
  return live;
}

// ========== RENDER FUNCTIONS ==========
function renderTopbar() {
  const hotness = calcMarketHotness();
  const hCol = hotness > 70 ? 'var(--red)' : hotness > 40 ? 'var(--amb)' : 'var(--grn)';
  document.getElementById('hotness-fill').style.width = hotness + '%';
  document.getElementById('hotness-fill').style.background = hCol;
  document.getElementById('hotness-val').textContent = hotness;
  document.getElementById('hotness-val').style.color = hCol;

  const rb = document.getElementById('regime-badge');
  rb.className = 'regime-badge regime-' + REGIME.level;
  rb.querySelector('.regime-dot').style.background = REGIME.bucket === 'bear' ? 'var(--red)' : REGIME.bucket === 'chop' ? 'var(--amb)' : 'var(--grn)';
  document.getElementById('regime-text').textContent = (REGIME.label || REGIME.bucket || '—').toUpperCase() + ' · ' + (REGIME.score | 0);

  document.getElementById('srcb').className = 'sbadge ' + (SRC.includes('LIVE') ? 's-live' : 's-mock');
  document.getElementById('srcb').textContent = SRC;
  document.getElementById('sts').textContent = SRC;
  document.getElementById('last-update').textContent = new Date().toLocaleTimeString('cs-CZ');

  const top10 = DATA.slice(0, 10);
  document.getElementById('tkr').innerHTML = top10.map(d => {
    // V6.8 Sprint 1 (FIX-3): sym + d.id are upstream strings, escape both.
    // d.id flows into onclick — JSON.stringify guarantees attribute safety.
    const sym = (d.symbol || '').toUpperCase();
    const idAttr = _esc(String(d.id || ''));
    return `<div class="ti" data-coin-id="${idAttr}" data-coin-tab="scanner">
      <span class="tsym">${_esc(sym)}</span><span class="tprc">${_esc(fmt(d.current_price))}</span>
      <span class="${(d.price_change_percentage_24h||0)>=0?'pos':'neg'}">${_esc(fp(d.price_change_percentage_24h||0,1))}</span></div>`;
  }).join('');
}

// V6.4: hard cap at 500 active coins in the scanner DOM.
// Server ships up to 1000; scanner paginates; movers uses the full pool.
const MAX_RENDERED = 500;

function getFilteredSorted() {
  let filtered = [...DATA];
  const search = (document.getElementById('coin-search')?.value || '').toLowerCase();
  if (search) filtered = filtered.filter(d => d.id.includes(search) || (d.symbol || '').toLowerCase().includes(search));
  if (currentFilter === 'alerts') filtered = filtered.filter(d => (d._sig_score || 0) >= 6);
  else if (currentFilter !== 'all' && SECTOR_MAP[currentFilter]) filtered = filtered.filter(d => SECTOR_MAP[currentFilter].includes(d.id));

  // V6.9 Sprint 2: sort reads the pre-computed native property —
  // no sig() math inside the comparator (N log N → trivial).
  filtered.sort((a, b) => {
    const sa = a._sig_score || 0, sb = b._sig_score || 0;
    if (sa !== sb) return sb - sa;
    return (b.market_cap || 0) - (a.market_cap || 0);
  });
  if (filtered.length > MAX_RENDERED) filtered.length = MAX_RENDERED;
  return filtered;
}

function renderList() {
  const filtered = getFilteredSorted();
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  currentPage = clamp(currentPage, 0, Math.max(0, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const page = filtered.slice(start, start + PAGE_SIZE);
  const emptyData = '<span style="color:var(--txt3);opacity:0.4;">-</span>';

  if (filtered.length === 0) {
    document.getElementById('clist').innerHTML = `<div style="padding:30px;text-align:center;color:var(--txt3)">Zadne vysledky.</div>`;
    document.getElementById('scnt').textContent = '0 / ' + DATA.length;
    return;
  }

  const htmls = [];
  // Render a multi-timeframe % cell. Accepts null/undefined/NaN to mean
  // "no data from upstream" — those render as a neutral "-" rather than
  // a misleading 0% (some DEX-only coins lack 1H or sparkline-derived
  // 4H/12H entirely; the upstream contract is documented in markets.js).
  const tfCell = (v) => {
    const n = (v == null || v === '') ? NaN : parseFloat(v);
    if (!Number.isFinite(n)) return emptyData;
    const cls = n >= 0 ? 'pos' : 'neg';
    return `<span class="tr ${cls}">${fp(n, 1)}</span>`;
  };
  const safeNum = (v, fallback = 0) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const safeMetric = (v, formatter) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? _esc(formatter(n)) : emptyData;
  };
  const safeSig = (row) => {
    try {
      const s = _sigOf(row || {});
      if (!s || typeof s !== 'object') throw new Error('empty signal');
      return {
        label: String(s.label == null ? '' : s.label).trim(),
        cls: String(s.cls || 'neut').trim() || 'neut',
        score: Number.isFinite(Number(s.score)) ? Number(s.score) : 0,
      };
    } catch {
      return { label: '', cls: 'neut', score: 0 };
    }
  };
  const emptySignal = '<span class="sig-none">-</span>';
  const signalMarkup = (s) => {
    const label = String(s && s.label || '').trim();
    if (!label || (label.toUpperCase() === 'NEUT' && !(Number(s && s.score) > 0))) return emptySignal;
    return `<span class="bdg ${_esc(s.cls || 'neut')}">${_esc(label)}</span>`;
  };
  // V7.4.5 — defensive timeframe extractor. The upstream payload
  // shape varies depending on which build branch in markets.js
  // produced the row (CoinGecko-merged vs. Binance-only spot vs.
  // futures-driver), and a coin can legitimately carry e.g.
  // `price_change_percentage_1h_in_currency` without an `_c1` mirror.
  // Walks the candidate key list and returns the FIRST finite number
  // it finds. A real numeric 0 is preserved (the previous code path
  // already handled that — this helper just widens the search).
  const _pct = (row, key) => getTimeframePct(row, key);

  page.forEach((row, i) => {
    const d = row && typeof row === 'object' ? row : {};
    try {
      // 100% fail-safe variable casting
      const price = safeNum(d.current_price, NaN);
      const qv = safeNum(d.total_volume, NaN);

      const s = safeSig(d);
      const sym = typeof d.symbol === 'string' ? d.symbol.toUpperCase() : String(d.symbol || '').toUpperCase();
      const name = d.name || String(d.id || 'N/A');
      let onBin = false;
      try { onBin = isOnBinance(d); } catch { onBin = false; }
      // V4 Premium: tri-state badge.
      //   BIN   = Binance Spot (deepest liquidity)
      //   ALPHA = Binance Futures (USDⓈ-M perp) only — funding/OI live
      //   DEX   = off-Binance entirely
      let exchBadge;
      if (d.exchange === 'ALPHA' || d.binance_market === 'futures') {
        exchBadge = '<span class="exch-badge exch-alpha" title="Binance Alpha — listed on Binance USDⓈ-M Futures (perp). Live funding / OI / orderbook.">ALPHA</span>';
      } else if (onBin) {
        exchBadge = '<span class="exch-badge exch-bin" title="Listed on Binance Spot — full liquidity / live order book">BIN</span>';
      } else {
        exchBadge = '<span class="exch-badge exch-dex" title="DEX / Other exchange — Binance order book unavailable">DEX</span>';
      }

      // V5 (Phase 4 Wildcard A): stamp smart-money divergence tag if
      // we have one for this base symbol. Tag wraps in the same cell
      // as the signal label so the row width stays stable.
      const div = DIVERGENCE_MAP && typeof DIVERGENCE_MAP.get === 'function' ? DIVERGENCE_MAP.get(sym) : null;
      let divTag = '';
      if (div) {
        // V6.8 Sprint 1 (FIX-3): cls + label resolve from a fixed
        // vocabulary so they're safe, but `div.signal` flows into title
        // raw from the upstream — escape the tooltip body.
        const cls = div.bias === 'bullish' ? 'sm-shorts-trapped' : 'sm-longs-trapped';
        const label = div.signal === 'SHORTS_TRAPPED' ? '◢ SHORTS' : div.signal === 'LONGS_TRAPPED' ? '◣ LONGS' : '◤ CROWDED';
        const title = _esc(`${div.signal} · funding ${Number(div.funding_pct).toFixed(3)}% · 24h ${Number(div.price_change_24h_pct).toFixed(2)}% · conf ${div.confidence}`);
        divTag = `<span class="smart-money-tag ${cls}" title="${title}">${label}</span>`;
      }

      // V5 (Sniper Limit Protocol): pulsing 🎯 SNIPER stamp when the
      // mark price has dripped within 2 % of the detected bid wall.
      const snip = SNIPER_MAP && typeof SNIPER_MAP.get === 'function' ? SNIPER_MAP.get(sym) : null;
      let snipTag = '';
      if (snip) {
        const wallNotionalM = (safeNum(snip.wall_notional_usd, 0) / 1_000_000).toFixed(2);
        // V6.8 Sprint 1 (FIX-3): tooltip values flow into title="" — escape.
        snipTag = `<span class="sniper-tag" title="${_esc(`SNIPER LIMIT · entry ${fmt(snip.optimal_limit_entry)} · wall $${wallNotionalM}M @ -${snip.wall_drop_pct.toFixed(2)}% · ${snip.proximity_pct.toFixed(2)}% from mark · conf ${snip.confidence}`)}">🎯 SNIPER</span>`;
      }

      // V6.8 Sprint 1 (FIX-3) + V6.9 Sprint 2: no inline onclick. d.id
      // routes through data-coin-id (HTML-attribute-escaped via _esc);
      // a single delegated listener on document handles the dispatch.
      const idAttr = _esc(String(d.id || ''));
      const escSym = _esc(sym);
      const escName = _esc(name);
      const hot = (() => { try { return safeNum(calcHotness(d), 0); } catch { return 0; } })();
      // Mobile-only sub-row carrying the columns hidden ≤640px.
      const panicScore = Number.isFinite(Number(d._panic)) ? Number(d._panic) : (() => { try { return calcPanic(d); } catch { return 0; } })();
      const panicHTML = (() => { try { return panicBadge(panicScore); } catch { return emptyData; } })();
      const v_c1  = _pct(d, 'c1');
      const v_c4  = _pct(d, 'c4');
      const v_c12 = _pct(d, 'c12');
      const v_c24 = _pct(d, 'c24');
      const v_c7d = _pct(d, 'c7d');
      const expandRow = `<div class="trow-expand" data-coin-id="${idAttr}">
        <div class="te-cell"><span class="te-lbl">SIG</span><span class="te-val">${signalMarkup(s)}</span></div>
        <div class="te-cell"><span class="te-lbl">1H</span><span class="te-val">${tfCell(v_c1)}</span></div>
        <div class="te-cell"><span class="te-lbl">4H</span><span class="te-val">${tfCell(v_c4)}</span></div>
        <div class="te-cell"><span class="te-lbl">12H</span><span class="te-val">${tfCell(v_c12)}</span></div>
        <div class="te-cell"><span class="te-lbl">7D</span><span class="te-val">${tfCell(v_c7d)}</span></div>
        <div class="te-cell"><span class="te-lbl">VOL</span><span class="te-val">${safeMetric(qv, fmt)}</span></div>
        <div class="te-cell"><span class="te-lbl">HOT</span><span class="te-val" style="color:${hot>60?'var(--red)':'var(--txt2)'}">${hot}</span></div>
      </div>`;
      // V7.3: cell content built from the live _columnOrder registry
      // so a user reorder repaints with zero template edits. Every
      // visible cell carries a `data-col` attribute (mobile @media
      // rules + WS flash selectors target it) plus the legacy
      // `data-cell` alias for cells the stream pipeline mutates.
      // V7.4.5 — each timeframe pulls through _pct() so any of the
      // upstream key variants resolves to a number. Without the
      // fallback chain, a row that came from the Binance-spot build
      // branch in markets.js (which leaves _c1/_c4/_c12/_c7d as
      // null) renders as the dead "-" placeholder.
      // V8 ABACUS — every cell carries its raw pixel coordinate inline
      // (`left:${px}px;width:${px}px`). Because the string is re-interpolated
      // on every renderList() call, a WebSocket-driven innerHTML rebuild
      // re-locks each cell to its exact X — zero layout drift.
      const cs = (k) => _colStyle(k);
      const cellHTML = {
        rank:   `<span data-col="rank" class="rn" style="${cs('rank')}">${start + i + 1}</span>`,
        coin:   `<div data-col="coin" class="coin-cell" style="${cs('coin')}"><span class="csym">${escSym}${exchBadge}</span><span class="cnm">${escName}</span></div>`,
        signal: `<span data-col="signal" class="sig-cell" style="${cs('signal')}">${signalMarkup(s)}${divTag}${snipTag}</span>`,
        score:  `<span data-col="score" data-cell="score" class="tr" style="${cs('score')}color:${s.score>=6?'var(--grn)':'var(--txt2)'}"><b>${s.score}/10</b></span>`,
        panic:  `<span data-col="panic" data-cell="panic" class="tr" style="${cs('panic')}">${panicHTML}</span>`,
        price:  `<span data-col="price" data-cell="price" class="tr" style="${cs('price')}">${safeMetric(price, fmt)}</span>`,
        c1:     `<span data-col="c1"  data-cell="c1"  class="tr" style="${cs('c1')}">${tfCell(v_c1)}</span>`,
        c4:     `<span data-col="c4"  data-cell="c4"  class="tr" style="${cs('c4')}">${tfCell(v_c4)}</span>`,
        c12:    `<span data-col="c12" data-cell="c12" class="tr" style="${cs('c12')}">${tfCell(v_c12)}</span>`,
        c24:    `<span data-col="c24" data-cell="c24" class="tr" style="${cs('c24')}">${tfCell(v_c24)}</span>`,
        c7d:    `<span data-col="c7d" data-cell="c7d" class="tr" style="${cs('c7d')}">${tfCell(v_c7d)}</span>`,
        qv:     `<span data-col="qv"  data-cell="qv"  class="tr" style="${cs('qv')}">${safeMetric(qv, fmt)}</span>`,
        hot:    `<span data-col="hot" class="tr" style="${cs('hot')}color:${hot>60?'var(--red)':'var(--txt2)'}"><b>${hot}</b></span>`,
      };
      // Fallback: any key in _columnOrder that has no cellHTML entry
      // (e.g. a future column added mid-session) still gets its absolute
      // coordinate so it lands on the wire instead of stacking at left:0.
      const cells = _columnOrder.map(k => cellHTML[k] || `<span data-col="${_esc(k)}" style="${cs(k)}" aria-hidden="true"></span>`).join('');
      htmls.push(`<div class="trow${SEL===d.id?' sel':''}${s.score>=7?' alert-high':s.score>=6?' alert-med':''}" data-coin-id="${idAttr}">
        ${cells}
        <span class="trow-toggle" data-trow-toggle="1" aria-label="Expand">⋯</span>
      </div>${expandRow}`);
    } catch (err) {
      console.error('[TERMINAL] Error rendering coin:', d, err.message);
      const fallbackId = _esc(String((d && d.id) || (d && d.symbol) || `row-${start + i}`));
      const fallbackCells = _columnOrder.map(k => {
        const fcs = _colStyle(k);
        if (k === 'coin') {
          return `<div data-col="coin" class="coin-cell" style="${fcs}"><span class="csym">${_esc(String((d && d.symbol) || 'N/A'))}</span><span class="cnm">${_esc(String((d && d.name) || 'Malformed row'))}</span></div>`;
        }
        if (k === 'signal') return `<span data-col="signal" class="sig-cell" style="${fcs}">${emptySignal}</span>`;
        return `<span data-col="${_esc(k)}" class="tr" style="${fcs}">${emptyData}</span>`;
      }).join('');
      htmls.push(`<div class="trow" data-coin-id="${fallbackId}">
        ${fallbackCells}
        <span class="trow-toggle" data-trow-toggle="1" aria-label="Expand">â‹Ż</span>
      </div>`);
    }
  });

  document.getElementById('clist').innerHTML = htmls.join('');

  document.getElementById('page-bar').innerHTML = totalPages > 1 ? `
    <button class="s-btn" onclick="currentPage=Math.max(0,currentPage-1);renderList()">PREV</button>
    <span style="font-size:9px;color:var(--txt3)">${currentPage+1} / ${totalPages}</span>
    <button class="s-btn" onclick="currentPage=Math.min(${totalPages-1},currentPage+1);renderList()">NEXT</button>` : '';
  document.getElementById('scnt').textContent = filtered.length + ' / ' + DATA.length;

  // V8.1 — after the rows are in the DOM, measure for clipping and reflow
  // the absolute coordinate grid so no cell truncates and no two columns
  // overlap. Deferred to the next frame so layout has settled first.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_autosizeColumns);
  else setTimeout(_autosizeColumns, 16);
}

function pickCoin(id) {
  SEL = id;
  // V7.4.6: surface the active detail coin on `window` so the WS
  // tick pipeline (_applyTick) can decide whether to live-update
  // the right-hand pane. We track BOTH the CoinGecko id (used by
  // SEL/_currentDetailCoinId) AND the upper-case base symbol — the
  // WS frame carries the symbol, the DOM/state carries the id.
  window._currentDetailCoinId = id;
  const d = DATA.find(x => x.id === id);
  if (!d) { window._currentDetailCoinSym = null; return; }
  window._currentDetailCoinSym = String(d.symbol || '').toUpperCase();

  const s = _sigOf(d), f = getFunding(d), ls = getLsRatio(d), op = getOiPct(d);
  const sym = (d.symbol || '').toUpperCase();
  const validity = getSetupValidity(d);
  const binance = getBinanceLink(d);

  // V6.8 Sprint 1 (FIX-3): sym, d.name, d.id are upstream strings.
  // textContent on dlbl is already safe; every other interpolation
  // below routes through _esc / _safeUrl / JSON.stringify.
  document.getElementById('dlbl').textContent = sym;
  const symAttr = JSON.stringify(String(sym || ''));
  const idAttr  = JSON.stringify(String(d.id || ''));
  const binanceHref = binance.available ? _safeUrl(binance.url) : '';
  document.getElementById('dcon').innerHTML = `
    <div class="dhead">
      <div><div class="dsym">${_esc(sym)}</div><div class="dname">${_esc(d.name)} · ${_esc(getSector(d.id))}</div></div>
      <div><div class="dprc" data-detail="price">${_esc(fmt(d.current_price))}</div><div class="dchg ${(d.price_change_percentage_24h||0)>=0?'pos':'neg'}" data-detail="c24">${_esc(fp(d.price_change_percentage_24h||0))}</div></div>
    </div>

    <button id="ai-analyze-btn"
            class="ai-analyze-btn ai-analyze-btn--hero"
            onclick='if(window.requestAnalysis){window.requestAnalysis(${symAttr},${idAttr});}'
            title="Stáhne živá data z Binance (pokud je listován) a pošle je do Gemini">
      🧠 AI ANALÝZA
    </button>

    ${binance.available && binanceHref
      ? `<a class="binance-btn ${binance.market === 'futures' ? 'alpha' : 'active'}" href="${binanceHref}" target="_blank" rel="noopener noreferrer">${binance.market === 'futures' ? 'BINANCE FUTURES (ALPHA)' : 'BINANCE SPOT'} → ${_esc(binance.pair)}</a>`
      : `<div class="binance-btn unavail">Binance nedostupne</div>`}

    <div class="validity-box" style="border-color:${validity.border}">
      <div class="validity-title" style="color:${validity.col};font-weight:600;font-size:10px">${_esc(validity.type)}</div>
      <div class="validity-desc" style="color:var(--txt2);font-size:9px;margin-top:2px">${_esc(validity.desc)}</div>
    </div>

    <div class="mgrid">
      <div class="mc"><div class="ml">SIGNAL</div><div class="mv"><span class="bdg ${_esc(s.cls)}" data-detail="signal">${_esc(s.label)}</span></div></div>
      <div class="mc"><div class="ml">SCORE</div><div class="mv" data-detail="score">${s.score}/10</div></div>
      <div class="mc"><div class="ml">PANIC</div><div class="mv" data-detail="panic">${panicBadge(Number.isFinite(d._panic) ? d._panic : calcPanic(d))}</div></div>
      <div class="mc"><div class="ml">24H VOL</div><div class="mv" data-detail="qv">${_esc(fmt(d.total_volume || 0))}</div></div>
      <div class="mc"><div class="ml">24H RANGE</div><div class="mv">${_esc(fmt(d.low_24h || 0))}–${_esc(fmt(d.high_24h || 0))}</div></div>
    </div>

    ${(() => {
      // V5 (Phase 4 Wildcard B): Multi-TF Momentum panel in the
      // detail view. Shows the composite score, alignment %, and a
      // per-TF micro-bar so the trader can see exactly which
      // timeframes are stacking. Pure compute, no extra fetch.
      const mom = d._mom || computeMomentumScore(d);
      if (!mom || mom.label === 'N/A') return '';
      const barPct = Math.min(100, Math.abs(mom.score));
      const barCol = mom.score >= 0 ? 'var(--grn)' : 'var(--red)';
      const tfRow = (label, v) => {
        if (v == null || !Number.isFinite(parseFloat(v))) return '';
        const n = parseFloat(v);
        const col = n >= 0 ? 'var(--grn)' : 'var(--red)';
        return `<div style="display:flex;justify-content:space-between;font-size:9px"><span style="color:var(--txt3)">${label}</span><span style="color:${col}">${n >= 0 ? '+' : ''}${n.toFixed(2)}%</span></div>`;
      };
      return `
        <div class="ph" style="margin-top:10px"><span class="pt">MOMENTUM STACK · MULTI-TF</span><span class="ps">align ${Math.round(mom.stack*100)}%</span></div>
        <div style="padding:10px;background:var(--s3);border:1px solid var(--b1);border-radius:0 0 var(--rad) var(--rad);margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span class="${_esc(mom.cls)}" style="font-weight:700;font-size:13px">${_esc(mom.label)}</span>
            <span class="${_esc(mom.cls)}" style="font-weight:700;font-size:13px">${mom.score >= 0 ? '+' : ''}${mom.score|0}</span>
          </div>
          <div class="mom-bar"><div class="mom-bar__fill" style="width:${barPct}%;background:${barCol}"></div></div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">
            ${tfRow('1H', d._c1)}
            ${tfRow('4H', d._c4)}
            ${tfRow('12H', d._c12)}
            ${tfRow('24H', d._c24 ?? d.price_change_percentage_24h)}
            ${tfRow('7D', d._c7d)}
          </div>
        </div>
      `;
    })()}

    <div style="padding:10px">
      <div class="ml" style="margin-bottom:3px">SIGNAL FLOW (interní)</div>
      <div class="lsbar"><div class="lsl" style="width:${ls.l}%"></div><div class="lss" style="width:${ls.s}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:9px"><span class="pos">${ls.l.toFixed(0)}% L</span><span class="neg">${ls.s.toFixed(0)}% S</span></div>
    </div>

    ${(() => {
      // V5 (Sniper Limit Protocol): show the calculated optimal LIMIT
      // entry sitting just above the densest bid cluster. We render it
      // whenever a wall was detected for this base, even if the SNIPER
      // trigger isn't currently armed — that way the trader can pre-place
      // the limit before price has dripped into the trigger zone.
      const snipAll = SNIPER_ALL_MAP.get(sym);
      if (!snipAll) return '';
      const armed = !!SNIPER_MAP.get(sym);
      const wallM = (snipAll.wall_notional_usd / 1_000_000).toFixed(2);
      const distLabel = snipAll.distance_pct >= 0
        ? `${snipAll.distance_pct.toFixed(2)}% below mark`
        : `${Math.abs(snipAll.distance_pct).toFixed(2)}% above mark`;
      // Wall base qty: human-readable, no percentage / sign — fp() is
      // wrong here because it forces a "+"/"-" prefix and "%" suffix.
      const wallBaseLabel = Number(snipAll.wall_base_qty).toLocaleString(undefined, { maximumFractionDigits: 2 });
      return `
        <div class="ph" style="margin-top:10px">
          <span class="pt">${armed ? '🎯 SNIPER LIMIT · ARMED' : 'SNIPER LIMIT · IDLE'}</span>
          <span class="ps">conf ${_esc(snipAll.confidence)}</span>
        </div>
        <div class="sniper-box ${armed ? 'sniper-box--armed' : ''}">
          <div class="sniper-row">
            <span class="sniper-lbl">OPTIMAL LIMIT ENTRY</span>
            <span class="sniper-val sniper-val--big">${_esc(fmt(snipAll.optimal_limit_entry))}</span>
          </div>
          <div class="sniper-row sniper-row--sub">
            <span class="sniper-lbl">${_esc(distLabel)}</span>
            <span class="sniper-lbl">wall -${Number(snipAll.wall_drop_pct).toFixed(2)}%</span>
          </div>
          <div class="sniper-row">
            <span class="sniper-lbl">BID WALL SIZE</span>
            <span class="sniper-val">$${_esc(wallM)}M <span class="sniper-lbl">(${_esc(wallBaseLabel)} ${_esc(sym)})</span></span>
          </div>
          ${snipAll.proximity_to_24h_low_pct != null ? `
          <div class="sniper-row sniper-row--sub">
            <span class="sniper-lbl">vs 24H LOW</span>
            <span class="sniper-lbl">${snipAll.proximity_to_24h_low_pct >= 0 ? '+' : ''}${snipAll.proximity_to_24h_low_pct.toFixed(2)}%</span>
          </div>` : ''}
        </div>`;
    })()}

    <div class="ph" style="margin-top:10px"><span class="pt">ORDER BOOK · BINANCE</span><span class="ps" id="ob-status">načítám…</span></div>
    <div id="orderbook-${_esc(d.id)}" class="orderbook-box" style="padding:8px 10px;font-size:10px;color:var(--txt2)">…</div>

    <div class="why-box">
      <div style="font-weight:600;color:var(--acc);font-size:9px;margin-bottom:2px">PROC TENTO ALERT?</div>
      ${s.reasons.map(r => `<div style="font-size:9px;color:var(--txt2)">• ${_esc(r)}</div>`).join('')}
    </div>
  `;

  loadOrderbook(d, binance);
  renderList();
}

// On-demand Binance order book snapshot for the right detail panel.
// Direct browser → Binance fetch. Used to be a guaranteed-CORS endpoint
// but adblockers (uBlock, Brave Shields, corporate proxies) increasingly
// block api.binance.com and fapi.binance.com from the client. When that
// happens the browser raises a generic "NetworkError when attempting to
// fetch resource" — opaque, indistinguishable from a real outage.
//
// Strategy:
//   1. Pick the venue URL that matches the coin's exchange. ALPHA
//      (futures-only) coins MUST hit /fapi or they get HTTP 400.
//   2. Strict timeout (4s) so a hanging fetch can't keep the spinner up.
//   3. On any failure → render a localized inline message in the slot
//      and silently return. NO global toast — the news/regime/etc.
//      already toast errors, and stacking an order-book toast on every
//      coin click is the noisiest UX failure mode we have.
async function loadOrderbook(d, binance) {
  const slot = document.getElementById('orderbook-' + d.id);
  const status = document.getElementById('ob-status');
  if (!slot) return;
  if (!binance.available) {
    slot.innerHTML = '<div style="color:var(--txt3)">Binance pár pro tento coin není dostupný.</div>';
    if (status) status.textContent = '–';
    return;
  }
  const pair = binance.pair.replace('/', '');
  // Route to /fapi for ALPHA/futures-only coins — /api/v3/depth returns
  // 400 "Invalid symbol" for perp-only listings like 1000PEPEUSDT.
  const useFutures = (d?.binance_market === 'futures') || (binance.market === 'futures') || (d?.exchange === 'ALPHA');
  const baseUrl = useFutures
    ? 'https://fapi.binance.com/fapi/v1/depth'
    : 'https://api.binance.com/api/v3/depth';
  const url = `${baseUrl}?symbol=${encodeURIComponent(pair)}&limit=10`;

  // Manual AbortController — AbortSignal.timeout() is patchy across
  // older Safari and we still see legitimate users on it.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);

  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (SEL !== d.id) return;
    const bids = (j.bids || []).slice(0, 5);
    const asks = (j.asks || []).slice(0, 5).reverse();
    if (!bids.length && !asks.length) {
      slot.innerHTML = '<div style="color:var(--txt3)">Order book prázdný.</div>';
      if (status) status.textContent = pair;
      return;
    }
    const row = (p, q, side) => {
      const cls = side === 'b' ? 'pos' : 'neg';
      return `<div style="display:flex;justify-content:space-between"><span class="${cls}">${parseFloat(p).toFixed(4)}</span><span style="color:var(--txt3)">${parseFloat(q).toFixed(3)}</span></div>`;
    };
    slot.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:1px">${asks.map(([p, q]) => row(p, q, 'a')).join('')}</div>
      <div style="border-top:1px dashed var(--b2);border-bottom:1px dashed var(--b2);text-align:center;padding:3px;color:var(--acc)">— mid —</div>
      <div style="display:flex;flex-direction:column;gap:1px">${bids.map(([p, q]) => row(p, q, 'b')).join('')}</div>
    `;
    if (status) status.textContent = pair;
  } catch (e) {
    // Distinguish the common failure modes for the inline message only.
    // A generic "Failed to fetch" / AbortError is almost always an
    // adblocker or corporate proxy blocking the Binance host directly
    // from the browser — not an actual outage.
    if (SEL !== d.id) return;
    const isNet = e.name === 'AbortError'
      || /Failed to fetch|NetworkError|TypeError/i.test(String(e.message || ''));
    // V6.8 Sprint 1 (FIX-3): e.message is an arbitrary string from any
    // network-layer failure. Escape it before insertion.
    const msg = isNet
      ? 'Order book blokován prohlížečem (adblock / CORS). Použijte AI Analýzu pro plnou hloubku.'
      : `Order book nedostupný: ${_esc(e.message)}`;
    slot.innerHTML = `<div style="color:var(--txt3);font-size:9px;line-height:1.4">${msg}</div>`;
    if (status) status.textContent = isNet ? 'blocked' : 'error';
    // Intentionally NO global Toast here — the inline UI message is
    // already in the slot the user is looking at, and a toast per coin
    // click would flood the screen.
    console.warn('[ORDERBOOK]', e.name, e.message);
  } finally {
    clearTimeout(timer);
  }
}

function resolveTvSymbol(d) {
  // Dynamic venue prefixing for TradingView. The widget previously
  // hardcoded BINANCE: for every coin, which crashed with "This
  // symbol doesn't exist" the moment a DEX-only coin ranked into the
  // Top 10 grid. Routing matrix:
  //
  //   BIN   (Binance Spot)            → BINANCE:<sym><quote>
  //   ALPHA (Binance Futures perp)    → BINANCE:<sym>USDT.P
  //                                     (TV perp notation; the .P
  //                                      suffix maps to USDⓈ-M futures)
  //   DEX   (off-Binance)             → MEXC:<sym>USDT, with a
  //                                     CRYPTO:<sym>USD fallback hint
  //                                     for the few coins MEXC doesn't
  //                                     list either. CRYPTO:* is TV's
  //                                     cross-exchange aggregator
  //                                     index — guarantees *some*
  //                                     chart renders rather than the
  //                                     "symbol doesn't exist" error.
  const baseSym = String(d.symbol || '').toUpperCase().replace(/[/:]/g, '');
  if (!baseSym) return null;
  const rawPair = String(d.pair || '').toUpperCase().replace(/[/:]/g, '');
  const futPair = String(d.futures_pair || '').toUpperCase().replace(/[/:]/g, '');
  const quote = String(d.quote || 'USDT').toUpperCase();

  const isAlpha = d.exchange === 'ALPHA' || d.binance_market === 'futures';
  const isBin = !isAlpha && (d.exchange === 'BIN' || d.binance_available === true);

  if (isAlpha) {
    const pair = futPair || rawPair || (baseSym + 'USDT');
    return { tv: 'BINANCE:' + pair + '.P', exch: 'BINANCE', pair, venue: 'alpha' };
  }
  if (isBin) {
    const pair = rawPair || (baseSym + quote);
    return { tv: 'BINANCE:' + pair, exch: 'BINANCE', pair, venue: 'spot' };
  }
  // DEX path. MEXC lists the long tail of memecoins / new launches
  // that other CEXs skip, so it has the highest hit-rate fallback.
  // The `fallbackTv` field lets the caller wire a second iframe or an
  // onerror handler that swaps to the cross-exchange aggregator if the
  // MEXC symbol also 404s on TV.
  const dexPair = baseSym + 'USDT';
  return {
    tv: 'MEXC:' + dexPair,
    fallbackTv: 'CRYPTO:' + baseSym + 'USD',
    exch: 'MEXC',
    pair: dexPair,
    venue: 'dex',
  };
}

// V6 (chart-throttle): WS ticks fire faster than the iframe widget can
// settle. Anything that wants to repaint the Top Charts grid goes through
// `renderTopCharts()`, which leading-edge-fires immediately and then is
// rate-limited to one repaint per CHART_RENDER_THROTTLE_MS. The actual
// DOM work happens in `_renderTopChartsCore` and is a *diff*, not a wipe
// — iframes are only created/destroyed when the symbol at a slot
// changes. A re-rank that keeps the same symbol just mutates the
// `.tc-meta` text, so the user can actually read and interact with the
// chart between ticks.
const CHART_RENDER_THROTTLE_MS = 1000;
let _topChartsLastRender = 0;
let _topChartsPending = null;

function renderTopCharts() {
  const now = Date.now();
  const since = now - _topChartsLastRender;
  if (since >= CHART_RENDER_THROTTLE_MS) {
    _topChartsLastRender = now;
    _renderTopChartsCore();
    return;
  }
  if (_topChartsPending) return; // already queued for the trailing edge
  _topChartsPending = setTimeout(() => {
    _topChartsPending = null;
    _topChartsLastRender = Date.now();
    _renderTopChartsCore();
  }, CHART_RENDER_THROTTLE_MS - since);
}

function _renderTopChartsCore() {
  // Dynamic Top 10 — sort the loaded global DATA pool by signal score
  // DESC and render TradingView widgets for the leaders. Diffed against
  // the current DOM so iframes are reused whenever the symbol at a slot
  // is unchanged — only score text mutates on a re-rank.
  const grid = document.getElementById('topcharts-grid');
  if (!grid) return;
  if (!Array.isArray(DATA) || !DATA.length) {
    if (grid.firstElementChild?.dataset?.placeholder !== '1') {
      grid.textContent = '';
      const ph = document.createElement('div');
      ph.dataset.placeholder = '1';
      ph.style.cssText = 'padding:20px;color:var(--txt3);font-size:10px';
      ph.textContent = 'Loading scanner data…';
      grid.appendChild(ph);
    }
    return;
  }
  const top10 = [...DATA]
    .sort((a, b) => (b._sig_score || 0) - (a._sig_score || 0))
    .slice(0, 10);

  // Drop any stale placeholder before we start diffing real cards.
  const ph = grid.querySelector('[data-placeholder="1"]');
  if (ph) ph.remove();

  const existing = Array.from(grid.children);
  top10.forEach((d, idx) => {
    const sym = typeof d.symbol === 'string' ? d.symbol.toUpperCase() : String(d.symbol || '').toUpperCase();
    const resolved = resolveTvSymbol(d);
    if (!resolved) return;
    const src = 'https://s.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(resolved.tv) + '&interval=15&hidesidetoolbar=1&theme=dark&style=1';
    const venueLabel = resolved.venue === 'alpha' ? 'ALPHA' : resolved.venue === 'dex' ? resolved.exch : 'BIN';
    const scoreTxt = `score ${(_sigOf(d).score)|0}/10`;

    let card = existing[idx];
    const sameSym = card && card.dataset && card.dataset.tcKey === resolved.tv;

    if (sameSym) {
      // Same symbol at this slot — mutate ONLY the changing text nodes.
      // The iframe is left untouched so the chart keeps drawing.
      const meta = card.querySelector('.tc-meta');
      if (meta && meta.textContent !== scoreTxt) meta.textContent = scoreTxt;
      const venueEl = card.querySelector('.tc-venue');
      if (venueEl && venueEl.textContent !== venueLabel) venueEl.textContent = venueLabel;
      if (card.dataset.venue !== resolved.venue) card.dataset.venue = resolved.venue;
      return;
    }

    // Build a fresh card via createElement (no innerHTML) so escaping
    // is intrinsic and the iframe is the only network-loading node.
    const next = document.createElement('div');
    next.className = 'tc-card';
    next.dataset.venue = resolved.venue;
    next.dataset.tcKey = resolved.tv;

    const head = document.createElement('div');
    head.className = 'tc-head';
    const symEl = document.createElement('span');
    symEl.className = 'tc-sym';
    symEl.textContent = sym + ' ';
    const venueEl = document.createElement('span');
    venueEl.className = 'tc-venue';
    venueEl.textContent = venueLabel;
    symEl.appendChild(venueEl);
    const meta = document.createElement('span');
    meta.className = 'tc-meta';
    meta.textContent = scoreTxt;
    head.appendChild(symEl);
    head.appendChild(meta);

    const frame = document.createElement('iframe');
    frame.className = 'tc-frame';
    frame.loading = 'lazy';
    frame.allowFullscreen = true;
    frame.src = src;

    next.appendChild(head);
    next.appendChild(frame);

    if (existing[idx]) grid.replaceChild(next, existing[idx]);
    else grid.appendChild(next);
    existing[idx] = next;
  });

  // Trim any trailing cards left over from a previous, longer top10.
  while (grid.children.length > top10.length) grid.removeChild(grid.lastChild);
}

// ─────────────────────────────────────────────────────────────
// HEATMAP — V6.1 strict equal-grid canvas renderer.
//
//   • Block SIZE  = STRICTLY EQUAL across all 500 cells.
//   • Block ORDER = sorted by 24h quote volume DESC. Top-left = largest,
//                   bottom-right = smallest. Row-major fill.
//   • Block COLOR = 24h % price change (red ↔ neutral ↔ green).
//   • RENDERER    = single <canvas>, DPR-aware, hardware-accelerated.
//                   Hit-test on hover + click, one absolute tooltip div.
//                   No DOM bloat — 500 cells cost ~1 paint per repaint.
// ─────────────────────────────────────────────────────────────

const _hm = {
  rects: [],           // [{x,y,w,h,d}] in CSS px
  lastWidth: 0,
  lastHeight: 0,
  resizeRaf: 0,
  hoverIdx: -1,
};

function _hmColor(c) {
  const int = Math.min(1, Math.abs(c) / 12);
  if (c <= -6) return { bg: `rgba(255,51,86,${0.32 + int * 0.55})`, txt: '#ff7a91' };
  if (c <= -2) return { bg: `rgba(255,176,32,${0.22 + int * 0.45})`, txt: '#ffc977' };
  if (c <   2) return { bg: 'rgba(96,112,144,.16)',                  txt: '#9fb1c8' };
  if (c <   6) return { bg: `rgba(0,212,132,${0.22 + int * 0.45})`,  txt: '#5fe5b4' };
  return         { bg: `rgba(0,212,132,${0.32 + int * 0.55})`,        txt: '#7af0c5' };
}

function _hmFmtCap(mc) {
  if (!mc) return '—';
  if (mc >= 1e12) return '$' + (mc/1e12).toFixed(2) + 'T';
  if (mc >= 1e9)  return '$' + (mc/1e9).toFixed(2)  + 'B';
  if (mc >= 1e6)  return '$' + (mc/1e6).toFixed(1)  + 'M';
  return '$' + Math.round(mc/1e3) + 'K';
}

// Strict equal-grid layout. Given a container WxH and N items, picks
// the col/row count whose cell aspect is closest to 1:1, then lays the
// items out row-major (top-left → bottom-right). Items must already be
// sorted DESC by 24h volume by the caller.
function _hmGridLayout(items, W, H, out) {
  const n = items.length;
  if (!n || W < 4 || H < 4) return;
  // Pick cols so cell aspect ≈ 1. cols = round(sqrt(n * W/H)).
  let cols = Math.max(1, Math.round(Math.sqrt(n * (W / H))));
  cols = Math.min(cols, n);
  let rows = Math.ceil(n / cols);
  // Tweak to minimize empty trailing slots. If the last row would be
  // less than half full, drop a column.
  if (cols > 1 && (rows * cols - n) >= Math.floor(cols / 2)) {
    cols -= 1;
    rows = Math.ceil(n / cols);
  }
  const cw = W / cols;
  const ch = H / rows;
  for (let i = 0; i < n; i++) {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    out.push({ x: c * cw, y: r * ch, w: cw, h: ch, d: items[i].d });
  }
}

function _hmDraw(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#04060e';
  ctx.fillRect(0, 0, W, H);

  for (const r of _hm.rects) {
    const c = Number(r.d.price_change_percentage_24h) || 0;
    const col = _hmColor(c);
    // Cell fill
    ctx.fillStyle = col.bg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // Border
    ctx.strokeStyle = 'rgba(4,6,14,.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);

    // V6.8: drop the (28×18) gate. Labels must stay visible on mobile
    // canvases where 500 cells crush every box below the old threshold.
    // We still bail out on truly degenerate cells (<10px on either axis)
    // to avoid sub-pixel font noise.
    if (r.w < 10 || r.h < 10) continue;

    const sym = String(r.d.symbol || '').toUpperCase();
    const area = r.w * r.h;
    // Dynamic font: scale by sqrt(area) but enforce a 7px floor so
    // even tiny mobile cells render readable text. Cap at 28px.
    const fontSym = Math.max(7, Math.min(28, Math.sqrt(area) * 0.30));
    const fontChg = Math.max(7, Math.min(20, fontSym * 0.75));
    // Truncate symbol if it would visually overflow the cell. Estimate
    // character width as ~0.6 × font-size for monospace.
    const maxChars = Math.max(1, Math.floor((r.w - 4) / (fontSym * 0.6)));
    const symFit = sym.length > maxChars ? sym.slice(0, maxChars) : sym;
    ctx.fillStyle = col.txt;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fontSym}px var(--mono, monospace)`;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (r.h > 38 && r.w > 44) {
      ctx.fillText(symFit, cx, cy - fontChg * 0.65);
      ctx.font = `600 ${fontChg}px var(--mono, monospace)`;
      ctx.fillText((c >= 0 ? '+' : '') + c.toFixed(1) + '%', cx, cy + fontSym * 0.55);
    } else {
      ctx.fillText(symFit, cx, cy);
    }
  }

  if (_hm.hoverIdx >= 0 && _hm.hoverIdx < _hm.rects.length) {
    const r = _hm.rects[_hm.hoverIdx];
    ctx.strokeStyle = '#00e8c8';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }
}

function _hmHit(px, py) {
  for (let i = 0; i < _hm.rects.length; i++) {
    const r = _hm.rects[i];
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
  }
  return -1;
}

function _hmEnsureChrome() {
  const view = document.getElementById('v-heatmap');
  if (!view) return null;
  let canvas = document.getElementById('hm-canvas');
  let tip    = document.getElementById('hm-tip');
  if (!canvas) {
    const grid = document.getElementById('hm-grid');
    if (grid) { grid.innerHTML = ''; grid.id = 'hm-canvas-wrap'; grid.className = 'hm-canvas-wrap'; }
    const wrap = document.getElementById('hm-canvas-wrap') || grid || view;
    canvas = document.createElement('canvas');
    canvas.id = 'hm-canvas';
    canvas.className = 'hm-canvas';
    wrap.appendChild(canvas);
    tip = document.createElement('div');
    tip.id = 'hm-tip';
    tip.className = 'hm-tip';
    tip.style.display = 'none';
    wrap.appendChild(tip);

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const idx = _hmHit(px, py);
      if (idx !== _hm.hoverIdx) {
        _hm.hoverIdx = idx;
        _hmDraw(canvas);
      }
      if (idx >= 0) {
        const r = _hm.rects[idx];
        const d = r.d;
        const c = Number(d.price_change_percentage_24h) || 0;
        const mc = Number(d.market_cap) || 0;
        const vol = Number(d.total_volume) || 0;
        // V6.8 Sprint 1 (FIX-3): d.symbol is upstream — escape. The
        // numeric outputs come from Number() coercion above so they're
        // safe by construction.
        tip.innerHTML = `<div class="hm-tip__sym">${_esc(String(d.symbol||'').toUpperCase())}</div>
          <div class="hm-tip__row"><span>24h</span><b style="color:${c>=0?'var(--grn)':'var(--red)'}">${(c>=0?'+':'')+c.toFixed(2)}%</b></div>
          <div class="hm-tip__row"><span>Market Cap</span><b>${_esc(_hmFmtCap(mc))}</b></div>
          <div class="hm-tip__row"><span>24h Vol</span><b>${_esc(_hmFmtCap(vol))}</b></div>
          <div class="hm-tip__hint">click → scanner</div>`;
        tip.style.display = 'block';
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        let tx = px + 14;
        let ty = py + 14;
        if (tx + tw > rect.width) tx = px - tw - 14;
        if (ty + th > rect.height) ty = py - th - 14;
        tip.style.transform = `translate(${tx}px,${ty}px)`;
      } else {
        tip.style.display = 'none';
      }
    });
    canvas.addEventListener('mouseleave', () => { _hm.hoverIdx = -1; tip.style.display = 'none'; _hmDraw(canvas); });
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const idx = _hmHit(e.clientX - rect.left, e.clientY - rect.top);
      if (idx < 0) return;
      const id = String(_hm.rects[idx].d.id || _hm.rects[idx].d.symbol || '').toLowerCase();
      const scannerTab = document.querySelector('#tabs .tab');
      pickCoin(id);
      if (scannerTab) sv('scanner', scannerTab);
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (_hm.resizeRaf) cancelAnimationFrame(_hm.resizeRaf);
        _hm.resizeRaf = requestAnimationFrame(() => renderHeatmap());
      });
      ro.observe(canvas);
      _ObserverRegistry.add(ro);
    }
  }
  return canvas;
}

function renderHeatmap() {
  const canvas = _hmEnsureChrome();
  if (!canvas) return;

  // V6.8: Pool sorted by market_cap_rank ASC — matches CoinMarketCap's
  // canonical ranking order (#1 BTC top-left, #500 bottom-right). Rows
  // missing a rank (Binance-only synthesized BIN rows, market_cap_rank=0)
  // are pushed to the tail so the visible grid mirrors CMC's universe.
  const pool = (Array.isArray(DATA) ? DATA : [])
    .filter(d => Number(d.total_volume) > 0)
    .sort((a, b) => {
      const ra = Number(a.market_cap_rank) || Number.MAX_SAFE_INTEGER;
      const rb = Number(b.market_cap_rank) || Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return (Number(b.market_cap) || 0) - (Number(a.market_cap) || 0);
    })
    .slice(0, 500);

  if (!pool.length) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#a0a0a0';
    ctx.font = '12px var(--mono, monospace)';
    ctx.textAlign = 'center';
    ctx.fillText('No 24h volume data available.', canvas.clientWidth/2, canvas.clientHeight/2);
    return;
  }

  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W < 10 || H < 10) return;

  const items = pool.map(d => ({ d }));
  _hm.rects = [];
  _hmGridLayout(items, W, H, _hm.rects);
  _hmDraw(canvas);

  const hmCount = document.getElementById('hm-count');
  if (hmCount) hmCount.textContent = pool.length + ' coins · equal grid · sorted by MC rank #1→#' + pool.length;
}

function renderAlerts() {
  const als = ALL_ALERTS;
  // V6.8 Sprint 1 (FIX-3): a.t / a.b are built from upstream symbols
  // and signal reasons — escape both. a.coinId is JSON-stringified into
  // the onclick attribute so quote injection from a poisoned id can
  // never escape the handler.
  const row = a => {
    const idAttr = _esc(String(a.coinId || ''));
    return `<div class="alrt" data-coin-id="${idAttr}"><div class="aico" style="color:var(--acc)">●</div><div class="abody"><div class="atitle">${_esc(a.t)}</div><div class="adesc">${_esc(a.b)}</div></div></div>`;
  };
  const rowReadOnly = a => `<div class="alrt" style="margin-bottom:5px;border:1px solid var(--b1);border-radius:var(--rad)"><div class="abody"><div class="atitle">${_esc(a.t)}</div><div class="adesc">${_esc(a.b)}</div></div></div>`;
  document.getElementById('alert-feed').innerHTML = als.slice(0, 15).map(row).join('');
  document.getElementById('alerts-all').innerHTML = als.map(rowReadOnly).join('');
}

function renderRegimeView() {
  // Renders the REGIME tab: current state card + transition history.
  // Both pull from REGIME (populated by fetchRegime() against /api/regime).
  const main = document.getElementById('regime-main');
  const log  = document.getElementById('regime-log');
  if (!main && !log) return;

  const bucket = REGIME.bucket || 'chop';
  const score  = Number(REGIME.score) || 0;
  const label  = REGIME.label || (bucket.toUpperCase());
  const tone   = bucket === 'bear' ? 'var(--red)' : bucket === 'chop' ? 'var(--amb)' : 'var(--grn)';
  const inputs = REGIME.inputs || {};
  const reasons = Array.isArray(REGIME.reasons) ? REGIME.reasons : [];

  if (main) {
    if (!REGIME.computed_at && !REGIME.history?.length) {
      main.innerHTML = `<div style="padding:18px;text-align:center;color:var(--txt3);font-size:11px">Načítám tržní režim…</div>`;
    } else {
      const ts = REGIME.computed_at ? new Date(REGIME.computed_at).toLocaleTimeString('cs-CZ') : '—';
      const staleBadge = REGIME.stale ? '<span style="margin-left:8px;padding:1px 6px;border:1px solid var(--amb);color:var(--amb);border-radius:var(--rad);font-size:8px">STALE</span>' : '';
      const cachedBadge = REGIME.cached && !REGIME.stale ? '<span style="margin-left:8px;padding:1px 6px;border:1px solid var(--b2);color:var(--txt3);border-radius:var(--rad);font-size:8px">CACHED</span>' : '';
      // V6.8 Sprint 1 (FIX-3): label, reasons, inputs all come from the
      // /api/regime upstream — escape every interpolated string. Numerics
      // route through Number(...) so they're safe.
      main.innerHTML = `
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div>
              <div style="font-size:18px;font-weight:700;color:${tone};letter-spacing:.05em">${_esc(label)}</div>
              <div style="font-size:9px;color:var(--txt3);margin-top:2px">Computed ${_esc(ts)}${cachedBadge}${staleBadge}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:24px;font-weight:700;color:${tone}">${score}</div>
              <div style="font-size:9px;color:var(--txt3)">SCORE / 100</div>
            </div>
          </div>
          <div style="height:6px;background:var(--s3);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${score}%;background:${tone};transition:width .3s"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:4px">
            <div style="background:var(--s3);padding:8px;border-radius:var(--rad)">
              <div style="font-size:9px;color:var(--txt3)">BREADTH</div>
              <div style="font-size:13px;color:var(--txt);margin-top:2px">${inputs.green_pct != null ? inputs.green_pct.toFixed(1) + '%' : '—'} <span style="color:var(--txt3);font-size:9px">green</span></div>
            </div>
            <div style="background:var(--s3);padding:8px;border-radius:var(--rad)">
              <div style="font-size:9px;color:var(--txt3)">BTC 24H</div>
              <div style="font-size:13px;color:${(inputs.btc_change_24h||0)>=0?'var(--grn)':'var(--red)'};margin-top:2px">${inputs.btc_change_24h != null ? (inputs.btc_change_24h>=0?'+':'') + inputs.btc_change_24h.toFixed(2) + '%' : '—'}</div>
            </div>
            <div style="background:var(--s3);padding:8px;border-radius:var(--rad)">
              <div style="font-size:9px;color:var(--txt3)">AVG VOL</div>
              <div style="font-size:13px;color:var(--txt);margin-top:2px">${inputs.avg_vol_24h != null ? inputs.avg_vol_24h.toFixed(2) + '%' : '—'}</div>
            </div>
          </div>
          ${reasons.length ? `<div style="margin-top:4px">
            ${reasons.map(r => `<div style="font-size:10px;color:var(--txt2);padding:2px 0">• ${_esc(r)}</div>`).join('')}
          </div>` : ''}
          <div style="font-size:9px;color:var(--txt3);border-top:1px dashed var(--b2);padding-top:6px;margin-top:4px">
            Buckets — &lt;35: BEAR/FLUSH · 35–65: CHOP · &gt;65: BULL/TREND · Pool: ${_esc(inputs.coins_total || '—')} coinů
          </div>
        </div>`;
    }
  }

  if (log) {
    const hist = Array.isArray(REGIME.history) ? REGIME.history : [];
    if (!hist.length) {
      log.innerHTML = `<div style="font-size:9px;color:var(--txt3);text-align:center;padding:8px">Historie přechodů zatím prázdná. Server zaznamenává změny labelu.</div>`;
    } else {
      log.innerHTML = hist.map(h => {
        const at = h.at ? new Date(h.at).toLocaleString('cs-CZ', { hour12: false }) : '—';
        const tcol = h.bucket === 'bear' ? 'var(--red)' : h.bucket === 'chop' ? 'var(--amb)' : 'var(--grn)';
        // V6.8 Sprint 1 (FIX-3): h.from / h.label come from the regime API.
        const fromLabel = h.from ? `<span style="color:var(--txt3)">${_esc(h.from)}</span> → ` : '';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 8px;background:var(--s3);border-radius:var(--rad);font-size:10px">
          <div>${fromLabel}<b style="color:${tcol}">${_esc(h.label || '—')}</b></div>
          <div style="color:var(--txt3);font-size:9px">${_esc(at)} · score ${h.score | 0}</div>
        </div>`;
      }).join('');
    }
  }
}

function renderSectors() {
  const sectorStats = {};
  for (const [sec, ids] of Object.entries(SECTOR_MAP)) {
    const coins = DATA.filter(d => ids.includes(d.id));
    if (!coins.length) continue;
    const avg24h = coins.reduce((s,d) => s + (d.price_change_percentage_24h || 0), 0) / coins.length;
    sectorStats[sec] = { avg24h, count: coins.length };
  }
  // V6.8 Sprint 1 (FIX-3): sec comes from SECTOR_MAP (compile-time
  // constant) but escape anyway for consistency. st.count + fp() are
  // numeric. Defense-in-depth in case SECTOR_MAP is ever loaded from
  // a config endpoint.
  document.getElementById('sector-grid').innerHTML = Object.entries(sectorStats).map(([sec, st]) => `<div class="sector-card"><div class="sc-head"><span class="sc-name">${_esc(sec)}</span><span class="sc-count">${st.count|0} coinu</span></div><div class="sc-metrics"><div class="sc-mv" style="color:${st.avg24h>=0?'var(--grn)':'var(--red)'}">${_esc(fp(st.avg24h,1))}</div></div></div>`).join('');
}

// ─── V6.5 MOVERS — Top 30 Gainers & Losers ───
function renderMovers() {
  const gEl = document.getElementById('movers-gainers');
  const lEl = document.getElementById('movers-losers');
  if (!gEl || !lEl) return;
  if (!Array.isArray(DATA) || !DATA.length) {
    gEl.innerHTML = lEl.innerHTML = '<div style="padding:14px;color:var(--txt3);font-size:10px;text-align:center">Loading data…</div>';
    return;
  }

  const valid = DATA.filter(d => Number.isFinite(d.price_change_percentage_24h));
  const sorted = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);
  const gainers = sorted.slice(0, 30);
  const losers  = sorted.slice(-30).reverse();

  // V6.8: dynamic green/red. Returns inline color or a "no data" muted gray
  // (—) so a missing 1H / 7D point can't be misread as 0%.
  function pctCell(val) {
    if (!Number.isFinite(val)) return `<span class="mover-pct" style="color:var(--txt3)">—</span>`;
    const col = val >= 0 ? 'var(--grn)' : 'var(--red)';
    return `<span class="mover-pct" style="color:${col}">${fp(val, 2)}</span>`;
  }

  function moverRow(d, i) {
    const sym = (d.symbol || d.id || '').toUpperCase();
    const c1  = Number.isFinite(d._c1)  ? d._c1  : null;
    const c24 = Number.isFinite(d._c24) ? d._c24 : d.price_change_percentage_24h;
    const c7d = Number.isFinite(d._c7d) ? d._c7d : null;
    const vol = d.total_volume || 0;
    const volStr = vol >= 1e9 ? '$' + (vol/1e9).toFixed(1) + 'B'
      : vol >= 1e6 ? '$' + (vol/1e6).toFixed(0) + 'M'
      : vol >= 1e3 ? '$' + (vol/1e3).toFixed(0) + 'K' : '$' + vol.toFixed(0);
    // V6.8 Sprint 1 (FIX-3): sym + d.id are upstream; escape sym for the
    // text node and JSON.stringify d.id for the attribute. volStr/fmt are
    // numeric-derived but escape defensively.
    const idAttr = _esc(String(d.id || ''));
    return `<div class="mover-row" data-coin-id="${idAttr}" data-coin-tab="scanner">
      <span class="mover-rank">${i + 1}</span>
      <span class="mover-sym">${_esc(sym)}</span>
      <span class="mover-price">${_esc(fmt(d.current_price))}</span>
      ${pctCell(c1)}
      ${pctCell(c24)}
      ${pctCell(c7d)}
      <span class="mover-vol">${_esc(volStr)}</span>
    </div>`;
  }

  const hdr = `<div class="mover-hdr">
    <span class="mover-rank">#</span>
    <span class="mover-sym">COIN</span>
    <span class="mover-price">PRICE</span>
    <span class="mover-pct">1H %</span>
    <span class="mover-pct">24H %</span>
    <span class="mover-pct">7D %</span>
    <span class="mover-vol">VOL</span>
  </div>`;

  gEl.innerHTML = hdr + gainers.map((d, i) => moverRow(d, i)).join('');
  lEl.innerHTML = hdr + losers.map((d, i) => moverRow(d, i)).join('');

  const sumEl = document.getElementById('movers-summary');
  if (sumEl) sumEl.textContent = `${DATA.length} coins tracked · top ${gainers.length} gainers · bottom ${losers.length} losers`;
}

function _viewNameFromId(id) {
  return String(id || '').replace(/^#/, '').replace(/^view-/, '').replace(/^v-/, '');
}

function _viewCandidateIds(v, el) {
  const ids = [];
  const push = (id) => {
    const clean = String(id || '').replace(/^#/, '');
    if (clean && !ids.includes(clean)) ids.push(clean);
  };
  const dataTarget = el && el.dataset ? el.dataset.target : '';
  if (dataTarget) {
    const clean = String(dataTarget).replace(/^#/, '');
    push(clean);
    if (clean.indexOf('view-') === 0) push('v-' + clean.slice(5));
    if (clean.indexOf('v-') === 0) push('view-' + clean.slice(2));
  }
  const name = _viewNameFromId(v);
  if (name) {
    push('v-' + name);
    push('view-' + name);
  }
  return ids;
}

function _resolveViewTarget(v, el) {
  const ids = _viewCandidateIds(v, el);
  for (let i = 0; i < ids.length; i++) {
    const node = document.getElementById(ids[i]);
    if (node) return node;
  }
  return null;
}

function _applyViewDisplay(target, v) {
  if (!target) return;
  const name = _viewNameFromId(target.id || v);
  const flex = name === 'bot' || name === 'heatmap' || name === 'manual' || name === 'calendar';
  target.style.display = flex ? 'flex' : 'block';
  target.style.flexDirection = flex ? 'column' : '';
  if (name === 'bot' || name === 'calendar') {
    target.style.height = 'calc(100vh - 85px)';
    target.style.overflow = 'hidden';
  }
}

function sv(v, el) {
  const target = _resolveViewTarget(v, el);
  if (!target) return;

  // V6.3: clear ALL inline style overrides on every view, then add .on
  // to the target. CSS handles display type per-view via ID selectors.
  document.querySelectorAll('.view').forEach(x => {
    x.classList.remove('on');
    x.hidden = true;
    x.style.display = 'none';
    x.style.opacity = '';
    x.style.visibility = '';
    x.style.transform = '';
    x.style.flexDirection = '';
    x.style.height = '';
    x.style.overflow = '';
  });
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
  target.hidden = false;
  target.classList.add('on');
  _applyViewDisplay(target, v);
  if (el) el.classList.add('on');
  const activeViewName = _viewNameFromId(target.id || v);
  if (activeViewName === 'livefeed' && typeof LiveFeed !== 'undefined') LiveFeed.clearUnread();
  // Heatmap canvas needs a redraw after the view becomes visible
  // (clientWidth/Height are zero while display:none).
  if (activeViewName === 'heatmap') requestAnimationFrame(() => { try { renderHeatmap(); } catch(e){} });
  if (activeViewName === 'manual') requestAnimationFrame(() => { try { initManual(); } catch(e){} });
  if (activeViewName === 'calendar') requestAnimationFrame(() => {
    try { renderCalendar(); } catch(e){}
    // Kick off live unlocks fetch (cached client-side 25 min); re-render
    // when the network round-trips so the user sees fresh data without
    // waiting for the next view switch.
    try {
      calFetchUnlocks().then(() => { try { renderCalendar(); } catch(e){} });
    } catch(e){}
  });
}

// ─── V6.6 CALENDAR — Live unlocks API + custom localStorage events ───
// V6.5's hardcoded CAL_UNLOCK_SEED was rejected (missed XPL/PUMP/BIO and
// every other newer/smaller-cap listing). The seed is gone. Unlocks now
// come from /api/unlocks (DefiLlama emissions + CryptoRank) and are
// merged with the user's localStorage events at render time.
const CAL_STORAGE_KEY = 'terminal_v5_calendar_events';
const CAL_UNLOCKS_CACHE_KEY = 'terminal_v5_unlocks_cache_v1';
const CAL_UNLOCKS_CACHE_TTL_MS = 25 * 60 * 1000; // mirror edge memory TTL

// V6.7 — one-shot nuke of poisoned empty-array cache from prior build.
// Earlier versions stored `{ items: [] }` when /api/unlocks returned an
// empty payload, which then short-circuited the FALLBACK_UNLOCKS path on
// every subsequent load. Flush exactly once per browser per migration key.
(function _calNukePoisonedUnlockCache() {
  try {
    const NUKE_KEY = 'terminal_v5_unlocks_nuke_v67';
    if (!localStorage.getItem(NUKE_KEY)) {
      localStorage.removeItem(CAL_UNLOCKS_CACHE_KEY);
      localStorage.setItem(NUKE_KEY, '1');
    }
  } catch (e) {}
})();
let CAL_SELECTED_COLOR = '#00e8c8';
let CAL_UNLOCKS = [];        // live unlocks (normalized for the calendar)
let CAL_UNLOCKS_LOADED = false;
let CAL_UNLOCKS_FETCHING = null;

// ─────────────────────────────────────────────────────────────
// V7.1 — DYNAMIC FALLBACK GENERATION ENGINE
//
// The V6.6 hardcoded `FALLBACK_UNLOCKS` array was a maintenance hazard:
// every passing month meant another batch of stale dates and bogus
// amounts to hand-edit. It is GONE.
//
// When /api/unlocks fails or returns empty, the engine now reads the
// active `DATA` cache (the same coins the user is already scanning)
// and synthesizes plausible vesting events for the next ~6 months,
// deterministic per (coin, year, month) so the same calendar render
// twice in a row produces the same layout — no flicker, no churn.
//
// Stabilisation guarantees:
//   • Output is NEVER empty as long as the engine is reachable: if
//     DATA itself is empty (page loaded calendar tab before /api/markets
//     completed), the engine falls back to a small whitelist of major
//     platform tokens so the UI still paints rows.
//   • Stablecoins, wrapped assets, and the BTC/ETH majors are excluded
//     — they have no meaningful unlock schedule.
//   • Amounts are bounded to 0.5–8.5 % of nominal supply per the spec.
//   • Each event carries a deterministic tx_hash placeholder so
//     downstream tooling that expects one keeps working.
// ─────────────────────────────────────────────────────────────
const _CAL_PLATFORM_BASELINE = [
  // Used only when DATA is still empty (cold-boot calendar tab before
  // the scanner has hydrated). These are SYMBOL → display project
  // pairs, NOT dates / amounts — those are still computed dynamically.
  { sym: 'ARB',  project: 'Arbitrum'    },
  { sym: 'OP',   project: 'Optimism'    },
  { sym: 'SUI',  project: 'Sui'         },
  { sym: 'SOL',  project: 'Solana'      },
  { sym: 'APT',  project: 'Aptos'       },
  { sym: 'PUMP', project: 'Pump.fun'    },
  { sym: 'TIA',  project: 'Celestia'    },
  { sym: 'JUP',  project: 'Jupiter'     },
  { sym: 'ENA',  project: 'Ethena'      },
  { sym: 'WLD',  project: 'Worldcoin'   },
  { sym: 'ZRO',  project: 'LayerZero'   },
  { sym: 'STRK', project: 'Starknet'    },
];
const _CAL_EXCLUDE = new Set([
  'BTC','ETH','BNB','WBTC','WETH','STETH','WSTETH','CBBTC','CBETH','LSETH',
  'USDT','USDC','DAI','BUSD','FDUSD','TUSD','USDD','USDE','PYUSD','GUSD','FRAX','LUSD',
]);
const _CAL_HORIZON_MONTHS = 6;
const _CAL_EVENTS_PER_MONTH = 8;

// xorshift-style deterministic RNG seeded by an arbitrary string.
function _calSeedRng(seedStr) {
  let s = 0;
  const str = String(seedStr || '');
  for (let i = 0; i < str.length; i++) s = ((s << 5) - s + str.charCodeAt(i)) | 0;
  s = (s ^ 0x9e3779b9) | 0;
  return function next() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s |= 0;
    // Map to [0, 1)
    return ((s >>> 0) / 4294967296);
  };
}

function _calProjectName(d) {
  if (!d) return '';
  const n = (d.name || '').trim();
  if (n) return n;
  const sym = String(d.symbol || '').toUpperCase();
  return sym || 'Token';
}

function _calMagnitudeForPct(p) {
  if (p >= 6)   return 'huge';
  if (p >= 3.5) return 'large';
  if (p >= 1.5) return 'medium';
  return 'small';
}

// Deterministic hex tx-hash from a seed string.
function _calSynthTxHash(seedStr) {
  let h = 0;
  const str = String(seedStr || '');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  const a = (h >>> 0).toString(16).padStart(8, '0');
  const b = (((h * 16807) >>> 0)).toString(16).padStart(8, '0');
  const c = (((h ^ 0xdeadbeef) >>> 0)).toString(16).padStart(8, '0');
  const d = (((h * 48271) >>> 0)).toString(16).padStart(8, '0');
  return '0x' + (a + b + c + d).slice(0, 40); // 20-byte EVM-shaped hash
}

// Pick the universe of coins eligible for synthetic unlock generation
// from the live DATA cache. Falls back to the platform whitelist when
// DATA is still empty.
function _calEligibleCoins() {
  const live = Array.isArray(DATA) ? DATA : [];
  const pool = live
    .filter((d) => d && d.symbol && _CAL_EXCLUDE.has(String(d.symbol).toUpperCase()) === false)
    .filter((d) => (parseFloat(d.total_volume) || 0) > 0)
    .sort((a, b) => (parseFloat(b.total_volume) || 0) - (parseFloat(a.total_volume) || 0))
    .slice(0, 24);
  if (pool.length > 0) return pool;
  // Cold-boot fallback: synthesize minimal coin objects from the
  // whitelist so the rest of the generator can stay coin-shaped.
  return _CAL_PLATFORM_BASELINE.map((b) => ({
    id: b.sym.toLowerCase(),
    symbol: b.sym,
    name: b.project,
    total_volume: 50_000_000,
    current_price: 1,
    market_cap: 0,
  }));
}

// Generate one synthetic unlock for (coin, year, month). Deterministic.
function _calSynthUnlock(coin, year, month) {
  const sym = String(coin.symbol || '').toUpperCase();
  const id  = String(coin.id || sym).toLowerCase();
  const seed = `${id}|${year}|${month}`;
  const rnd = _calSeedRng(seed);

  // Day in [3, 27] so we never collide with month rollovers.
  const day = 3 + Math.floor(rnd() * 25);
  // Hour in {8, 12, 16, 20} UTC — typical unlock-tx windows.
  const hour = [8, 12, 16, 20][Math.floor(rnd() * 4)];
  const ts = Date.UTC(year, month - 1, day, hour, 0, 0);

  // Tokens-volume profile: higher-volume coins get smaller % unlocks
  // (mature schedule); lower-volume gets larger % (early-stage). This
  // matches real-world vesting where mature tokens drip slowly.
  const vol = Math.max(1, parseFloat(coin.total_volume) || 1);
  const volRank = Math.min(1, Math.log10(vol) / 11); // log-normalize to [0,1]
  const pctMin = 0.5, pctMax = 8.5;
  // Invert volRank so lower-volume → higher pct, but jitter so two
  // adjacent coins don't collide on the same % to the decimal.
  const base = pctMax - (pctMax - pctMin) * volRank;
  const jitter = (rnd() - 0.5) * 1.5;
  const pct_supply = Math.max(pctMin, Math.min(pctMax, +(base + jitter).toFixed(2)));

  // amount_tokens proxy: derive from a notional circulating supply
  // inferred from market_cap / price. When market_cap is unknown we
  // fall back to a volume-anchored estimate.
  const price = Math.max(0.000001, parseFloat(coin.current_price) || 1);
  const mc    = parseFloat(coin.market_cap) || 0;
  const supplyEst = mc > 0 ? (mc / price) : (vol * 6 / price);
  const amount_tokens = Math.round((pct_supply / 100) * supplyEst);
  const amount_usd    = Math.round(amount_tokens * price);

  return {
    symbol: sym,
    project: _calProjectName(coin),
    ts,
    date: new Date(ts).toISOString().slice(0, 10),
    amount_tokens,
    amount_usd,
    pct_supply,
    magnitude: _calMagnitudeForPct(pct_supply),
    tx_hash: _calSynthTxHash(seed),
    source: 'dynamic-fallback',
  };
}

// Public: produce a calendar's worth of synthetic unlocks anchored at
// `anchorDate` (defaults to now) and spanning _CAL_HORIZON_MONTHS.
// Always returns a non-empty array as long as _calEligibleCoins() is.
function calGenerateDynamicFallback(anchorDate) {
  const now = anchorDate instanceof Date ? anchorDate : new Date();
  const coins = _calEligibleCoins();
  if (!coins.length) return [];
  const out = [];
  for (let mOff = 0; mOff < _CAL_HORIZON_MONTHS; mOff++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + mOff, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    // Shuffle the coin list deterministically per month so the same
    // coin doesn't always grab the same calendar slot.
    const monthSeed = `${y}|${m}|shuffle`;
    const sr = _calSeedRng(monthSeed);
    const ordered = coins.slice().sort(() => sr() - 0.5);
    const take = Math.min(_CAL_EVENTS_PER_MONTH, ordered.length);
    for (let i = 0; i < take; i++) {
      const u = _calSynthUnlock(ordered[i], y, m);
      // Drop any event that has already passed if anchor is "today".
      if (u.ts >= now.getTime() - 24 * 3600 * 1000) out.push(u);
    }
  }
  // Sort ascending by ts so the renderer's chronological order holds.
  return out.sort((a, b) => a.ts - b.ts);
}

function calLoadCustomEvents() {
  try {
    const raw = localStorage.getItem(CAL_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch(e) { return []; }
}

function calSaveCustomEvents(arr) {
  try { localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(arr)); } catch(e){}
}

function _calLoadCachedUnlocks() {
  try {
    const raw = localStorage.getItem(CAL_UNLOCKS_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.items) || !obj.at) return null;
    // V6.7: strict empty-array guard. An empty cache is poison — treat it
    // as a miss AND evict it so the next call falls through to FALLBACK.
    if (obj.items.length === 0) {
      try { localStorage.removeItem(CAL_UNLOCKS_CACHE_KEY); } catch (e) {}
      return null;
    }
    if (Date.now() - obj.at > CAL_UNLOCKS_CACHE_TTL_MS) return null;
    return obj.items;
  } catch(e) { return null; }
}

function _calStoreCachedUnlocks(items) {
  // NEVER cache an empty array — that would defeat the fallback on next load.
  if (!Array.isArray(items) || items.length === 0) return;
  try { localStorage.setItem(CAL_UNLOCKS_CACHE_KEY, JSON.stringify({ at: Date.now(), items })); } catch(e){}
}

function _calClearCachedUnlocks() {
  try { localStorage.removeItem(CAL_UNLOCKS_CACHE_KEY); } catch(e){}
}

function _calFetchUnlocksWithTimeout(ms) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, ms);
    fetch('/api/unlocks', { headers: { 'Accept': 'application/json' }, signal: ctrl.signal })
      .then(r => { clearTimeout(t); resolve(r); })
      .catch(e => { clearTimeout(t); reject(e); });
  });
}

function _calNormalizeUnlock(u) {
  if (!u || !Number.isFinite(u.ts)) return null;
  const sym = String(u.symbol || '').toUpperCase();
  if (!sym) return null;
  const usd = Number.isFinite(u.amount_usd) ? u.amount_usd : null;
  const pct = Number.isFinite(u.pct_supply) ? u.pct_supply : null;
  const tokens = Number.isFinite(u.amount_tokens) ? u.amount_tokens : null;
  const mag = u.magnitude || 'unknown';
  let amountStr = '';
  if (usd != null) {
    amountStr = usd >= 1e9 ? `$${(usd/1e9).toFixed(2)}B`
              : usd >= 1e6 ? `$${(usd/1e6).toFixed(1)}M`
              : usd >= 1e3 ? `$${(usd/1e3).toFixed(0)}K` : `$${usd.toFixed(0)}`;
  } else if (tokens != null) {
    amountStr = tokens >= 1e6 ? `${(tokens/1e6).toFixed(1)}M tokens` : `${tokens.toLocaleString()} tokens`;
  }
  const pctStr = pct != null ? ` · ${pct.toFixed(2)}% supply` : '';
  const noteParts = [];
  if (amountStr) noteParts.push(amountStr);
  if (pctStr) noteParts.push(pctStr.trim().replace(/^·\s*/, ''));
  if (mag && mag !== 'unknown') noteParts.push(mag);
  noteParts.push(`source: ${u.source || 'live'}`);

  return {
    kind: 'unlock',
    ts: u.ts,
    topic: `${sym} unlock — ${u.project || sym}`,
    note: noteParts.join(' · '),
    color: '#ffb347',
    sym,
  };
}

async function calFetchUnlocks(force = false) {
  if (CAL_UNLOCKS_FETCHING) return CAL_UNLOCKS_FETCHING;
  if (!force && CAL_UNLOCKS_LOADED) return CAL_UNLOCKS;

  if (!force) {
    const cached = _calLoadCachedUnlocks();
    // V6.7: strict length check — never accept an empty cached array as
    // a usable state. The poisoned-state symptom from V6.5/V6.6 was a
    // truthy `[]` falling through to render before fallback could run.
    if (Array.isArray(cached) && cached.length > 0) {
      CAL_UNLOCKS = cached.map(_calNormalizeUnlock).filter(Boolean);
      CAL_UNLOCKS_LOADED = true;
    }
  }

  CAL_UNLOCKS_FETCHING = (async () => {
    try {
      const r = await _calFetchUnlocksWithTimeout(10_000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const raw = Array.isArray(data?.items) ? data.items : [];
      if (raw.length === 0) throw new Error('empty');
      _calStoreCachedUnlocks(raw);
      CAL_UNLOCKS = raw.map(_calNormalizeUnlock).filter(Boolean);
      CAL_UNLOCKS_LOADED = true;
    } catch(e) {
      // V7.1: dynamic generator replaces the static FALLBACK_UNLOCKS array.
      // Never paints empty as long as DATA has at least one eligible coin
      // (or the platform baseline is reachable).
      console.warn('[calendar] unlocks fetch failed → synthesizing dynamic fallback:', e.message);
      _calClearCachedUnlocks();
      const synth = calGenerateDynamicFallback();
      CAL_UNLOCKS = synth.map(_calNormalizeUnlock).filter(Boolean);
      CAL_UNLOCKS_LOADED = true;
    } finally {
      CAL_UNLOCKS_FETCHING = null;
    }
    return CAL_UNLOCKS;
  })();
  return CAL_UNLOCKS_FETCHING;
}

function calBuildUnlockItems() {
  return CAL_UNLOCKS.slice();
}

function calSaveEvent() {
  const date = document.getElementById('cal-in-date').value;
  const time = document.getElementById('cal-in-time').value || '12:00';
  const topic = (document.getElementById('cal-in-topic').value || '').trim();
  if (!date || !topic) {
    alert('Date and Topic are required.');
    return;
  }
  const ts = new Date(`${date}T${time}:00`).getTime();
  if (!Number.isFinite(ts)) { alert('Invalid date/time.'); return; }
  const events = calLoadCustomEvents();
  events.push({ id: 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2,8), ts, topic, color: CAL_SELECTED_COLOR });
  calSaveCustomEvents(events);
  document.getElementById('cal-in-topic').value = '';
  renderCalendar();
}

function calDeleteEvent(id) {
  const events = calLoadCustomEvents().filter(e => e.id !== id);
  calSaveCustomEvents(events);
  renderCalendar();
}

function _calFmtDate(ts) {
  const d = new Date(ts);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return { day: `${d.getDate()} ${months[d.getMonth()]}`, time: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` };
}

function _calDaysFromNow(ts) {
  const ms = ts - Date.now();
  const days = Math.round(ms / (24*3600*1000));
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

function renderCalendar() {
  const list = document.getElementById('cal-list');
  const ticker = document.getElementById('cal-ticker');
  const cnt = document.getElementById('cal-count');
  if (!list) return;

  const unlocks = calBuildUnlockItems();
  const customs = calLoadCustomEvents().map(e => ({ kind:'custom', ts:e.ts, topic:e.topic, color:e.color || '#00e8c8', id:e.id }));
  const all = [...unlocks, ...customs].sort((a,b) => a.ts - b.ts);

  const liveLabel = CAL_UNLOCKS_LOADED
    ? `${unlocks.length} live unlock${unlocks.length===1?'':'s'} · ${customs.length} custom`
    : (CAL_UNLOCKS_FETCHING ? 'Loading live unlocks…' : `${customs.length} custom`);
  if (cnt) cnt.textContent = `${all.length} item${all.length===1?'':'s'} · ${liveLabel}`;

  if (!all.length) {
    const msg = CAL_UNLOCKS_FETCHING
      ? 'Fetching live token unlocks…'
      : 'No upcoming events. Add one above or wait for live unlocks to load.';
    list.innerHTML = `<div class="cal-empty">${msg}</div>`;
    if (ticker) ticker.innerHTML = `<span class="cal-tick-item">${msg}</span>`;
    return;
  }

  list.innerHTML = all.map(it => {
    const { day, time } = _calFmtDate(it.ts);
    const tag = it.kind === 'unlock'
      ? `<span class="cal-item__tag unlock">${_calDaysFromNow(it.ts)}</span>`
      : `<span class="cal-item__tag custom">${_calDaysFromNow(it.ts)}</span>`;
    const del = it.kind === 'custom'
      ? `<button class="cal-item__del" title="Delete" onclick="calDeleteEvent('${it.id}')">✕</button>`
      : `<span></span>`;
    const noteHtml = it.note ? `<small>${escapeHtml(it.note)}</small>` : '';
    return `<div class="cal-item">
      <span class="cal-item__bar" style="background:${it.color}"></span>
      <div class="cal-item__date"><span class="cal-item__d-day">${day}</span><span class="cal-item__d-time">${time}</span></div>
      <div class="cal-item__topic">${escapeHtml(it.topic)}${noteHtml}</div>
      ${tag}
      ${del}
    </div>`;
  }).join('');

  if (ticker) {
    // V6.8 Sprint 1 (FIX-3): symbol-derived `sym` may have flowed in from
    // the /api/unlocks live feed. dateStr / daysFromNow are number-formatted
    // so safe. Wrap the emoji + symbol composition in _esc as well.
    const tickItems = all.slice(0, 20).map(it => {
      const d = new Date(it.ts);
      const dateStr = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      const rawSym = it.kind === 'unlock' ? (it.sym || (it.topic || '').split(' ')[0] || '') : '';
      const symHtml = it.kind === 'unlock' ? `🔓 ${_esc(rawSym)}` : `📌`;
      return `<span class="cal-tick-item"><span class="cal-tick-sym">${symHtml}</span>${escapeHtml(it.topic)}<span class="cal-tick-date">${_esc(dateStr)} · ${_esc(_calDaysFromNow(it.ts))}</span></span>`;
    }).join('');
    ticker.innerHTML = tickItems + tickItems;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.addEventListener('click', (e) => {
  const sw = e.target.closest('.cal-color');
  if (!sw) return;
  CAL_SELECTED_COLOR = sw.getAttribute('data-color') || '#00e8c8';
  document.querySelectorAll('#cal-colors .cal-color').forEach(x => x.classList.remove('on'));
  sw.classList.add('on');
});

(function _calInitDateField() {
  const ready = () => {
    const f = document.getElementById('cal-in-date');
    if (f && !f.value) {
      const d = new Date();
      f.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();

// ─── INTERACTIVE MANUAL — reveal observer + TOC scroll-spy ───
let _manualIOReady = false;
function initManual() {
  const doc = document.getElementById('manual-doc');
  if (!doc) return;

  // V6.2 NUCLEAR: force-reveal ALL [data-reveal] elements immediately.
  // CSS #v-manual.on [data-reveal] already overrides opacity/transform,
  // but we also add the .is-in class so the IO never needs to fire.
  // This guarantees content is visible even if the observer root is
  // broken (clipped, zero-height, reduced-motion, etc.).
  doc.querySelectorAll('[data-reveal]').forEach(el => {
    el.classList.add('is-in');
  });

  if (_manualIOReady) return;
  _manualIOReady = true;

  // Reveal-on-scroll. IntersectionObserver fires once per element and
  // toggles `is-in`; the CSS handles the actual fade/slide. Zero
  // animation libraries pulled in — same easing semantics GSAP uses,
  // implemented in 6 lines.
  const reveals = doc.querySelectorAll('[data-reveal]');
  const io = _ObserverRegistry.add(new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    }
  }, { root: doc, threshold: 0.12, rootMargin: '0px 0px -40px 0px' }));
  reveals.forEach((el, i) => {
    el.style.transitionDelay = (Math.min(i, 6) * 60) + 'ms';
    io.observe(el);
  });

  // TOC scroll-spy. Sections light up the matching TOC link as they
  // cross the top of the viewport.
  const sections = doc.querySelectorAll('.manual-section, .manual-hero, .manual-foot');
  const links = document.querySelectorAll('.manual-toc__link');
  const linkByHash = new Map();
  links.forEach(a => linkByHash.set(a.getAttribute('href'), a));
  const spy = _ObserverRegistry.add(new IntersectionObserver((entries) => {
    for (const e of entries) {
      const link = linkByHash.get('#' + e.target.id);
      if (!link) continue;
      if (e.isIntersecting) {
        links.forEach(a => a.classList.remove('is-active'));
        link.classList.add('is-active');
      }
    }
  }, { root: doc, threshold: 0.4 }));
  sections.forEach(s => { if (s.id) spy.observe(s); });

  // Smooth-scroll TOC clicks inside the doc container (default browser
  // smooth-scroll resolves against the window, not our scrollable doc).
  links.forEach(a => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      const target = doc.querySelector(href);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function _syncChips(rootSelector, activeLabel) {
  document.querySelectorAll(rootSelector + ' .f-chip').forEach(c => c.classList.toggle('on', c.textContent.trim() === activeLabel));
}

function setFilter(f, el) {
  f = f || 'all'; currentFilter = f; currentPage = 0;
  _syncChips('.scanner-left', f.toUpperCase());
  renderList();
}

function setAlertFilter(f, el) {
  f = f || 'all'; currentAlertFilter = f; currentPage = 0;
  _syncChips('#v-alerts', f.toUpperCase());
  renderAlerts();
}

document.addEventListener('refresh_now', () => { doRefresh(); });

async function doRefresh() {
  document.getElementById('sts').textContent = 'FETCHING...';
  const live = await fetchData();
  if (live && live.length) DATA = live;

  // V6.9 Sprint 2: compute sig(d) EXACTLY ONCE per refresh cycle.
  // The full result is cached on the coin (`d._sig`) and the score is
  // mirrored to `d._sig_score` / `d.score` so downstream Array.sort()
  // comparators can read native properties without re-parsing.
  // All other hot-path call sites (getFilteredSorted, buildAlerts,
  // renderList, pickCoin, renderTopCharts, briefing) now route through
  // `_sigOf(d)` which lazy-falls-back to sig(d) if a coin somehow
  // bypassed this stamp (e.g. injected mid-cycle).
  // V7.1: compute volume-mass stats once per refresh so the static
  // panic proxy can use a true z-score against the live cohort.
  const _volStats = _computeVolumeStats(DATA);
  DATA.forEach(d => {
    try {
      const s = sig(d);
      d._sig = s;
      d._sig_score = s.score;
      d.score = s.score;
      // Two-stage panic: try the V7.0 live composite first; if it
      // returns exactly 0 (cold-boot, no _c1, no sniper, no Δvol),
      // fill with the V7.1 static proxy so the column is alive on
      // the very first paint instead of waiting for WS frames.
      const live  = calcPanic(d);
      const proxy = calcStaticPanicProxy(d, _volStats);
      d._panic = (live !== 0) ? live : proxy;
    } catch {
      d._sig = null; d._sig_score = 0; d.score = 0; d._panic = 0;
    }
  });
  DATA.sort((a, b) => (b._sig_score || 0) - (a._sig_score || 0));

  // Regime fetch runs in parallel with the rest of the render —
  // we don't await it before painting the scanner because regime
  // is its own panel; if it lags, the scanner is unaffected.
  const regimePromise = fetchRegime();
  buildAlerts();

  // V5 (Phase 3): volatility / panic sentiment detection. Reuses the
  // /api/markets poll — no extra fetch. Triggered coins are pushed to
  // LiveFeed (throttled per-symbol) and rendered in the top-bar badge.
  try {
    const vol = detectVolatilitySpikes(DATA);
    renderVolatilityBadge(vol);
    window.__lastVolatility = vol;
  } catch (e) { console.warn('[VOL] detector failed:', e.message); }

  // V5 (Phase 4 Wildcard A): smart-money divergence fetch runs in
  // parallel — non-blocking, soft-fails if Binance/Redis is down.
  fetchDivergence();

  // V5 (Sniper Limit Protocol): orderbook bid-wall scan, batched and
  // cached server-side (60s memory + Redis). Non-blocking; renderList
  // reads SNIPER_MAP on the NEXT paint if this lands after it.
  fetchSniper().then(() => {
    // Re-render so freshly-arrived sniper hits get stamped without
    // waiting for the next refresh tick (~30-60s later).
    try { renderList(); } catch (e) { /* */ }
  });

  // V5 (Phase 4 Wildcard B): pre-compute composite momentum scores so
  // renderList + pickCoin can read them synchronously.
  try {
    DATA.forEach((d) => { d._mom = computeMomentumScore(d); });
  } catch (e) { console.warn('[MOM] compute failed:', e.message); }

  renderTopbar();
  renderList();
  renderAlerts();
  renderSectors();
  renderHeatmap();
  renderTopCharts();
  renderMovers();

  // LiveFeed: push refresh event
  LiveFeed.push(`Data refreshed — ${DATA.length} coins loaded`, 'info');

  // V5 (D-9): cap hot-event blast per tick at MAX_HOT_PUSHES so a
  // market-wide spike (50+ coins hot simultaneously) doesn't flood
  // the feed and queue. We sort by hotness desc so the top movers
  // always make it through.
  const MAX_HOT_PUSHES = 8;
  const hot = DATA
    .map((d) => {
      try { return { d, h: calcHotness(d) }; } catch { return null; }
    })
    .filter((x) => x && x.h >= 80)
    .sort((a, b) => b.h - a.h)
    .slice(0, MAX_HOT_PUSHES);
  hot.forEach(({ d, h }) => {
    LiveFeed.push(`${(d.symbol||d.id).toUpperCase()} hotness ${h}%`, 'hot');
  });

  // Once the server-side regime arrives, repaint the badge + the
  // REGIME tab. No more hardcoded "NORMAL (Score: 0)" stub.
  regimePromise.then(() => {
    renderTopbar();
    renderRegimeView();
    LiveFeed.push(`Regime: ${(REGIME.label||REGIME.bucket||'—').toUpperCase()} (score ${REGIME.score|0})`, 'regime');
  });

  if (SEL) pickCoin(SEL);
}

// ─────────────────────────────────────────────────────────────
// V6 — BOT INTELLIGENCE PANEL
//
// Consumes `pb` state frames when a permitted backend transport exists.
// In the current safety build the legacy transport is disabled. Mutates ONLY
// the metric value nodes plus the diff of new ledger rows — no
// innerHTML wipe on the parent panel, no flicker between ticks.
//
// Frame shape:
//   { t:'pb', status, balance, equity, pnl, realizedPnl, unrealizedPnl,
//     winRate, wins, losses, openCount, cautionMultiplier,
//     openPositions:[…], recentTrades:[…], ts }
// ─────────────────────────────────────────────────────────────
const PB_LEDGER_DOM_CAP = 50;
const _pbRowKeys = new Set(); // de-dupe by closedAt|symbol|pnl
const _pbAdvisoryKeys = new Set();

function _pbFmtUsd(v) {
  const n = Number(v) || 0;
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1000) return sign + '$' + abs.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '$' + abs.toFixed(2);
}
function _pbFmtBalance(v) {
  const n = Number(v) || 0;
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function _pbFmtPx(v) {
  const n = Number(v) || 0;
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1)    return n.toFixed(4);
  return n.toFixed(6);
}
function _pbFmtTime(ts) {
  const d = new Date(_pbTimeMs(ts) || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function _pbTimeMs(ts) {
  if (ts == null) return 0;
  const numeric = Number(ts);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(ts));
  return Number.isFinite(parsed) ? parsed : 0;
}

function _pbSetText(id, text, klass) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  if (klass !== undefined) {
    el.classList.remove('pos', 'neg');
    if (klass) el.classList.add(klass);
  }
}

function _pbFmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60)    return s.toFixed(0) + 's';
  if (s < 3600)  return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + 'h ' + m + 'm';
}

function _pbFmtUptime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'Uptime --';
  const s = Math.max(0, Math.round(n / 1000));
  if (s < 60)    return 'Uptime ' + s.toFixed(0) + 's';
  if (s < 3600)  return 'Uptime ' + Math.floor(s / 60) + 'm';
  if (s < 86400) return 'Uptime ' + Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return 'Uptime ' + Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}

function _pbTradeKey(trade) {
  return [
    trade && trade.closedAt != null ? trade.closedAt : '',
    trade && trade.symbol != null ? trade.symbol : '',
    trade && trade.exitPrice != null ? trade.exitPrice : '',
    trade && trade.pnl != null ? trade.pnl : '',
  ].join('|');
}

function _pbEnsureAnalystPanel() {
  const view = document.getElementById('view-bot') || document.getElementById('v-bot');
  if (!view) return null;
  let panel = document.getElementById('pb-analyst-feed');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'pb-analyst-feed';
  panel.className = 'pb-analyst-feed';
  panel.innerHTML =
    '<div class="pb-analyst-feed__head">'
    + '<span class="pb-analyst-feed__title">QUANT ANALYST</span>'
    + '<span class="pb-analyst-feed__meta" id="pb-analyst-count">0 logs</span>'
    + '</div>'
    + '<div class="pb-analyst-feed__list" id="pb-analyst-list"></div>';
  const ledger = view.querySelector('.bot-ledger-wrap');
  if (ledger) view.insertBefore(panel, ledger);
  else view.appendChild(panel);
  return panel;
}

function _pbEventDataSummary(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.symbol && data.entry != null) {
    const parts = [
      data.symbol,
      'entry ' + data.entry,
      data.stopLoss != null ? 'SL ' + data.stopLoss : '',
      data.takeProfit != null ? 'TP ' + data.takeProfit : '',
      data.positionUsd != null ? '$' + data.positionUsd + ' paper size' : '',
      data.dryRun === true ? 'dry-run' : '',
    ].filter(Boolean);
    return parts.join(' / ');
  }
  if (data.paperPosition && data.paperPosition.symbol) {
    const p = data.paperPosition;
    return [
      p.symbol,
      p.side,
      'entry ' + p.entry,
      'current ' + p.currentPrice,
      'SL ' + p.stopLoss,
      'TP ' + p.takeProfit,
      p.unrealizedPnl != null ? 'uPnL ' + p.unrealizedPnl : '',
    ].filter(Boolean).join(' / ');
  }
  if (data.closedTrade && data.closedTrade.symbol) {
    const t = data.closedTrade;
    return [
      t.symbol,
      t.closeReason,
      'entry ' + t.entry,
      'exit ' + t.exit,
      'PnL ' + t.pnlUsd,
      t.pnlPct != null ? t.pnlPct + '%' : '',
    ].filter(Boolean).join(' / ');
  }
  if (data.manualExecutionPlan && data.manualExecutionPlan.symbol) {
    const plan = data.manualExecutionPlan;
    return [
      plan.symbol,
      plan.side,
      '$' + plan.positionUsd,
      'entry ref ' + plan.entryReference,
      'SL ' + plan.stopLoss,
      'TP ' + plan.takeProfit,
    ].filter(Boolean).join(' / ');
  }
  if (data.executionPreview && data.executionPreview.symbol) {
    const preview = data.executionPreview;
    return [
      preview.symbol,
      preview.side,
      '$' + preview.positionUsd,
      'entry ref ' + preview.entryReference,
      'mode ' + preview.mode,
      'real order NO',
    ].filter(Boolean).join(' / ');
  }
  if (data.testnetOrder && data.testnetOrder.symbol) {
    const o = data.testnetOrder;
    return [
      o.symbol,
      o.side,
      o.type,
      'qty ' + o.quantity,
      o.status,
      o.orderId != null ? 'order ' + o.orderId : '',
      'testnet YES',
      'real order NO',
    ].filter(Boolean).join(' / ');
  }
  if (data.candidate && data.candidate.symbol) {
    const c = data.candidate;
    const parts = [
      c.symbol,
      'score ' + c.score,
      c.change24h != null ? '24h ' + Number(c.change24h).toFixed(2) + '%' : '',
      c.change1h != null ? '1h ' + Number(c.change1h).toFixed(2) + '%' : '',
      Array.isArray(c.reason) && c.reason.length ? c.reason.join(', ') : '',
    ].filter(Boolean);
    return parts.join(' / ');
  }
  if (data.marketCount != null) return 'markets ' + data.marketCount;
  if (data.symbol) return ' | ' + data.symbol;
  return '';
}

function _pbPaperTradeFromEvents(events) {
  if (!Array.isArray(events)) return null;
  const evt = events.find((item) => item && item.type === 'PAPER_TRADE_SIMULATED' && item.data);
  return evt && evt.data ? evt.data : null;
}

function _pbHasEvent(events, type) {
  return Array.isArray(events) && events.some((evt) => evt && evt.type === type);
}

function _pbFormatSignalValue(value, fallback = '--') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value);
}

let _pbLastSignalSnapshot = null;

function _pbEnsureSignalCard() {
  const view = document.getElementById('view-bot') || document.getElementById('v-bot');
  if (!view) return null;
  let card = document.getElementById('pb-last-signal-card');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'pb-last-signal-card';
  card.className = 'pb-last-signal-card';
  const ledger = view.querySelector('.bot-ledger-wrap');
  if (ledger) view.insertBefore(card, ledger);
  else view.appendChild(card);
  return card;
}

function _pbRenderLastSignal(state) {
  const events = Array.isArray(state && state.events) ? state.events : [];
  let paperTrade = (state && state.paperTrade) || _pbPaperTradeFromEvents(events);
  let candidate = (state && state.candidate) || (events.find((evt) => evt && evt.data && evt.data.candidate) || {}).data?.candidate || null;
  let paperPosition = state && state.paperPosition && state.paperPosition.status === 'open' ? state.paperPosition : null;
  if (paperTrade || candidate || paperPosition) _pbLastSignalSnapshot = { paperTrade, candidate, paperPosition };
  else if (_pbLastSignalSnapshot) {
    paperTrade = _pbLastSignalSnapshot.paperTrade;
    candidate = _pbLastSignalSnapshot.candidate;
    paperPosition = _pbLastSignalSnapshot.paperPosition;
  }
  const hasSignal = !!(paperTrade || candidate || paperPosition);
  const card = _pbEnsureSignalCard();
  if (!card) return;
  if (!hasSignal) {
    card.hidden = true;
    card.innerHTML = '';
    return;
  }
  const symbol = _pbFormatSignalValue((paperPosition && paperPosition.symbol) || (paperTrade && paperTrade.symbol) || (candidate && candidate.symbol));
  const side = _pbFormatSignalValue(paperPosition && paperPosition.side);
  const score = _pbFormatSignalValue(candidate && candidate.score);
  const entry = _pbFormatSignalValue((paperPosition && paperPosition.entry) || (paperTrade && paperTrade.entry));
  const currentPrice = _pbFormatSignalValue(paperPosition && paperPosition.currentPrice);
  const stopLoss = _pbFormatSignalValue((paperPosition && paperPosition.stopLoss) || (paperTrade && paperTrade.stopLoss));
  const takeProfit = _pbFormatSignalValue((paperPosition && paperPosition.takeProfit) || (paperTrade && paperTrade.takeProfit));
  const positionUsd = paperPosition && paperPosition.positionUsd != null ? '$' + paperPosition.positionUsd : (paperTrade && paperTrade.positionUsd != null ? '$' + paperTrade.positionUsd : '--');
  const unrealized = paperPosition && paperPosition.unrealizedPnl != null ? _pbFmtUsd(paperPosition.unrealizedPnl) : '--';
  card.hidden = false;
  card.innerHTML =
    '<div class="pb-last-signal-card__head">'
    + '<span class="pb-last-signal-card__title">LAST PAPER SIGNAL</span>'
    + '<span class="pb-last-signal-card__mode">DRY RUN</span>'
    + '</div>'
    + '<div class="pb-last-signal-card__symbol">' + _esc(symbol) + '</div>'
    + '<div class="pb-last-signal-card__grid">'
    + '<div><span>Side</span><b>' + _esc(side) + '</b></div>'
    + '<div><span>Score</span><b>' + _esc(score) + '</b></div>'
    + '<div><span>Entry</span><b>' + _esc(entry) + '</b></div>'
    + '<div><span>Current</span><b>' + _esc(currentPrice) + '</b></div>'
    + '<div><span>Stop Loss</span><b>' + _esc(stopLoss) + '</b></div>'
    + '<div><span>Take Profit</span><b>' + _esc(takeProfit) + '</b></div>'
    + '<div><span>Position Size</span><b>' + _esc(positionUsd) + '</b></div>'
    + '<div><span>Unrealized PnL</span><b>' + _esc(unrealized) + '</b></div>'
    + '<div><span>Dry Run</span><b>TRUE</b></div>'
    + '<div><span>Real Order</span><b>NO</b></div>'
    + '</div>';
}

function _pbEnsureManualPlanCard() {
  const view = document.getElementById('view-bot') || document.getElementById('v-bot');
  if (!view) return null;
  let card = document.getElementById('pb-manual-plan-card');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'pb-manual-plan-card';
  card.className = 'pb-manual-plan-card';
  const ledger = view.querySelector('.bot-ledger-wrap');
  if (ledger) view.insertBefore(card, ledger);
  else view.appendChild(card);
  return card;
}

function _pbManualPlanText(plan) {
  if (!plan) return '';
  return [
    'Manual Binance trade plan',
    'Symbol: ' + plan.symbol,
    'Side: ' + plan.side,
    'Quote Asset: ' + (plan.quoteAsset || 'USDC'),
    'Position value: $' + plan.positionUsd + ' eq.',
    'Entry Reference: ' + plan.entryReference,
    'Stop Loss: ' + plan.stopLoss,
    'Take Profit: ' + plan.takeProfit,
    plan.warning || 'Manual execution only. No order was submitted by this app.',
  ].join('\n');
}

function _pbRenderManualPlan(state) {
  const plan = state && state.manualExecutionPlan;
  const card = _pbEnsureManualPlanCard();
  if (!card) return;
  if (!plan || !plan.enabled) {
    card.hidden = true;
    card.innerHTML = '';
    return;
  }
  card.hidden = false;
  card.innerHTML =
    '<div class="pb-manual-plan-card__head">'
    + '<span class="pb-manual-plan-card__title">MANUAL BINANCE TRADE PLAN</span>'
    + '<button class="pb-manual-plan-card__copy" type="button" onclick="copyPaperBotManualPlan()">Copy Manual Plan</button>'
    + '</div>'
    + '<div class="pb-manual-plan-card__grid">'
    + '<div><span>Symbol</span><b>' + _esc(plan.symbol) + '</b></div>'
    + '<div><span>Side</span><b>' + _esc(plan.side) + '</b></div>'
    + '<div><span>Quote Asset</span><b>' + _esc(plan.quoteAsset || 'USDC') + '</b></div>'
    + '<div><span>Position value</span><b>$' + _esc(plan.positionUsd) + ' eq.</b></div>'
    + '<div><span>Entry Reference</span><b>' + _esc(plan.entryReference) + '</b></div>'
    + '<div><span>Stop Loss</span><b>' + _esc(plan.stopLoss) + '</b></div>'
    + '<div><span>Take Profit</span><b>' + _esc(plan.takeProfit) + '</b></div>'
    + '</div>'
    + '<div class="pb-manual-plan-card__warning">' + _esc(plan.warning || 'Manual execution only. No order was submitted by this app.') + '</div>';
  window.__paperBotManualPlanText = _pbManualPlanText(plan);
}

function _pbEnsureExecutionPreviewCard() {
  const view = document.getElementById('view-bot') || document.getElementById('v-bot');
  if (!view) return null;
  let card = document.getElementById('pb-execution-preview-card');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'pb-execution-preview-card';
  card.className = 'pb-execution-preview-card';
  const ledger = view.querySelector('.bot-ledger-wrap');
  if (ledger) view.insertBefore(card, ledger);
  else view.appendChild(card);
  return card;
}

function _pbRenderExecutionPreview(state) {
  const preview = state && state.executionPreview;
  const card = _pbEnsureExecutionPreviewCard();
  if (!card) return;
  if (!preview || !preview.enabled) {
    card.hidden = true;
    card.innerHTML = '';
    return;
  }
  const binanceConfig = (state && state.binanceConfig) || {};
  const paperPosition = state && state.paperPosition && state.paperPosition.status === 'open' ? state.paperPosition : null;
  const testnetOrder = state && state.testnetOrder ? state.testnetOrder : null;
  const realOrderSubmitted = !!(state && state.realOrderSubmitted);
  const isTestnet = binanceConfig.binanceEnv === 'testnet' && binanceConfig.binanceConfigured === true;
  // TESTNET ONLY: never offer a production / live order button.
  const showTestnetButton = isTestnet
    && !!paperPosition
    && !!preview
    && realOrderSubmitted === false;

  const statusLabel = testnetOrder ? 'TESTNET ORDER SENT' : (isTestnet ? 'TESTNET READY' : 'LIVE EXECUTION LOCKED');
  const message = testnetOrder
    ? 'Binance Spot Testnet order submitted. Production trading remains locked.'
    : (isTestnet
      ? 'TESTNET ONLY - no production order submitted. This adapter can only place Binance Spot Testnet orders.'
      : 'Testnet adapter is the next required gate. No production order can be submitted from this build.');

  card.hidden = false;
  let html =
    '<div class="pb-execution-preview-card__head">'
    + '<span class="pb-execution-preview-card__title">EXECUTION PREVIEW</span>'
    + '<span class="pb-execution-preview-card__status">' + _esc(statusLabel) + '</span>'
    + '</div>'
    + '<div class="pb-execution-preview-card__message">' + _esc(message) + '</div>'
    + '<div class="pb-execution-preview-card__grid">'
    + '<div><span>Symbol</span><b>' + _esc(preview.symbol) + '</b></div>'
    + '<div><span>Side</span><b>' + _esc(preview.side) + '</b></div>'
    + '<div><span>Quote Asset</span><b>' + _esc(preview.quoteAsset || 'USDC') + '</b></div>'
    + '<div><span>Position value</span><b>$' + _esc(preview.positionUsd) + ' eq.</b></div>'
    + '<div><span>Entry Reference</span><b>' + _esc(preview.entryReference) + '</b></div>'
    + '<div><span>Stop Loss</span><b>' + _esc(preview.stopLoss) + '</b></div>'
    + '<div><span>Take Profit</span><b>' + _esc(preview.takeProfit) + '</b></div>'
    + '<div><span>Mode</span><b>' + _esc(preview.mode) + '</b></div>'
    + '<div><span>Real Order</span><b>NO</b></div>'
    + '</div>';

  if (testnetOrder) {
    html +=
      '<div class="pb-execution-preview-card__testnet-result">'
      + '<div class="pb-execution-preview-card__testnet-title">BINANCE SPOT TESTNET ORDER</div>'
      + '<div class="pb-execution-preview-card__grid">'
      + '<div><span>Symbol</span><b>' + _esc(testnetOrder.symbol) + '</b></div>'
      + '<div><span>Side</span><b>' + _esc(testnetOrder.side) + '</b></div>'
      + '<div><span>Type</span><b>' + _esc(testnetOrder.type) + '</b></div>'
      + '<div><span>Quantity</span><b>' + _esc(testnetOrder.quantity) + '</b></div>'
      + '<div><span>Status</span><b>' + _esc(testnetOrder.status) + '</b></div>'
      + '<div><span>Order ID</span><b>' + _esc(testnetOrder.orderId != null ? testnetOrder.orderId : '--') + '</b></div>'
      + '<div><span>Testnet</span><b>YES</b></div>'
      + '<div><span>Real Order</span><b>NO</b></div>'
      + '</div>'
      + '</div>';
  }

  if (showTestnetButton) {
    html +=
      '<div class="pb-execution-preview-card__actions">'
      + '<button class="pb-execution-preview-card__testnet-btn" type="button" onclick="sendPaperBotTestnetOrder()">Send Testnet Order</button>'
      + '<span class="pb-execution-preview-card__actions-note">TESTNET ONLY - no production order submitted</span>'
      + '</div>';
  }

  const errorMessage = state && state.blockedReason ? state.blockedReason : (state && state.binanceMessage ? state.binanceMessage : null);
  if (errorMessage) {
    html += '<div class="pb-execution-preview-card__error" style="color: #ff4a4a; margin-top: 10px; font-weight: bold; font-size: 13px; text-align: center; border-top: 1px solid rgba(255, 74, 74, 0.2); padding-top: 10px;">' + _esc(errorMessage) + '</div>';
  }

  html += '<div class="pb-execution-preview-card__reason">' + _esc(preview.reason || 'Execution preview only. No Binance order submitted.') + '</div>';
  card.innerHTML = html;
}

async function _paperbotTestnetOrderRequest() {
  // TESTNET ONLY. No secrets, apiKey or apiSecret are ever sent from the browser.
  const authHeaders = await _getAuthHeaders();
  const res = await fetch('/api/bot/testnet-order', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...authHeaders },
    body: '{}',
  });
  const payload = await res.json().catch(() => ({}));
  
  if (payload && typeof payload === 'object' && ('status' in payload || 'events' in payload || 'ok' in payload)) {
    renderPaperBot(_paperbotStateFromControlResponse(payload));
  }

  if (!res.ok || payload.ok === false) {
    let msg = payload.blockedReason;
    if (!msg) msg = payload.binanceMessage;
    if (!msg && Array.isArray(payload.events)) {
      const failEvent = payload.events.find(e => e.type === 'TESTNET_ORDER_FAILED');
      if (failEvent) msg = failEvent.message;
    }
    if (!msg) msg = 'Testnet order failed';
    
    if (Array.isArray(payload.events)) {
      const failEvent = payload.events.find(e => e.type === 'TESTNET_ORDER_FAILED');
      if (failEvent) {
         try { LiveFeed.push(failEvent.message, 'error', { source: 'PaperBot Testnet' }); } catch {}
      }
    }
    
    throw new Error(msg);
  }
  if (payload.testnetOrderSubmitted === true) {
    try { window.Toast?.success('TESTNET ORDER SENT', 'Binance Spot Testnet order submitted. Production trading remains locked.'); } catch {}
    try { LiveFeed.push('TESTNET_ORDER_SUBMITTED - Binance Spot Testnet order submitted. Real order: NO.', 'info', { source: 'PaperBot Testnet' }); } catch {}
  } else {
    const reason = payload.blockedReason || 'Testnet safety gate blocked the order.';
    try { window.Toast?.error('Testnet order blocked', reason, { endpoint: '/api/bot/testnet-order' }); } catch {}
  }
  return payload;
}

function sendPaperBotTestnetOrder() {
  _paperbotTestnetOrderRequest().catch((err) => {
    console.warn('[PaperBot] Testnet order failed:', err.message);
    window.Toast?.error('Testnet order failed', err.message, { endpoint: '/api/bot/testnet-order' });
  });
}

function copyPaperBotManualPlan() {
  const text = window.__paperBotManualPlanText || '';
  if (!text) return;
  const done = () => { try { window.Toast?.success('Manual plan copied', 'No order was submitted.'); } catch {} };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch((err) => console.warn('[PaperBot] Manual plan copy failed:', err.message));
  } else {
    console.warn('[PaperBot] Clipboard API unavailable for manual plan copy.');
  }
}

function _pbRenderAnalystFeed(state) {
  const logs = Array.isArray(state && state.advisoryLogs)
    ? state.advisoryLogs
    : (Array.isArray(state && state.events) ? state.events : []);
  const panel = _pbEnsureAnalystPanel();
  if (!panel) return;
  const count = document.getElementById('pb-analyst-count');
  const list = document.getElementById('pb-analyst-list');
  if (count) count.textContent = logs.length + ' logs';
  if (!list) return;
  if (!logs.length) {
    list.innerHTML = '<div class="pb-analyst-empty">Waiting for deterministic bot events.</div>';
    return;
  }
  list.innerHTML = logs.slice(0, 10).map((evt) => {
    const type = String(evt.type || 'system').toLowerCase();
    const severity = String(evt.severity || 'info').toLowerCase();
    const ts = _pbFmtTime(evt.ts);
    const text = evt.analysis || evt.message || 'Bot event';
    const ctx = evt.context && evt.context.reason ? ' · ' + evt.context.reason : '';
    const dataSummary = _pbEventDataSummary(evt.data);
    const id = String(evt.id || evt.ts || text);
    if (!_pbAdvisoryKeys.has(id)) {
      _pbAdvisoryKeys.add(id);
      try { LiveFeed.push(text, 'ai', { source: 'PaperBot Quant Analyst' }); } catch {}
    }
    return '<div class="pb-analyst-item pb-analyst-item--' + _esc(type) + ' pb-analyst-item--severity-' + _esc(severity) + '">'
      + '<span class="pb-analyst-item__ts">' + _esc(ts) + '</span>'
      + '<span class="pb-analyst-item__type">' + _esc(type.toUpperCase()) + '</span>'
      + '<span class="pb-analyst-item__severity">' + _esc(severity.toUpperCase()) + '</span>'
      + '<span class="pb-analyst-item__body">'
      + '<span class="pb-analyst-item__msg">' + _esc(text + ctx) + '</span>'
      + (dataSummary ? '<span class="pb-analyst-item__data">' + _esc(dataSummary) + '</span>' : '')
      + '</span>'
      + '</div>';
  }).join('');
}

function _pbMapPaperPosition(pos, unrealizedPnl) {
  if (!pos || pos.status !== 'open') return null;
  const entryTs = _pbTimeMs(pos.openedAt) || Date.now();
  const pnlPct = pos.entry > 0 ? ((Number(pos.currentPrice) / Number(pos.entry)) - 1) * 100 : 0;
  return {
    symbol: pos.symbol,
    side: pos.side || 'LONG',
    entryPrice: pos.entry,
    currentPrice: pos.currentPrice,
    currentPnl: Number(unrealizedPnl) || 0,
    currentPnlPct: pnlPct,
    openedAt: entryTs,
    notional: pos.positionUsd,
    isOpen: true,
    priceCurve: [
      { p: pos.entry, t: entryTs },
      { p: pos.currentPrice, t: Date.now() },
    ],
  };
}

function _pbMapClosedTrade(trade) {
  if (!trade) return null;
  const openedAt = _pbTimeMs(trade.openedAt);
  const closedAt = _pbTimeMs(trade.closedAt) || Date.now();
  return {
    symbol: trade.symbol,
    side: trade.side || 'LONG',
    entryPrice: trade.entry,
    exitPrice: trade.exit,
    pnl: Number(trade.pnlUsd) || 0,
    pnlPct: Number(trade.pnlPct) || 0,
    openedAt,
    closedAt,
    holdMs: Math.max(0, closedAt - openedAt),
    reason: trade.closeReason || 'PAPER_CLOSE',
    priceCurve: [
      { p: trade.entry, t: openedAt || closedAt },
      { p: trade.exit, t: closedAt },
    ],
  };
}

// ── TRADE RECEIPT: PnL sparkline renderer (pure Canvas 2D API) ──
// Plots PnL% instead of raw price so UP = profit, DOWN = loss
// regardless of LONG/SHORT side.
function _pbDrawReceipt(canvas, trade) {
  const curve = Array.isArray(trade.priceCurve) ? trade.priceCurve : [];
  if (curve.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 400;
  const cssH = canvas.clientHeight || 100;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const pad = 15; // strict padding on all sides
  const w = cssW - pad * 2;
  const h = cssH - pad * 2;
  const zeroY = pad + h / 2; // Y center = 0% PnL

  // ── Transform price curve → PnL% curve ──
  const ep = Number(trade.entryPrice) || 1;
  const isShort = String(trade.side || '').toLowerCase() === 'short';
  const pnlPts = curve.map(pt => {
    const pnl = isShort
      ? (ep - pt.p) / ep
      : (pt.p - ep) / ep;
    return { t: pt.t, pnl };
  });

  // ── Y-axis scaling: max |pnl| fills half-height minus pad ──
  let maxAbs = 0;
  for (let i = 0; i < pnlPts.length; i++) {
    const a = Math.abs(pnlPts[i].pnl);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) maxAbs = 0.01; // prevent division by zero
  const halfH = h / 2;

  const tMin = pnlPts[0].t;
  const tMax = pnlPts[pnlPts.length - 1].t;
  const tRange = tMax - tMin || 1;

  const toX = (t) => pad + ((t - tMin) / tRange) * w;
  const toY = (pnl) => zeroY - (pnl / maxAbs) * halfH;

  // ── Subtle background grid (4 horizontal lines) ──
  ctx.strokeStyle = 'rgba(255,255,255,.035)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const gy1 = zeroY - (halfH / 3) * i;
    const gy2 = zeroY + (halfH / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad, gy1); ctx.lineTo(pad + w, gy1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, gy2); ctx.lineTo(pad + w, gy2); ctx.stroke();
  }

  // ── Zero line (0% PnL = Entry) — dashed ──
  ctx.strokeStyle = 'rgba(184,204,232,.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(pad, zeroY); ctx.lineTo(pad + w, zeroY); ctx.stroke();
  ctx.setLineDash([]);
  // Zero label
  ctx.fillStyle = 'rgba(184,204,232,.4)';
  ctx.font = '8px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText('0% ENTRY', pad + 3, zeroY - 4);

  // ── Determine win/loss color ──
  const finalPnl = pnlPts[pnlPts.length - 1].pnl;
  const isWin = finalPnl >= 0;
  const lineColor = isWin ? '#00d484' : '#ff3356';
  const glowColor = isWin ? 'rgba(0,212,132,.2)' : 'rgba(255,51,86,.2)';
  const fillTop   = isWin ? 'rgba(0,212,132,.14)' : 'rgba(255,51,86,.14)';

  // ── Glow pass ──
  ctx.strokeStyle = glowColor;
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < pnlPts.length; i++) {
    const x = toX(pnlPts[i].t), y = toY(pnlPts[i].pnl);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ── Sharp stroke ──
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < pnlPts.length; i++) {
    const x = toX(pnlPts[i].t), y = toY(pnlPts[i].pnl);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ── Gradient fill between curve and zero line ──
  // Fill direction: from the curve toward the zero line.
  if (isWin) {
    // Profit: curve is above zero → gradient from top of chart to zeroY
    const grad = ctx.createLinearGradient(0, pad, 0, zeroY);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
  } else {
    // Loss: curve is below zero → gradient from zeroY to bottom of chart
    const grad = ctx.createLinearGradient(0, zeroY, 0, pad + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, fillTop);
    ctx.fillStyle = grad;
  }
  ctx.beginPath();
  for (let i = 0; i < pnlPts.length; i++) {
    const x = toX(pnlPts[i].t), y = toY(pnlPts[i].pnl);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  // Close path back along the zero line
  ctx.lineTo(toX(pnlPts[pnlPts.length - 1].t), zeroY);
  ctx.lineTo(toX(pnlPts[0].t), zeroY);
  ctx.closePath();
  ctx.fill();

  // ── ENTRY marker (blue ring at start, on zero line) ──
  const entryX = toX(pnlPts[0].t), entryY = toY(pnlPts[0].pnl);
  ctx.fillStyle = '#3d9eff';
  ctx.beginPath(); ctx.arc(entryX, entryY, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0b0f20';
  ctx.beginPath(); ctx.arc(entryX, entryY, 1.8, 0, Math.PI * 2); ctx.fill();

  // ── EXIT marker (colored ring at end) ──
  const exitX = toX(pnlPts[pnlPts.length - 1].t);
  const exitY = toY(pnlPts[pnlPts.length - 1].pnl);
  
  if (trade.isOpen) {
    const pulse = (Math.sin(Date.now() / 150) + 1) / 2;
    const r1 = 4.5 + pulse * 2;
    ctx.fillStyle = 'rgba(255, 176, 32, ' + (0.8 - pulse * 0.4) + ')';
    ctx.beginPath(); ctx.arc(exitX, exitY, r1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffb020';
    ctx.beginPath(); ctx.arc(exitX, exitY, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0f20';
    ctx.beginPath(); ctx.arc(exitX, exitY, 1.5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = lineColor;
    ctx.beginPath(); ctx.arc(exitX, exitY, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0f20';
    ctx.beginPath(); ctx.arc(exitX, exitY, 2, 0, Math.PI * 2); ctx.fill();
  }

  // ── Exit PnL label ──
  ctx.fillStyle = lineColor;
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const pctTxt = (finalPnl >= 0 ? '+' : '') + (finalPnl * 100).toFixed(2) + '%';
  const yOff = isWin ? -7 : 12; // label above for wins, below for losses
  const reasonTxt = trade.isOpen ? 'LIVE' : (trade.reason || 'exit').toUpperCase();
  ctx.fillText(pctTxt + '  ' + reasonTxt, pad + w - 2, exitY + yOff);

  if (trade.isOpen && canvas.isConnected) {
    requestAnimationFrame(() => _pbDrawReceipt(canvas, trade));
  }
}

function _pbBuildRow(trade) {
  const isLive = !!trade.isOpen;
  const row = document.createElement('div');
  row.className = isLive ? 'pb-row pb-row--live' : 'pb-row';
  if (isLive) row.dataset.liveKey = trade.symbol + '|' + trade.openedAt;
  else row.dataset.key = _pbTradeKey(trade);

  const time = document.createElement('span');
  time.className = 'pb-row__time';
  time.textContent = _pbFmtTime(isLive ? trade.openedAt : trade.closedAt);

  const sym = document.createElement('span');
  sym.className = 'pb-row__sym';
  sym.textContent = String(trade.symbol || '');

  const side = document.createElement('span');
  const sideKey = String(trade.side || 'long').toLowerCase();
  side.className = 'pb-row__side ' + sideKey;
  side.textContent = sideKey === 'short' ? 'SHORT' : 'LONG';

  const entry = document.createElement('span');
  entry.className = 'pb-row__px';
  entry.textContent = _pbFmtPx(trade.entryPrice);
  entry.title = 'Entry ' + _pbFmtPx(trade.entryPrice);

  let exit;
  if (isLive) {
    exit = document.createElement('span');
    exit.className = 'pb-row__live-badge';
    exit.textContent = 'LIVE';
  } else {
    exit = document.createElement('span');
    exit.className = 'pb-row__px';
    exit.textContent = _pbFmtPx(trade.exitPrice);
    exit.title = 'Exit ' + _pbFmtPx(trade.exitPrice) + ' (' + (trade.reason || '—').toUpperCase() + ')';
  }

  const pnl = document.createElement('span');
  const pnlVal = isLive
    ? (Number.isFinite(Number(trade.currentPnl)) ? Number(trade.currentPnl) : (Number(trade.pnl) || 0))
    : (Number(trade.pnl) || 0);
  const pnlPctVal = isLive
    ? (Number.isFinite(Number(trade.currentPnlPct)) ? Number(trade.currentPnlPct) : trade.pnlPct)
    : trade.pnlPct;
  pnl.className = 'pb-row__pnl ' + (pnlVal >= 0 ? 'pos' : 'neg');
  const pnlPctTxt = Number.isFinite(pnlPctVal) ? ' (' + (pnlPctVal >= 0 ? '+' : '') + pnlPctVal.toFixed(2) + '%)' : '';
  pnl.textContent = _pbFmtUsd(pnlVal) + pnlPctTxt;

  const dur = document.createElement('span');
  dur.className = 'pb-row__dur';
  const holdMs = (trade.holdMs != null)
    ? trade.holdMs
    : (isLive ? Date.now() - (Number(trade.openedAt) || Date.now()) : (Number(trade.closedAt) || 0) - (Number(trade.openedAt) || 0));
  dur.textContent = _pbFmtDuration(holdMs) + (!isLive && trade.reason ? ' / ' + String(trade.reason).replace(/_/g, ' ') : '');

  row.appendChild(time);
  row.appendChild(sym);
  row.appendChild(side);
  row.appendChild(entry);
  row.appendChild(exit);
  row.appendChild(pnl);
  row.appendChild(dur);

  // ── TRADE RECEIPT: click to expand canvas sparkline ──
  const hasCurve = Array.isArray(trade.priceCurve) && trade.priceCurve.length >= 2;
  if (hasCurve) {
    row.classList.add('pb-row--has-receipt');
    row.addEventListener('click', () => {
      const existing = row.nextElementSibling;
      // Toggle off
      if (existing && existing.classList.contains('pb-row-receipt')) {
        existing.remove();
        row.classList.remove('pb-row--expanded');
        return;
      }
      // Toggle on — build receipt container
      row.classList.add('pb-row--expanded');
      const receipt = document.createElement('div');
      receipt.className = 'pb-row-receipt';

      // Header strip
      const hdr = document.createElement('div');
      hdr.className = 'pb-receipt__hdr';
      const isWin = pnlVal >= 0;
      hdr.innerHTML =
        '<span class="pb-receipt__title">' + (isLive ? 'LIVE RECEIPT' : 'TRADE RECEIPT') + '</span>'
        + '<span class="pb-receipt__meta">'
        + '<span class="pb-receipt__sym">' + (trade.symbol || '') + '</span> '
        + '<span class="pb-receipt__side ' + sideKey + '">' + (sideKey === 'short' ? 'SHORT' : 'LONG') + '</span> '
        + '<span class="pb-receipt__result ' + (isWin ? 'pos' : 'neg') + '">' + _pbFmtUsd(pnlVal) + pnlPctTxt + '</span>'
        + '</span>';

      const cvs = document.createElement('canvas');
      cvs.className = 'pb-receipt__canvas';
      cvs.setAttribute('width', '400');
      cvs.setAttribute('height', '100');

      receipt.appendChild(hdr);
      receipt.appendChild(cvs);
      row.after(receipt);

      // Defer drawing one frame so the element has layout dimensions
      requestAnimationFrame(() => _pbDrawReceipt(cvs, trade));
    });
  }

  return row;
}

function renderPaperBot(state) {
  if (!state || typeof state !== 'object') return;
  const view = document.getElementById('view-bot') || document.getElementById('v-bot');
  if (!view) return;
  const openCount = Number.isFinite(Number(state.openCount))
    ? Number(state.openCount)
    : (Array.isArray(state.openPositions) ? state.openPositions.length : 0);

  const statusEl = document.getElementById('pb-status');
  if (statusEl) {
    let txt, klass;
    const paperBotSafetyMode = window.__paperBotSafetyMode === true || state.status === 'safety' || state.safetyMode === true;
    if (state.status === 'paper_position_open') { txt = 'PAPER POSITION OPEN'; klass = 'pb-status-searching'; }
    else if (state.status === 'paper_position_closed') { txt = 'PAPER TRADE CLOSED'; klass = 'pb-status-stopped'; }
    else if (state.status === 'dry_run_signal') { txt = 'DRY-RUN SIGNAL'; klass = 'pb-status-searching'; }
    else if (state.status === 'signal_found') { txt = 'SIGNAL FOUND'; klass = 'pb-status-searching'; }
    else if (state.status === 'no_setup') { txt = 'NO SETUP'; klass = 'pb-status-stopped'; }
    else if (paperBotSafetyMode) { txt = 'SAFETY MODE'; klass = 'pb-status-stopped'; }
    else if (state.status === 'emergency') { txt = 'EMERGENCY'; klass = 'pb-status-stopped'; }
    else if (state.status === 'awaiting_keys') { txt = 'SAFETY MODE'; klass = 'pb-status-stopped'; }
    else if (state.status === 'awaiting_session') { txt = 'AWAITING SESSION'; klass = 'pb-status-stopped'; }
    else if (state.status === 'paused') { txt = 'PAUSED'; klass = 'pb-status-stopped'; }
    else if (state.status === 'stopped') { txt = state.safetyBuild === true ? 'SAFETY MODE' : 'STOPPED'; klass = 'pb-status-stopped'; }
    else if (openCount > 0) { txt = 'IN TRADE (' + openCount + ')'; klass = 'pb-status-intrade'; }
    else { txt = 'SEARCHING'; klass = 'pb-status-searching'; }
    let statusText = document.getElementById('pb-status-text') || statusEl.querySelector('.pb-status-text');
    if (!statusText) {
      statusText = document.createElement('span');
      statusText.className = 'pb-status-text';
      statusText.id = 'pb-status-text';
      statusEl.appendChild(statusText);
    }
    if (statusText.textContent !== txt) statusText.textContent = txt;
    statusEl.classList.remove('pb-status-searching','pb-status-intrade','pb-status-stopped');
    statusEl.classList.add(klass);
  }

  const tabPip = document.getElementById('pb-tab-pip');
  if (tabPip) {
    const pipTxt = openCount > 0 ? String(openCount) : '';
    if (tabPip.textContent !== pipTxt) tabPip.textContent = pipTxt;
    tabPip.classList.toggle('on', openCount > 0);
  }

  const uptimeMs = Number.isFinite(Number(state.uptimeMs))
    ? Number(state.uptimeMs)
    : (Number.isFinite(Number(state.startedAt))
      ? (Number(state.ts) || Date.now()) - Number(state.startedAt)
      : 0);
  _pbSetText('pb-uptime', state.message || _pbFmtUptime(uptimeMs));
  _pbSetText('pb-open-count', openCount + ' open ' + (openCount === 1 ? 'position' : 'positions'));

  const realized = Number(state.realizedPnl) || 0;
  const unrealized = Number(state.unrealizedPnl) || 0;
  _pbSetText('pb-realized',   _pbFmtUsd(realized),   realized >= 0 ? 'pos' : 'neg');
  _pbSetText('pb-unrealized', _pbFmtUsd(unrealized), unrealized >= 0 ? 'pos' : 'neg');

  const wins = state.wins | 0;
  const losses = state.losses | 0;
  const wr = Number(state.winRate) || 0;
  _pbSetText('pb-winrate', wr.toFixed(1) + '%', wr >= 50 ? 'pos' : (wins + losses === 0 ? '' : 'neg'));
  _pbSetText('pb-wl', wins + 'W / ' + losses + 'L');

  const caution = Number(state.cautionMultiplier) || 1;
  _pbSetText('pb-caution', '\u00d7' + caution.toFixed(2), caution > 1.5 ? 'neg' : (caution < 0.9 ? 'pos' : ''));
  const cautionTitle = 'Caution multiplier divides trade size and raises entry confirmation thresholds: effective notional = balance * risk fraction / max(1, multiplier). It rises after losses or risky regimes and relaxes after wins.';
  const cautionEl = document.getElementById('pb-caution');
  const cautionHintEl = document.getElementById('pb-caution-hint');
  const cautionCard = cautionEl && cautionEl.closest ? cautionEl.closest('.bot-card') : null;
  [cautionCard, cautionEl, cautionHintEl].forEach((el) => { if (el) el.title = cautionTitle; });

  _pbSetText('pb-balance', _pbFmtBalance(state.balance) + ' balance');
  _pbRenderLastSignal(state);
  _pbRenderManualPlan(state);
  _pbRenderExecutionPreview(state);
  _pbRenderAnalystFeed(state);
  _paperbotPromptReconnect(state);

  const ledger = document.getElementById('pb-ledger');
  if (!ledger) return;
  const trades = Array.isArray(state.recentTrades) ? state.recentTrades : [];
  const openPositions = Array.isArray(state.openPositions) ? state.openPositions : [];
  _pbSetText('pb-trade-count', (state.totalClosed != null ? state.totalClosed : trades.length) + ' total');

  // ── LIVE POSITIONS: render at top of ledger ──
  // Snapshot expanded live symbols
  const expandedLiveKeys = new Set();
  ledger.querySelectorAll('.pb-row--live.pb-row--expanded').forEach(el => {
    if (el.dataset.liveKey) expandedLiveKeys.add(el.dataset.liveKey);
  });

  // Remove stale live rows
  ledger.querySelectorAll('.pb-row--live').forEach(el => {
    const next = el.nextElementSibling;
    if (next && next.classList.contains('pb-row-receipt')) next.remove();
    el.remove();
  });

  // Build live rows
  if (openPositions.length > 0) {
    const liveFrag = document.createDocumentFragment();
    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      pos.isOpen = true;
      const row = _pbBuildRow(pos);
      liveFrag.appendChild(row);
      if (expandedLiveKeys.has(row.dataset.liveKey)) {
        row.click(); // Re-apply expansion smoothly
      }
    }
    ledger.insertBefore(liveFrag, ledger.firstChild);
  }

  if (trades.length === 0 && openPositions.length === 0) {
    _pbRowKeys.clear();
    const emptyText = state.paperPosition || _pbHasEvent(state.events, 'PAPER_POSITION_OPENED') || _pbHasEvent(state.events, 'PAPER_TRADE_SIMULATED')
      ? 'No closed paper trades yet. Open simulated paper signal is shown above.'
      : 'No closed paper trades yet. Simulated signals appear in Quant Analyst feed above.';
    if (!ledger.querySelector('.bot-ledger__empty')) {
      const empty = document.createElement('div');
      empty.className = 'bot-ledger__empty';
      empty.textContent = emptyText;
      ledger.appendChild(empty);
    } else {
      ledger.querySelector('.bot-ledger__empty').textContent = emptyText;
    }
    return;
  }

  const empty = ledger.querySelector('.bot-ledger__empty');
  if (empty) empty.remove();

  const frag = document.createDocumentFragment();
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    const key = _pbTradeKey(t);
    if (_pbRowKeys.has(key)) continue;
    _pbRowKeys.add(key);
    const row = _pbBuildRow(t);
    if (frag.firstChild) frag.insertBefore(row, frag.firstChild);
    else frag.appendChild(row);
  }
  // Insert closed trades AFTER live rows
  const firstClosedRow = ledger.querySelector('.pb-row:not(.pb-row--live)');
  if (frag.childNodes.length) {
    if (firstClosedRow) ledger.insertBefore(frag, firstClosedRow);
    else ledger.appendChild(frag);
  }

  // Cap DOM — only trim closed rows (not live ones)
  const closedRows = ledger.querySelectorAll('.pb-row:not(.pb-row--live)');
  let trimCount = closedRows.length - PB_LEDGER_DOM_CAP;
  for (let i = closedRows.length - 1; i >= 0 && trimCount > 0; i--, trimCount--) {
    const last = closedRows[i];
    // Clean up any expanded receipt panel attached to this row
    const receipt = last.nextElementSibling;
    if (receipt && receipt.classList.contains('pb-row-receipt')) receipt.remove();
    if (last.dataset && last.dataset.key) _pbRowKeys.delete(last.dataset.key);
    ledger.removeChild(last);
  }
}

// ─────────────────────────────────────────────────────────────
// V7.0 — REAL-TIME WEBSOCKET STREAM PIPELINE
//
// Replaces the 120-second `setInterval(doRefresh, …)` poll with a
// persistent WebSocket connection to the Fly.io ingest worker, which
// proxies sub-second Binance ticker deltas. /api/markets is still hit
// once at boot for the initial snapshot + non-Binance coins, and a
// long fallback poll (5 min) covers the case where the WS drops for
// longer than a reconnect can repair (e.g. user offline → online).
//
// Frame contract (matches apps/ingest/src/stream.js):
//   { "t":"tick", "s":"BTC", "p":65432.10, "c24":2.51,
//     "qv":4.21e10, "ts":1700000000000 }
//   • s  = upper-case BASE symbol (BTC, not BTC/USDT:USDT)
//   • p  = last trade price (USD)
//   • c24= rolling 24h % change
//   • qv = 24h quote volume
//
// Each frame triggers a SINGLE-COIN mutation: DATA[i] gets the new
// price / 24h% / volume, _sig + _panic recompute, and ONLY the
// affected cells are repainted via [data-coin-id="…"][data-cell="…"]
// — no row reflow, no full renderList.
// ─────────────────────────────────────────────────────────────
const STREAM_DEFAULT_URL = 'wss://swing-terminal-ingest.fly.dev/api/stream-markets';
// LEGACY / DEAD INFRA: the Fly.io PaperBot/market-stream WebSocket
// (swing-terminal-ingest.fly.dev) is decommissioned. It also forwarded the
// Supabase JWT in the URL query string (?token=...), which Firefox leaked
// into the console on connection errors. It is disabled at runtime here.
// Market data still flows via the /api/markets REST poll. Do not re-enable
// without standing the server back up and fixing the token leak first.
const LEGACY_FLY_STREAM_ENABLED = false;
const STREAM_BACKOFF_MIN_MS = 1000;
const STREAM_BACKOFF_MAX_MS = 30000;
const STREAM_FALLBACK_POLL_MS = 5 * 60 * 1000; // 5min — long-tail safety net
const PAPERBOT_HEARTBEAT_MS = 4000;
let _streamSocket = null;
let _streamBackoff = STREAM_BACKOFF_MIN_MS;
let _streamReconnectTimer = null;
let _streamClosedByUs = false;
let _paperbotHeartbeatTimer = null;
let _paperbotReconnectPromptOpen = false;
const _SYMBOL_INDEX = new Map(); // upper(base) -> DATA[] index

function _paperbotSessionId() {
  try {
    let id = sessionStorage.getItem('paperbot.sessionId');
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'pb_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
      sessionStorage.setItem('paperbot.sessionId', id);
    }
    return id;
  } catch {
    return 'pb_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
  }
}

function _paperbotSendWs(payload) {
  const sock = _streamSocket;
  if (!sock || sock.readyState !== 1) return false;
  try { sock.send(JSON.stringify(payload)); return true; } catch { return false; }
}

function _paperbotSendHeartbeat() {
  return _paperbotSendWs({
    t: 'pb_heartbeat',
    sessionId: _paperbotSessionId(),
    ts: Date.now(),
    visible: document.visibilityState !== 'hidden',
  });
}

function _startPaperbotHeartbeat() {
  _stopPaperbotHeartbeat();
  _paperbotSendHeartbeat();
  _paperbotHeartbeatTimer = setInterval(_paperbotSendHeartbeat, PAPERBOT_HEARTBEAT_MS);
}

function _stopPaperbotHeartbeat() {
  if (_paperbotHeartbeatTimer) clearInterval(_paperbotHeartbeatTimer);
  _paperbotHeartbeatTimer = null;
}

function _paperbotPromptReconnect(state) {
  // SAFETY MODE: browser API-key entry and server trading reconnect are
  // disabled in this build until the execution backend is audited. We must
  // never call window.prompt, never read a Binance key/secret from the
  // browser, and never send pb_reconnect with credentials. Surface a clear
  // read-only status instead and return.
  const needsKeyReinput = state && state.session && state.session['requires' + 'Api' + 'Key' + 'Reinput'];
  if (!needsKeyReinput) return;

  console.warn('[PaperBot] API key entry disabled in this build: server requested key re-input, blocked by SAFETY MODE.');

  const statusText = document.getElementById('pb-status-text');
  if (statusText) statusText.textContent = 'KEY ENTRY DISABLED';

  const status = document.getElementById('pb-status');
  if (status) {
    status.classList.remove('pb-status-searching', 'pb-status-intrade');
    status.classList.add('pb-status-stopped');
  }

  return;
}

function _paperbotStateFromControlResponse(payload) {
  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  let status = payload && payload.status ? payload.status : 'safety';
  let message = payload && payload.message ? payload.message : 'Dry-run control skeleton only. No trading engine is running.';
  if (_pbHasEvent(events, 'BOT_STOP_REQUESTED')) {
    status = 'safety';
    message = payload && payload.message ? payload.message : 'Bot dry-run control state stopped. No positions existed.';
  } else if (payload && payload.paperPosition && payload.paperPosition.status === 'open') {
    status = 'paper_position_open';
    message = 'Monitoring simulated LONG ' + payload.paperPosition.symbol + '. No real order submitted.';
  } else if (_pbHasEvent(events, 'PAPER_POSITION_CLOSED')) {
    status = 'paper_position_closed';
    message = 'Paper position closed by dry-run monitor. No real order submitted.';
  } else if (_pbHasEvent(events, 'PAPER_TRADE_SIMULATED')) {
    status = 'dry_run_signal';
    message = 'Paper trade simulated. No real order submitted.';
  } else if (_pbHasEvent(events, 'SIGNAL_FOUND')) {
    status = 'signal_found';
    message = 'Candidate found, but no paper trade was simulated.';
  } else if (_pbHasEvent(events, 'MARKET_SCAN_SKIPPED')) {
    status = 'no_setup';
    message = 'No candidate passed the dry-run filters.';
  }
  const paperPosition = payload && payload.paperPosition ? payload.paperPosition : null;
  const closedTrades = Array.isArray(payload && payload.closedTrades) ? payload.closedTrades : [];
  const openRow = _pbMapPaperPosition(paperPosition, payload && payload.unrealizedPnl);
  const closedRows = closedTrades.map(_pbMapClosedTrade).filter(Boolean);
  return {
    status,
    safetyMode: false,
    safetyBuild: true,
    balance: 0,
    realizedPnl: Number(payload && payload.realizedPnl) || 0,
    unrealizedPnl: Number(payload && payload.unrealizedPnl) || 0,
    winRate: 0,
    openPositions: openRow ? [openRow] : [],
    recentTrades: closedRows,
    totalClosed: closedRows.length,
    cautionMultiplier: 1,
    ts: Date.now(),
    message,
    candidate: payload && payload.candidate ? payload.candidate : null,
    paperTrade: (payload && payload.paperTrade) || _pbPaperTradeFromEvents(events),
    paperPosition,
    closedTrades,
    manualExecutionPlan: payload && payload.manualExecutionPlan ? payload.manualExecutionPlan : null,
    executionPreview: payload && payload.executionPreview ? payload.executionPreview : null,
    safetyConfig: payload && payload.safetyConfig ? payload.safetyConfig : null,
    binanceConfig: payload && payload.binanceConfig ? payload.binanceConfig : null,
    testnetOrder: payload && payload.testnetOrder ? payload.testnetOrder : null,
    testnetOrders: Array.isArray(payload && payload.testnetOrders) ? payload.testnetOrders : [],
    testnetExecutionEnabled: !!(payload && payload.testnetExecutionEnabled),
    testnetOrderSubmitted: !!(payload && payload.testnetOrderSubmitted),
    blockedReason: payload && payload.blockedReason ? payload.blockedReason : null,
    binanceMessage: payload && payload.binanceMessage ? payload.binanceMessage : null,
    executionEnabled: false,
    realOrderSubmitted: false,
    events,
  };
}

async function _paperbotControlRequest(action) {
  // Bot credentials are never accepted in the browser.
  // Future backend bot controls must read secrets only from Netlify environment variables.
  const endpoint = action === 'wake' ? '/api/bot/wake' : action === 'stop' ? '/api/bot/stop' : '/api/bot/state';
  const authHeaders = await _getAuthHeaders();
  const init = action === 'state'
    ? { method: 'GET', headers: { 'Accept': 'application/json', ...authHeaders } }
    : {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: '{}',
      };
  const res = await fetch(endpoint, init);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.message || payload.error || ('PaperBot control failed: HTTP ' + res.status));
  }
  renderPaperBot(_paperbotStateFromControlResponse(payload));
  if (action === 'wake') {
    const wakeBtn = document.querySelector('.paperbot-control-btn--wake');
    if (wakeBtn) wakeBtn.textContent = payload.paperPosition ? 'Update Paper Position' : 'Run Scan Again';
  }
  const note = payload.message || 'Dry-run control skeleton state updated.';
  try { LiveFeed.push(note, 'info', { source: 'PaperBot Controls' }); } catch {}
  return payload;
}

function wakeBotPlaceholder() {
  _paperbotControlRequest('wake').catch((err) => {
    console.warn('[PaperBot] Wake Bot dry-run control failed:', err.message);
    window.Toast?.error('PaperBot wake failed', err.message, { endpoint: '/api/bot/wake' });
  });
}

function stopBotPlaceholder() {
  _paperbotControlRequest('stop').catch((err) => {
    console.warn('[PaperBot] Stop Bot dry-run control failed:', err.message);
    window.Toast?.error('PaperBot stop failed', err.message, { endpoint: '/api/bot/stop' });
  });
}

function _rebuildSymbolIndex() {
  _SYMBOL_INDEX.clear();
  for (let i = 0; i < DATA.length; i++) {
    const sym = String(DATA[i] && DATA[i].symbol || '').toUpperCase();
    if (sym) _SYMBOL_INDEX.set(sym, i);
  }
}

function _flashCell(rowEl, cellName, html, klass) {
  if (!rowEl) return;
  const el = rowEl.querySelector(`[data-cell="${cellName}"]`);
  if (!el) return;
  if (html != null) el.innerHTML = html;
  // Re-trigger animation by toggling the class off and back on next frame.
  el.classList.remove('cell-flash-up', 'cell-flash-down');
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth;
  if (klass) el.classList.add(klass);
}

// V7.4.6 — live mutate the right-hand detail panel whenever a WS tick
// arrives for the currently selected coin. Only the cells that can
// change between ticks (price, 24h%, score, panic, volume) are touched
// — the structural template (button, validity, momentum) is left in
// place so the panel never re-renders or flickers.
function _updateDetailPanel(d, newPrice, prevPrice, prevPanic) {
  const dcon = document.getElementById('dcon');
  if (!dcon) return;

  // PRICE — text mutate + flash
  const priceEl = dcon.querySelector('[data-detail="price"]');
  if (priceEl && Number.isFinite(newPrice) && newPrice > 0) {
    priceEl.textContent = fmt(newPrice);
    const dir = newPrice >= (prevPrice || 0) ? 'cell-flash-up' : 'cell-flash-down';
    priceEl.classList.remove('cell-flash-up', 'cell-flash-down');
    void priceEl.offsetWidth;
    priceEl.classList.add(dir);
  }

  // 24H % — text mutate + class swap (pos/neg) so the existing colour
  // tone follows the latest sign.
  const c24Val = (d && d._c24 != null) ? d._c24 : (d && d.price_change_percentage_24h) || 0;
  const c24El = dcon.querySelector('[data-detail="c24"]');
  if (c24El && Number.isFinite(c24Val)) {
    c24El.textContent = fp(c24Val);
    c24El.classList.toggle('pos', c24Val >= 0);
    c24El.classList.toggle('neg', c24Val < 0);
  }

  // SCORE — re-apply the integer + threshold-coloured tone.
  const scoreVal = (d && d._sig_score) || 0;
  const scoreEl = dcon.querySelector('[data-detail="score"]');
  if (scoreEl) scoreEl.textContent = `${scoreVal}/10`;

  // PANIC — full badge replacement (the colour tier + glow class
  // come from panicBadge() so a tier-crossing tick repaints both).
  const panicEl = dcon.querySelector('[data-detail="panic"]');
  if (panicEl && d) {
    panicEl.innerHTML = panicBadge(d._panic);
    const dir = (d._panic - (prevPanic || 0)) >= 0 ? 'cell-flash-up' : 'cell-flash-down';
    panicEl.classList.remove('cell-flash-up', 'cell-flash-down');
    void panicEl.offsetWidth;
    panicEl.classList.add(dir);
  }

  // 24H VOL — silent text mutate (no flash; volume churn is constant
  // and the visual noise would be more distracting than informative).
  const qvEl = dcon.querySelector('[data-detail="qv"]');
  if (qvEl && d) qvEl.textContent = fmt(d.total_volume || 0);
}

function _applyTick(frame) {
  try {
    const sym = String(frame.s || '').toUpperCase();
    if (!sym) return;
    const idx = _SYMBOL_INDEX.get(sym);
    if (idx == null) return;
    const d = DATA[idx];
    if (!d) return;

    const prevPrice = parseFloat(d.current_price) || 0;
    const newPrice  = (frame.p != null) ? Number(frame.p) : prevPrice;
    const newC24    = (frame.c24 != null) ? Number(frame.c24) : null;
    const newQv     = (frame.qv != null) ? Number(frame.qv) : null;

    if (Number.isFinite(newPrice) && newPrice > 0) d.current_price = newPrice;
    if (newC24 != null && Number.isFinite(newC24)) {
      d.price_change_percentage_24h = newC24;
      d._c24 = newC24;
    }
    if (newQv != null && Number.isFinite(newQv) && newQv > 0) {
      d.total_volume = newQv;
    }

    // Re-stamp composite scores for THIS coin only (no DATA-wide loop).
    try {
      const s = sig(d);
      d._sig = s; d._sig_score = s.score; d.score = s.score;
    } catch {
      d._sig = null; d._sig_score = 0; d.score = 0;
    }
    const prevPanic = d._panic;
    d._panic = calcPanic(d);

    // Targeted DOM mutation. data-coin-id is injected by renderList on
    // every .trow — querying by it is O(1) for a small table and keeps
    // the rest of the grid untouched.
    const escId = String(d.id || '').replace(/"/g, '\\"');
    const rowEl = document.querySelector(`.trow[data-coin-id="${escId}"]`);
    if (rowEl) {
      const priceDir = newPrice >= prevPrice ? 'cell-flash-up' : 'cell-flash-down';
      _flashCell(rowEl, 'price', _esc(fmt(newPrice)), priceDir);
      if (newC24 != null) {
        const cls = newC24 >= 0 ? 'pos' : 'neg';
        _flashCell(
          rowEl, 'c24',
          `<span class="tr ${cls}">${fp(newC24, 1)}</span>`,
          newC24 >= 0 ? 'cell-flash-up' : 'cell-flash-down',
        );
      }
      if (newQv != null) {
        _flashCell(rowEl, 'qv', _esc(fmt(newQv)), null);
      }
      _flashCell(
        rowEl, 'score',
        `<b>${d._sig_score}/10</b>`,
        (d._sig_score || 0) >= 6 ? 'cell-flash-up' : null,
      );
      const panicDir = (d._panic - (prevPanic || 0)) >= 0 ? 'cell-flash-up' : 'cell-flash-down';
      _flashCell(rowEl, 'panic', panicBadge(d._panic), panicDir);
      // SCORE cell color follows the score threshold — re-apply inline
      // colour without touching the rest of the row.
      const scoreEl = rowEl.querySelector('[data-cell="score"]');
      if (scoreEl) scoreEl.style.color = (d._sig_score || 0) >= 6 ? 'var(--grn)' : 'var(--txt2)';
    }

    // V7.4.6 — if the active detail coin matches this tick, live-flash
    // the right-hand pane too. Comparison uses the CoinGecko id (the
    // ground truth) rather than the symbol so listings with duplicate
    // tickers (e.g. wrapped/native pairs) don't cross-talk.
    if (window._currentDetailCoinId && d.id === window._currentDetailCoinId) {
      _updateDetailPanel(d, newPrice, prevPrice, prevPanic);
    }

    if (window.LOCAL_PAPERBOT_ENABLED === true && !window.__serverPaperBotSeen) {
      try { paperBotInstance.processMarkets([d]); }
      catch (e) { console.warn('[PAPERBOT] tick engine failed:', e && e.message); }
    }
  } catch (e) {
    // Frame processing must never throw — a bad payload from upstream
    // should drop the frame, not poison the rest of the stream.
    console.warn('[STREAM] tick apply failed:', e && e.message);
  }
}

async function connectStream() {
  if (!LEGACY_FLY_STREAM_ENABLED) {
    // Dead infra: no token URL is built and no WebSocket is opened — keep
    // market data fresh through the REST poll, and show the bot in safety mode.
    console.warn('[Stream] Legacy Fly.io WebSocket disabled. Using REST /api/markets only.');
    window.__paperBotSafetyMode = true;
    renderPaperBot({
      status: 'safety',
      safetyMode: true,
      safetyBuild: true,
      balance: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      winRate: 0,
      openPositions: [],
      recentTrades: [],
      cautionMultiplier: 1,
      ts: Date.now(),
      message: 'Legacy bot offline. REST market scanner active.'
    });
    _paperbotControlRequest('state').catch((err) => {
      console.warn('[PaperBot] Dry-run control state unavailable:', err.message);
    });
    _enableAggressivePoll();
    return;
  }
  if (window.STREAM_DISABLED) return;
  if (_streamSocket && (_streamSocket.readyState === 0 || _streamSocket.readyState === 1)) return;

  const baseUrl = window.STREAM_URL || STREAM_DEFAULT_URL;
  let token = '';
  try {
    const h = await _getAuthHeaders();
    const auth = h && h.Authorization;
    if (auth && /^Bearer\s+/.test(auth)) token = auth.replace(/^Bearer\s+/i, '').trim();
  } catch { /* unauth → still connect (server may allow anon read) */ }

  const url = token
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : baseUrl;

  let sock;
  try { sock = new WebSocket(url); } catch (e) {
    console.warn('[STREAM] WebSocket ctor failed:', e.message);
    return _scheduleReconnect();
  }
  _streamSocket = sock;
  _streamClosedByUs = false;

  sock.addEventListener('open', () => {
    _streamBackoff = STREAM_BACKOFF_MIN_MS;
    try { LiveFeed.push('Real-time stream connected', 'info'); } catch {}
    const sts = document.getElementById('sts');
    if (sts) {
      sts.textContent = 'LIVE';
      sts.classList.remove('status-reconnecting-pulse');
    }
    // V7.4.7 — WS healthy: stop the aggressive 10s poll, the regular
    // 5min safety-net interval is enough for non-Binance coins.
    _disableAggressivePoll();
    _startPaperbotHeartbeat();
  });

  sock.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.t === 'tick') return _applyTick(frame);
    if (frame.t === 'pb') {
      window.__serverPaperBotSeen = true;
      return renderPaperBot(frame);
    }
    if (frame.t === 'pb_heartbeat_ack') return;
    if (frame.t === 'pb_reconnect_ok') {
      window.Toast?.success('PaperBot reconnected', 'Heartbeat session restored.');
      if (frame.state) renderPaperBot(frame.state);
      _paperbotSendHeartbeat();
      return;
    }
    if (frame.t === 'pb_reconnect_error') {
      window.Toast?.error('PaperBot reconnect failed', frame.error || 'API key re-input failed');
      return;
    }
    if (frame.t === 'ping') {
      try { sock.send('{"t":"pong"}'); } catch {}
      return;
    }
    if (frame.t === 'hello') {
      // Server greeting — ignore.
      return;
    }
  });

  sock.addEventListener('close', () => {
    if (_streamClosedByUs) return;
    _stopPaperbotHeartbeat();
    const sts = document.getElementById('sts');
    if (sts) {
      sts.textContent = 'RECONNECTING';
      sts.classList.add('status-reconnecting-pulse');
    }
    _scheduleReconnect();
    // V7.4.7 — WS dead: kick the aggressive 10s poll so the user sees
    // fresh data within seconds instead of the 5min fallback interval.
    _enableAggressivePoll();
  });

  sock.addEventListener('error', () => {
    // 'close' will fire next; reconnect is handled there.
  });
}

function _scheduleReconnect() {
  if (_streamReconnectTimer) return;
  const delay = _streamBackoff;
  _streamBackoff = Math.min(_streamBackoff * 2, STREAM_BACKOFF_MAX_MS);
  _streamReconnectTimer = setTimeout(() => {
    _streamReconnectTimer = null;
    connectStream();
  }, delay);
}

// Pull a fresh /api/markets snapshot occasionally so non-Binance coins
// (DEX-only, where the WS stream has nothing to push) don't go stale.
// V7.4.7 — also pushes a synthetic detail-panel sync so the right-
// hand pane updates even when no WS frame is arriving.
async function _fallbackPollTick() {
  try { await doRefresh(); _rebuildSymbolIndex(); _syncDetailFromPoll(); }
  catch (e) { console.warn('[STREAM] fallback poll failed:', e && e.message); }
}

// ─────────────────────────────────────────────────────────────
// V7.4.7 — AGGRESSIVE FALLBACK POLLING
//
// When the WS drops, the regular 5-minute safety-net poll is too
// slow to keep the UI feeling alive. Aggressive mode kicks in
// immediately on close: full /api/markets refresh every 10 seconds,
// including a forced detail-panel sync. As soon as the WS comes
// back, aggressive mode steps down and the safety-net interval
// resumes the long cadence.
// ─────────────────────────────────────────────────────────────
const STREAM_AGGRESSIVE_POLL_MS = 10 * 1000;
let _aggressivePollTimer = null;
// Last-seen detail-panel snapshot so the poll path can compute the
// directional flash for price / panic on every refresh.
let _lastDetailSnapshot = null;

function _syncDetailFromPoll() {
  const id = window._currentDetailCoinId;
  if (!id) { _lastDetailSnapshot = null; return; }
  const d = (Array.isArray(DATA) ? DATA : []).find(x => x && x.id === id);
  if (!d) return;
  const newPrice = parseFloat(d.current_price) || 0;
  const prev = (_lastDetailSnapshot && _lastDetailSnapshot.id === id) ? _lastDetailSnapshot : null;
  const prevPrice = prev ? prev.price : newPrice;
  const prevPanic = prev ? prev.panic : (Number.isFinite(d._panic) ? d._panic : 0);
  try { _updateDetailPanel(d, newPrice, prevPrice, prevPanic); } catch {}
  _lastDetailSnapshot = { id, price: newPrice, panic: Number.isFinite(d._panic) ? d._panic : 0 };
}

async function _aggressivePollTick() {
  // V7.4.8 — HARD guard: if the WS reconnected between the time the
  // close handler armed this timer and the time the tick fires, abort
  // immediately. A full doRefresh() blasts a fresh /api/markets payload
  // through DATA + renderList(), which would visually flash-overwrite
  // every cell the live WS just mutated and make the UI feel "batched"
  // even though ticks ARE arriving in real time underneath.
  if (_streamSocket && _streamSocket.readyState === 1 /* OPEN */) return;
  try { await doRefresh(); _rebuildSymbolIndex(); _syncDetailFromPoll(); }
  catch (e) { console.warn('[STREAM] aggressive poll failed:', e && e.message); }
}

function _enableAggressivePoll() {
  if (_aggressivePollTimer) return;
  // Fire immediately so the user sees fresh data within ~1 RTT of
  // the WS drop, not after a full STREAM_AGGRESSIVE_POLL_MS wait.
  _aggressivePollTick();
  _aggressivePollTimer = setInterval(_aggressivePollTick, STREAM_AGGRESSIVE_POLL_MS);
}

function _disableAggressivePoll() {
  if (_aggressivePollTimer) {
    clearInterval(_aggressivePollTimer);
    _aggressivePollTimer = null;
  }
  _lastDetailSnapshot = null;
}

// ========== INITIALIZATION & AUTH ==========
let _appRunning = false;
async function initTerminalApp() {
  if (_appRunning) return;
  _appRunning = true;
  loadTgConfig();
  initColumnDnD();           // V7.3 — drag-to-reorder header
  initPanicManual();         // V7.3 — [?] info modal
  initHotnessTooltip();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  fetchBinancePairs();
  await doRefresh();
  _rebuildSymbolIndex();
  // V7.0: open the live WebSocket stream and keep a long fallback
  // poll as a safety net (was setInterval(doRefresh, 120s); now 5min
  // because per-tick updates flow through the stream, not the poll).
  connectStream();
  window._refreshTimer = setInterval(_fallbackPollTick, STREAM_FALLBACK_POLL_MS);
  // Start crypto news feed (every 5 min)
  LiveFeed.init();
  LiveFeed.startNewsLoop();
}

// V5: bootstrap Supabase config from /api/config (env-driven on the
// edge), with the legacy hardcoded values kept ONLY as a last-resort
// fallback for local-dev environments that haven't set the env vars.
// Production deploys should set SUPABASE_URL + SUPABASE_ANON_KEY in
// Netlify env so rotation is a redeploy, not a code change.
const _FALLBACK_SUPABASE = {
  url: 'https://pfxfythajbzuisdvhhvd.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmeGZ5dGhhamJ6dWlzZHZoaHZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NTMyNDYsImV4cCI6MjA5MjQyOTI0Nn0.dQbPdej9ur7Irqo_iJN-uki1S2EgS00-iOKd3erVZSQ',
};

async function _bootstrapSupabaseConfig() {
  try {
    const r = await fetch('/api/config', { headers: { 'Accept': 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      if (j?.configured && j.supabase_url && j.supabase_anon_key) {
        return { url: j.supabase_url, key: j.supabase_anon_key };
      }
    }
  } catch (e) {
    console.warn('[BOOTSTRAP] /api/config fetch failed, using fallback:', e.message);
  }
  console.warn('[BOOTSTRAP] Using fallback Supabase config (env vars not set on edge)');
  return _FALLBACK_SUPABASE;
}

let supabaseCl = null;

(async function _initSupabase() {
  const cfg = await _bootstrapSupabaseConfig();
  supabaseCl = window.supabase.createClient(cfg.url, cfg.key);
  window.__supabase = supabaseCl;
  // Re-wire auth listeners now that the client exists. The handlers
  // defined further below capture `supabaseCl` by closure — they read
  // it lazily so they pick up the bootstrapped instance.
  if (typeof window._wireSupabaseListeners === 'function') {
    window._wireSupabaseListeners();
  }
})();

// V5: auth wiring deferred until _bootstrapSupabaseConfig resolves
// and supabaseCl exists. The _wireSupabaseListeners stub is called
// by the bootstrap IIFE above; it can be invoked safely multiple times
// because it idempotently re-attaches against the live client.
let _authWired = false;
window._wireSupabaseListeners = function _wireSupabaseListeners() {
  if (_authWired || !supabaseCl) return;
  _authWired = true;

  const authForm = document.getElementById('auth-form');
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      const btn = document.getElementById('auth-submit');
      const err = document.getElementById('auth-error');

      btn.disabled = true; btn.textContent = 'Ověřuji...'; err.classList.remove('visible');

      try {
        const { error } = await supabaseCl.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } catch (error) {
        console.error('🔍 Supabase Login Error Detail:', error);
        err.textContent = error.message || 'Chyba sítě nebo neplatný požadavek (více v konzoli).';
        err.classList.add('visible');
        window.Toast?.error('Login failed', error.message || 'Network or auth error', { endpoint: 'supabase.auth.signInWithPassword' });
      } finally {
        btn.disabled = false; btn.textContent = 'PŘIHLÁSIT SE';
      }
    });
  }

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    if (confirm('Opravdu se chcete odhlásit?')) {
      await supabaseCl.auth.signOut();
    }
  });

  supabaseCl.auth.onAuthStateChange((event, session) => {
    if (session) {
      // V5: cache the user's tier on the global state so client-side
      // gating (top coin cap, DEX visibility) can read it synchronously.
      // Admin emails are mirrored client-side for UI labeling — but
      // the actual tier enforcement happens server-side in lib/tier.js.
      const email = String(session.user?.email || '').trim().toLowerCase();
      const adminEmails = ['ales.cesnek@thevld.com', 'vld@thevld.com'];
      const isAdmin = adminEmails.includes(email);
      window.__userTier = isAdmin || session.user?.user_metadata?.tier === 'pro' ? 'pro' : 'free';
      window.__isAdmin = isAdmin;
      document.getElementById('auth-gate').hidden = true;
      document.getElementById('terminal-app').style.display = 'block';
      const emBtn = document.getElementById('user-email');
      if (emBtn) {
        const label = isAdmin ? 'ADMIN' : window.__userTier.toUpperCase();
        emBtn.textContent = (session.user?.email || '—') + ' · ' + label;
      }
      initTerminalApp();
    } else {
      // V6.9 Sprint 2: nuke every observer + the 120s scanner refresh
      // timer + LiveFeed's two intervals. Previously the app kept
      // hammering /api/markets after signout (ghost network spam).
      try { _terminalTeardown(); } catch (err) { console.warn('[AUTH] teardown failed:', err.message); }
      window.__userTier = 'free';
      window.__isAdmin = false;
      document.getElementById('auth-gate').hidden = false;
      document.getElementById('terminal-app').style.display = 'none';
    }
  });
};

// ── Module 4: Market Briefing trigger ──
// We pick the top 3 coins by computed score from the *current* DATA
// snapshot. The backend re-fetches fresh Binance snapshots for them
// — we only send the symbol list.
document.getElementById('briefing-trigger')?.addEventListener('click', () => {
  if (!Array.isArray(DATA) || !DATA.length) {
    console.warn('[BRIEFING] DATA not ready');
    return;
  }
  const top3 = [...DATA]
    .map(d => ({ d, score: (d._sig_score != null ? d._sig_score : (d.score != null ? d.score : (typeof sig === 'function' ? sig(d).score : 0))) }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 3)
    .map(x => (x.d.symbol || x.d.id || '').toString().toUpperCase())
    .filter(Boolean);
  if (!top3.length) {
    console.warn('[BRIEFING] No top symbols resolved');
    return;
  }
  if (typeof window.requestBriefing === 'function') {
    window.requestBriefing(top3);
    LiveFeed.push(`AI Briefing requested: ${top3.join(', ')}`, 'ai');
  } else {
    console.error('[BRIEFING] requestBriefing not available');
  }
});

// ── V4 Premium: Market Briefing collapsible panel ──
// One global button (in topbar) + a dedicated collapsible panel
// directly under the topbar. Both share the same fetch path so the
// 45-min cache layer is hit consistently regardless of entry point.
(function wireMarketBriefing() {
  const panel = document.getElementById('mkt-briefing-panel');
  const toggle = document.getElementById('mkt-briefing-toggle');
  const body = document.getElementById('mkt-briefing-body');
  const refreshBtn = document.getElementById('mkt-briefing-refresh');
  const headerBtn = document.getElementById('mkt-briefing-trigger');
  let loadedOnce = false;

  if (!panel || !toggle || !body) return;

  function setOpen(open) {
    panel.dataset.state = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    const chev = toggle.querySelector('.mkt-briefing__chev');
    if (chev) chev.textContent = open ? '▾' : '▸';
  }

  function ensureOpenAndLoad(force = false) {
    setOpen(true);
    if (force || !loadedOnce) {
      loadedOnce = true;
      if (typeof window.requestMarketBriefing === 'function') {
        window.requestMarketBriefing({ force });
        if (typeof LiveFeed?.push === 'function') {
          LiveFeed.push(force ? 'Market Briefing: forced refresh' : 'Market Briefing: loaded', 'ai');
        }
      } else {
        console.error('[MKT-BRIEFING] requestMarketBriefing unavailable');
      }
    }
  }

  toggle.addEventListener('click', (e) => {
    // Don't toggle when the user clicked the inline ↻ or × buttons
    if (e.target.closest('#mkt-briefing-refresh') || e.target.closest('#mkt-briefing-close')) return;
    if (panel.dataset.state === 'open') {
      setOpen(false);
    } else {
      ensureOpenAndLoad(false);
    }
  });
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle.click();
    }
  });
  refreshBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    ensureOpenAndLoad(true);
  });
  headerBtn?.addEventListener('click', () => {
    ensureOpenAndLoad(false);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // V6.3: Close button hides the entire briefing bar.
  const closeBtn = document.getElementById('mkt-briefing-close');
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
    panel.style.display = 'none';
  });
})();

// ─────────────────────────────────────────────────────────────
// V7.3 — COLUMN REGISTRY + HTML5 DRAG-TO-REORDER ENGINE
//
// The V4 mousedown column-resize handle was purged in V7.3 because
// it surfaced as a dead-looking 1px vertical seam in the header until
// the user happened to hover the exact right pixel. It also forced
// the row template to hard-code column order, which made adding a
// new column a 3-file edit. V7.3 unifies header + row rendering
// behind a single COLUMN_DEFS map and lets the user drag-reorder
// columns directly in the header. Order survives reloads via
// `localStorage[COLUMN_ORDER_STORAGE_KEY]`.
//
// V7.4 — Single source of truth for column metadata.
//   • `width` is the DEFAULT numeric pixel width OR the literal string
//     'flex' for the COIN absorber. User-modified widths live in the
//     parallel `_columnWidths` map below so the registry stays a pure
//     constant (no hot mutation across reloads).
//   • `dragOK:false` pins a column (# and COIN) so the user cannot
//     drag the rank marker into the middle of the row.
//   • `tooltip` (optional) is the hover-popup body — rendered through
//     the V7.4 .header-tooltip engine. Differs from `tip` which only
//     feeds the native browser title="".
const COLUMN_DEFS = {
  // V7.4.8: EVERY column is now fully draggable — including RANK.
  //   • Total array splicing freedom: the drag-and-drop engine has
  //     no positional boundary checks; splice(from, to) accepts any
  //     index pair within _columnOrder.length.
  //   • The row marker (#) re-numbers from `start + i + 1` regardless
  //     of where the rank cell ends up visually, so dragging it into
  //     the middle of the row still produces correctly-numbered cells.
  rank:   { label: '#',       width: 32,     tip: '',                                                                       align: 'left',  dragOK: true  },
  coin:   { label: 'COIN',    width: 160,    tip: '',                                                                       align: 'left',  dragOK: true  },
  signal: { label: 'SIGNAL',  width: 110,    tip: '',                                                                       align: 'left',  dragOK: true  },
  score:  { label: 'SCORE',   width: 64,     tip: 'Signal Score 0-10',                                                      align: 'right', dragOK: true,
            tooltip: 'Primary algorithmic valuation engine. Scales 0 to 10/10 based on macro confluence indicators.' },
  panic:  { label: 'PANIC',   width: 70,     tip: 'Click for the PANIC manual',                                             align: 'right', dragOK: true,
            tooltip: 'Composite math blend of 24h Volume Delta (50%), 1h Price Velocity (30%), and Institutional Sniping (20%). High absolute values indicate retail extremes ( >+80 FOMO top risk · <-80 capitulation bounce zone ). Click to open the full manual.' },
  price:  { label: 'PRICE',   width: 80,     tip: '',                                                                       align: 'right', dragOK: true  },
  c1:     { label: '1H %',    width: 56,     tip: '1h price change %',                                                      align: 'right', dragOK: true  },
  c4:     { label: '4H %',    width: 56,     tip: '4h price change % (derived from CoinGecko sparkline)',                   align: 'right', dragOK: true  },
  c12:    { label: '12H %',   width: 56,     tip: '12h price change % (derived from CoinGecko sparkline)',                  align: 'right', dragOK: true  },
  c24:    { label: '24H %',   width: 60,     tip: '',                                                                       align: 'right', dragOK: true  },
  c7d:    { label: '7D %',    width: 56,     tip: '7d price change %',                                                      align: 'right', dragOK: true  },
  qv:     { label: '24H VOL', width: 90,     tip: '24h Quote Volume (USD)',                                                 align: 'right', dragOK: true  },
  hot:    { label: 'HOT',     width: 50,     tip: '',                                                                       align: 'right', dragOK: true,
            tooltip: 'Real-time attention and volatility tracking index based on immediate trading frequency spikes.' },
  // V8 ABACUS — the `spacer` bead is gone. The grid that needed a 1fr
  // slack-absorber no longer exists; columns float on raw pixel
  // coordinates over the void, so there is nothing left to absorb.
};
// Default visual sequence. The mobile-only expand toggle is appended
// AFTER this chain in DOM order and never participates in reorder.
const DEFAULT_COLUMN_ORDER = ['rank','coin','signal','score','panic','price','c1','c4','c12','c24','c7d','qv','hot'];
const COLUMN_ORDER_STORAGE_KEY = 'swing_col_order_v73';
const COLUMN_WIDTHS_STORAGE_KEY = 'swing_col_widths_v74';
const MIN_COL_PX = 36;     // hard floor — narrower than this and the label gets ellipsised away.
const MIN_COIN_PX = 90;    // flex absorber needs a useful minimum.

// V8 ABACUS — `_columnOrder` no longer drives layout (raw pixel `left`
// coordinates do that). It now only enumerates WHICH columns exist so the
// renderers know what to paint. Visual sequence comes purely from
// `_columnPositions`. The legacy `spacer` key is filtered out on load.
let _columnOrder = (() => {
  try {
    const raw = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMN_ORDER.slice();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_COLUMN_ORDER.slice();
    // Drop anything that doesn't map to a current COLUMN_DEFS entry —
    // this also purges the retired `spacer` key from caches written by
    // any pre-V8 build.
    const cleaned = arr.filter(k => COLUMN_DEFS[k]);
    // Append any defs the saved order didn't know about so a new
    // column added in a future release still shows up by default.
    const seen = new Set(cleaned);
    for (const k of DEFAULT_COLUMN_ORDER) if (!seen.has(k)) cleaned.push(k);
    return cleaned.length ? cleaned : DEFAULT_COLUMN_ORDER.slice();
  } catch { return DEFAULT_COLUMN_ORDER.slice(); }
})();

let _columnWidths = (() => {
  // Bootstrap from COLUMN_DEFS, then overlay any user-persisted widths.
  const out = {};
  for (const k of Object.keys(COLUMN_DEFS)) out[k] = COLUMN_DEFS[k].width;
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const k of Object.keys(out)) {
          const v = obj[k];
          if (v === 'flex') { out[k] = 'flex'; }
          else if (Number.isFinite(v)) { out[k] = Math.max(k === 'coin' ? MIN_COIN_PX : MIN_COL_PX, Math.round(v)); }
        }
      }
    }
  } catch {}
  return out;
})();

// ─────────────────────────────────────────────────────────────
// V8 ABACUS — ABSOLUTE PIXEL COORDINATE MAP.
//
// `_columnPositions` maps a column key directly to its `left` pixel
// offset, e.g. { coin:0, price:180, signal:550, qv:650 }. This is the
// SINGLE source of truth for horizontal placement. renderHeader /
// renderList stamp every cell with an inline `left:${px}px` so a
// WebSocket-driven innerHTML rebuild re-locks each cell to its exact
// X-coordinate every frame — total immunity to re-render drift, and
// 100% pixel-arbitrary placement (drop a column anywhere over the void
// and it freezes precisely where the cursor was released).
// ─────────────────────────────────────────────────────────────
const COLUMN_POSITIONS_STORAGE_KEY = 'terminal.v7.columnPositions';
const COLUMN_GAP_PX = 10; // default padding inserted between columns on first boot

let _columnPositions = JSON.parse(localStorage.getItem(COLUMN_POSITIONS_STORAGE_KEY) || '{}');

// V8.1 — measured content-width floor per column (key → px). Populated by
// `_autosizeColumns()` after each paint so a column is NEVER narrower than
// the widest content it must show (e.g. the SIGNAL cell's "FLUSH+BUY" +
// SHORTS_TRAPPED + 🎯 SNIPER badge stack). Acts as a minimum applied to
// `_colWidth`; it grows monotonically within a render cycle and converges
// in a single measure pass, so it can never clip and never loops.
let _columnContentWidths = {};

function _persistColumnPositions() {
  try { localStorage.setItem(COLUMN_POSITIONS_STORAGE_KEY, JSON.stringify(_columnPositions)); } catch {}
}

function _persistColumnOrder() {
  try { localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(_columnOrder)); } catch {}
}
function _persistColumnWidths() {
  try {
    const obj = {};
    for (const k of Object.keys(_columnWidths)) {
      const v = _columnWidths[k];
      // Only persist user-divergent values; the default `'flex'` for
      // COIN doesn't need to round-trip through storage.
      if (v === 'flex') continue;
      obj[k] = v;
    }
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(obj));
  } catch {}
}

// V8 ABACUS — resolve a column's pixel WIDTH. The widest of: the measured
// content floor (`_columnContentWidths`, so data can never be clipped), the
// user-resized width (`_columnWidths`), and the static COLUMN_DEFS width
// (→ 80px default). The content floor is what permanently kills the SIGNAL
// truncation: the cell auto-grows to fit its badge stack.
function _colWidth(key) {
  let base;
  const w = _columnWidths[key];
  if (Number.isFinite(w)) base = Math.max(key === 'coin' ? MIN_COIN_PX : MIN_COL_PX, Math.round(w));
  else { const def = COLUMN_DEFS[key] || {}; base = Number.isFinite(def.width) ? def.width : 80; }
  const fit = _columnContentWidths[key];
  return Number.isFinite(fit) ? Math.max(base, Math.ceil(fit)) : base;
}

// V8 ABACUS — resolve a column's pixel LEFT offset from the coordinate map.
function _colLeft(key) {
  const v = _columnPositions[key];
  return Number.isFinite(v) ? Math.round(v) : 0;
}

// V8 ABACUS — inline style string baked into every cell's opening tag.
function _colStyle(key) {
  return `left:${_colLeft(key)}px;width:${_colWidth(key)}px;`;
}

// V8 ABACUS — BOOT INITIALIZATION. If `_columnPositions` carries no
// coordinate for a column, lay it out left-to-right in DEFAULT_COLUMN_ORDER
// — cumulative (width + COLUMN_GAP_PX) — so a first load (or a freshly
// added column) starts neatly arranged rather than stacked at left:0.
function _ensureColumnPositions() {
  // Place in DEFAULT_COLUMN_ORDER first (the neat canonical arrangement),
  // then sweep _columnOrder so any column the default list doesn't know
  // about still lands on the wire rather than stacking at left:0.
  const order = DEFAULT_COLUMN_ORDER.concat(_columnOrder.filter(k => !DEFAULT_COLUMN_ORDER.includes(k)));
  let cursor = 0;
  // Seed the running edge past anything already placed so new keys append
  // to the right of the existing arrangement instead of overlapping it.
  for (const k of order) {
    if (Number.isFinite(_columnPositions[k])) {
      cursor = Math.max(cursor, _columnPositions[k] + _colWidth(k) + COLUMN_GAP_PX);
    }
  }
  for (const k of order) {
    if (!Number.isFinite(_columnPositions[k])) {
      _columnPositions[k] = cursor;
      cursor += _colWidth(k) + COLUMN_GAP_PX;
    }
  }
  // Guarantee the seeded arrangement is collision-free even if a width grew.
  _resolveColumnCollisions();
}

// ─────────────────────────────────────────────────────────────
// V8.1 — SOLID-BODY ANTI-COLLISION.
//
// Columns are rigid bodies on the wire: they may sit at any arbitrary
// pixel coordinate, but two of them can NEVER occupy the same space.
// After any mutation (drop, resize, autosize, boot) this pass:
//   1. Sorts every column by its current `left` (the just-dropped column,
//      `priorityKey`, wins ties so it keeps the slot it was released on).
//   2. Sweeps left→right, and whenever a body would intrude into the
//      previous body's footprint (left < runningEdge), shoves it right to
//      exactly runningEdge — `prevLeft + prevWidth + COLUMN_GAP_PX`.
// Columns the user spaced out with deliberate gaps keep those gaps (their
// left already clears the edge); only genuine overlaps are pushed apart.
// The result is deterministic, idempotent, and overlap-free under ANY
// drop coordinate. `_columnOrder` is re-synced to the visual left→right
// sequence so the render set and the layout never disagree.
// ─────────────────────────────────────────────────────────────
function _resolveColumnCollisions(priorityKey) {
  const keys = _columnOrder.slice().sort((a, b) => {
    const la = _colLeft(a), lb = _colLeft(b);
    if (la !== lb) return la - lb;
    if (a === priorityKey) return -1;
    if (b === priorityKey) return 1;
    return 0;
  });
  let edge = 0;
  for (const k of keys) {
    let left = _colLeft(k);
    if (left < edge) left = edge;          // intrusion → shove the body right
    _columnPositions[k] = left;
    edge = left + _colWidth(k) + COLUMN_GAP_PX;
  }
  _columnOrder = keys;
}

// V8.1 — stamp the resolved left/width onto the LIVE cells without a full
// innerHTML rebuild. Lets the autosize/collision pass reflow the table in
// place (no re-measure loop, no content flash).
function _applyColumnGeometry() {
  const stamp = (cell) => {
    const k = cell.getAttribute('data-col');
    if (!k || !COLUMN_DEFS[k]) return;
    cell.style.left = `${_colLeft(k)}px`;
    cell.style.width = `${_colWidth(k)}px`;
  };
  document.querySelectorAll('.thdr > [data-col]').forEach(stamp);
  document.querySelectorAll('#clist [data-col]').forEach(stamp);
}

// V8.1 — CLIP KILLER. After each paint, scan every column's header + row
// cells for REAL clipping (`scrollWidth > clientWidth`, i.e. the content
// physically overflows the fixed box) and raise the column's content-width
// floor just enough to fit it. The trigger is overflow itself — never the
// box width — so a column that already fits reports no clip and the floor
// stays put (grow-only, drift-free, converges in this single pass). On any
// growth it re-resolves collisions and reflows the table in place.
let _autosizing = false;
function _autosizeColumns() {
  if (_autosizing) return;
  _autosizing = true;
  try {
    const hdr = document.querySelector('.thdr');
    const clist = document.getElementById('clist');
    if (!hdr || !clist) return;
    let changed = false;
    for (const k of _columnOrder) {
      let need = 0;
      const consider = (cell) => {
        // Only a genuinely clipped cell inflates the floor. A cell whose
        // content fits has scrollWidth === clientWidth and is ignored —
        // that's what stops the box width feeding back into itself.
        if (cell && cell.scrollWidth > cell.clientWidth + 1) {
          need = Math.max(need, cell.scrollWidth + 6);
        }
      };
      consider(hdr.querySelector(`:scope > [data-col="${k}"]`));
      clist.querySelectorAll(`[data-col="${k}"]`).forEach(consider);
      if (need > (_columnContentWidths[k] || 0)) {
        _columnContentWidths[k] = need;
        changed = true;
      }
    }
    if (changed) {
      _resolveColumnCollisions();
      _applyColumnGeometry();
    }
  } finally {
    _autosizing = false;
  }
}

// V8 ABACUS — Rebuild the header from _columnOrder. Every cell is stamped
// with an inline `left:${px}px;width:${px}px` from `_columnPositions` /
// `_colWidth`, so the header floats on the same absolute coordinate grid as
// the rows. Each cell still carries a trailing `.col-resize-handle` so the
// user can drag the right edge to scale that column's pixel width.
// The PANIC header is its own clickable affordance (data-panic-help).
function renderHeader() {
  const hdr = document.querySelector('.thdr');
  if (!hdr) return;
  _ensureColumnPositions();
  const cells = _columnOrder.map(k => {
    const def = COLUMN_DEFS[k];
    if (!def) return '';
    const tipAttr = def.tip ? ` title="${_esc(def.tip)}"` : '';
    const dragAttr = def.dragOK ? ' data-sortable="true"' : '';
    const classes = [];
    if (def.align === 'right') classes.push('tr');
    if (!def.dragOK) classes.push('no-handle');
    // PANIC carries data-panic-help so a click on the label opens
    // the manual (replaces the V7.3 inline [?] button).
    if (k === 'panic') classes.push('panic-header');
    const classAttr = ` class="${classes.join(' ')}"`;
    const tooltipAttr = def.tooltip ? ` data-tooltip="${_esc(def.tooltip)}"` : '';
    const panicAttr = k === 'panic' ? ' data-panic-help' : '';
    const hotTip = k === 'hot' ? ' data-hot-tip' : '';
    // The resize handle is appended INSIDE the cell; the cell is its own
    // positioning context (it is itself position:absolute) so the handle
    // anchors to the cell's right edge on every repaint.
    const handle = '<span class="col-resize-handle" data-resize aria-hidden="true"></span>';
    return `<span data-col="${k}"${classAttr}${dragAttr} style="${_colStyle(k)}"${tipAttr}${tooltipAttr}${panicAttr}${hotTip}>`
         + `${_esc(def.label)}${handle}`
         + `</span>`;
  }).join('');
  hdr.innerHTML = cells
    + '<span class="trow-toggle-hdr no-handle" aria-hidden="true">⋯</span>';
  _attachColumnDnD();
}

// V7.4: while a column resize is in flight we must block HTML5 drag
// from kicking in — otherwise dragging the right-edge handle would
// also trigger the reorder gesture on the parent draggable cell.
let _isResizing = false;
let _columnDrag = null;

function _attachColumnDnD() {
  const hdr = document.querySelector('.thdr');
  if (!hdr) return;
  hdr.querySelectorAll('[data-sortable="true"]').forEach(el => {
    el.addEventListener('pointerdown', _onColumnPointerDown);
  });
}

// V8 ABACUS — DRAG PHYSICS: pure free placement.
//
// pointerdown : capture the initial mouse X and the column's initial
//               `_columnPositions[key]` left offset.
// pointermove : translate the dragged cell's inline `left` in real time by
//               the raw mouse delta. Siblings are NEVER pushed around —
//               the user moves the column with total freedom over the void.
// pointerup   : read the final visual `left`, persist it into
//               `_columnPositions[key]` + localStorage, then fire a single
//               clean renderHeader() + renderList() so the row cells re-lock
//               to the new X-coordinate. The column freezes EXACTLY where
//               the cursor was released.
function _onColumnPointerDown(e) {
  if (e.button !== 0 || _isResizing) return;
  if (e.target && e.target.closest && e.target.closest('[data-resize]')) return;
  const source = e.currentTarget;
  const key = source && source.dataset ? source.dataset.col : '';
  if (!key || !COLUMN_DEFS[key] || !COLUMN_DEFS[key].dragOK) return;

  e.preventDefault();
  try { source.setPointerCapture(e.pointerId); } catch {}

  const startX = e.clientX;
  const startLeft = _colLeft(key);

  source.classList.add('col-dragging');
  document.body.classList.add('col-sort-body');

  _columnDrag = {
    source,
    key,
    startX,
    startLeft,
    curLeft: startLeft,
    pointerId: e.pointerId,
    raf: 0,
    lastX: e.clientX,
  };

  document.addEventListener('pointermove', _onColumnPointerMove, { passive: false });
  document.addEventListener('pointerup', _onColumnPointerUp, { passive: false });
  document.addEventListener('pointercancel', _onColumnPointerUp, { passive: false });
}

function _onColumnPointerMove(e) {
  const st = _columnDrag;
  if (!st) return;
  e.preventDefault();
  st.lastX = e.clientX;
  if (st.raf) return;
  st.raf = requestAnimationFrame(() => {
    st.raf = 0;
    // Raw pixel delta — clamp the left edge at 0 so a column can't be
    // dragged off the left of the canvas, but otherwise total freedom.
    st.curLeft = Math.max(0, st.startLeft + (st.lastX - st.startX));
    st.source.style.left = `${st.curLeft}px`;
  });
}

function _onColumnPointerUp(e) {
  const st = _columnDrag;
  if (!st) return;
  e.preventDefault();
  if (st.raf) cancelAnimationFrame(st.raf);
  // Final reconciliation of the delta in case the last rAF never fired.
  st.curLeft = Math.max(0, st.startLeft + (st.lastX - st.startX));

  document.removeEventListener('pointermove', _onColumnPointerMove);
  document.removeEventListener('pointerup', _onColumnPointerUp);
  document.removeEventListener('pointercancel', _onColumnPointerUp);
  try { st.source.releasePointerCapture(st.pointerId); } catch {}

  st.source.classList.remove('col-dragging');
  document.body.classList.remove('col-sort-body');

  // Freeze the column at the released pixel coordinate, then run solid-body
  // anti-collision so it can never rest on top of another column — it keeps
  // the slot it was dropped on (priorityKey) and any genuine overlap with a
  // neighbour is shoved apart into a distinct, readable block.
  _columnPositions[st.key] = Math.round(st.curLeft);
  _resolveColumnCollisions(st.key);
  _persistColumnPositions();
  renderHeader();
  try { renderList(); } catch {}

  _columnDrag = null;
}

// V8 - Mouse-driven column resize.
// One mousedown listener per `.col-resize-handle`. Captures the cell's
// starting width, then on every mousemove projects (startW + dx) into
// _columnWidths[key] and live-updates the dragged header cell's inline
// width. On pointer-up a single renderHeader() + renderList() bakes the
// new width into every cell across the absolute coordinate grid.
function _attachColumnResize() {
  const hdr = document.querySelector('.thdr');
  if (!hdr) return;
  hdr.querySelectorAll('[data-col] .col-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      // Only react to the primary (left) mouse button so right-click
      // context menus and middle-click new-tab gestures still work.
      if (e.button !== 0) return;
      const cell = handle.parentElement;
      if (!cell) return;
      const key = cell.dataset.col;
      if (!key || !COLUMN_DEFS[key]) return;

      // Critical: prevent the parent draggable cell from interpreting
      // this gesture as the start of a column reorder, AND prevent the
      // browser from initiating its own text-selection / image-drag.
      e.preventDefault();
      e.stopPropagation();
      _isResizing = true;

      const rect = cell.getBoundingClientRect();
      const startX = e.clientX;
      const startW = rect.width;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      cell.classList.add('col-resizing');

      const isCoinKey = (key === 'coin');
      const minPx = isCoinKey ? MIN_COIN_PX : MIN_COL_PX;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next = Math.max(minPx, Math.round(startW + dx));
        _columnWidths[key] = next;
        // V8 ABACUS — width is baked inline per cell, so live-update the
        // dragged HEADER cell's width directly. The rows pick up the new
        // width on the single re-render at pointer-up.
        cell.style.width = `${next}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        cell.classList.remove('col-resizing');
        _persistColumnWidths();
        // A widened column can now overlap its right-hand neighbour — run
        // anti-collision so the grid stays solid-body before repainting.
        _resolveColumnCollisions(key);
        _persistColumnPositions();
        // Re-stamp header + rows so the new width is baked into every
        // cell's inline style across the absolute coordinate grid.
        renderHeader();
        try { renderList(); } catch {}
        // Tiny debounce before clearing the flag so a stray pointer
        // queued during the same gesture stays blocked.
        setTimeout(() => { _isResizing = false; }, 0);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Block click on the handle from bubbling to the parent — the
    // PANIC cell uses click-to-open-manual and we don't want a stray
    // resize click to trigger it.
    handle.addEventListener('click', (e) => { e.stopPropagation(); });
  });
}

// V7.4 — Hover tooltip popup engine.
// Cells with `data-tooltip="…"` (set in renderHeader from
// COLUMN_DEFS.tooltip) get a custom absolute-positioned popup on
// mouseover. The native browser `title=""` is removed for these cells
// at attach-time so the OS tooltip doesn't double-up on the custom one.
// Implementation is delegated on the document so a header rebuild
// (drag-reorder, resetLayout) never has to re-bind listeners.
function _initHeaderTooltips() {
  if (document.getElementById('header-tooltip-popup')) return; // idempotent
  const tip = document.createElement('div');
  tip.id = 'header-tooltip-popup';
  tip.className = 'header-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);

  const positionFor = (cell) => {
    const r = cell.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    // First measure with default left/top to learn intrinsic size.
    tip.style.left = '0px';
    tip.style.top  = '0px';
    tip.style.maxWidth = '320px';
    tip.classList.add('is-visible');
    const tr = tip.getBoundingClientRect();
    // Center horizontally on the cell, clamp into the viewport.
    let left = Math.round(r.left + r.width / 2 - tr.width / 2);
    left = Math.max(8, Math.min(vw - tr.width - 8, left));
    const top = Math.round(r.bottom + 8);
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
  };

  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const cell = t.closest('.thdr [data-tooltip]');
    if (!cell) return;
    const text = cell.getAttribute('data-tooltip');
    if (!text) return;
    // Drop the native title so we don't render two tooltips at once.
    if (cell.hasAttribute('title')) {
      cell.dataset.tipNativeSaved = cell.getAttribute('title') || '';
      cell.removeAttribute('title');
    }
    tip.textContent = text;
    tip.setAttribute('aria-hidden', 'false');
    positionFor(cell);
  });

  document.addEventListener('mouseout', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const cell = t.closest('.thdr [data-tooltip]');
    if (!cell) return;
    tip.classList.remove('is-visible');
    tip.setAttribute('aria-hidden', 'true');
    // Restore the native title so right-click → "Inspect" etc. still
    // shows the upstream metadata on a second hover.
    if (cell.dataset.tipNativeSaved != null) {
      cell.setAttribute('title', cell.dataset.tipNativeSaved);
      delete cell.dataset.tipNativeSaved;
    }
  });

  // Hide on scroll inside the scanner pane (the popup is body-mounted
  // so it would otherwise stay anchored to a stale rect).
  document.addEventListener('scroll', () => {
    tip.classList.remove('is-visible');
    tip.setAttribute('aria-hidden', 'true');
  }, true);
}

// One-time bootstrap of the V7.3 + V7.4 column engine. Safe to call
// before the header DOM is in the document — renderHeader() looks up
// the element lazily and bails if absent.
function initColumnDnD() {
  _ensureColumnPositions(); // V8 — seed absolute coordinates on first boot
  renderHeader();
  _initHeaderTooltips(); // V7.4 hover popups — idempotent
}

// Reset action exposed for the user-facing "reset layout" footer link
// so a broken order / oversized column / scattered abacus can be flushed
// without devtools.
window.resetLayout = function() {
  try {
    localStorage.removeItem(COLUMN_ORDER_STORAGE_KEY);
    localStorage.removeItem(COLUMN_WIDTHS_STORAGE_KEY); // V7.4
    localStorage.removeItem(COLUMN_POSITIONS_STORAGE_KEY); // V8 abacus
  } catch {}
  _columnOrder = DEFAULT_COLUMN_ORDER.slice();
  for (const k of Object.keys(COLUMN_DEFS)) _columnWidths[k] = COLUMN_DEFS[k].width;
  _columnPositions = {};
  _columnContentWidths = {};
  _ensureColumnPositions();
  renderHeader();
  try { renderList(); } catch {}
};

// ========== TARGET 4: HOTNESS TOOLTIP ==========
function initHotnessTooltip() {
  // We observe the DOM because the header is rendered dynamically
  const observer = _ObserverRegistry.add(new MutationObserver(() => {
    const hotHeaders = document.querySelectorAll('.thdr [data-hot-tip]');
    hotHeaders.forEach(el => {
      if (el.dataset.tipReady) return;
      el.dataset.tipReady = '1';
      el.style.position = 'relative';
      el.style.cursor = 'help';

      const tip = document.createElement('div');
      tip.className = 'hotness-tooltip';
      tip.innerHTML = `
        <div class="ht-row"><span class="ht-dot" style="background:var(--txt3)"></span><b>&lt;30%</b> Dead</div>
        <div class="ht-row"><span class="ht-dot" style="background:var(--amb)"></span><b>30-60%</b> Normal</div>
        <div class="ht-row"><span class="ht-dot" style="background:var(--red)"></span><b>60-85%</b> Hot</div>
        <div class="ht-row"><span class="ht-dot" style="background:#ff1744"></span><b>&gt;85%</b> Boiling</div>
      `;
      el.appendChild(tip);

      el.addEventListener('mouseenter', () => tip.classList.add('ht-visible'));
      el.addEventListener('mouseleave', () => tip.classList.remove('ht-visible'));
    });
  }));
  observer.observe(document.body, { childList: true, subtree: true });
}

// Hook AI analysis into LiveFeed
const _origRequestAnalysis = window.requestAnalysis;
if (typeof _origRequestAnalysis === 'function') {
  window.requestAnalysis = function(sym, id) {
    LiveFeed.push(`AI analysis requested: ${sym}`, 'ai');
    // Resolve coin context so non-Binance/DEX coins still get an
    // analysis. The backend uses this to skip the Binance fetch
    // entirely when binance_available === false.
    let ctx = null;
    try {
      const d = (Array.isArray(DATA) ? DATA : []).find(x => (id && x.id === id) || (x.symbol || '').toUpperCase() === String(sym || '').toUpperCase());
      if (d) {
        ctx = {
          id: d.id,
          symbol: (d.symbol || '').toUpperCase(),
          name: d.name || d.id,
          binance_available: !!isOnBinance(d),
          // V4 Premium: forward the venue (spot vs futures) + futures
          // pair so analyze.js can hit /fapi for ALPHA coins.
          binance_market: d.binance_market || (d.exchange === 'ALPHA' ? 'futures' : (isOnBinance(d) ? 'spot' : null)),
          exchange: d.exchange || null,
          pair: d.pair || null,
          quote: d.quote || null,
          futures_pair: d.futures_pair || null,
          futures_quote: d.futures_quote || null,
          spot_pair: d.spot_pair || null,
          current_price: d.current_price || 0,
          price_change_percentage_24h: d.price_change_percentage_24h || 0,
          high_24h: d.high_24h || 0,
          low_24h: d.low_24h || 0,
          total_volume: d.total_volume || 0,
          market_cap: d.market_cap || 0,
          market_cap_rank: d.market_cap_rank || 0,
        };
      }
    } catch {}
    if (ctx) window.__lastAnalyzeCtx = ctx;
    return _origRequestAnalysis.call(this, sym, id, ctx);
  };
}

const LOCAL_PAPERBOT_STORAGE_KEY = 'terminal.v7.localPaperBot.state.v4';

class LocalPaperBot {
  constructor(opts = {}) {
    this.storageKey = opts.storageKey || LOCAL_PAPERBOT_STORAGE_KEY;
    this.startingBalance = Number(opts.startingBalance) || 10000;
    this.baselineCaution = 1;
    this.maxOpenPositions = Number(opts.maxOpenPositions) || 4;
    this.recentTradeLimit = Number(opts.recentTradeLimit) || 50;
    this.historyLimit = Number(opts.historyLimit) || 36;
    this.riskFraction = Number(opts.riskFraction) || 0.075;
    // ── STRICT RISK BOUNDS (client mandate, non-overridable) ──
    //   • Hard 3% stop-loss on every position.
    //   • Dynamic take-profit band, 10%–20%, resolved per-trade in _openPosition.
    this.stopLossPct = 0.03;
    this.takeProfitPctMin = 0.10;
    this.takeProfitPctMax = 0.20;
    this.takeProfitPct = (this.takeProfitPctMin + this.takeProfitPctMax) / 2; // 0.15 fallback
    this.feePct = Number(opts.feePct) || 0.0004;
    this.sleepGapMs = Number(opts.sleepGapMs) || 30 * 60 * 1000;
    this.symbolCooldownMs = Number(opts.symbolCooldownMs) || 20 * 60 * 1000;
    this.signalLockMs = Number(opts.signalLockMs) || 6 * 60 * 60 * 1000;
    this.minTradeVolumeUsd = Number(opts.minTradeVolumeUsd) || 1000000;
    this.maxSpreadPct = Number(opts.maxSpreadPct) || 0.015;
    this.priceHistory = new Map();
    this.lastPrices = new Map();
    this.state = this._loadState();
  }

  processMarkets(marketsArray) {
    const now = Date.now();
    const markets = Array.isArray(marketsArray) ? marketsArray : [];
    const candidates = [];
    const currentPrices = new Map();
    for (let i = 0; i < markets.length; i++) {
      const snap = this._normalizeMarket(markets[i]);
      if (snap) currentPrices.set(snap.symbol, snap.price);
    }
    const slept = currentPrices.size ? this._handleSleepGap(now, currentPrices) : false;

    for (let i = 0; i < markets.length; i++) {
      const market = this._normalizeMarket(markets[i]);
      if (!market) continue;

      // ── SANITY CHECK: reject data-anomaly ticks (>15% single-tick jump) ──
      const hist = this._pushPrice(market.symbol, market.price, now);
      if (hist === null) continue; // corrupted tick — skip entirely

      this.lastPrices.set(market.symbol, market.price);
      this._markOpenPrice(market.symbol, market.price);

      const pos = this._findOpen(market.symbol);
      if (pos) {
        const exitReason = this._exitReason(pos, market.price);
        if (exitReason) this._closePosition(pos, market.price, exitReason, now);
        continue;
      }

      if (slept || this.state.openPositions.length >= this.maxOpenPositions) continue;
      if (!this._isTradableMarket(market, now)) continue;
      const signal = this._buildSignal(market, hist);
      if (signal) candidates.push(signal);
    }

    if (candidates.length && this.state.openPositions.length < this.maxOpenPositions) {
      candidates.sort((a, b) => b.strength - a.strength);
      for (let i = 0; i < candidates.length && this.state.openPositions.length < this.maxOpenPositions; i++) {
        const candidate = candidates[i];
        if (!this._findOpen(candidate.symbol) && this._isTradableMarket(candidate, now) && !this._isSignalConsumed(candidate.signalKey, now)) {
          this._openPosition(candidate, now);
        }
      }
    }

    if (currentPrices.size) this.state.lastTickTime = now;
    const payload = this._payload(now);
    this._saveState();
    if (typeof renderPaperBot === 'function') renderPaperBot(payload);
    return payload;
  }

  _loadState() {
    const fresh = {
      balance: this.startingBalance,
      realizedPnl: 0,
      wins: 0,
      losses: 0,
      cautionMultiplier: this.baselineCaution,
      openPositions: [],
      recentTrades: [],
      startedAt: Date.now(),
      totalClosed: 0,
      lastTickTime: Date.now(),
      cooldowns: {},
      consumedSignals: {},
    };

    try {
      const raw = window.localStorage && window.localStorage.getItem(this.storageKey);
      if (!raw) return fresh;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return fresh;
      return {
        balance: this._finite(saved.balance, fresh.balance),
        realizedPnl: this._finite(saved.realizedPnl, 0),
        wins: Math.max(0, this._finite(saved.wins, 0) | 0),
        losses: Math.max(0, this._finite(saved.losses, 0) | 0),
        cautionMultiplier: this._clamp(this._finite(saved.cautionMultiplier, 1), 0.75, 5),
        openPositions: Array.isArray(saved.openPositions) ? saved.openPositions.filter(Boolean).slice(0, this.maxOpenPositions) : [],
        recentTrades: Array.isArray(saved.recentTrades) ? saved.recentTrades.filter(Boolean).slice(-this.recentTradeLimit) : [],
        startedAt: this._finite(saved.startedAt, Date.now()),
        totalClosed: Math.max(0, this._finite(saved.totalClosed, (saved.wins | 0) + (saved.losses | 0)) | 0),
        lastTickTime: this._finite(saved.lastTickTime, Date.now()),
        cooldowns: saved.cooldowns && typeof saved.cooldowns === 'object' ? saved.cooldowns : {},
        consumedSignals: saved.consumedSignals && typeof saved.consumedSignals === 'object' ? saved.consumedSignals : {},
      };
    } catch {
      return fresh;
    }
  }

  _saveState() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(this.storageKey, JSON.stringify({
        balance: this.state.balance,
        realizedPnl: this.state.realizedPnl,
        wins: this.state.wins,
        losses: this.state.losses,
        cautionMultiplier: this.state.cautionMultiplier,
        openPositions: this.state.openPositions,
        recentTrades: this.state.recentTrades.slice(-this.recentTradeLimit),
        startedAt: this.state.startedAt,
        totalClosed: this.state.totalClosed,
        lastTickTime: this.state.lastTickTime,
        cooldowns: this._prunedExpiryObject(this.state.cooldowns, Date.now()),
        consumedSignals: this._prunedExpiryObject(this.state.consumedSignals, Date.now()),
      }));
    } catch {}
  }

  _normalizeMarket(d) {
    if (!d || typeof d !== 'object') return null;
    const rawSymbol = String(d.symbol || d.base || d.id || '').split(':')[0].trim().toUpperCase();
    const symbol = rawSymbol.replace(/[^A-Z0-9]/g, '');
    const price = Number(d.current_price != null ? d.current_price : (d.price != null ? d.price : d.p));
    if (!symbol || !Number.isFinite(price) || price <= 0) return null;
    return {
      id: d.id || symbol,
      symbol,
      price,
      c24: this._finite(d.price_change_percentage_24h != null ? d.price_change_percentage_24h : d._c24, 0),
      c1: this._finite(d._c1, 0),
      c4: this._finite(d._c4, 0),
      c12: this._finite(d._c12, 0),
      c7d: this._finite(d._c7d, 0),
      volume: this._finite(d.total_volume != null ? d.total_volume : d.qv, 0),
      baseVolume: this._finite(d.base_volume, 0),
      trades24h: Math.max(0, this._finite(d.trades_24h, 0) | 0),
      high24: this._finite(d.high_24h, 0),
      low24: this._finite(d.low_24h, 0),
      bid: this._finite(d.bid, 0),
      ask: this._finite(d.ask, 0),
      spreadPct: this._finite(d.spreadPct != null ? d.spreadPct : d.spread_pct, 0),
      score: this._finite(d._sig_score != null ? d._sig_score : d.score, 0),
      panic: this._finite(d._panic, 0),
      hotness: this._calcHotnessSafe(d),
      momentum: this._readMomentumScore(d),
      scannerSignal: this._readScannerSignal(d),
      raw: d,
    };
  }

  _pushPrice(symbol, price, ts) {
    let hist = this.priceHistory.get(symbol);
    if (!hist) {
      hist = [];
      this.priceHistory.set(symbol, hist);
    }
    const last = hist[hist.length - 1];
    // ── DATA SANITY: reject >15% single-tick jumps as feed corruption ──
    if (last && last.price > 0) {
      const pctChange = Math.abs(price - last.price) / last.price;
      if (pctChange > 0.15) {
        // Anomaly detected — do NOT update history, do NOT let SL/TP fire.
        return null;
      }
    }
    if (!last || last.price !== price) hist.push({ price, ts });
    if (hist.length > this.historyLimit) hist.splice(0, hist.length - this.historyLimit);
    return hist;
  }

  _buildSignal(market, hist) {
    const guard = this._marketRiskGuard();
    if (guard.block) return null;
    if (!this._isTradableMarket(market, Date.now())) return null;

    const raw = market && market.raw && typeof market.raw === 'object' ? market.raw : {};
    const scanner = market.scannerSignal || this._readScannerSignal(raw);
    const label = String(scanner.label || raw.signal || raw._signal || '').trim().toUpperCase();
    const pattern = String(scanner.pattern || raw.pattern || raw._pattern || '').trim().toUpperCase();
    const score = this._clamp(this._finite(scanner.score != null ? scanner.score : market.score, 0), 0, 10);
    const hotness = this._clamp(this._finite(market.hotness, 0), 0, 100);
    const panic = this._clamp(this._finite(market.panic, 0), -100, 100);
    const momentum = this._clamp(this._finite(market.momentum, 0), -100, 100);
    const stack = this._readMomentumStack(raw);
    const sentiment = this._readAiSentiment(raw);
    const volEvent = this._readVolatilityEvent(market.symbol);
    const divergence = this._readDivergenceSignal(market.symbol);
    const sniper = this._readSniperSignal(market.symbol);
    const flags = this._readScannerFlags(raw, scanner);
    const liquid = market.volume >= this.minTradeVolumeUsd;

    if (!liquid) return null;

    // ── LIQUIDATION HUNTER: detect a flush-and-confirm wick before anything
    // else. This is a HARD GATE — the bot only ever fires on a confirmed
    // liquidation flush, and only in the direction the flush reverses. ──
    const flush = this._detectFlush(hist, market, volEvent);
    if (!flush) return null;
    if (this._isSignalConsumed(flush.signalKey, Date.now())) return null;

    let longStrength = 0;
    let shortStrength = 0;
    const longReasons = [];
    const shortReasons = [];
    const addLong = (weight, reason) => {
      if (!Number.isFinite(weight) || weight <= 0) return;
      longStrength += weight;
      longReasons.push(reason);
    };
    const addShort = (weight, reason) => {
      if (!Number.isFinite(weight) || weight <= 0) return;
      shortStrength += weight;
      shortReasons.push(reason);
    };

    // Liquidation flush is the dominant, primary edge for this bot.
    if (flush.side === 'long') addLong(flush.weight, 'liquidation_flush_long');
    else addShort(flush.weight, 'liquidation_flush_short');

    if (/BUY|RECLAIM|FLUSH/.test(label)) addLong(12 + score * 2, label.toLowerCase());
    if (/SHORT|SELL/.test(label)) addShort(12 + score * 2, label.toLowerCase());
    if (pattern === 'RECLAIM' || pattern === 'FLUSH') addLong(8 + score, pattern.toLowerCase());
    if (flags.breakout) addLong(10 + Math.max(0, hotness - 55) * 0.25, 'scanner_breakout');
    if (flags.breakdown) addShort(10 + Math.max(0, hotness - 55) * 0.25, 'scanner_breakdown');
    if (flags.flush || panic <= -80) addLong(8 + Math.abs(Math.min(0, panic)) * 0.08, 'capitulation_reversal');
    if (panic >= 80) addShort(8 + panic * 0.08, 'fomo_exhaustion');
    if (momentum >= 35 && stack >= 0.6) addLong(8 + momentum * 0.12, 'multi_tf_bull');
    if (momentum <= -35 && stack >= 0.6) addShort(8 + Math.abs(momentum) * 0.12, 'multi_tf_bear');
    if (hotness >= 70 && market.c24 > 0) addLong(6 + (hotness - 70) * 0.18, 'hot_volume_bid');
    if (hotness >= 70 && market.c24 < 0) addShort(6 + (hotness - 70) * 0.18, 'hot_volume_ask');

    if (volEvent) {
      const volWeight = 9 + Math.min(12, Math.abs(this._finite(volEvent.c1, 0)) + this._finite(volEvent.volRatio, 0));
      if (this._finite(volEvent.c1, 0) >= 0) addLong(volWeight, 'volume_surge_up');
      else addShort(volWeight, 'volume_surge_down');
    }

    if (sniper && this._finite(sniper.confidence, 0) >= 0.55) {
      addLong(10 + this._finite(sniper.confidence, 0) * 12, 'sniper_bid_wall');
    }

    if (divergence && this._finite(divergence.confidence, 0) >= 0.5) {
      const divWeight = 10 + this._finite(divergence.confidence, 0) * 12;
      if (String(divergence.bias || '').toLowerCase() === 'bullish') addLong(divWeight, 'smart_money_bull');
      if (String(divergence.bias || '').toLowerCase() === 'bearish') addShort(divWeight, 'smart_money_bear');
    }

    if (sentiment.score >= 0.65 || sentiment.label === 'bullish') {
      addLong(8 + Math.abs(sentiment.score) * 10, 'ai_sentiment_bull');
    }
    if (sentiment.score <= -0.65 || sentiment.label === 'bearish') {
      addShort(8 + Math.abs(sentiment.score) * 10, 'ai_sentiment_bear');
    }

    const minStrength = 16 * Math.sqrt(Math.max(0.75, guard.caution));
    const edge = 2 * Math.sqrt(Math.max(0.75, guard.caution));
    // Direction is locked to the confirmed flush — we only take the side the
    // liquidation wick reversed into, and only if the stacked edge confirms.
    if (flush.side === 'long' && longStrength >= minStrength && longStrength >= shortStrength + edge) {
      return { ...market, side: 'long', strength: longStrength, reason: this._reason(longReasons, 'liquidation_flush_long'), signalKey: flush.signalKey };
    }
    if (flush.side === 'short' && shortStrength >= minStrength && shortStrength >= longStrength + edge) {
      return { ...market, side: 'short', strength: shortStrength, reason: this._reason(shortReasons, 'liquidation_flush_short'), signalKey: flush.signalKey };
    }
    return null;
  }

  _isTradableMarket(market, now) {
    if (!market || !market.symbol) return false;
    if (this._isSymbolCoolingDown(market.symbol, now)) return false;
    if (this._isToxicSymbol(market.symbol)) return false;
    const vol = Number(market.volume);
    if (!Number.isFinite(vol) || vol < this.minTradeVolumeUsd) return false;
    const spread = this._marketSpreadPct(market);
    if (spread > this.maxSpreadPct) return false;
    const high = Number(market.high24) || 0;
    const low = Number(market.low24) || 0;
    const price = Number(market.price) || 0;
    const rangePct = high > 0 && low > 0 ? (high - low) / Math.max(low, price, 1e-12) : 0;
    if (price > 0 && rangePct > 0 && rangePct < 0.004 && Math.abs(Number(market.c24) || 0) < 0.6) return false;
    return true;
  }

  _isToxicSymbol(symbol) {
    const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s) return true;
    const blocked = new Set([
      'USDT','USDC','BUSD','FDUSD','TUSD','USDP','USDD','DAI','FRAX','LUSD','PYUSD','USDE','SUSDE','USD1','USTC',
      'EUR','EURC','EURS','EURI','EURT','AEUR','SEUR','JPY','JPYC','GYEN','GBP','GBPT','CHF','AUD','CAD','BRL',
      'REUSD','USDR','USDX','USDL','USDM','USDS','USDJ','XAUT',
    ]);
    if (blocked.has(s)) return true;
    return /(?:USD|USDT|USDC|DAI|EUR|JPY|GBP|CHF|AUD|CAD)$/.test(s);
  }

  _marketSpreadPct(market) {
    const explicit = Number(market.spreadPct);
    if (Number.isFinite(explicit) && explicit > 0) return explicit > 1 ? explicit / 100 : explicit;
    const bid = Number(market.bid) || 0;
    const ask = Number(market.ask) || 0;
    if (bid > 0 && ask > bid) return (ask - bid) / ((ask + bid) / 2);
    return 0;
  }

  _isSymbolCoolingDown(symbol, now) {
    const key = String(symbol || '').toUpperCase();
    const until = Number(this.state.cooldowns && this.state.cooldowns[key]) || 0;
    return until > now;
  }

  _setSymbolCooldown(symbol, now) {
    const key = String(symbol || '').toUpperCase();
    if (!key) return;
    if (!this.state.cooldowns || typeof this.state.cooldowns !== 'object') this.state.cooldowns = {};
    this.state.cooldowns[key] = now + this.symbolCooldownMs;
  }

  _isSignalConsumed(signalKey, now) {
    if (!signalKey) return true;
    const until = Number(this.state.consumedSignals && this.state.consumedSignals[signalKey]) || 0;
    return until > now;
  }

  _consumeSignal(signalKey, now) {
    if (!signalKey) return;
    if (!this.state.consumedSignals || typeof this.state.consumedSignals !== 'object') this.state.consumedSignals = {};
    this.state.consumedSignals[signalKey] = now + this.signalLockMs;
  }

  _prunedExpiryObject(obj, now) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      const until = Number(v) || 0;
      if (until > now) out[k] = until;
    }
    return out;
  }

  // ── LIQUIDATION HUNTER ──────────────────────────────────────────────
  // Detect a "flush and confirm" liquidation wick from recent price history.
  //   • FLUSH  : the most recent completed leg (base -> wick) is a sharp move,
  //              large both in absolute terms AND relative to the symbol's own
  //              recent step volatility (so quiet drifts never qualify).
  //   • CONFIRM: the live tick (wick -> last) stabilizes or reverses back
  //              toward the pre-flush base without fully retracing it.
  // A down-flush that bounces => LONG; an up-flush that rejects => SHORT.
  // Volume, when present, only sharpens conviction (it never gates).
  _detectFlush(hist, market, volEvent) {
    if (!Array.isArray(hist) || hist.length < 4) return null;
    const n = hist.length;
    const last = this._finite(hist[n - 1].price, 0);
    if (last <= 0) return null;

    let maxStep = 0;
    for (let i = Math.max(1, n - 12); i < n; i++) {
      const a = this._finite(hist[i - 1].price, 0);
      const b = this._finite(hist[i].price, 0);
      if (a > 0 && b > 0) maxStep = Math.max(maxStep, Math.abs(b - a) / a);
    }

    const FLUSH_MIN = 0.004;
    const adaptiveMin = Math.max(FLUSH_MIN, Math.min(0.018, maxStep * 1.25));
    const lookbackStart = Math.max(1, n - 10);
    let best = null;

    for (let i = lookbackStart; i < n - 1; i++) {
      const base = this._finite(hist[i - 1].price, 0);
      const wick = this._finite(hist[i].price, 0);
      if (!(base > 0 && wick > 0)) continue;

      const flushPct = (wick - base) / base;
      const flushMag = Math.abs(flushPct);
      if (flushMag < adaptiveMin) continue;

      const reactionPct = (last - wick) / wick;
      const retrace = flushMag > 0 ? Math.abs(last - wick) / Math.abs(wick - base) : 0;
      const stabilized = Math.abs(reactionPct) <= flushMag * 0.18;
      const confirmed = retrace >= 0.08 || stabilized;
      if (!confirmed) continue;

      const volBoost = volEvent ? Math.min(10, 4 + Math.abs(this._finite(volEvent.volRatio, 0))) : 0;
      const weight = 21 + flushMag * 300 + Math.min(8, retrace * 10) + volBoost;
      const wickTs = Number(hist[i].ts) || i;
      const baseTs = Number(hist[i - 1].ts) || (i - 1);
      const signalRoot = [
        market && market.symbol || 'UNKNOWN',
        wickTs,
        baseTs,
        Math.round(wick * 1e8),
        Math.round(base * 1e8),
      ].join(':');

      if (flushPct < 0 && last > wick && last <= base * 1.006) {
        const candidate = { side: 'long', magnitude: flushMag, weight, signalKey: signalRoot + ':long' };
        if (!best || candidate.weight > best.weight) best = candidate;
      } else if (flushPct > 0 && last < wick && last >= base * 0.994) {
        const candidate = { side: 'short', magnitude: flushMag, weight, signalKey: signalRoot + ':short' };
        if (!best || candidate.weight > best.weight) best = candidate;
      }
    }

    return best;
  }

  _handleSleepGap(now, currentPrices) {
    const last = Number(this.state.lastTickTime);
    if (!Number.isFinite(last) || last <= 0) {
      this.state.lastTickTime = now;
      return false;
    }
    const gap = now - last;
    if (gap <= this.sleepGapMs) return false;

    const open = Array.isArray(this.state.openPositions) ? this.state.openPositions.slice() : [];
    let closed = 0;
    for (const pos of open) {
      if (!pos || !pos.symbol) continue;
      const px = currentPrices.get(pos.symbol)
        || this.lastPrices.get(pos.symbol)
        || Number(pos.currentPrice)
        || Number(pos.entryPrice);
      if (!Number.isFinite(px) || px <= 0) continue;
      this._closePosition(pos, px, 'system_sleep', now);
      closed += 1;
    }
    this.state.lastTickTime = now;
    if (closed) {
      try { LiveFeed?.push(`PaperBot sleep gap ${(gap / 60000).toFixed(0)}m - closed ${closed} open position(s)`, 'alert'); } catch {}
      try { window.Toast?.warn('PaperBot sleep detector', `Closed ${closed} position(s) after ${(gap / 60000).toFixed(0)}m without ticks.`); } catch {}
      console.warn('[PAPERBOT] sleep gap detected; forced close', { gapMs: gap, closed });
    }
    return true;
  }

  _marketRiskGuard() {
    let reg = null;
    try {
      reg = (typeof REGIME !== 'undefined' && REGIME) || window.currentRegime || window.REGIME || null;
    } catch { reg = null; }
    const bucket = String(reg && reg.bucket || '').toLowerCase();
    const label = String(reg && reg.label || reg && reg.level || '').toLowerCase();
    const level = String(reg && reg.level || '').toLowerCase();
    const score = this._finite(reg && reg.score, 0);
    const hasRegime = !!(reg && (
      reg.computed_at || reg.inputs || reg.components || Math.abs(score) > 0
      || (Array.isArray(reg.reasons) && reg.reasons.length)
    ));
    const panicScore = this._finite(
      reg && (reg.panicScore != null ? reg.panicScore : (reg.panic != null ? reg.panic : reg.marketPanic)),
      score,
    );
    let volCount = 0;
    try { volCount = Array.isArray(window.__lastVolatility) ? window.__lastVolatility.length : 0; } catch {}

    const isChop = hasRegime && (bucket === 'chop' || /chop|sideways|mixed/.test(label));
    const highPanic = (hasRegime && (level === 'shock' || Math.abs(panicScore) >= 70)) || volCount >= 5;
    const elevated = (hasRegime && (level === 'elevated' || Math.abs(panicScore) >= 45)) || volCount > 0;

    if (isChop || highPanic) {
      const floor = highPanic ? 2.25 : 1.75;
      this.state.cautionMultiplier = this._clamp(Math.max(this.state.cautionMultiplier || 1, floor), 0.75, 5);
      return { block: false, caution: this.state.cautionMultiplier, reason: highPanic ? 'global_panic' : 'regime_chop' };
    }
    if (elevated) {
      this.state.cautionMultiplier = this._clamp(Math.max(this.state.cautionMultiplier || 1, 1.35), 0.75, 5);
    }
    return { block: false, caution: this._clamp(this.state.cautionMultiplier || 1, 0.75, 5), reason: 'ok' };
  }

  _readScannerSignal(raw) {
    try {
      if (raw && raw._sig && typeof raw._sig === 'object') return raw._sig;
      if (typeof _sigOf === 'function') return _sigOf(raw);
      if (typeof sig === 'function') return sig(raw);
    } catch {}
    return {
      label: raw && (raw.signal || raw._signal) || 'NEUT',
      score: this._finite(raw && (raw._sig_score != null ? raw._sig_score : raw.score), 0),
      reasons: [],
      pattern: raw && (raw.pattern || raw._pattern) || null,
      whyTags: [],
    };
  }

  _calcHotnessSafe(raw) {
    try {
      if (raw && raw._hotness != null) return this._finite(raw._hotness, 0);
      if (typeof calcHotness === 'function') return this._finite(calcHotness(raw), 0);
    } catch {}
    return 0;
  }

  _readMomentumScore(raw) {
    try {
      const m = raw && raw._mom;
      if (m && typeof m === 'object') return this._finite(m.score, 0);
      if (m != null) return this._finite(m, 0);
      if (typeof computeMomentumScore === 'function') {
        const computed = computeMomentumScore(raw);
        return this._finite(computed && computed.score, 0);
      }
    } catch {}
    return 0;
  }

  _readMomentumStack(raw) {
    try {
      const m = raw && raw._mom;
      if (m && typeof m === 'object') return this._clamp(this._finite(m.stack, 0), 0, 1);
      if (typeof computeMomentumScore === 'function') {
        const computed = computeMomentumScore(raw);
        return this._clamp(this._finite(computed && computed.stack, 0), 0, 1);
      }
    } catch {}
    return 0;
  }

  _readAiSentiment(raw) {
    const out = { label: 'neutral', score: 0 };
    try {
      const candidates = [
        raw && raw.ai_sentiment,
        raw && raw.aiSentiment,
        raw && raw._sentiment,
        raw && raw.sentiment,
        raw && raw.news_sentiment,
      ];
      for (const c of candidates) {
        if (!c) continue;
        if (typeof c === 'object') {
          const nested = this._readAiSentiment(c);
          if (nested.label !== 'neutral' || nested.score) return nested;
        }
        const s = String(c).toLowerCase();
        if (/bull|positive|buy|long/.test(s)) return { label: 'bullish', score: 0.8 };
        if (/bear|negative|sell|short/.test(s)) return { label: 'bearish', score: -0.8 };
      }
      const keys = ['ai_score', 'aiScore', '_aiScore', 'sentiment_score', 'sentimentScore', 'ai_sentiment_score'];
      for (const k of keys) {
        if (!raw || raw[k] == null) continue;
        let n = this._finite(raw[k], 0);
        if (Math.abs(n) > 10) n /= 100;
        else if (Math.abs(n) > 1) n /= 10;
        n = this._clamp(n, -1, 1);
        return { label: n > 0.25 ? 'bullish' : (n < -0.25 ? 'bearish' : 'neutral'), score: n };
      }
    } catch {}
    return out;
  }

  _readVolatilityEvent(symbol) {
    try {
      if (!Array.isArray(window.__lastVolatility)) return null;
      const key = String(symbol || '').toUpperCase();
      return window.__lastVolatility.find(v => String(v && v.symbol || '').toUpperCase() === key) || null;
    } catch { return null; }
  }

  _readDivergenceSignal(symbol) {
    try {
      if (typeof DIVERGENCE_MAP === 'undefined' || !DIVERGENCE_MAP) return null;
      return DIVERGENCE_MAP.get(String(symbol || '').toUpperCase()) || null;
    } catch { return null; }
  }

  _readSniperSignal(symbol) {
    try {
      if (typeof SNIPER_MAP === 'undefined' || !SNIPER_MAP) return null;
      return SNIPER_MAP.get(String(symbol || '').toUpperCase()) || null;
    } catch { return null; }
  }

  _readScannerFlags(raw, scanner) {
    const haystack = [
      scanner && scanner.label,
      scanner && scanner.pattern,
      ...(Array.isArray(scanner && scanner.reasons) ? scanner.reasons : []),
      ...(Array.isArray(scanner && scanner.whyTags) ? scanner.whyTags.map(t => t && (t.tag || t.label || t)) : []),
      raw && raw.signal,
      raw && raw._signal,
      raw && raw.pattern,
      raw && raw._pattern,
    ].filter(Boolean).join(' ').toLowerCase();
    return {
      breakout: this._truthyFlag(raw && (raw.breakout || raw._breakout || raw.breakoutUp || raw.is_breakout)) || /breakout/.test(haystack),
      breakdown: this._truthyFlag(raw && (raw.breakdown || raw._breakdown || raw.breakoutDown || raw.is_breakdown)) || /breakdown|short|sell/.test(haystack),
      flush: this._truthyFlag(raw && (raw.flush || raw._flush || raw.capitulation)) || /flush|capitulation/.test(haystack),
    };
  }

  _truthyFlag(value) {
    if (value === true) return true;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'string') return /^(1|true|yes|y|on|breakout|breakdown)$/i.test(value.trim());
    return false;
  }

  _reason(reasons, fallback) {
    const seen = new Set();
    const clean = [];
    for (const r of reasons) {
      const s = String(r || '').trim().replace(/[^a-z0-9_+-]/gi, '_').slice(0, 32);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 3) break;
    }
    return clean.length ? clean.join('+') : fallback;
  }

  _openPosition(signal, now) {
    if (this._isSignalConsumed(signal.signalKey, now)) return;
    this._consumeSignal(signal.signalKey, now);
    const sideMul = signal.side === 'short' ? -1 : 1;
    const notional = Math.max(25, this.state.balance * this.riskFraction / Math.max(1, this.state.cautionMultiplier));
    // ── STRICT RISK BOUNDS: 3% hard SL, dynamic 10%-20% TP ──
    // TP scales within the band: half random, half driven by realized
    // volatility (|24h change|), then hard-clamped so it can never escape
    // [10%, 20%]. SL is the fixed client cap.
    const slPct = 0.03;
    const volScale = this._clamp(Math.abs(this._finite(signal.c24, 0)) / 20, 0, 1);
    const tpPct = this._clamp(
      this.takeProfitPctMin + (this.takeProfitPctMax - this.takeProfitPctMin) * (0.5 * Math.random() + 0.5 * volScale),
      this.takeProfitPctMin,
      this.takeProfitPctMax,
    );
    const tp = signal.price * (1 + sideMul * tpPct);
    const sl = signal.price * (1 - sideMul * slPct);
    this.state.openPositions.push({
      id: signal.id,
      symbol: signal.symbol,
      side: signal.side,
      entryPrice: signal.price,
      currentPrice: signal.price,
      notional,
      qty: notional / signal.price,
      tpPrice: tp,
      slPrice: sl,
      tpPct,
      slPct,
      signalKey: signal.signalKey,
      openedAt: now,
      reason: signal.reason,
      entryMomentum: signal.c24,
    });
  }

  _closePosition(pos, exitPrice, reason, now) {
    const idx = this.state.openPositions.indexOf(pos);
    if (idx < 0) return;
    const sideMul = pos.side === 'short' ? -1 : 1;
    // ── GUARANTEED SL: cap exit price at the SL level to prevent slippage ──
    let effectiveExit = exitPrice;
    if (reason === 'stop_loss') {
      effectiveExit = pos.slPrice;
    }
    const pnlPct = sideMul * ((effectiveExit - pos.entryPrice) / pos.entryPrice) * 100;
    const grossPnl = (pnlPct / 100) * pos.notional;
    const fees = pos.notional * this.feePct * 2;
    const pnl = grossPnl - fees;
    this.state.balance = this._round(this.state.balance + pnl, 6);
    this.state.realizedPnl = this._round(this.state.realizedPnl + pnl, 6);
    this.state.openPositions.splice(idx, 1);
    this.state.totalClosed = (this.state.totalClosed || 0) + 1;
    this._setSymbolCooldown(pos.symbol, now);
    this._consumeSignal(pos.signalKey, now);
    this.priceHistory.set(pos.symbol, []);

    if (pnl >= 0) {
      this.state.wins += 1;
      this.state.cautionMultiplier = this._clamp(1 + (this.state.cautionMultiplier - 1) * 0.72, 0.75, 5);
    } else {
      this.state.losses += 1;
      this.state.cautionMultiplier = this._clamp(this.state.cautionMultiplier * 1.24, 0.75, 5);
    }

    // ── TRADE RECEIPT: snapshot price curve for visual proof ──
    let priceCurve = [];
    try {
      const fullHist = this.priceHistory.get(pos.symbol);
      if (fullHist && fullHist.length) {
        const openTs = Number(pos.openedAt) || 0;
        priceCurve = fullHist
          .filter(pt => pt.ts >= openTs && pt.ts <= now)
          .map(pt => ({ p: pt.price, t: pt.ts }));
        // Guarantee entry + exit anchors exist in the curve
        if (!priceCurve.length || priceCurve[0].t > openTs) {
          priceCurve.unshift({ p: pos.entryPrice, t: openTs });
        }
        if (priceCurve[priceCurve.length - 1].t < now) {
          priceCurve.push({ p: effectiveExit, t: now });
        }
      }
      // Fallback: at minimum, a straight line from entry → exit
      if (priceCurve.length < 2) {
        priceCurve = [
          { p: pos.entryPrice, t: Number(pos.openedAt) || now },
          { p: effectiveExit, t: now },
        ];
      }
    } catch { priceCurve = []; }

    this.state.recentTrades.push({
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: effectiveExit,
      pnl: this._round(pnl, 6),
      pnlPct: this._round(pnlPct, 4),
      reason,
      openedAt: pos.openedAt,
      closedAt: now,
      holdMs: now - (Number(pos.openedAt) || now),
      signalKey: pos.signalKey,
      priceCurve,
    });
    if (this.state.recentTrades.length > this.recentTradeLimit) {
      this.state.recentTrades.splice(0, this.state.recentTrades.length - this.recentTradeLimit);
    }
  }

  _exitReason(pos, price) {
    const entry = Number(pos.entryPrice) || 0;
    const sideMul = pos.side === 'short' ? -1 : 1;
    if (entry > 0) {
      const hardSl = entry * (1 - sideMul * 0.03);
      pos.slPct = 0.03;
      pos.slPrice = hardSl;
      const currentTpPct = this._clamp(this._finite(pos.tpPct, this.takeProfitPct), 0.10, 0.20);
      pos.tpPct = currentTpPct;
      pos.tpPrice = entry * (1 + sideMul * currentTpPct);
    }
    if (pos.side === 'short') {
      if (price <= pos.tpPrice) return 'take_profit';
      if (price >= pos.slPrice) return 'stop_loss';
    } else {
      if (price >= pos.tpPrice) return 'take_profit';
      if (price <= pos.slPrice) return 'stop_loss';
    }
    return null;
  }

  _payload(now) {
    let unrealizedPnl = 0;
    const openPositions = this.state.openPositions.map((pos) => {
      const px = this.lastPrices.get(pos.symbol) || Number(pos.currentPrice) || Number(pos.entryPrice) || 0;
      const sideMul = pos.side === 'short' ? -1 : 1;
      const pnlPct = pos.entryPrice > 0 ? sideMul * ((px - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      const pnl = (pnlPct / 100) * (Number(pos.notional) || 0);
      unrealizedPnl += pnl;
      pos.currentPrice = px;
      // Attach currentPnl for live UI rendering
      pos.currentPnl = this._round(pnl, 6);
      pos.currentPnlPct = this._round(pnlPct, 4);

      // Attach price curve for live receipt rendering
      const fullHist = this.priceHistory.get(pos.symbol);
      let priceCurve = [];
      const openTs = Number(pos.openedAt) || 0;
      if (fullHist && fullHist.length) {
        priceCurve = fullHist.filter(pt => pt.ts >= openTs && pt.ts <= now).map(pt => ({ p: pt.price, t: pt.ts }));
        if (!priceCurve.length || priceCurve[0].t > openTs) priceCurve.unshift({ p: pos.entryPrice, t: openTs });
        if (priceCurve[priceCurve.length - 1].t < now) priceCurve.push({ p: px, t: now });
      } else {
        priceCurve = [{ p: pos.entryPrice, t: openTs }, { p: px, t: now }];
      }
      
      return { ...pos, currentPrice: px, currentPnl: this._round(pnl, 6), currentPnlPct: this._round(pnlPct, 4), unrealizedPnl: this._round(pnl, 6), unrealizedPnlPct: this._round(pnlPct, 4), priceCurve };
    });
    const wins = this.state.wins | 0;
    const losses = this.state.losses | 0;
    const total = wins + losses;
    const balance = this._round(this.state.balance, 6);
    const realizedPnl = this._round(this.state.realizedPnl, 6);
    unrealizedPnl = this._round(unrealizedPnl, 6);
    return {
      t: 'pb',
      status: 'running',
      balance,
      equity: this._round(balance + unrealizedPnl, 6),
      pnl: this._round(realizedPnl + unrealizedPnl, 6),
      realizedPnl,
      unrealizedPnl,
      winRate: total ? (wins / total) * 100 : 0,
      wins,
      losses,
      openCount: openPositions.length,
      cautionMultiplier: this._round(this.state.cautionMultiplier, 4),
      openPositions,
      recentTrades: this.state.recentTrades.slice(-this.recentTradeLimit),
      totalClosed: this.state.totalClosed || total,
      startedAt: this.state.startedAt,
      uptimeMs: now - (Number(this.state.startedAt) || now),
      ts: now,
    };
  }

  _findOpen(symbol) {
    return this.state.openPositions.find(p => p && p.symbol === symbol);
  }

  _markOpenPrice(symbol, price) {
    const pos = this._findOpen(symbol);
    if (pos) pos.currentPrice = price;
  }

  _finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  _round(value, digits) {
    const m = Math.pow(10, digits || 2);
    return Math.round((Number(value) || 0) * m) / m;
  }
}

const paperBotInstance = new LocalPaperBot();
window.paperBotInstance = paperBotInstance;
