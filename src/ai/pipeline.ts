import { db } from '../lib/db';
import { fmtTime, parseTime } from '../lib/format';
import { uid } from '../lib/hash';
import { getSettings, hasAi } from '../lib/settings';
import type { AiResult, BriefItem, Rec, Segment, Task, Term } from '../lib/types';
import { AiError, complete, parseJsonReply } from './client';
import { buildMergePrompt, buildPartPrompt, buildPrompt, SYSTEM_PROMPT } from './prompts';

/** Above this size the transcript is summarised in parts first. About 15 000 tokens. */
const SINGLE_PASS_CHARS = 45000;
const PART_CHARS = 30000;

const running = new Set<string>();

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}

/** Converts the model JSON into our types, dropping anything malformed. */
export function normalizeResult(raw: Record<string, unknown>, model: string, now = Date.now()): AiResult & { title: string; noise: number[] } {
  const brief: BriefItem[] = Array.isArray(raw.brief)
    ? raw.brief
        .map((b) => (typeof b === 'string' ? { text: b } : (b as Record<string, unknown>)))
        .map((b) => ({ text: str(b.text), t: parseTime(b.time) }))
        .filter((b) => b.text)
    : [];
  const terms: Term[] = Array.isArray(raw.terms)
    ? raw.terms
        .map((t) => t as Record<string, unknown>)
        .map((t) => ({ term: str(t.term), definition: str(t.definition) }))
        .filter((t) => t.term)
    : [];
  const tasks: Task[] = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((t) => (typeof t === 'string' ? { text: t } : (t as Record<string, unknown>)))
        .map((t) => ({
          id: uid(),
          text: str(t.text),
          who: str(t.who) || undefined,
          due: str(t.due) || undefined,
          t: parseTime(t.time),
          done: false,
          updatedAt: now,
        }))
        .filter((t) => t.text)
    : [];
  const noise = Array.isArray(raw.noise) ? raw.noise.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  const result: AiResult & { title: string; noise: number[] } = {
    title: str(raw.title),
    noise,
    brief,
    model,
    createdAt: now,
  };
  const notes = str(raw.notes);
  if (notes) result.notes = notes;
  if (terms.length) result.terms = terms;
  if (Array.isArray(raw.decisions)) result.decisions = strList(raw.decisions);
  if (Array.isArray(raw.tasks)) result.tasks = tasks;
  if (Array.isArray(raw.questions)) result.questions = strList(raw.questions);
  return result;
}

export function transcriptLines(segments: Segment[]): string[] {
  return segments.map((s, i) => `#${i + 1} [${fmtTime(s.startMs)}] ${s.text}`);
}

function splitParts(lines: string[], limit: number): { lines: string[]; offset: number }[] {
  const parts: { lines: string[]; offset: number }[] = [];
  let cur: string[] = [];
  let size = 0;
  let offset = 0;
  lines.forEach((l, i) => {
    if (size + l.length > limit && cur.length) {
      parts.push({ lines: cur, offset });
      cur = [];
      size = 0;
      offset = i;
    }
    cur.push(l);
    size += l.length + 1;
  });
  if (cur.length) parts.push({ lines: cur, offset });
  return parts;
}

/** Builds the summary, notes or meeting results for one recording. */
export async function runAi(recordId: string): Promise<void> {
  if (running.has(recordId)) return;
  running.add(recordId);
  try {
    const settings = await getSettings();
    const rec = await db.records.get(recordId);
    if (!rec) return;
    if (!hasAi(settings)) throw new AiError('Добавьте API-ключ в настройках.');
    await db.records.update(recordId, { aiPending: true, aiError: undefined });

    const all = await db.segments.where('[recordId+startMs]').between([recordId, -Infinity], [recordId, Infinity]).toArray();
    // Artefacts never reach the model. Hall voices are re-judged on every run.
    const usable = all.filter((s) => s.noiseReason !== 'artefact');
    if (usable.length === 0) throw new AiError('В записи нет распознанной речи.');

    const lines = transcriptLines(usable);
    const withNoise = settings.hideHall;
    const sys = { role: 'system' as const, content: SYSTEM_PROMPT };
    let raw: Record<string, unknown>;
    let noise: number[] = [];

    if (lines.join('\n').length <= SINGLE_PASS_CHARS) {
      raw = parseJsonReply(
        await complete(settings, [sys, { role: 'user', content: buildPrompt(rec.scenario, lines.join('\n'), withNoise) }], { json: true }),
      );
      noise = normalizeResult(raw, settings.model).noise;
    } else {
      const parts = splitParts(lines, PART_CHARS);
      const notes: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const prompt = buildPartPrompt(rec.scenario, parts[i].lines.join('\n'), i + 1, parts.length, withNoise);
        const part = parseJsonReply(await complete(settings, [sys, { role: 'user', content: prompt }], { json: true }));
        notes.push(`### Часть ${i + 1}\n${str(part.notes)}`);
        // Numbers in the transcript are global, so part results can be used as-is.
        if (Array.isArray(part.noise)) noise.push(...part.noise.map(Number).filter((n) => Number.isInteger(n) && n > 0));
      }
      raw = parseJsonReply(
        await complete(settings, [sys, { role: 'user', content: buildMergePrompt(rec.scenario, notes.join('\n\n')) }], { json: true }),
      );
    }

    const result = normalizeResult(raw, settings.model);
    const noiseSet = new Set(withNoise ? noise : []);
    const now = Date.now();
    const { title, noise: _ignored, ...ai } = result;
    void _ignored;

    await db.transaction('rw', db.records, db.segments, async () => {
      const changed: Segment[] = [];
      usable.forEach((s, i) => {
        const hall = noiseSet.has(i + 1);
        if (hall !== (s.noise && s.noiseReason === 'hall')) {
          changed.push({ ...s, noise: hall, noiseReason: hall ? 'hall' : undefined, updatedAt: now });
        }
      });
      if (changed.length) await db.segments.bulkPut(changed);
      const cur = await db.records.get(recordId);
      const patch: Partial<Rec> = { ai, aiPending: false, aiError: undefined, updatedAt: now };
      if (cur && !cur.titleByUser && title) patch.title = title.slice(0, 120);
      await db.records.update(recordId, patch);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.records.update(recordId, { aiPending: false, aiError: msg });
  } finally {
    running.delete(recordId);
  }
}

/** Ticks a meeting task on or off. */
export async function setTaskDone(recordId: string, taskId: string, done: boolean): Promise<void> {
  const now = Date.now();
  await db.records
    .where('id')
    .equals(recordId)
    .modify((r) => {
      const t = r.ai?.tasks?.find((x) => x.id === taskId);
      if (t) {
        t.done = done;
        t.updatedAt = now;
        r.updatedAt = now;
      }
    });
}
