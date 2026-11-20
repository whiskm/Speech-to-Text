/** Shared helpers for the API handlers in /server, called from the Worker in /worker. */

export interface CommonEnv {
  /** Optional. When set, requests must carry the same value in the X-Access-Code header. */
  ACCESS_CODE?: string;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Blocks other websites from calling our endpoints from a browser, and checks the
 * optional access code so strangers cannot spend the owner's Workers AI quota.
 */
export function checkAccess(request: Request, env: CommonEnv): Response | null {
  const origin = request.headers.get('Origin');
  if (origin) {
    const host = new URL(request.url).host;
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return json({ error: 'bad_origin' }, 403);
    }
    if (originHost !== host) return json({ error: 'bad_origin' }, 403);
  }
  const code = env.ACCESS_CODE?.trim();
  if (code) {
    const got = request.headers.get('X-Access-Code') ?? '';
    if (!safeEqual(got, code)) return json({ error: 'access_code' }, 401);
  }
  return null;
}
