import { checkAccess, json, type CommonEnv } from './common';

export interface LlmEnv extends CommonEnv {
  /** Optional comma-separated extra hosts for self-hosted or rare OpenAI-compatible APIs. */
  EXTRA_LLM_HOSTS?: string;
}

/** Hosts of OpenAI-compatible APIs this proxy may forward to. Anything else is refused. */
const ALLOWED_HOSTS = new Set([
  'api.deepseek.com',
  'api.openai.com',
  'openrouter.ai',
  'api.groq.com',
  'api.mistral.ai',
  'api.together.xyz',
  'api.x.ai',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'generativelanguage.googleapis.com',
  'api.anthropic.com',
]);

const MAX_BODY = 2 * 1024 * 1024;

interface ProxyBody {
  baseUrl?: unknown;
  payload?: {
    model?: unknown;
    messages?: unknown;
    temperature?: unknown;
    stream?: unknown;
    response_format?: unknown;
    max_tokens?: unknown;
  };
}

/**
 * POST /api/llm
 * Forwards a chat completion to the provider the user chose. The key travels in the
 * X-LLM-Key header and is never stored or logged. Browsers cannot call most providers
 * directly because of CORS, which is why this proxy exists.
 */
export async function handleLlm(request: Request, env: LlmEnv): Promise<Response> {
  const denied = checkAccess(request, env);
  if (denied) return denied;

  const key = request.headers.get('X-LLM-Key') ?? '';
  if (!key) return json({ error: { message: 'API key is missing' } }, 400);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: { message: 'Request is too large' } }, 413);

  let body: ProxyBody;
  try {
    body = JSON.parse(raw) as ProxyBody;
  } catch {
    return json({ error: { message: 'Bad JSON' } }, 400);
  }

  let target: URL;
  try {
    target = new URL(String(body.baseUrl ?? ''));
  } catch {
    return json({ error: { message: 'Bad API address' } }, 400);
  }
  const extra = (env.EXTRA_LLM_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (target.protocol !== 'https:' || !(ALLOWED_HOSTS.has(target.hostname) || extra.includes(target.hostname))) {
    return json({ error: { message: `Host ${target.hostname} is not allowed`, code: 'host_not_allowed' } }, 403);
  }
  target.pathname = target.pathname.replace(/\/+$/, '') + '/chat/completions';

  const p = body.payload ?? {};
  if (typeof p.model !== 'string' || !Array.isArray(p.messages)) {
    return json({ error: { message: 'model and messages are required' } }, 400);
  }
  const payload: Record<string, unknown> = { model: p.model, messages: p.messages };
  if (typeof p.temperature === 'number') payload.temperature = p.temperature;
  if (typeof p.max_tokens === 'number') payload.max_tokens = p.max_tokens;
  if (p.stream === true) payload.stream = true;
  if (p.response_format && typeof p.response_format === 'object') payload.response_format = p.response_format;

  const upstream = await fetch(target.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
