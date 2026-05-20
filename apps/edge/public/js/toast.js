// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — Global Toast / Notification System
//
// Surfaces fetch failures, unhandled rejections, and explicit
// app-level errors directly to the user in the UI instead of
// leaving them buried in the devtools console.
//
// API:
//   Toast.error(title, detail?, { code?, endpoint?, sticky? })
//   Toast.warn(title, detail?, opts?)
//   Toast.info(title, detail?, opts?)
//   Toast.success(title, detail?, opts?)
//
// Globals installed: window.Toast, plus passive listeners for
// `window.onerror` and `window.onunhandledrejection`.
// ─────────────────────────────────────────────────────────────

(function () {
  const MAX_VISIBLE = 5;
  const DEFAULT_TTL_MS = 7000;
  const STICKY_TTL_MS = 0;

  let _container = null;
  let _seq = 0;

  function ensureContainer() {
    if (_container && document.body.contains(_container)) return _container;
    _container = document.createElement('div');
    _container.id = 'toast-container';
    _container.setAttribute('role', 'log');
    _container.setAttribute('aria-live', 'polite');
    // V5 hotfix: belt-and-suspenders inline styles. If terminal.css is
    // stale-cached at an older revision the container still floats
    // above any modal. Inline rules win over the cached stylesheet.
    _container.style.cssText = [
      'position:fixed',
      'top:56px',
      'right:14px',
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'gap:6px',
      'max-width:400px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(_container);
    return _container;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function trimVisible() {
    const c = ensureContainer();
    while (c.children.length > MAX_VISIBLE) {
      c.removeChild(c.firstChild);
    }
  }

  function push(level, title, detail, opts) {
    opts = opts || {};
    // V5 hotfix: explicit console heartbeat so toast misses are
    // observable in devtools even when the visual toast itself fails.
    try { console.log('[TOAST] ' + level + ' · ' + String(title || '').slice(0, 80)); } catch { /* */ }
    const c = ensureContainer();
    const id = 'toast_' + (++_seq);
    const el = document.createElement('div');
    el.className = 'toast toast--' + level;
    el.id = id;
    // Defensive inline z-index in case the cached stylesheet is stale.
    el.style.position = 'relative';
    el.style.pointerEvents = 'auto';

    const code = opts.code != null ? `<span class="toast__code">${esc(opts.code)}</span>` : '';
    const endpoint = opts.endpoint ? `<div class="toast__endpoint">${esc(opts.endpoint)}</div>` : '';
    const detailHtml = detail ? `<div class="toast__detail">${esc(detail)}</div>` : '';

    el.innerHTML = `
      <div class="toast__row">
        <span class="toast__icon" aria-hidden="true">${iconFor(level)}</span>
        <div class="toast__body">
          <div class="toast__title">${esc(title)}${code}</div>
          ${detailHtml}
          ${endpoint}
        </div>
        <button class="toast__close" aria-label="Dismiss">&times;</button>
      </div>
    `;
    c.appendChild(el);
    trimVisible();

    const close = () => {
      if (!el.parentNode) return;
      el.classList.add('toast--leaving');
      setTimeout(() => { try { el.remove(); } catch { /* */ } }, 200);
    };
    el.querySelector('.toast__close').addEventListener('click', close);

    const ttl = opts.sticky ? STICKY_TTL_MS : (opts.ttl != null ? opts.ttl : DEFAULT_TTL_MS);
    if (ttl > 0) setTimeout(close, ttl);
    return id;
  }

  function iconFor(level) {
    return level === 'error' ? '🚨'
      : level === 'warn' ? '⚠️'
      : level === 'success' ? '✅'
      : 'ℹ️';
  }

  const Toast = {
    error: (title, detail, opts) => push('error', title, detail, opts),
    warn:  (title, detail, opts) => push('warn',  title, detail, opts),
    info:  (title, detail, opts) => push('info',  title, detail, opts),
    success: (title, detail, opts) => push('success', title, detail, opts),
  };

  // ── Global error capture ──
  // Surface every uncaught error + unhandled rejection. We keep the
  // existing console.error path intact so devtools logs are unchanged.
  window.addEventListener('error', (e) => {
    if (e?.message && /ResizeObserver loop/i.test(e.message)) return; // known noisy
    Toast.error(
      'Unhandled error',
      e?.message || 'unknown',
      { endpoint: e?.filename ? `${e.filename}:${e.lineno || '?'}` : undefined },
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    const msg = (r && (r.message || r.error)) || String(r || 'unknown');
    Toast.error('Unhandled promise rejection', msg);
  });

  window.Toast = Toast;
})();
