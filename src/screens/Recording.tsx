import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { session, useSession } from '../audio/session';
import { db } from '../lib/db';
import { fmtTime, SCENARIO_LABEL } from '../lib/format';
import { go } from '../lib/router';
import { useSettings } from '../lib/settings';
import { IconBack, IconBookmark, IconPause, IconPlay } from '../ui/icons';
import { toast, useOnline } from '../ui/kit';

const LANG_LABEL = { auto: 'авто-язык', ru: 'русский', en: 'English' } as const;

export function Recording() {
  const live = useSession();
  const settings = useSettings();
  const online = useOnline();
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const pulseRef = useRef<HTMLDivElement>(null);
  const recordId = live?.recordId;

  const rec = useLiveQuery(() => (recordId ? db.records.get(recordId) : undefined), [recordId]);
  const lines = useLiveQuery(
    async () => {
      if (!recordId) return [];
      const segs = await db.segments.where('[recordId+startMs]').between([recordId, -Infinity], [recordId, Infinity]).toArray();
      return segs.filter((s) => s.noiseReason !== 'artefact').slice(-3);
    },
    [recordId],
    [],
  );
  const pending = useLiveQuery(() => (recordId ? db.chunks.where('recordId').equals(recordId).count() : 0), [recordId], 0);

  useEffect(() => {
    const t = setInterval(() => setElapsed(session.elapsedMs), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(
    () =>
      session.onLevel((v) => {
        pulseRef.current?.style.setProperty('--level', v.toFixed(3));
      }),
    [],
  );

  if (!live) {
    return (
      <main className="screen">
        <div className="topbar">
          <button type="button" className="icon-btn" aria-label="На главную" onClick={() => go('', true)}>
            <IconBack />
          </button>
        </div>
        <div className="empty">
          Запись не идёт.
          <button type="button" className="btn btn-sm" onClick={() => go('', true)}>
            На главную
          </button>
        </div>
      </main>
    );
  }

  const finish = async () => {
    setStopping(true);
    try {
      const id = await session.finish();
      if (id) go(`r/${id}`, true);
    } catch {
      toast('Не удалось сохранить запись');
      setStopping(false);
    }
  };

  const mark = async () => {
    const t = await session.mark();
    toast(`Отметка на ${fmtTime(t)}`, 1800);
  };

  const paused = live.paused;

  return (
    <main className={`screen screen-fixed${paused ? ' paused' : ''}`}>
      <div className="topbar">
        <button type="button" className="icon-btn" aria-label="На главную, запись продолжится" onClick={() => go('')}>
          <IconBack />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500, flex: 1 }}>
          <span className="live-dot" />
          {paused ? 'Пауза' : 'Запись'}
        </div>
        <span style={{ fontSize: 13, color: 'var(--muted)', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {rec?.title}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 8 }}>
        <span className="timer" aria-live="off">
          {fmtTime(elapsed)}
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {rec && (
            <span className="chip">
              {SCENARIO_LABEL[rec.scenario]} · {LANG_LABEL[rec.lang]}
            </span>
          )}
          {settings?.noiseSuppression && (
            <span className="chip">
              <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--accent)' }} />
              Шумоподавление
            </span>
          )}
          {!!rec?.marks.length && <span className="chip">Отметки: {rec.marks.length}</span>}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, minHeight: 0 }}>
        <div className="pulse" ref={pulseRef}>
          <div className="ripple" />
          <div className="ripple" />
          <div className="ripple" />
          <div className="pulse-core" aria-hidden="true">
            {[28, 46, 62, 42, 24].map((h, i) => (
              <div key={i} className="bar" style={{ height: h, ['--k' as string]: [0.8, 1, 1.2, 0.95, 0.75][i] }} />
            ))}
          </div>
        </div>
        <span style={{ fontSize: 13, color: 'var(--accent)' }}>{paused ? 'Запись приостановлена' : 'Слушаю'}</span>
      </div>

      <div className="subtitles" aria-live="polite">
        {lines.length === 0 && (
          <p className="sys">{online ? 'Текст появится после первой фразы.' : 'Нет сети. Звук сохраняется, текст появится позже.'}</p>
        )}
        {lines.map((s, i) => (
          <p key={s.id} style={{ opacity: [0.28, 0.6, 1][i + 3 - lines.length] }}>
            {s.text}
            {i === lines.length - 1 && !paused && <span className="caret">▍</span>}
          </p>
        ))}
        {online && pending > 2 && <p className="sys">· в очереди на распознавание: {pending} ·</p>}
        {!online && lines.length > 0 && <p className="sys">· нет сети, остальной текст появится позже ·</p>}
      </div>

      <div className="controls">
        <div className="control">
          <button
            type="button"
            className="round"
            aria-label={paused ? 'Продолжить' : 'Пауза'}
            onClick={() => (paused ? session.resume() : session.pause())}
            disabled={stopping}
          >
            {paused ? <IconPlay size={22} /> : <IconPause size={22} />}
          </button>
          {paused ? 'Продолжить' : 'Пауза'}
        </div>
        <div className="control" style={{ width: 96 }}>
          <button type="button" className="stop" aria-label="Закончить запись" onClick={finish} disabled={stopping}>
            <i />
          </button>
          {stopping ? 'Сохраняю…' : 'Готово'}
        </div>
        <div className="control">
          <button type="button" className="round" aria-label="Поставить отметку на важном месте" onClick={mark} disabled={stopping || paused}>
            <IconBookmark size={22} />
          </button>
          Отметка
        </div>
      </div>
    </main>
  );
}
