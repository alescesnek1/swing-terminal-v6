// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — Structured JSON Logger (Deno Edge)
//
// Single-line JSON log emission for fatal / warn paths so production
// log scrapers (Netlify, Datadog, etc.) can index { type, location,
// payload, error, stack } cleanly instead of free-form console.error.
//
// Usage:
//   logFatal({ location: 'analyze/fatal', error, payload: { symbol } });
//   logWarn ({ location: 'analyze/binance', error, payload: { pair } });
//
// Keep the call sites minimal — the helper handles serialization,
// truncation, and stack extraction.
// ─────────────────────────────────────────────────────────────

const MAX_PAYLOAD_CHARS = 2000;
const MAX_STACK_LINES = 10;

function serializeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, code: err.code, status: err.status };
  }
  if (typeof err === 'object') return { ...err };
  return { message: String(err) };
}

function serializeStack(err) {
  if (!err || !(err instanceof Error) || !err.stack) return null;
  return String(err.stack).split('\n').slice(0, MAX_STACK_LINES).join('\n');
}

function truncate(s) {
  if (s == null) return s;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > MAX_PAYLOAD_CHARS ? str.slice(0, MAX_PAYLOAD_CHARS) + '…[truncated]' : str;
}

function emit(level, type, { location, payload, error }) {
  const line = {
    type,
    level,
    ts: new Date().toISOString(),
    location: location || 'unknown',
    payload: payload === undefined ? null : payload,
    error: serializeError(error),
    stack: serializeStack(error),
  };
  // Truncate payload to keep log lines indexable.
  if (line.payload != null) {
    try { line.payload = JSON.parse(truncate(line.payload)); }
    catch { line.payload = truncate(line.payload); }
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  try {
    fn(JSON.stringify(line));
  } catch {
    fn(`[${type}] ${location} ${error?.message || error || ''}`);
  }
}

export function logFatal(args) { emit('error', 'FATAL_ERROR', args); }
export function logWarn(args)  { emit('warn',  'WARN_ERROR',  args); }
export function logInfo(args)  { emit('info',  'INFO',        args); }
