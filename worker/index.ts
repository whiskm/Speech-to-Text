import { json } from '../server/common';
import { handleLlm, type LlmEnv } from '../server/llm';
import { handleTranscribe, type TranscribeEnv } from '../server/transcribe';

interface Env extends TranscribeEnv, LlmEnv {
  /** The built site from ./dist, see [assets] in wrangler.toml. */
  ASSETS: Fetcher;
}

const ROUTES: Record<string, (request: Request, env: Env) => Promise<Response>> = {
  '/api/transcribe': handleTranscribe,
  '/api/llm': handleLlm,
};

/**
 * Cloudflare Worker entry. wrangler.toml sends only /api/* here (run_worker_first);
 * every other path is served straight from ./dist by Workers static assets.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const handler = ROUTES[pathname];
    if (handler) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return handler(request, env);
    }
    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
