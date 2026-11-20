import type { AiResult, Message, Rec, Segment, Task, Tombstone } from '../lib/types';

export interface Snapshot {
  records: Rec[];
  segments: Segment[];
  messages: Message[];
  tombstones: Tombstone[];
}

export interface RecordUpdate {
  merged: Rec;
  reasons: string[];
}

export interface MergePlan {
  add: Rec[];
  update: RecordUpdate[];
  /** Records already present unchanged, or the same audio under another id. */
  duplicates: number;
  /** Records the user deleted here after the backup was made. */
  skippedDeleted: number;
  segmentsPut: Segment[];
  messagesPut: Message[];
  /** Records whose audio should be copied from the backup. */
  audioFor: string[];
}

function groupBy<T extends { recordId: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.recordId);
    if (list) list.push(it);
    else m.set(it.recordId, [it]);
  }
  return m;
}

function mergeTasks(a: Task[] = [], b: Task[] = []): { tasks: Task[]; changed: number } {
  const byId = new Map(a.map((t) => [t.id, t]));
  let changed = 0;
  for (const t of b) {
    const cur = byId.get(t.id);
    if (!cur) {
      byId.set(t.id, t);
      changed++;
    } else if (t.updatedAt > cur.updatedAt && (t.done !== cur.done || t.text !== cur.text)) {
      byId.set(t.id, t);
      changed++;
    }
  }
  return { tasks: [...byId.values()], changed };
}

function mergeAi(local: AiResult | undefined, incoming: AiResult | undefined): { ai: AiResult | undefined; reasons: string[] } {
  if (!incoming) return { ai: local, reasons: [] };
  if (!local) return { ai: incoming, reasons: ['выжимка и конспект'] };
  if (incoming.createdAt > local.createdAt) return { ai: incoming, reasons: ['более новая выжимка'] };
  if (incoming.createdAt === local.createdAt && (local.tasks || incoming.tasks)) {
    const { tasks, changed } = mergeTasks(local.tasks, incoming.tasks);
    if (changed > 0) return { ai: { ...local, tasks }, reasons: [`задачи: изменено ${changed}`] };
  }
  return { ai: local, reasons: [] };
}

function stripAudio(r: Rec): Rec {
  return { ...r, audioHash: undefined, audioMime: undefined, audioSize: undefined };
}

/**
 * Plans an additive import. Nothing local is removed: new records are added, records
 * present on both sides are combined, and records deleted here stay deleted.
 * `incomingAudio` lists records whose audio file is inside the backup; omit it when every
 * record with an audio hash also has its file.
 */
export function planMerge(local: Snapshot, incoming: Snapshot, incomingAudio?: Set<string>): MergePlan {
  const hasAudioFile = (r: Rec) => !!r.audioHash && (!incomingAudio || incomingAudio.has(r.id));
  const plan: MergePlan = { add: [], update: [], duplicates: 0, skippedDeleted: 0, segmentsPut: [], messagesPut: [], audioFor: [] };

  const localById = new Map(local.records.map((r) => [r.id, r]));
  const localByHash = new Map(local.records.filter((r) => r.audioHash).map((r) => [r.audioHash!, r]));
  const tombs = new Map(local.tombstones.map((t) => [t.id, t.deletedAt]));
  const localSegs = groupBy(local.segments);
  const localMsgIds = new Set(local.messages.map((m) => m.id));
  const inSegs = groupBy(incoming.segments);
  const inMsgs = groupBy(incoming.messages);
  const seenIncoming = new Set<string>();

  for (const r of incoming.records) {
    if (seenIncoming.has(r.id)) continue;
    seenIncoming.add(r.id);

    const deletedAt = tombs.get(r.id);
    if (deletedAt !== undefined && deletedAt >= r.updatedAt) {
      plan.skippedDeleted++;
      continue;
    }
    const msgs = (inMsgs.get(r.id) ?? []).filter((m) => !tombs.has(m.id));
    const l = localById.get(r.id);

    if (!l) {
      if (r.audioHash && localByHash.has(r.audioHash)) {
        plan.duplicates++;
        continue;
      }
      plan.add.push(hasAudioFile(r) ? r : stripAudio(r));
      plan.segmentsPut.push(...(inSegs.get(r.id) ?? []));
      plan.messagesPut.push(...msgs);
      if (hasAudioFile(r)) plan.audioFor.push(r.id);
      continue;
    }

    const reasons: string[] = [];
    const newer = r.updatedAt > l.updatedAt ? r : l;
    const merged: Rec = { ...newer };

    if (r.updatedAt > l.updatedAt && r.title !== l.title && r.titleByUser) reasons.push('название');
    if (r.updatedAt <= l.updatedAt) {
      // Local scalars win, but a local record still stuck in processing takes a finished state.
      if (l.status !== 'ready' && r.status === 'ready') {
        merged.status = 'ready';
        merged.error = undefined;
        reasons.push('распознавание завершено');
      }
    }

    const ai = mergeAi(l.ai, r.ai);
    merged.ai = ai.ai;
    reasons.push(...ai.reasons);

    const marks = [...new Set([...l.marks, ...r.marks])].sort((a, b) => a - b);
    if (marks.length > l.marks.length) reasons.push(`отметки: +${marks.length - l.marks.length}`);
    merged.marks = marks;

    const mine = new Map((localSegs.get(r.id) ?? []).map((s) => [s.id, s]));
    const segPut = (inSegs.get(r.id) ?? []).filter((s) => {
      const cur = mine.get(s.id);
      return !cur || s.updatedAt > cur.updatedAt;
    });
    if (segPut.length) {
      plan.segmentsPut.push(...segPut);
      reasons.push(mine.size === 0 ? 'расшифровка' : `фрагменты текста: ${segPut.length}`);
    }

    const msgPut = msgs.filter((m) => !localMsgIds.has(m.id));
    if (msgPut.length) {
      plan.messagesPut.push(...msgPut);
      const q = msgPut.filter((m) => m.role === 'user').length;
      reasons.push(q > 0 ? `вопросы в чате: +${q}` : `сообщения в чате: +${msgPut.length}`);
    }

    if (!l.audioHash && hasAudioFile(r)) {
      merged.audioHash = r.audioHash;
      merged.audioMime = r.audioMime;
      merged.audioSize = r.audioSize;
      plan.audioFor.push(r.id);
      reasons.push('аудио');
    } else {
      merged.audioHash = l.audioHash;
      merged.audioMime = l.audioMime;
      merged.audioSize = l.audioSize;
    }

    if (reasons.length === 0) {
      plan.duplicates++;
      continue;
    }
    merged.updatedAt = Math.max(l.updatedAt, r.updatedAt);
    plan.update.push({ merged, reasons });
  }

  return plan;
}
