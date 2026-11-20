import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { complete } from '../ai/client';
import { backupAndDownload } from '../backup/backup';
import { setPendingBackup } from '../backup/pending';
import { db } from '../lib/db';
import { daysSince, fmtBytes, fmtDate, plural } from '../lib/format';
import { go } from '../lib/router';
import { hasAi, PROVIDERS, saveSettings, useMeta, useSettings, type ProviderId } from '../lib/settings';
import type { Lang } from '../lib/types';
import { IconLock } from '../ui/icons';
import { BackButton, Segmented, Spinner, Switch, toast } from '../ui/kit';

/** Text field with its own state: settings are saved in the background, so typing never waits for the database. */
function DraftInput({ initial, onSave, ...rest }: { initial: string; onSave: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(initial);
  return (
    <input
      {...rest}
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        onSave(e.target.value);
      }}
    />
  );
}

export function Settings({ anchor }: { anchor?: string }) {
  const s = useSettings();
  const meta = useMeta();
  const [keyState, setKeyState] = useState<'idle' | 'checking' | 'ok' | string>('idle');
  const [backingUp, setBackingUp] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const stats = useLiveQuery(async () => {
    const count = await db.records.count();
    let audioBytes = 0;
    await db.audio.each((a) => {
      audioBytes += a.blob.size;
    });
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    return { count, audioBytes, persisted };
  }, []);

  useEffect(() => {
    if (!anchor || !s) return;
    document.getElementById(`sec-${anchor}`)?.scrollIntoView({ block: 'start' });
  }, [anchor, s]);

  if (!s) return null;

  const set = (patch: Parameters<typeof saveSettings>[0]) => {
    void saveSettings(patch);
    if ('apiKey' in patch || 'baseUrl' in patch || 'model' in patch || 'provider' in patch) setKeyState('idle');
  };

  const checkKey = async () => {
    setKeyState('checking');
    try {
      await complete(s, [{ role: 'user', content: 'Ответь одним словом: ок' }], { temperature: 0 });
      setKeyState('ok');
    } catch (e) {
      setKeyState(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const backup = async () => {
    setBackingUp(true);
    try {
      const name = await backupAndDownload(s.backupWithAudio);
      toast(`Сохранено: ${name}`, 4000);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось создать копию', 5000);
    } finally {
      setBackingUp(false);
    }
  };

  const textSize = 3 * 1024 * 1024 * Math.max(1, (stats?.count ?? 0) / 24);
  const lastBackup = meta?.lastBackupAt;
  const stale = !lastBackup || daysSince(lastBackup) > 14;

  return (
    <main className="screen">
      <div className="topbar">
        <BackButton />
        <h1>Настройки</h1>
      </div>

      <div className="stack" style={{ gap: 28, padding: '16px 0 40px' }}>
        <section className="stack">
          <h2 className="section-label">Язык речи</h2>
          <Segmented<Lang>
            label="Язык речи"
            value={s.lang}
            options={[
              { id: 'auto', label: 'Авто' },
              { id: 'ru', label: 'Русский' },
              { id: 'en', label: 'English' },
            ]}
            onChange={(lang) => set({ lang })}
          />
          <p className="hint">«Авто» сам различает русский и английский. Если язык известен заранее, выберите его: точность будет выше.</p>
        </section>

        <section className="stack" id="sec-backup">
          <h2 className="section-label">Данные и резервные копии</h2>
          <div className="card">
            <div className="row">
              <span className="row-main">
                <span className="row-title">Последняя копия</span>
                <span className="row-sub" style={{ color: stale ? 'var(--warn)' : undefined }}>
                  {lastBackup ? `${fmtDate(lastBackup)}, ${daysSince(lastBackup)} ${plural(daysSince(lastBackup), 'день', 'дня', 'дней')} назад` : 'Ещё не было'}
                </span>
              </span>
              <span className="row-sub" style={{ textAlign: 'right' }}>
                {stats?.count ?? 0} {plural(stats?.count ?? 0, 'запись', 'записи', 'записей')}
                <br />
                аудио {fmtBytes(stats?.audioBytes ?? 0)}
              </span>
            </div>
            <label className="row" htmlFor="sw-audio" style={{ cursor: 'pointer' }}>
              <span className="row-main">
                <span className="row-title">Сохранять аудио в копию</span>
                <span className="row-sub">
                  {s.backupWithAudio
                    ? `Копия займёт около ${fmtBytes((stats?.audioBytes ?? 0) + textSize / 10)}`
                    : 'Без аудио копия маленькая: только тексты, выжимки и чаты'}
                </span>
              </span>
              <Switch id="sw-audio" checked={s.backupWithAudio} onChange={(v) => set({ backupWithAudio: v })} />
            </label>
            <div className="stack" style={{ padding: '4px 16px 16px' }}>
              <button type="button" className="btn btn-accent btn-block" onClick={backup} disabled={backingUp}>
                {backingUp ? 'Собираю копию…' : 'Создать копию'}
              </button>
              <button type="button" className="btn btn-ghost btn-block" onClick={() => fileRef.current?.click()}>
                Загрузить копию
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setPendingBackup(f);
                    go('import');
                  }
                  e.target.value = '';
                }}
              />
            </div>
          </div>
          <p className="hint">
            API-ключ в копию не попадает. Загрузка копии дополняет записи и пропускает повторы.
            {stats && !stats.persisted && ' Браузер может удалить данные при нехватке места, поэтому копии важны.'}
          </p>
        </section>

        <section className="stack">
          <h2 className="section-label">Запись</h2>
          <div className="card">
            <label className="row" htmlFor="sw-noise" style={{ cursor: 'pointer' }}>
              <span className="row-main">
                <span className="row-title">Шумоподавление</span>
                <span className="row-sub">Глушит гул, шаги и стук до распознавания</span>
              </span>
              <Switch id="sw-noise" checked={s.noiseSuppression} onChange={(v) => set({ noiseSuppression: v })} />
            </label>
            <label className="row" htmlFor="sw-hall" style={{ cursor: 'pointer' }}>
              <span className="row-main">
                <span className="row-title">Скрывать голоса из зала</span>
                <span className="row-sub">ИИ оставляет основную речь, посторонние реплики прячет в серые блоки</span>
              </span>
              <Switch id="sw-hall" checked={s.hideHall} onChange={(v) => set({ hideHall: v })} />
            </label>
          </div>
        </section>

        <section className="stack" id="sec-ai">
          <h2 className="section-label">ИИ для выжимок и чата</h2>
          <div className="card card-pad stack" style={{ gap: 16 }}>
            <div className="field">
              <label htmlFor="provider">Сервис</label>
              <select
                id="provider"
                className="input"
                value={s.provider}
                onChange={(e) => {
                  const p = e.target.value as ProviderId;
                  set({ provider: p, ...(p !== 'custom' ? { baseUrl: PROVIDERS[p].baseUrl, model: PROVIDERS[p].model } : {}) });
                }}
              >
                {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="key">API-ключ</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <DraftInput
                  id="key"
                  type={showKey ? 'text' : 'password'}
                  className="input"
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  initial={s.apiKey}
                  onSave={(apiKey) => set({ apiKey })}
                />
                <button type="button" className="btn btn-ghost btn-sm" style={{ height: 48 }} onClick={() => setShowKey(!showKey)}>
                  {showKey ? 'Скрыть' : 'Показать'}
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="base">Адрес API</label>
              <DraftInput
                key={`base-${s.provider}`}
                id="base"
                type="url"
                className="input"
                placeholder="https://api.deepseek.com"
                initial={s.baseUrl}
                onSave={(baseUrl) => set({ baseUrl })}
              />
            </div>
            <div className="field">
              <label htmlFor="model">Модель</label>
              <DraftInput
                key={`model-${s.provider}`}
                id="model"
                className="input"
                placeholder="deepseek-chat"
                spellCheck={false}
                initial={s.model}
                onSave={(model) => set({ model })}
              />
            </div>
            <label className="row" htmlFor="sw-auto" style={{ padding: '4px 0', cursor: 'pointer' }}>
              <span className="row-main">
                <span className="row-title">Делать выжимку сразу</span>
                <span className="row-sub">После распознавания ИИ сам напишет выжимку и конспект</span>
              </span>
              <Switch id="sw-auto" checked={s.autoAi} onChange={(v) => set({ autoAi: v })} />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={checkKey} disabled={!hasAi(s) || keyState === 'checking'}>
                Проверить ключ
              </button>
              {keyState === 'checking' && <Spinner />}
              {keyState === 'ok' && (
                <span role="status" style={{ fontSize: 13, color: 'var(--accent)' }}>
                  Ключ работает
                </span>
              )}
              {keyState !== 'idle' && keyState !== 'checking' && keyState !== 'ok' && (
                <span role="status" style={{ fontSize: 13, color: 'var(--danger)' }}>
                  {keyState}
                </span>
              )}
            </div>
            <p className="hint" style={{ margin: 0, display: 'flex', gap: 8 }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}>
                <IconLock size={16} />
              </span>
              Ключ хранится только на этом устройстве. Без ключа приложение распознаёт речь, но не делает выжимку и не отвечает на вопросы.
            </p>
          </div>
        </section>

        <section className="stack">
          <h2 className="section-label">Сервер распознавания</h2>
          <div className="card card-pad stack" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="code">Код доступа</label>
              <DraftInput
                id="code"
                type="password"
                className="input"
                autoComplete="off"
                placeholder="Если задан в Cloudflare как ACCESS_CODE"
                initial={s.accessCode}
                onSave={(accessCode) => set({ accessCode })}
              />
            </div>
            <p className="hint" style={{ margin: 0 }}>
              Код защищает ваш лимит Cloudflare от чужих людей. Оставьте поле пустым, если код на сервере не задан.
            </p>
          </div>
        </section>

        <p className="hint" style={{ textAlign: 'center' }}>Pith · версия {__APP_VERSION__}</p>
      </div>
    </main>
  );
}
