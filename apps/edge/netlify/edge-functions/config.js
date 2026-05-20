// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — /api/config Edge Function (Deno)
//
// Returns the *public* runtime config the browser needs to bootstrap
// the Supabase client. Anon keys are designed to be public but binding
// them to git makes rotation a code change. Reading from env lets ops
// rotate by redeploy.
//
// Only public values go here — never service-role keys, Gemini keys,
// Upstash tokens, etc.
// ─────────────────────────────────────────────────────────────

import { pickAllowOrigin } from './lib/security.js';

const CDN_MAX_AGE_SEC = 300;

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request ? pickAllowOrigin(request) : (Deno.env.get('APP_ORIGIN') || '*'),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Vary': 'Origin',
  };
}

export default function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';

  return new Response(JSON.stringify({
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
    configured: !!(supabaseUrl && supabaseAnonKey),
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, s-maxage=${CDN_MAX_AGE_SEC}`,
      ...corsHeaders(request),
    },
  });
}
