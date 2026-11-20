import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ask } from '../ai/chat';
import { runAi, setTaskDone } from '../ai/pipeline';
import { CHAT_SUGGESTIONS } from '../ai/prompts';
import { downloadBlob } from '../backup/backup';
import { db } from '../lib/db';
import { recordToMarkdown, safeFileName } from '../lib/exportMd';
import { fmtTime, SCENARIO_RESULT_TAB } from '../lib/format';
import { clearChat, deleteRecord, recognizeAgain, renameRecord } from '../lib/records';
import { go } from '../lib/router';
import { hasAi, useSettings, type Settings } from '../lib/settings';
import type { Rec, Segment } from '../lib/types';
import { retryRecord } from '../stt/queue';
import { IconChat, IconMore, IconSend, IconWave } from '../ui/icons';
import { BackButton, Segmented, Sheet, Spinner, toast, useOnline } from '../ui/kit';
import { Player, type PlayerHandle } from '../ui/Player';
import { recMeta } from '../ui/recMeta';
import { RichText } from '../ui/RichText';

type Tab = 'brief' | 'result' | 'text' | 'chat';

const between = (id: string) => [
  [id, -Infinity],
  [id, Infinity],
] as const;

export function RecordView({ id }: { id: string }) {
  const rec = useLiveQuery(() => db.records.get(id).then((r) => r ?? null), [id]);
  const segments = useLiveQuery(() => db.segments.where('[recordId+startMs]').between(...between(id)).toArray(), [id], [] as Segment[]);
  const messages = useLiveQuery(() => db.messages.where('[recordId+createdAt]').between(...between(id)).toArray(), [id], []);
  const chunksLeft = useLiveQuery(() => db.chunks.where('recordId').equals(id).count(), [id], 0);
  const audio = useLiveQuery(() => db.audio.get(id), [id]);
  const settings = useSettings();

  const [tab, setTab] = useState<Tab | null>(null);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const player = useRef<PlayerHandle>(null);
  const abort = useRef<AbortController | null>(null);
  const seek = (ms: number) => player.current?.seek(ms);

  useEffect(() => {
    if (rec && tab === null) setTab(rec.ai ? 'brief' : 'text');
  }, [rec, tab]);

  useEffect(() => () => abort.current?.abort(), []);

  if (rec === undefined) return null;
  if (rec === null) {
    return (
      <main className="screen">
        <div className="topbar">
          <BackButton />
        </div>
        <div className="empty">
          Запись не найдена. Возможно, её удалили.
          <a className="btn btn-sm" href="#/">
            На главную
          </a>
        </div>
      </main>
    );
  }

  const current: Tab = tab ?? 'text';
  const aiReady = hasAi(settings);

  const askQuestion = async (q: string) => {
    const question = q.trim();
    if (!question || answer !== null) return;
    if (!aiReady) {
      toast('Добавьте API-ключ в настройках');
      return;
    }
    setTab('chat');
    setDraft('');
    setAnswer('');
    abort.current = new AbortController();
    try {
      await ask(id, question, (t) => setAnswer(t), abort.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(e instanceof Error ? e.message : 'Ошибка ИИ', 5000);
    } finally {
      setAnswer(null);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'brief', label: 'Выжимка' },
    { id: 'result', label: SCENARIO_RESULT_TAB[rec.scenario] },
    { id: 'text', label: 'Текст' },
    { id: 'chat', label: 'Чат' },
  ];

  return (
    <main className="screen screen-fixed">
      <div className="topbar">
        <BackButton label="Назад к записям" />
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" aria-label="Действия с записью" onClick={() => setMenu(true)}>
          <IconMore />
        </button>
      </div>

      <div className="rec-head">
        <h1>
          <button
            type="button"
            style={{ all: 'inherit', cursor: 'text' }}
            title="Переименовать"
            onClick={() => {
              const t = prompt('Название записи', rec.title);
              if (t) void renameRecord(id, t);
            }}
          >
            {rec.title}
          </button>
        </h1>
        <span className="row-sub">
          {recMeta(rec, chunksLeft)}
          {rec.marks.length > 0 && ` · отметок: ${rec.marks.length}`}
        </span>
      </div>

      <Segmented label="Вид записи" role="tab" value={current} options={tabs} onChange={setTab} />

      <div className="scroll" style={{ paddingTop: 22, paddingBottom: 20 }}>
        {current === 'brief' && (
          <AiGate rec={rec} settings={settings}>
            <BriefTab rec={rec} seek={seek} />
          </AiGate>
        )}
        {current === 'result' && (
          <AiGate rec={rec} settings={settings}>
            <ResultTab rec={rec} seek={seek} />
          </AiGate>
        )}
        {current === 'text' && (
          <TextTab
            rec={rec}
            segments={segments}
            chunksLeft={chunksLeft}
            hasAudio={!!audio}
            seek={seek}
            onExplain={(s) => void askQuestion(`Объясни проще: «${s}»`)}
            onAsk={(s) => {
              setDraft(`«${s}» — `);
              setTab('chat');
            }}
          />
        )}
        {current === 'chat' && (
          <ChatTab rec={rec} messages={messages} answer={answer} aiReady={aiReady} seek={seek} onAsk={(q) => void askQuestion(q)} />
        )}
      </div>

      <div className="bottom-bar">
        {current === 'chat' ? (
          <form
            style={{ display: 'flex', gap: 10, flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              void askQuestion(draft);
            }}
          >
            <label htmlFor="ask" className="sr-only">
              Вопрос по записи
            </label>
            <input
              id="ask"
              className="input"
              style={{ borderRadius: 24, background: 'var(--surface)', paddingLeft: 18 }}
              placeholder={aiReady ? 'Спросите о записи…' : 'Нужен API-ключ в настройках'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!aiReady}
              autoComplete="off"
            />
            {answer !== null ? (
              <button type="button" className="icon-btn" aria-label="Остановить ответ" onClick={() => abort.current?.abort()}>
                <Spinner />
              </button>
            ) : (
              <button
                type="submit"
                className="icon-btn"
                style={{ width: 48, height: 48, borderRadius: 24, background: 'var(--accent)', color: 'var(--accent-ink)' }}
                aria-label="Отправить вопрос"
                disabled={!aiReady || !draft.trim()}
              >
                <IconSend />
              </button>
            )}
          </form>
        ) : (
          <>
            <Player ref={player} blob={audio?.blob} durationMs={rec.durationMs} />
            <button type="button" className="btn btn-accent btn-sm" style={{ flexShrink: 0 }} onClick={() => setTab('chat')}>
              <IconChat size={16} />
              Спросить ИИ
            </button>
          </>
        )}
      </div>

      <RecordMenu
        open={menu}
        onClose={() => setMenu(false)}
        rec={rec}
        segments={segments}
        hasAudio={!!audio}
        audioBlob={audio?.blob}
        aiReady={aiReady}
        hasMessages={messages.length > 0}
      />
    </main>
  );
}

function AiGate({ rec, settings, children }: { rec: Rec; settings: Settings | undefined; children: ReactNode }) {
  if (rec.ai) {
    return (
      <>
        {rec.aiPending && (
          <div className="alert alert-warn" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
            <Spinner /> ИИ переделывает выжимку…
          </div>
        )}
        {rec.aiError && !rec.aiPending && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            {rec.aiError}
          </div>
        )}
        {children}
      </>
    );
  }
  if (rec.status !== 'ready') {
    return <div className="empty">Выжимка появится, когда закончится распознавание.</div>;
  }
  if (rec.aiPending) {
    return (
      <div className="empty">
        <Spinner />
        ИИ читает запись. Для лекции на полтора часа это около минуты.
      </div>
    );
  }
  if (!hasAi(settings)) {
    return (
      <div className="empty">
        Добавьте API-ключ DeepSeek или другого сервиса, и ИИ сделает выжимку, {SCENARIO_RESULT_TAB[rec.scenario].toLowerCase()} и ответит на вопросы.
        <a className="btn btn-sm" href="#/settings/ai">
          Открыть настройки
        </a>
      </div>
    );
  }
  return (
    <div className="empty">
      {rec.aiError && (
        <div className="alert alert-danger" style={{ textAlign: 'left' }}>
          {rec.aiError}
        </div>
      )}
      <button type="button" className="btn btn-accent" onClick={() => void runAi(rec.id)}>
        Сделать выжимку и {SCENARIO_RESULT_TAB[rec.scenario].toLowerCase()}
      </button>
    </div>
  );
}

function TimeChip({ t, seek }: { t: number | undefined; seek: (ms: number) => void }) {
  if (t === undefined) return null;
  return (
    <button type="button" className="chip" aria-label={`Слушать с ${fmtTime(t)}`} onClick={() => seek(t)}>
      {fmtTime(t)}
    </button>
  );
}

function BriefTab({ rec, seek }: { rec: Rec; seek: (ms: number) => void }) {
  const brief = rec.ai?.brief ?? [];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <h2 className="section-label">Главное за 30 секунд</h2>
      {brief.length === 0 ? (
        <p className="hint">ИИ не нашёл главных мыслей в этой записи.</p>
      ) : (
        <ol className="brief">
          {brief.map((b, i) => (
            <li key={i}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <span className="t">{b.text}</span>
              <TimeChip t={b.t} seek={seek} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ResultTab({ rec, seek }: { rec: Rec; seek: (ms: number) => void }) {
  const ai = rec.ai!;
  if (rec.scenario === 'meeting') {
    return (
      <div className="stack" style={{ gap: 26 }}>
        <section className="stack">
          <h2 className="section-label">Решения</h2>
          {ai.decisions?.length ? (
            <ul className="md" style={{ margin: 0 }}>
              {ai.decisions.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">Решений не прозвучало.</p>
          )}
        </section>
        <section className="stack">
          <h2 className="section-label">Задачи</h2>
          {ai.tasks?.length ? (
            <div className="card" style={{ padding: '4px 0' }}>
              {ai.tasks.map((t) => (
                <label key={t.id} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="checkbox" className="check" checked={t.done} onChange={(e) => void setTaskDone(rec.id, t.id, e.target.checked)} />
                  <span className="row-main" style={{ gap: 6 }}>
                    <span className="row-title" style={{ color: t.done ? 'var(--dim)' : undefined, textDecoration: t.done ? 'line-through' : undefined }}>
                      {t.text}
                    </span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {t.who && <span className="chip" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>{t.who}</span>}
                      {t.due && <span className="chip" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>до {t.due}</span>}
                      {t.t !== undefined && (
                        <button
                          type="button"
                          className="chip"
                          style={{ background: 'var(--surface-2)' }}
                          onClick={(e) => {
                            e.preventDefault();
                            seek(t.t!);
                          }}
                        >
                          ▶ {fmtTime(t.t)}
                        </button>
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="hint">Задач не прозвучало.</p>
          )}
        </section>
        {!!ai.questions?.length && (
          <section className="stack">
            <h2 className="section-label">Открытые вопросы</h2>
            {ai.questions.map((q, i) => (
              <p key={i} className="serif" style={{ margin: 0, padding: '12px 14px', borderRadius: 14, border: '1px dashed #3a3e46', lineHeight: 1.5 }}>
                {q}
              </p>
            ))}
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 24 }}>
      {ai.notes ? <RichText md={ai.notes} seek={seek} /> : <p className="hint">ИИ не вернул текст.</p>}
      {!!ai.terms?.length && (
        <section className="stack">
          <h2 className="section-label">Термины</h2>
          <dl className="stack" style={{ margin: 0 }}>
            {ai.terms.map((t, i) => (
              <div key={i} className="term">
                <dt>{t.term}</dt>
                <dd>{t.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {rec.scenario === 'note' && ai.notes && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => void navigator.clipboard.writeText(ai.notes!).then(() => toast('Текст скопирован'))}
        >
          Скопировать текст
        </button>
      )}
    </div>
  );
}

type Block = { kind: 'para'; segs: Segment[] } | { kind: 'noise'; segs: Segment[] };

function toBlocks(segments: Segment[]): Block[] {
  const blocks: Block[] = [];
  for (const s of segments) {
    const last = blocks[blocks.length - 1];
    if (s.noise) {
      if (last?.kind === 'noise') last.segs.push(s);
      else blocks.push({ kind: 'noise', segs: [s] });
      continue;
    }
    if (last?.kind === 'para') {
      const prev = last.segs[last.segs.length - 1];
      const len = last.segs.reduce((n, x) => n + x.text.length, 0);
      if (s.startMs - prev.endMs < 2500 && len < 600) {
        last.segs.push(s);
        continue;
      }
    }
    blocks.push({ kind: 'para', segs: [s] });
  }
  return blocks;
}

function TextTab({
  rec,
  segments,
  chunksLeft,
  hasAudio,
  seek,
  onExplain,
  onAsk,
}: {
  rec: Rec;
  segments: Segment[];
  chunksLeft: number;
  hasAudio: boolean;
  seek: (ms: number) => void;
  onExplain: (s: string) => void;
  onAsk: (s: string) => void;
}) {
  const online = useOnline();
  const blocks = useMemo(() => toBlocks(segments), [segments]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = () => {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && box.current && sel.anchorNode && box.current.contains(sel.anchorNode)) {
        setSelected(sel.toString().trim().slice(0, 1500));
      } else {
        setSelected('');
      }
    };
    document.addEventListener('selectionchange', on);
    return () => document.removeEventListener('selectionchange', on);
  }, []);

  const done = rec.chunksTotal - chunksLeft;
  const visible = segments.some((s) => !s.noise);

  return (
    <div className="stack" style={{ gap: 22 }}>
      {rec.status === 'recording' && (
        <div className="alert alert-warn" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Spinner />
          {rec.source === 'file' ? 'Файл читается и режется на фрагменты…' : 'Запись ещё идёт.'}
        </div>
      )}
      {rec.status === 'processing' && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="progress">
            <i style={{ width: `${rec.chunksTotal ? (done / rec.chunksTotal) * 100 : 0}%` }} />
          </div>
          <span className="hint">
            {online ? `Распознано ${done} из ${rec.chunksTotal} фрагментов` : 'Нет сети. Распознавание продолжится, когда она появится.'}
          </span>
        </div>
      )}
      {rec.status === 'error' && (
        <div className="alert alert-danger stack">
          <strong>Распознавание не закончилось</strong>
          <span>{rec.error}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {chunksLeft > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => void retryRecord(rec.id)}>
                Повторить
              </button>
            )}
            {hasAudio && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void recognizeAgain(rec.id)}>
                Распознать заново
              </button>
            )}
          </div>
        </div>
      )}
      {rec.status === 'ready' && !visible && <div className="empty">Речь в записи не найдена.</div>}

      <div ref={box} className="stack" style={{ gap: 22 }}>
        {blocks.map((b, i) => {
          if (b.kind === 'noise') {
            const ms = b.segs.reduce((n, s) => n + (s.endMs - s.startMs), 0);
            const hall = b.segs.some((s) => s.noiseReason === 'hall');
            const isOpen = open.has(i);
            return (
              <div key={i} className="stack">
                <button
                  type="button"
                  className="noise-chip"
                  aria-expanded={isOpen}
                  onClick={() => {
                    const next = new Set(open);
                    if (isOpen) next.delete(i);
                    else next.add(i);
                    setOpen(next);
                  }}
                >
                  <IconWave size={14} />
                  {isOpen ? 'Скрыть' : `Скрыто ${fmtTime(ms)} · ${hall ? 'голоса из зала' : 'помехи'}`}
                </button>
                {isOpen && <p className="noise-text">{b.segs.map((s) => s.text).join(' ')}</p>}
              </div>
            );
          }
          const start = b.segs[0].startMs;
          const end = b.segs[b.segs.length - 1].endMs;
          const marked = rec.marks.some((m) => m >= start - 3000 && m <= end);
          return (
            <div key={i} className="seg">
              <button type="button" className={`seg-time${marked ? ' is-mark' : ''}`} onClick={() => seek(start)} aria-label={`Слушать с ${fmtTime(start)}`}>
                {fmtTime(start)}
                {marked ? ' · отметка' : ''}
              </button>
              <p className="reading" style={{ margin: 0 }}>
                {b.segs.map((s) => s.text).join(' ')}
              </p>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="selection-bar" role="toolbar" aria-label="Действия с выделенным текстом">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onExplain(selected)}>
            Объясни проще
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onAsk(selected)} style={{ fontWeight: 500 }}>
            Спросить
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void navigator.clipboard.writeText(selected).then(() => toast('Скопировано'))}
            style={{ fontWeight: 500 }}
          >
            Копировать
          </button>
        </div>
      )}
    </div>
  );
}

function ChatTab({
  rec,
  messages,
  answer,
  aiReady,
  seek,
  onAsk,
}: {
  rec: Rec;
  messages: { id: string; role: 'user' | 'assistant'; text: string }[];
  answer: string | null;
  aiReady: boolean;
  seek: (ms: number) => void;
  onAsk: (q: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, answer]);

  if (!aiReady) {
    return (
      <div className="empty">
        Чтобы задавать вопросы по записи, добавьте API-ключ в настройках.
        <a className="btn btn-sm" href="#/settings/ai">
          Открыть настройки
        </a>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 14 }} aria-live="polite">
      {messages.length === 0 && answer === null && (
        <p className="hint">Спросите что угодно о записи. ИИ ответит по тексту и покажет, на какой минуте это прозвучало.</p>
      )}
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="bubble-me">
            {m.text}
          </div>
        ) : (
          <div key={m.id} className="bubble-ai">
            <RichText md={m.text} seek={seek} />
          </div>
        ),
      )}
      {answer !== null && (
        <div className="bubble-ai">{answer ? <RichText md={answer} seek={seek} /> : <Spinner />}</div>
      )}
      {answer === null && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 6 }}>
          {CHAT_SUGGESTIONS[rec.scenario].map((s) => (
            <button key={s} type="button" className="chip chip-outline" onClick={() => onAsk(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function RecordMenu({
  open,
  onClose,
  rec,
  segments,
  hasAudio,
  audioBlob,
  aiReady,
  hasMessages,
}: {
  open: boolean;
  onClose: () => void;
  rec: Rec;
  segments: Segment[];
  hasAudio: boolean;
  audioBlob: Blob | undefined;
  aiReady: boolean;
  hasMessages: boolean;
}) {
  const markdown = async () => {
    const msgs = await db.messages.where('[recordId+createdAt]').between(...between(rec.id)).toArray();
    return recordToMarkdown(rec, segments, msgs);
  };
  const act = (fn: () => unknown) => async () => {
    onClose();
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не получилось', 4000);
    }
  };
  const name = safeFileName(rec.title);
  const ext = (rec.audioMime ?? '').includes('mp4') ? 'm4a' : (rec.audioMime ?? '').includes('ogg') ? 'ogg' : (rec.audioMime ?? '').includes('mpeg') ? 'mp3' : 'webm';

  return (
    <Sheet open={open} onClose={onClose} label="Действия с записью">
      <button type="button" className="row" onClick={act(async () => downloadBlob(new Blob([await markdown()], { type: 'text/markdown' }), `${name}.md`))}>
        <span className="row-main">
          <span className="row-title">Скачать в Markdown</span>
          <span className="row-sub">Для Obsidian, Notion и любых заметок</span>
        </span>
      </button>
      <button type="button" className="row" onClick={act(() => go(`print/${rec.id}`))}>
        <span className="row-main">
          <span className="row-title">Сохранить в PDF</span>
          <span className="row-sub">Откроется печать, выберите «Сохранить как PDF»</span>
        </span>
      </button>
      <button type="button" className="row" onClick={act(async () => navigator.clipboard.writeText(await markdown()).then(() => toast('Скопировано')))}>
        <span className="row-title">Скопировать всё</span>
      </button>
      {typeof navigator.share === 'function' && (
        <button type="button" className="row" onClick={act(async () => navigator.share({ title: rec.title, text: await markdown() }))}>
          <span className="row-title">Поделиться</span>
        </button>
      )}
      {aiReady && rec.status === 'ready' && (
        <button type="button" className="row" onClick={act(() => runAi(rec.id))}>
          <span className="row-title">{rec.ai ? 'Переделать выжимку' : 'Сделать выжимку'}</span>
        </button>
      )}
      {hasAudio && (
        <button
          type="button"
          className="row"
          onClick={act(async () => {
            if (confirm('Распознать запись заново? Текущий текст заменится новым.')) await recognizeAgain(rec.id);
          })}
        >
          <span className="row-title">Распознать заново</span>
        </button>
      )}
      {audioBlob && (
        <button type="button" className="row" onClick={act(() => downloadBlob(audioBlob, `${name}.${ext}`))}>
          <span className="row-title">Скачать аудио</span>
        </button>
      )}
      {hasMessages && (
        <button
          type="button"
          className="row"
          onClick={act(async () => {
            if (confirm('Очистить чат по этой записи?')) await clearChat(rec.id);
          })}
        >
          <span className="row-title">Очистить чат</span>
        </button>
      )}
      <button
        type="button"
        className="row"
        onClick={act(async () => {
          if (confirm(`Удалить «${rec.title}»? Запись, текст и чат удалятся с этого устройства.`)) {
            await deleteRecord(rec.id);
            go('', true);
          }
        })}
      >
        <span className="row-title" style={{ color: 'var(--danger)' }}>
          Удалить запись
        </span>
      </button>
    </Sheet>
  );
}
