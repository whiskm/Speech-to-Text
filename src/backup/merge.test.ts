import { describe, expect, it } from 'vitest';
import type { Message, Rec, Segment, Task } from '../lib/types';
import { planMerge, type MergePlan, type Snapshot } from './merge';
import { sanitizeSnapshot } from './sanitize';

let n = 0;
const id = (p: string) => `${p}-${String(++n).padStart(8, '0')}`;

function rec(over: Partial<Rec> = {}): Rec {
  return {
    id: id('rec'),
    title: 'Лекция',
    titleByUser: false,
    scenario: 'lecture',
    lang: 'ru',
    source: 'mic',
    createdAt: 1000,
    updatedAt: 1000,
    durationMs: 60000,
    status: 'ready',
    marks: [],
    chunksTotal: 2,
    ...over,
  };
}

function seg(recordId: string, over: Partial<Segment> = {}): Segment {
  return { id: id('seg'), recordId, startMs: 0, endMs: 1000, text: 'текст', noise: false, updatedAt: 1000, ...over };
}

function msg(recordId: string, role: Message['role'], over: Partial<Message> = {}): Message {
  return { id: id('msg'), recordId, role, text: 'вопрос', createdAt: 1000, ...over };
}

const empty = (): Snapshot => ({ records: [], segments: [], messages: [], tombstones: [] });

/** Applies a plan the way applyMerge does, to check that a second import is a no-op. */
function apply(local: Snapshot, plan: MergePlan): Snapshot {
  const records = new Map(local.records.map((r) => [r.id, r]));
  for (const r of plan.add) records.set(r.id, r);
  for (const u of plan.update) records.set(u.merged.id, u.merged);
  const segs = new Map(local.segments.map((s) => [s.id, s]));
  for (const s of plan.segmentsPut) segs.set(s.id, s);
  const msgs = new Map(local.messages.map((m) => [m.id, m]));
  for (const m of plan.messagesPut) msgs.set(m.id, m);
  return { records: [...records.values()], segments: [...segs.values()], messages: [...msgs.values()], tombstones: local.tombstones };
}

describe('planMerge', () => {
  it('adds new records with their text, chat and audio', () => {
    const r = rec({ audioHash: 'a'.repeat(64) });
    const incoming: Snapshot = { ...empty(), records: [r], segments: [seg(r.id), seg(r.id)], messages: [msg(r.id, 'user')] };
    const plan = planMerge(empty(), incoming);
    expect(plan.add.map((x) => x.id)).toEqual([r.id]);
    expect(plan.segmentsPut).toHaveLength(2);
    expect(plan.messagesPut).toHaveLength(1);
    expect(plan.audioFor).toEqual([r.id]);
    expect(plan.duplicates).toBe(0);
  });

  it('skips a record that is already here unchanged', () => {
    const r = rec();
    const s = seg(r.id);
    const local: Snapshot = { ...empty(), records: [r], segments: [s] };
    const plan = planMerge(local, { ...empty(), records: [{ ...r }], segments: [{ ...s }] });
    expect(plan.add).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.duplicates).toBe(1);
  });

  it('treats the same audio under another id as a duplicate', () => {
    const hash = 'b'.repeat(64);
    const local: Snapshot = { ...empty(), records: [rec({ audioHash: hash })] };
    const plan = planMerge(local, { ...empty(), records: [rec({ audioHash: hash })] });
    expect(plan.add).toHaveLength(0);
    expect(plan.duplicates).toBe(1);
  });

  it('does not bring back records deleted after the backup', () => {
    const r = rec({ updatedAt: 1000 });
    const local: Snapshot = { ...empty(), tombstones: [{ id: r.id, kind: 'record', deletedAt: 2000 }] };
    const plan = planMerge(local, { ...empty(), records: [r] });
    expect(plan.add).toHaveLength(0);
    expect(plan.skippedDeleted).toBe(1);
  });

  it('restores a deleted record if it was changed elsewhere after the deletion', () => {
    const r = rec({ updatedAt: 3000 });
    const local: Snapshot = { ...empty(), tombstones: [{ id: r.id, kind: 'record', deletedAt: 2000 }] };
    const plan = planMerge(local, { ...empty(), records: [r] });
    expect(plan.add).toHaveLength(1);
  });

  it('joins chats from two devices without repeating messages', () => {
    const r = rec();
    const shared = msg(r.id, 'user', { text: 'общий вопрос' });
    const local: Snapshot = { ...empty(), records: [r], messages: [shared, msg(r.id, 'user', { text: 'только здесь' })] };
    const fromOther = [shared, msg(r.id, 'user', { text: 'с ноутбука' }), msg(r.id, 'assistant', { text: 'ответ' })];
    const plan = planMerge(local, { ...empty(), records: [{ ...r }], messages: fromOther });
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].reasons).toContain('вопросы в чате: +1');
    expect(plan.messagesPut.map((m) => m.text)).toEqual(['с ноутбука', 'ответ']);
  });

  it('does not re-import chat messages deleted here', () => {
    const r = rec();
    const m = msg(r.id, 'user');
    const local: Snapshot = { ...empty(), records: [r], tombstones: [{ id: m.id, kind: 'message', deletedAt: 5000 }] };
    const plan = planMerge(local, { ...empty(), records: [{ ...r }], messages: [m] });
    expect(plan.messagesPut).toHaveLength(0);
    expect(plan.duplicates).toBe(1);
  });

  it('takes the newer state of a meeting task', () => {
    const task: Task = { id: id('task'), text: 'Сделать', done: false, updatedAt: 1000 };
    const ai = { brief: [], model: 'm', createdAt: 500, tasks: [task] };
    const r = rec({ scenario: 'meeting', ai });
    const theirs = rec({ ...r, ai: { ...ai, tasks: [{ ...task, done: true, updatedAt: 2000 }] } });
    const plan = planMerge({ ...empty(), records: [r] }, { ...empty(), records: [theirs] });
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].merged.ai?.tasks?.[0].done).toBe(true);
  });

  it('keeps the newer AI result', () => {
    const r = rec({ ai: { brief: [{ text: 'старое' }], model: 'm', createdAt: 100 } });
    const theirs = { ...r, ai: { brief: [{ text: 'новое' }], model: 'm', createdAt: 200 } };
    const plan = planMerge({ ...empty(), records: [r] }, { ...empty(), records: [theirs] });
    expect(plan.update[0].merged.ai?.brief[0].text).toBe('новое');
    const back = planMerge({ ...empty(), records: [theirs] }, { ...empty(), records: [r] });
    expect(back.update).toHaveLength(0);
    expect(back.duplicates).toBe(1);
  });

  it('adds text recognised elsewhere to a record that had none', () => {
    const r = rec({ status: 'processing' });
    const theirs = { ...r, status: 'ready' as const };
    const plan = planMerge({ ...empty(), records: [r] }, { ...empty(), records: [theirs], segments: [seg(r.id)] });
    expect(plan.update[0].merged.status).toBe('ready');
    expect(plan.update[0].reasons).toContain('расшифровка');
    expect(plan.segmentsPut).toHaveLength(1);
  });

  it('drops the audio hash when the backup has no audio file', () => {
    const r = rec({ audioHash: 'c'.repeat(64) });
    const plan = planMerge(empty(), { ...empty(), records: [r] }, new Set());
    expect(plan.add[0].audioHash).toBeUndefined();
    expect(plan.audioFor).toHaveLength(0);
  });

  it('copies audio into an existing record that lacked it', () => {
    const r = rec();
    const theirs = { ...r, audioHash: 'd'.repeat(64), audioMime: 'audio/webm' };
    const plan = planMerge({ ...empty(), records: [r] }, { ...empty(), records: [theirs] }, new Set([r.id]));
    expect(plan.audioFor).toEqual([r.id]);
    expect(plan.update[0].reasons).toContain('аудио');
  });

  it('is a no-op when the same backup is imported twice', () => {
    const a = rec();
    const b = rec({ audioHash: 'e'.repeat(64) });
    const backup: Snapshot = {
      records: [a, b],
      segments: [seg(a.id), seg(b.id)],
      messages: [msg(a.id, 'user'), msg(a.id, 'assistant')],
      tombstones: [],
    };
    const local0: Snapshot = { ...empty(), records: [rec()] };
    const first = planMerge(local0, backup);
    expect(first.add).toHaveLength(2);
    const local1 = apply(local0, first);
    const second = planMerge(local1, backup);
    expect(second.add).toHaveLength(0);
    expect(second.update).toHaveLength(0);
    expect(second.duplicates).toBe(2);
    expect(local1.records).toHaveLength(3);
  });

  it('ignores a record listed twice in one backup', () => {
    const r = rec();
    const plan = planMerge(empty(), { ...empty(), records: [r, { ...r }] });
    expect(plan.add).toHaveLength(1);
  });
});

describe('sanitizeSnapshot', () => {
  it('drops malformed entries and orphaned text', () => {
    const good = rec();
    const snap = sanitizeSnapshot({
      records: [good, { id: '../../evil', title: 'x' }, null, { ...rec(), status: 'recording', scenario: 'party' }],
      segments: [seg(good.id), seg('rec-unknown-000')],
      messages: [msg(good.id, 'user'), { ...msg(good.id, 'user'), role: 'system' }],
      tombstones: [{ id: 'short' }],
    });
    expect(snap.records).toHaveLength(2);
    expect(snap.records[1].status).toBe('processing');
    expect(snap.records[1].scenario).toBe('note');
    expect(snap.segments).toHaveLength(1);
    expect(snap.messages).toHaveLength(1);
    expect(snap.tombstones).toHaveLength(0);
  });

  it('rejects data that is not an object', () => {
    expect(() => sanitizeSnapshot('hello')).toThrow();
  });
});
