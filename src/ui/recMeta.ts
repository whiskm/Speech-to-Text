import { fmtDate, fmtTime, SCENARIO_LABEL } from '../lib/format';
import type { Rec } from '../lib/types';

/** One-line description under a record title, e.g. "Лекция · вчера · 1:24:10 · выжимка готова". */
export function recMeta(r: Rec, chunksLeft?: number): string {
  const parts = [SCENARIO_LABEL[r.scenario], fmtDate(r.createdAt).toLowerCase()];
  if (r.durationMs > 0) parts.push(fmtTime(r.durationMs));
  parts.push(recState(r, chunksLeft));
  return parts.filter(Boolean).join(' · ');
}

export function recState(r: Rec, chunksLeft?: number): string {
  if (r.status === 'recording') return r.source === 'file' ? 'файл читается' : 'идёт запись';
  if (r.status === 'processing') {
    if (chunksLeft !== undefined && r.chunksTotal > 0) {
      const pct = Math.round(((r.chunksTotal - chunksLeft) / r.chunksTotal) * 100);
      return `распознано ${pct}%`;
    }
    return 'распознаётся';
  }
  if (r.status === 'error') return 'ошибка распознавания';
  if (r.aiPending) return 'ИИ пишет выжимку';
  if (r.scenario === 'meeting' && r.ai?.tasks) {
    const open = r.ai.tasks.filter((t) => !t.done).length;
    return open ? `задач: ${open}` : 'все задачи сделаны';
  }
  if (r.ai) return 'выжимка готова';
  return 'только текст';
}
