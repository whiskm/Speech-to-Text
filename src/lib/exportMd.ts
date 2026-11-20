import { fmtDateTime, fmtTime, SCENARIO_LABEL, SCENARIO_RESULT_TAB } from './format';
import type { Message, Rec, Segment } from './types';

/** Whole recording as Markdown: summary, notes or meeting results, transcript and chat. */
export function recordToMarkdown(rec: Rec, segments: Segment[], messages: Message[]): string {
  const out: string[] = [];
  out.push(`# ${rec.title}`, '');
  out.push(`${SCENARIO_LABEL[rec.scenario]} · ${fmtDateTime(rec.createdAt)} · ${fmtTime(rec.durationMs)}`, '');

  const ai = rec.ai;
  if (ai?.brief.length) {
    out.push('## Выжимка', '');
    ai.brief.forEach((b, i) => out.push(`${i + 1}. ${b.text}${b.t !== undefined ? ` [${fmtTime(b.t)}]` : ''}`));
    out.push('');
  }
  if (ai) {
    if (rec.scenario === 'meeting') {
      if (ai.decisions?.length) {
        out.push('## Решения', '', ...ai.decisions.map((d) => `- ${d}`), '');
      }
      if (ai.tasks?.length) {
        out.push('## Задачи', '');
        for (const t of ai.tasks) {
          const extra = [t.who, t.due ? `до ${t.due}` : ''].filter(Boolean).join(', ');
          out.push(`- [${t.done ? 'x' : ' '}] ${t.text}${extra ? ` (${extra})` : ''}`);
        }
        out.push('');
      }
      if (ai.questions?.length) {
        out.push('## Открытые вопросы', '', ...ai.questions.map((d) => `- ${d}`), '');
      }
    } else if (ai.notes) {
      out.push(`## ${SCENARIO_RESULT_TAB[rec.scenario]}`, '', ai.notes, '');
    }
    if (ai.terms?.length) {
      out.push('## Термины', '', ...ai.terms.map((t) => `- **${t.term}**: ${t.definition}`), '');
    }
  }

  const speech = segments.filter((s) => !s.noise);
  if (speech.length) {
    out.push('## Расшифровка', '');
    for (const s of speech) out.push(`[${fmtTime(s.startMs)}] ${s.text}`, '');
  }

  if (messages.length) {
    out.push('## Вопросы к ИИ', '');
    for (const m of messages) out.push(m.role === 'user' ? `**Вопрос:** ${m.text}` : m.text, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'запись';
}
