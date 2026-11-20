import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import { db } from '../lib/db';
import { fmtDateTime, fmtTime, SCENARIO_LABEL, SCENARIO_RESULT_TAB } from '../lib/format';
import { BackButton } from '../ui/kit';
import { RichText } from '../ui/RichText';

/** Printable page. The browser's print dialog saves it as PDF. */
export function Print({ id }: { id: string }) {
  const data = useLiveQuery(async () => {
    const rec = await db.records.get(id);
    const segs = await db.segments.where('[recordId+startMs]').between([id, -Infinity], [id, Infinity]).toArray();
    return rec ? { rec, segs: segs.filter((s) => !s.noise) } : null;
  }, [id]);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => {
      void document.fonts.ready.then(() => window.print());
    }, 300);
    return () => clearTimeout(t);
  }, [data]);

  if (!data) return null;
  const { rec, segs } = data;
  const ai = rec.ai;

  return (
    <div style={{ background: '#fff', minHeight: '100dvh' }}>
      <div className="no-print" style={{ display: 'flex', gap: 8, padding: 12, background: 'var(--bg)' }}>
        <BackButton />
        <button type="button" className="btn btn-sm" onClick={() => window.print()}>
          Печать или PDF
        </button>
      </div>
      <article className="print-page">
        <h1>{rec.title}</h1>
        <p className="meta">
          {SCENARIO_LABEL[rec.scenario]} · {fmtDateTime(rec.createdAt)} · {fmtTime(rec.durationMs)}
        </p>
        {!!ai?.brief.length && (
          <>
            <h2>Выжимка</h2>
            <ol>
              {ai.brief.map((b, i) => (
                <li key={i}>
                  {b.text} {b.t !== undefined && <span className="meta">[{fmtTime(b.t)}]</span>}
                </li>
              ))}
            </ol>
          </>
        )}
        {ai && rec.scenario === 'meeting' && (
          <>
            {!!ai.decisions?.length && (
              <>
                <h2>Решения</h2>
                <ul>
                  {ai.decisions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </>
            )}
            {!!ai.tasks?.length && (
              <>
                <h2>Задачи</h2>
                <ul>
                  {ai.tasks.map((t) => (
                    <li key={t.id}>
                      {t.done ? '☑' : '☐'} {t.text}
                      {t.who ? ` (${t.who}${t.due ? `, до ${t.due}` : ''})` : t.due ? ` (до ${t.due})` : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!!ai.questions?.length && (
              <>
                <h2>Открытые вопросы</h2>
                <ul>
                  {ai.questions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {ai && rec.scenario !== 'meeting' && ai.notes && (
          <>
            <h2>{SCENARIO_RESULT_TAB[rec.scenario]}</h2>
            <RichText md={ai.notes} className="" />
          </>
        )}
        {!!ai?.terms?.length && (
          <>
            <h2>Термины</h2>
            <dl>
              {ai.terms.map((t, i) => (
                <div key={i}>
                  <dt>
                    <b>{t.term}</b>
                  </dt>
                  <dd>{t.definition}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        {segs.length > 0 && (
          <>
            <h2>Расшифровка</h2>
            {segs.map((s) => (
              <p key={s.id}>
                <span className="meta">[{fmtTime(s.startMs)}]</span> {s.text}
              </p>
            ))}
          </>
        )}
      </article>
    </div>
  );
}
