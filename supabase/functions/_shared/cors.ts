export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin');
  const configured = (Deno.env.get('TRESOR_ALLOWED_ORIGINS') || 'https://suite-agente-viajes-codex.vercel.app,http://127.0.0.1:4173,http://localhost:4173')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!origin) return { 'Vary':'Origin' };
  if (!configured.includes(origin)) return { 'Vary':'Origin' };
  return { 'Access-Control-Allow-Origin':origin, 'Access-Control-Allow-Headers':'authorization, apikey, content-type, prefer',
    'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Max-Age':'600', 'Vary':'Origin' };
}
export function json(req: Request, body: unknown, status = 200): Response {
  const headers = new Headers(corsHeaders(req));
  headers.set('Content-Type','application/json; charset=utf-8');
  headers.set('Cache-Control','no-store, max-age=0');
  headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  headers.set('Referrer-Policy','no-referrer');
  if (req.headers.get('origin') && !headers.has('Access-Control-Allow-Origin')) return new Response(null,{status:403});
  return new Response(JSON.stringify(body),{status,headers});
}
export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  const headers = new Headers(corsHeaders(req));
  if (req.headers.get('origin') && !headers.has('Access-Control-Allow-Origin')) return new Response(null,{status:403});
  return new Response(null,{status:204,headers});
}
