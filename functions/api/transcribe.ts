import { Buffer } from 'node:buffer';
import { checkAccess, json, type CommonEnv } from '../../server/common';

interface Env extends CommonEnv {
  AI: Ai;
}

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Native base64 from node:buffer (needs the nodejs_compat flag). A 30 s WAV is about
 * 1 MB, and a JavaScript loop over it can use most of the 10 ms CPU limit of the free plan.
 */
function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

/**
 * POST /api/transcribe?lang=ru|en|auto&prompt=...
 * Body: a WAV file up to 30 s. Returns recognised text with segment timings.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = checkAccess(request, env);
  if (denied) return denied;
  if (!env.AI) return json({ error: 'no_ai_binding' }, 500);

  const url = new URL(request.url);
  const lang = url.searchParams.get('lang');
  const prompt = (url.searchParams.get('prompt') ?? '').slice(0, 200);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: 'too_large' }, 413);

  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toBase64(buf),
      task: 'transcribe',
      vad_filter: true,
      condition_on_previous_text: false,
      ...(lang === 'ru' || lang === 'en' ? { language: lang } : {}),
      ...(prompt ? { initial_prompt: prompt } : {}),
    });
    return json({
      text: out.text ?? '',
      language: out.transcription_info?.language ?? null,
      segments: (out.segments ?? []).map((s) => ({
        start: s.start ?? 0,
        end: s.end ?? 0,
        text: s.text ?? '',
        avg_logprob: s.avg_logprob ?? null,
        no_speech_prob: s.no_speech_prob ?? null,
        compression_ratio: s.compression_ratio ?? null,
      })),
    });
  } catch (e) {
    return json({ error: 'ai_failed', detail: String(e).slice(0, 300) }, 502);
  }
};
