import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { session, useSession } from '../audio/session';
import { db } from '../lib/db';
import { daysSince, fmtTime, plural, SCENARIO_GENITIVE, SCENARIO_HINT, SCENARIO_LABEL } from '../lib/format';
import { importAudioFile } from '../lib/records';
import { go } from '../lib/router';
import { saveMeta, useMeta } from '../lib/settings';
import type { Scenario } from '../lib/types';
import { IconClose, IconDb, IconMic, IconSearch, IconSliders, IconUpload, ScenarioIcon } from '../ui/icons';
import { toast } from '../ui/kit';
import { recMeta } from '../ui/recMeta';

const SCENARIOS: Scenario[] = ['lecture', 'meeting', 'talk', 'note'];
const DAY = 24 * 3600 * 1000;

function loadScenario(): Scenario {
  try {
    const v = localStorage.getItem('scenario') as Scenario | null;
    return v && SCENARIOS.includes(v) ? v : 'lecture';
  } catch {
    return 'lecture';
  }
}

function micError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Нет доступа к микрофону. Разрешите его в настройках браузера.';
  if (name === 'NotFoundError') return 'Микрофон не найден.';
  if (name === 'NotReadableError') return 'Микрофон занят другим приложением.';
  return 'Не удалось начать запись.';
}

export function Home() {
  const [scenario, setScenario] = useState<Scenario>(loadScenario);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const live = useSession();
  const meta = useMeta();
  const recent = useLiveQuery(() => db.records.orderBy('createdAt').reverse().limit(3).toArray(), []);
  const stats = useLiveQuery(async () => {
    const count = await db.records.count();
    const first = await db.records.orderBy('createdAt').first();
    return { count, firstAt: first?.createdAt };
  }, []);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem('scenario', scenario);
    } catch {
      // Private mode: the choice just is not remembered.
    }
  }, [scenario]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setElapsed(session.elapsedMs), 500);
    return () => clearInterval(t);
  }, [live]);

  const start = async () => {
    if (live) {
      go('record');
      return;
    }
    setBusy(true);
    try {
      await session.start(scenario);
      go('record');
    } catch (e) {
      toast(micError(e), 5000);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const id = await importAudioFile(file, scenario);
      go(`r/${id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось открыть файл', 5000);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const now = Date.now();
  const since = meta?.lastBackupAt ?? stats?.firstAt;
  const showBackup =
    !!meta && !!stats && stats.count > 0 && since !== undefined && now - since > 14 * DAY && (meta.backupSnoozeUntil ?? 0) < now;
  const backupText = meta?.lastBackupAt
    ? `Резервной копии не было ${daysSince(meta.lastBackupAt)} ${plural(daysSince(meta.lastBackupAt), 'день', 'дня', 'дней')}`
    : `Резервных копий ещё не было: ${stats?.count ?? 0} ${plural(stats?.count ?? 0, 'запись', 'записи', 'записей')} без защиты`;

  return (
    <main className="screen">
      <div className="topbar">
        <div className="wordmark">
          <i />
          Тихая комната
        </div>
        <button type="button" className="icon-btn" aria-label="Поиск по всем записям" onClick={() => go('records/search')}>
          <IconSearch />
        </button>
        <button type="button" className="icon-btn" aria-label="Настройки" onClick={() => go('settings')}>
          <IconSliders />
        </button>
      </div>

      {live && (
        <div className="banner banner-live" role="status" style={{ marginTop: 12 }}>
          <span className="live-dot" />
          <span className="banner-text">
            {live.paused ? 'Запись на паузе' : 'Идёт запись'} · {fmtTime(elapsed)}
          </span>
          <button type="button" className="banner-action" onClick={() => go('record')}>
            Открыть
          </button>
        </div>
      )}

      {!live && showBackup && (
        <div className="banner banner-warn" role="status" style={{ marginTop: 12 }}>
          <span style={{ color: 'var(--warn)', display: 'flex' }}>
            <IconDb size={18} />
          </span>
          <span className="banner-text">{backupText}</span>
          <button type="button" className="banner-action" onClick={() => go('settings/backup')}>
            Сделать
          </button>
          <button
            type="button"
            className="banner-close"
            aria-label="Скрыть напоминание на 3 дня"
            onClick={() => void saveMeta({ backupSnoozeUntil: Date.now() + 3 * DAY })}
          >
            <IconClose size={16} />
          </button>
        </div>
      )}

      <div className="home-center">
        <div className="scenarios" role="group" aria-label="Что записываем">
          {SCENARIOS.map((s) => (
            <button key={s} type="button" aria-pressed={scenario === s} onClick={() => setScenario(s)} disabled={!!live}>
              <ScenarioIcon scenario={s} />
              {SCENARIO_LABEL[s]}
            </button>
          ))}
        </div>

        <div className="orb">
          <div className="ring ring-outer" />
          <div className="ring ring-inner" />
          <button
            type="button"
            className="orb-button"
            onClick={start}
            disabled={busy}
            aria-label={live ? 'Открыть идущую запись' : `Начать запись ${SCENARIO_GENITIVE[scenario]}`}
          >
            <IconMic size={36} />
            <span>{live ? 'Идёт запись' : 'Записать'}</span>
          </button>
        </div>

        <p className="hint" style={{ textAlign: 'center', maxWidth: 300, minHeight: 38 }}>
          {SCENARIO_HINT[scenario]}
        </p>

        <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          <IconUpload size={18} />
          Загрузить аудиофайл
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*,.oga,.opus,.m4a,.amr"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      <section className="stack" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
          <h2 className="section-label">Недавние</h2>
          {!!stats?.count && (
            <a href="#/records" style={{ fontSize: 13, color: 'var(--muted)' }}>
              Все записи ({stats.count})
            </a>
          )}
        </div>
        {recent && recent.length > 0 ? (
          <div className="card" style={{ padding: '4px 0' }}>
            {recent.map((r) => (
              <a key={r.id} href={`#/r/${r.id}`} className="row rec-row">
                <span className="rec-icon">
                  <ScenarioIcon scenario={r.scenario} size={18} />
                </span>
                <span className="row-main">
                  <span className="row-title">{r.title}</span>
                  <span className="row-sub">{recMeta(r)}</span>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="hint" style={{ padding: '12px 4px' }}>
            Здесь появятся ваши записи. Положите телефон ближе к тому, кто говорит.
          </p>
        )}
      </section>
    </main>
  );
}
