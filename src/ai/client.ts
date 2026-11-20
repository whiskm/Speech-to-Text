import type { Settings } from '../lib/settings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

function friendlyError(status: number, detail: string): string {
  if (status === 401) {
    return detail.includes('access_code') ? 'Сервер просит код доступа. Проверьте его в настройках.' : 'Ключ не подошёл. Проверьте API-ключ в настройках.';
  }
  if (status === 402) return 'На счёте сервиса ИИ закончились деньги. Пополните баланс.';
  if (status === 403 && detail.includes('host_not_allowed')) return 'Этот адрес API не разрешён на сервере. Добавьте его в EXTRA_LLM_HOSTS.';
  if (status === 404 && detail === '') return 'Сервер приложения не найден. Откройте приложение с Cloudflare Pages.';
  if (status === 404) return 'Сервис не нашёл модель. Проверьте название модели в настройках.';
  if (status === 429) return 'Сервис ИИ просит подождать: слишком много запросов. Попробуйте через минуту.';
  if (status >= 500) return 'Сервис ИИ временно не отвечает. Попробуйте позже.';
  return `Ошибка ИИ (${status}). ${detail.slice(0, 200)}`;
}

async function post(settings: Settings, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch('/api/llm', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-LLM-Key': settings.apiKey.trim(),
        ...(settings.accessCode ? { 'X-Access-Code': settings.accessCode } : {}),
      },
      body: JSON.stringify({ baseUrl: settings.baseUrl.trim(), payload: { model: settings.model.trim(), ...payload } }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AiError('Нет связи с интернетом.', 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiError(friendlyError(res.status, text), res.status);
  }
  return res;
}

/** One completion. With `json`, asks for a JSON object and retries without that flag if the provider refuses it. */
export async function complete(
  settings: Settings,
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const base = { messages, temperature: opts.temperature ?? 0.3 };
  let res: Response;
  try {
    res = await post(settings, opts.json ? { ...base, response_format: { type: 'json_object' } } : base, opts.signal);
  } catch (e) {
    if (opts.json && e instanceof AiError && e.status === 400) res = await post(settings, base, opts.signal);
    else throw e;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new AiError('Сервис ИИ вернул пустой ответ.');
  return content;
}

/** Streams a chat answer, calling `onText` with the full text so far. */
export async function streamChat(
  settings: Settings,
  messages: ChatMessage[],
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await post(settings, { messages, temperature: 0.4, stream: true }, signal);
  if (!res.body || !(res.headers.get('Content-Type') ?? '').includes('event-stream')) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    onText(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return text;
      try {
        const evt = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(text);
        }
      } catch {
        // Keep-alive comments and partial lines are skipped.
      }
    }
  }
  return text;
}

/** Pulls the first JSON object out of a model reply, tolerating ```json fences and stray text. */
export function parseJsonReply(reply: string): Record<string, unknown> {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : reply;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('ИИ ответил не в том формате. Попробуйте ещё раз.');
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new AiError('ИИ ответил не в том формате. Попробуйте ещё раз.');
  }
}
