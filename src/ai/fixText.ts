import { db } from '../lib/db';
import { SCENARIO_LABEL } from '../lib/format';
import { getSettings, hasAi } from '../lib/settings';
import type { Rec, Segment } from '../lib/types';
import { AiError, complete, parseJsonReply } from './client';

/** About 1 500 tokens of text per request, so each answer stays fast and complete. */
const BATCH_CHARS = 4500;
const PARALLEL = 3;

const running = new Set<string>();

/** False after a reload in the middle of a correction, so the screen can offer to start again. */
export function isFixRunning(recordId: string): boolean {
  return running.has(recordId);
}

function buildFixPrompt(rec: Rec, lines: string[], glossary: string[]): string {
  return `Ниже реплики автоматической расшифровки речи. Тип записи: ${SCENARIO_LABEL[rec.scenario].toLowerCase()}. Тема: «${rec.title}».
Распознавание ошибается: путает похожие по звучанию слова, искажает термины, имена и числа, теряет или ставит лишнюю пунктуацию.

Исправь каждую реплику:
- замени неверно распознанные слова на те, что подходят по смыслу и по звучанию;
- поправь пунктуацию и заглавные буквы;
- не пересказывай, не сокращай и ничего не добавляй от себя;
- сохрани язык реплики и разговорный стиль;
- если реплика верна, верни её без изменений.
${glossary.length ? `\nТермины, которые звучат в записи: ${glossary.join(', ')}.\n` : ''}
Верни JSON строго такого вида, по одному элементу на каждую реплику в том же порядке:
{"lines": [{"n": 1, "text": "исправленная реплика"}]}

Реплики:
${lines.join('\n')}`;
}

/**
 * Accepts a corrected line only when it is still the same sentence: a model that
 * drops or invents content changes the length a lot.
 */
export function acceptFix(before: string, after: unknown): string | null {
  if (typeof after !== 'string') return null;
  const t = after.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const ratio = t.length / Math.max(1, before.length);
  if (ratio < 0.6 || ratio > 1.5) return null;
  return t;
}

function batches(segments: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  let cur: Segment[] = [];
  let size = 0;
  for (const s of segments) {
    if (size + s.text.length > BATCH_CHARS && cur.length) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += s.text.length + 8;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Corrects recognition mistakes in the transcript with the user's AI key. The original text is kept. */
export async function fixTranscript(recordId: string): Promise<void> {
  if (running.has(recordId)) return;
  running.add(recordId);
  try {
    const settings = await getSettings();
    if (!hasAi(settings)) throw new AiError('Добавьте API-ключ в настройках.');
    const rec = await db.records.get(recordId);
    if (!rec) return;
    const segments = (await db.segments.where('[recordId+startMs]').between([recordId, -Infinity], [recordId, Infinity]).toArray()).filter(
      (s) => !s.noise,
    );
    if (segments.length === 0) throw new AiError('В записи нет текста для исправления.');

    const glossary = (rec.ai?.terms ?? []).map((t) => t.term).slice(0, 40);
    const parts = batches(segments);
    let done = 0;
    await db.records.update(recordId, { fixProgress: { done, total: parts.length }, fixError: undefined });

    const work = async (part: Segment[]) => {
      const lines = part.map((s, i) => `#${i + 1} ${s.original ?? s.text}`);
      const reply = await complete(
        settings,
        [
          { role: 'system', content: 'Ты корректор автоматической расшифровки речи. Отвечай только JSON-объектом.' },
          { role: 'user', content: buildFixPrompt(rec, lines, glossary) },
        ],
        { json: true, temperature: 0.1 },
      );
      const raw = parseJsonReply(reply);
      const items = Array.isArray(raw.lines) ? (raw.lines as { n?: unknown; text?: unknown }[]) : [];
      const now = Date.now();
      const changed: Segment[] = [];
      for (const item of items) {
        const n = Number(item.n);
        const seg = Number.isInteger(n) ? part[n - 1] : undefined;
        if (!seg) continue;
        const source = seg.original ?? seg.text;
        const text = acceptFix(source, item.text);
        if (text && text !== seg.text) changed.push({ ...seg, original: source, text, updatedAt: now });
      }
      if (changed.length) await db.segments.bulkPut(changed);
      done++;
      await db.records.update(recordId, { fixProgress: { done, total: parts.length } });
    };

    const queue = [...parts];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) await work(p);
      }),
    );
    await db.records.update(recordId, {
      textFix: { at: Date.now(), model: settings.model },
      fixProgress: undefined,
      updatedAt: Date.now(),
    });
  } catch (e) {
    await db.records.update(recordId, { fixProgress: undefined, fixError: e instanceof Error ? e.message : String(e) });
  } finally {
    running.delete(recordId);
  }
}

/** Puts back the text exactly as Whisper recognised it. */
export async function undoFix(recordId: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.segments, db.records, async () => {
    const segs = await db.segments.where('recordId').equals(recordId).toArray();
    const restored = segs.filter((s) => s.original !== undefined).map((s) => ({ ...s, text: s.original!, original: undefined, updatedAt: now }));
    if (restored.length) await db.segments.bulkPut(restored);
    await db.records.update(recordId, { textFix: undefined, fixError: undefined, updatedAt: now });
  });
}
