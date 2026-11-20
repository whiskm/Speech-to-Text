import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLlm } from './llm';
import { handleTranscribe } from './transcribe';

const HOST = 'https://speech-to-text.example.workers.dev';

function fakeAi(output: unknown = { text: 'Привет', transcription_info: { language: 'ru' }, segments: [{ start: 0, end: 1.5, text: 'Привет', avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1 }] }) {
  const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => output);
  return { run, ai: { run } as unknown as Ai };
}

describe('handleTranscribe', () => {
  it('sends base64 audio with language and prompt and returns segments', async () => {
    const { run, ai } = fakeAi();
    const audio = new Uint8Array(70000).map((_, i) => i % 251);
    const res = await handleTranscribe(
      new Request(`${HOST}/api/transcribe?lang=ru&prompt=${encodeURIComponent('Лекция.')}`, { method: 'POST', body: audio }),
      { AI: ai },
    );
    expect(res.status).toBe(200);
    const [model, input] = run.mock.calls[0];
    expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
    expect(input.audio).toBe(Buffer.from(audio).toString('base64'));
    expect(input).toMatchObject({ language: 'ru', initial_prompt: 'Лекция.', task: 'transcribe', vad_filter: true, condition_on_previous_text: false });
    const body = (await res.json()) as { text: string; language: string; segments: { start: number; text: string }[] };
    expect(body).toMatchObject({ text: 'Привет', language: 'ru' });
    expect(body.segments[0]).toMatchObject({ start: 0, end: 1.5, text: 'Привет' });
  });

  it('leaves the language out for auto', async () => {
    const { run, ai } = fakeAi();
    await handleTranscribe(new Request(`${HOST}/api/transcribe?lang=auto`, { method: 'POST', body: new Uint8Array(10) }), { AI: ai });
    expect(run.mock.calls[0][1]).not.toHaveProperty('language');
  });

  it('refuses empty and oversized bodies', async () => {
    const { ai } = fakeAi();
    const empty = await handleTranscribe(new Request(`${HOST}/api/transcribe`, { method: 'POST' }), { AI: ai });
    expect(empty.status).toBe(400);
    const big = await handleTranscribe(new Request(`${HOST}/api/transcribe`, { method: 'POST', body: new Uint8Array(6 * 1024 * 1024) }), { AI: ai });
    expect(big.status).toBe(413);
  });

  it('checks the access code and the origin', async () => {
    const { run, ai } = fakeAi();
    const body = new Uint8Array(10);
    const noCode = await handleTranscribe(new Request(`${HOST}/api/transcribe`, { method: 'POST', body }), { AI: ai, ACCESS_CODE: 'abc' });
    expect(noCode.status).toBe(401);
    const foreign = await handleTranscribe(
      new Request(`${HOST}/api/transcribe`, { method: 'POST', body, headers: { Origin: 'https://evil.example', 'X-Access-Code': 'abc' } }),
      { AI: ai, ACCESS_CODE: 'abc' },
    );
    expect(foreign.status).toBe(403);
    const ok = await handleTranscribe(
      new Request(`${HOST}/api/transcribe`, { method: 'POST', body, headers: { Origin: HOST, 'X-Access-Code': 'abc' } }),
      { AI: ai, ACCESS_CODE: 'abc' },
    );
    expect(ok.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a Workers AI failure as 502', async () => {
    const ai = { run: vi.fn(async () => Promise.reject(new Error('capacity'))) } as unknown as Ai;
    const res = await handleTranscribe(new Request(`${HOST}/api/transcribe`, { method: 'POST', body: new Uint8Array(10) }), { AI: ai });
    expect(res.status).toBe(502);
  });
});

describe('handleLlm', () => {
  afterEach(() => vi.unstubAllGlobals());

  function call(body: unknown, headers: Record<string, string> = { 'X-LLM-Key': 'sk-test' }, env = {}) {
    return handleLlm(new Request(`${HOST}/api/llm`, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  }

  it('forwards to /chat/completions with the key and only known fields', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"choices":[]}', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call({
      baseUrl: 'https://api.deepseek.com/',
      payload: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, response_format: { type: 'json_object' }, evil: 1 },
    });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, response_format: { type: 'json_object' } });
  });

  it('refuses hosts outside the list, plain http and a missing key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const payload = { model: 'm', messages: [] };
    expect((await call({ baseUrl: 'https://169.254.169.254', payload })).status).toBe(403);
    expect((await call({ baseUrl: 'http://api.deepseek.com', payload })).status).toBe(403);
    expect((await call({ baseUrl: 'https://api.deepseek.com', payload }, {})).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows extra hosts from EXTRA_LLM_HOSTS', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call({ baseUrl: 'https://llm.my-company.ru/v1', payload: { model: 'm', messages: [] } }, { 'X-LLM-Key': 'k' }, { EXTRA_LLM_HOSTS: 'llm.my-company.ru' });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://llm.my-company.ru/v1/chat/completions');
  });

  it('passes the provider status through, for example 402 for an empty balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })));
    const res = await call({ baseUrl: 'https://api.deepseek.com', payload: { model: 'm', messages: [] } });
    expect(res.status).toBe(402);
  });
});
