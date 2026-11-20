import type { AiResult, Message, Rec, Scenario, Segment, Tombstone, Lang, RecordStatus } from '../lib/types';
import type { Snapshot } from './merge';

/** Backup files come from outside, so every field is checked before it reaches the database. */

const SCENARIOS: Scenario[] = ['lecture', 'meeting', 'talk', 'note'];
const LANGS: Lang[] = ['auto', 'ru', 'en'];
const STATUSES: RecordStatus[] = ['recording', 'processing', 'ready', 'error'];
const ID = /^[A-Za-z0-9_-]{8,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max = 100000) => (typeof v === 'string' ? v.slice(0, max) : '');
const optStr = (v: unknown, max = 1000) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function cleanAi(v: unknown): AiResult | undefined {
  if (!isObj(v)) return undefined;
  const brief = Array.isArray(v.brief) ? v.brief.filter(isObj).map((b) => ({ text: str(b.text, 2000), t: optNum(b.t) })) : [];
  const ai: AiResult = { brief, model: str(v.model, 200), createdAt: num(v.createdAt) };
  if (typeof v.notes === 'string') ai.notes = str(v.notes, 500000);
  if (Array.isArray(v.terms)) ai.terms = v.terms.filter(isObj).map((t) => ({ term: str(t.term, 500), definition: str(t.definition, 2000) }));
  if (Array.isArray(v.decisions)) ai.decisions = v.decisions.map((d) => str(d, 2000)).filter(Boolean);
  if (Array.isArray(v.questions)) ai.questions = v.questions.map((d) => str(d, 2000)).filter(Boolean);
  if (Array.isArray(v.tasks)) {
    ai.tasks = v.tasks
      .filter(isObj)
      .filter((t) => typeof t.id === 'string' && ID.test(t.id))
      .map((t) => ({
        id: t.id as string,
        text: str(t.text, 2000),
        who: optStr(t.who, 200),
        due: optStr(t.due, 200),
        t: optNum(t.t),
        done: t.done === true,
        updatedAt: num(t.updatedAt),
      }));
  }
  return ai;
}

function cleanRecord(v: unknown): Rec | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id)) return null;
  const scenario = SCENARIOS.includes(v.scenario as Scenario) ? (v.scenario as Scenario) : 'note';
  const status = STATUSES.includes(v.status as RecordStatus) ? (v.status as RecordStatus) : 'ready';
  return {
    id: v.id,
    title: str(v.title, 200) || 'Без названия',
    titleByUser: v.titleByUser === true,
    scenario,
    lang: LANGS.includes(v.lang as Lang) ? (v.lang as Lang) : 'auto',
    source: v.source === 'file' ? 'file' : 'mic',
    createdAt: num(v.createdAt, Date.now()),
    updatedAt: num(v.updatedAt),
    durationMs: num(v.durationMs),
    // A record still recording on the other device has no live session here.
    status: status === 'recording' ? 'processing' : status,
    error: optStr(v.error),
    marks: Array.isArray(v.marks) ? v.marks.filter((m): m is number => typeof m === 'number' && Number.isFinite(m)) : [],
    chunksTotal: num(v.chunksTotal),
    audioHash: typeof v.audioHash === 'string' && /^[0-9a-f]{64}$/.test(v.audioHash) ? v.audioHash : undefined,
    audioMime: optStr(v.audioMime, 100),
    audioSize: optNum(v.audioSize),
    ai: cleanAi(v.ai),
  };
}

function cleanSegment(v: unknown): Segment | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id) || typeof v.recordId !== 'string') return null;
  return {
    id: v.id,
    recordId: v.recordId,
    startMs: num(v.startMs),
    endMs: num(v.endMs),
    text: str(v.text, 20000),
    noise: v.noise === true,
    noiseReason: v.noiseReason === 'artefact' || v.noiseReason === 'hall' ? v.noiseReason : undefined,
    updatedAt: num(v.updatedAt),
  };
}

function cleanMessage(v: unknown): Message | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id) || typeof v.recordId !== 'string') return null;
  if (v.role !== 'user' && v.role !== 'assistant') return null;
  return { id: v.id, recordId: v.recordId, role: v.role, text: str(v.text, 100000), createdAt: num(v.createdAt) };
}

function cleanTombstone(v: unknown): Tombstone | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id)) return null;
  return { id: v.id, kind: v.kind === 'message' ? 'message' : 'record', deletedAt: num(v.deletedAt) };
}

function list<T>(v: unknown, fn: (x: unknown) => T | null): T[] {
  return Array.isArray(v) ? v.map(fn).filter((x): x is T => x !== null) : [];
}

export function sanitizeSnapshot(data: unknown): Snapshot {
  if (!isObj(data)) throw new Error('В файле нет данных приложения.');
  const records = list(data.records, cleanRecord);
  const ids = new Set(records.map((r) => r.id));
  return {
    records,
    segments: list(data.segments, cleanSegment).filter((s) => ids.has(s.recordId)),
    messages: list(data.messages, cleanMessage).filter((m) => ids.has(m.recordId)),
    tombstones: list(data.tombstones, cleanTombstone),
  };
}
