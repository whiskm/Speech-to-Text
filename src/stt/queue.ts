import Dexie from 'dexie';
import { db } from '../lib/db';
import { uid } from '../lib/hash';
import { getSettings, hasAi } from '../lib/settings';
import { runAi } from '../ai/pipeline';
import type { Chunk, Rec, Segment } from '../lib/types';
import { isArtefact, type RawSegment } from './noise';

const MAX_ATTEMPTS = 5;
const PARALLEL = 2;

interface ApiResponse {
  text: string;
  language: string | null;
  segments: (RawSegment & { start: number; end: number })[];
  error?: string;
}

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fatal = false,
  ) {
    super(message);
  }
}

const PROMPTS: Record<string, Record<string, string>> = {
  ru: {
    lecture: 'Лекция. Речь преподавателя, с пунктуацией.',
    meeting: 'Рабочая встреча. Обсуждение задач и сроков.',
    talk: 'Разговор двух людей.',
    note: 'Голосовая заметка.',
  },
  en: {
    lecture: 'A university lecture, with punctuation.',
    meeting: 'A work meeting about tasks and deadlines.',
    talk: 'A conversation between two people.',
    note: 'A voice note.',
  },
};

/** Last words before `ms`, cut at a word boundary. Whisper keeps style and terms consistent with them. */
export function promptTail(text: string, max = 180): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const space = cut.indexOf(' ');
  return space >= 0 ? cut.slice(space + 1) : cut;
}

async function contextPrompt(chunk: Chunk, rec: Rec): Promise<string | undefined> {
  const before = await db.segments
    .where('[recordId+startMs]')
    .between([rec.id, -Infinity], [rec.id, chunk.startMs], true, false)
    .reverse()
    .limit(8)
    .toArray();
  const tail = promptTail(
    before
      .filter((s) => !s.noise)
      .reverse()
      .map((s) => s.text)
      .join(' '),
  );
  if (tail) return tail;
  // No text yet: a short description of the recording, in its language.
  return rec.lang !== 'auto' ? PROMPTS[rec.lang]?.[rec.scenario] : undefined;
}

async function transcribe(chunk: Chunk, rec: Rec, accessCode: string): Promise<ApiResponse> {
  const params = new URLSearchParams({ lang: rec.lang });
  const prompt = await contextPrompt(chunk, rec);
  if (prompt) params.set('prompt', prompt);
  let res: Response;
  try {
    res = await fetch(`/api/transcribe?${params}`, {
      method: 'POST',
      body: chunk.wav,
      headers: { 'Content-Type': 'audio/wav', ...(accessCode ? { 'X-Access-Code': accessCode } : {}) },
    });
  } catch {
    throw new SttError('Нет связи с сервером', 0);
  }
  if (res.status === 401) throw new SttError('Сервер просит код доступа. Проверьте его в настройках.', 401, true);
  if (res.status === 404 || res.status === 405) {
    throw new SttError('Сервер распознавания не найден. Приложение нужно открыть с Cloudflare Pages.', res.status, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new SttError(`Ошибка распознавания (${res.status}${body.error ? ', ' + body.error : ''})`, res.status);
  }
  return (await res.json()) as ApiResponse;
}

let running = false;
let again = false;
const backoffUntil = new Map<string, number>();
const listeners = new Set<(msg: string | null) => void>();
let lastProblem: string | null = null;

/** Subscribes to queue-wide problems such as a missing access code. */
export function onQueueProblem(fn: (msg: string | null) => void): () => void {
  listeners.add(fn);
  fn(lastProblem);
  return () => listeners.delete(fn);
}

function setProblem(msg: string | null) {
  lastProblem = msg;
  listeners.forEach((fn) => fn(msg));
}

/**
 * Pieces of one microphone recording go one at a time, so each gets the text before it
 * as a Whisper prompt. Uploaded files allow two at once: they arrive all together and
 * would otherwise take twice as long.
 */
async function pickBatch(candidates: Chunk[]): Promise<Chunk[]> {
  const batch: Chunk[] = [];
  const perRecord = new Map<string, number>();
  const sources = new Map<string, Rec['source'] | undefined>();
  for (const c of candidates) {
    if (batch.length >= PARALLEL) break;
    if (!sources.has(c.recordId)) sources.set(c.recordId, (await db.records.get(c.recordId))?.source);
    const limit = sources.get(c.recordId) === 'file' ? PARALLEL : 1;
    const n = perRecord.get(c.recordId) ?? 0;
    if (n >= limit) continue;
    perRecord.set(c.recordId, n + 1);
    batch.push(c);
  }
  return batch;
}

/** Starts processing queued audio pieces if it is not running already. */
export function kickQueue(): void {
  if (running) {
    again = true;
    return;
  }
  void run();
}

async function run(): Promise<void> {
  running = true;
  try {
    for (;;) {
      again = false;
      if (!navigator.onLine) break;
      const now = Date.now();
      const candidates = await db.chunks
        .where('[recordId+idx]')
        .between([Dexie.minKey, Dexie.minKey], [Dexie.maxKey, Dexie.maxKey])
        .filter((c) => c.attempts < MAX_ATTEMPTS && (backoffUntil.get(c.id) ?? 0) <= now)
        .limit(PARALLEL * 4)
        .toArray();
      const batch = await pickBatch(candidates);
      if (batch.length === 0) {
        const waiting = [...backoffUntil.values()].filter((t) => t > now);
        if (waiting.length) setTimeout(kickQueue, Math.min(...waiting) - now + 50);
        break;
      }
      const results = await Promise.allSettled(batch.map(processChunk));
      const fatal = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof SttError && r.reason.fatal,
      );
      if (fatal) {
        setProblem((fatal.reason as SttError).message);
        break;
      }
      setProblem(null);
    }
  } finally {
    running = false;
    if (again) kickQueue();
  }
}

async function processChunk(chunk: Chunk): Promise<void> {
  const rec = await db.records.get(chunk.recordId);
  if (!rec) {
    await db.chunks.delete(chunk.id);
    return;
  }
  const settings = await getSettings();
  try {
    const out = await transcribe(chunk, rec, settings.accessCode);
    const now = Date.now();
    const segs: Segment[] = (out.segments.length ? out.segments : [{ start: 0, end: (chunk.endMs - chunk.startMs) / 1000, text: out.text, avg_logprob: null, no_speech_prob: null, compression_ratio: null }])
      .map((s) => ({ ...s, text: s.text.trim() }))
      .filter((s) => s.text !== '')
      .map((s) => {
        const artefact = isArtefact(s);
        return {
          id: uid(),
          recordId: chunk.recordId,
          startMs: Math.round(chunk.startMs + s.start * 1000),
          endMs: Math.round(chunk.startMs + s.end * 1000),
          text: s.text,
          noise: artefact,
          ...(artefact ? { noiseReason: 'artefact' as const } : {}),
          updatedAt: now,
        };
      });
    await db.transaction('rw', db.segments, db.chunks, db.records, async () => {
      if (segs.length) await db.segments.bulkAdd(segs);
      await db.chunks.delete(chunk.id);
      await db.records.update(chunk.recordId, { updatedAt: now });
    });
    backoffUntil.delete(chunk.id);
    await finalizeIfDone(chunk.recordId);
  } catch (e) {
    const err = e instanceof SttError ? e : new SttError(String(e), 0);
    if (err.status === 0 && !navigator.onLine) throw err;
    if (!err.fatal) {
      const attempts = chunk.attempts + 1;
      await db.chunks.update(chunk.id, { attempts, lastError: err.message });
      backoffUntil.set(chunk.id, Date.now() + 2000 * 2 ** attempts);
      if (attempts >= MAX_ATTEMPTS) await finalizeIfDone(chunk.recordId);
    }
    throw err;
  }
}

/** Marks a recording as ready once every piece is recognised, then starts the AI step. */
export async function finalizeIfDone(recordId: string): Promise<void> {
  const rec = await db.records.get(recordId);
  if (!rec || rec.status !== 'processing') return;
  const left = await db.chunks.where('recordId').equals(recordId).toArray();
  if (left.some((c) => c.attempts < MAX_ATTEMPTS)) return;
  if (left.length > 0) {
    await db.records.update(recordId, {
      status: 'error',
      error: `Не удалось распознать ${left.length} из ${rec.chunksTotal} фрагментов: ${left[0].lastError ?? 'ошибка'}`,
      updatedAt: Date.now(),
    });
    return;
  }
  await db.records.update(recordId, { status: 'ready', error: undefined, updatedAt: Date.now() });
  const settings = await getSettings();
  if (settings.autoAi && hasAi(settings) && !rec.ai) {
    void runAi(recordId);
  }
}

/** Puts failed pieces of a recording back into the queue. */
export async function retryRecord(recordId: string): Promise<void> {
  const chunks = await db.chunks.where('recordId').equals(recordId).toArray();
  for (const c of chunks) backoffUntil.delete(c.id);
  await db.chunks.where('recordId').equals(recordId).modify({ attempts: 0 });
  await db.records.update(recordId, { status: 'processing', error: undefined, updatedAt: Date.now() });
  setProblem(null);
  kickQueue();
}

export const MAX_CHUNK_ATTEMPTS = MAX_ATTEMPTS;
