import { db } from '../lib/db';
import { uid } from '../lib/hash';
import { getSettings, hasAi } from '../lib/settings';
import { AiError, streamChat, type ChatMessage } from './client';
import { transcriptLines } from './pipeline';
import { chatSystemPrompt } from './prompts';

const TRANSCRIPT_LIMIT = 90000;
const HISTORY = 16;

/**
 * Sends a question about a recording. The question is stored at once; the answer is
 * streamed through `onText` and stored when complete.
 */
export async function ask(recordId: string, question: string, onText: (t: string) => void, signal?: AbortSignal): Promise<void> {
  const settings = await getSettings();
  if (!hasAi(settings)) throw new AiError('Добавьте API-ключ в настройках, чтобы задавать вопросы.');
  const rec = await db.records.get(recordId);
  if (!rec) return;

  const segments = (await db.segments.where('[recordId+startMs]').between([recordId, -Infinity], [recordId, Infinity]).toArray()).filter(
    (s) => !s.noise,
  );
  let transcript = transcriptLines(segments).join('\n');
  if (transcript.length > TRANSCRIPT_LIMIT) {
    transcript = transcript.slice(0, TRANSCRIPT_LIMIT) + '\n[расшифровка обрезана]';
  }

  const history = await db.messages.where('[recordId+createdAt]').between([recordId, -Infinity], [recordId, Infinity]).toArray();
  const now = Date.now();
  await db.messages.add({ id: uid(), recordId, role: 'user', text: question, createdAt: now });

  const messages: ChatMessage[] = [
    { role: 'system', content: chatSystemPrompt(rec.title, rec.scenario, transcript, rec.ai?.notes) },
    ...history.slice(-HISTORY).map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: question },
  ];

  const answer = await streamChat(settings, messages, onText, signal);
  await db.messages.add({ id: uid(), recordId, role: 'assistant', text: answer.trim() || '…', createdAt: Date.now() });
}
