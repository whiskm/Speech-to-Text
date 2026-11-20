import { useEffect, useRef, useState } from 'react';
import { applyMerge, applyReplace, createBackup, downloadBlob, planImport, readBackup, type LoadedBackup } from '../backup/backup';
import type { MergePlan } from '../backup/merge';
import { takePendingBackup } from '../backup/pending';
import { db } from '../lib/db';
import { fmtBytes, fmtDate, fmtTime, plural } from '../lib/format';
import { go } from '../lib/router';
import { kickQueue } from '../stt/queue';
import { IconCheck, IconDb } from '../ui/icons';
import { BackButton, Segmented, Spinner } from '../ui/kit';

type Stage =
  | { kind: 'pick' }
  | { kind: 'loading' }
  | { kind: 'preview'; file: File; loaded: LoadedBackup; plan: MergePlan; localCount: number }
  | { kind: 'applying'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string };

export function Import() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [showAll, setShowAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const open = async (file: File) => {
    setStage({ kind: 'loading' });
    try {
      const loaded = await readBackup(file);
      const plan = await planImport(loaded);
      const localCount = await db.records.count();
      setStage({ kind: 'preview', file, loaded, plan, localCount });
    } catch (e) {
      setStage({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось прочитать файл' });
    }
  };

  useEffect(() => {
    const f = takePendingBackup();
    if (f) void open(f);
  }, []);

  const apply = async () => {
    if (stage.kind !== 'preview') return;
    const { loaded, plan, localCount } = stage;
    try {
      if (mode === 'merge') {
        setStage({ kind: 'applying', text: 'Добавляю записи…' });
        const r = await applyMerge(loaded, plan);
        setStage({
          kind: 'done',
          text: `Добавлено ${r.added} ${plural(r.added, 'запись', 'записи', 'записей')}, обновлено ${r.updated}. Повторы пропущены, ваши записи на месте.`,
        });
      } else {
        setStage({ kind: 'applying', text: 'Сохраняю копию текущих данных…' });
        if (localCount > 0) {
          const safety = await createBackup(true);
          downloadBlob(safety.blob, safety.name.replace('.zip', '-перед-заменой.zip'));
        }
        setStage({ kind: 'applying', text: 'Заменяю данные…' });
        const n = await applyReplace(loaded);
        setStage({
          kind: 'done',
          text: `Данные заменены копией: ${n} ${plural(n, 'запись', 'записи', 'записей')}.${localCount > 0 ? ' Прежние данные скачаны отдельным файлом.' : ''}`,
        });
      }
      kickQueue();
    } catch (e) {
      setStage({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось загрузить копию' });
    }
  };

  return (
    <main className="screen screen-fixed">
      <div className="topbar">
        <BackButton fallback="settings" />
        <h1>Загрузка копии</h1>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void open(f);
          e.target.value = '';
        }}
      />

      {stage.kind === 'pick' && (
        <div className="empty">
          Выберите файл резервной копии .zip
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Выбрать файл
          </button>
        </div>
      )}

      {(stage.kind === 'loading' || stage.kind === 'applying') && (
        <div className="empty">
          <Spinner />
          {stage.kind === 'loading' ? 'Читаю копию…' : stage.text}
        </div>
      )}

      {stage.kind === 'error' && (
        <div className="stack" style={{ paddingTop: 24 }}>
          <div className="alert alert-danger">{stage.text}</div>
          <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
            Выбрать другой файл
          </button>
        </div>
      )}

      {stage.kind === 'done' && (
        <div className="empty" style={{ flex: 1, justifyContent: 'center' }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: '50%',
              background: 'var(--surface)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 80px var(--accent-glow)',
            }}
          >
            <IconCheck size={40} />
          </div>
          <h2 style={{ margin: 0, color: 'var(--text)', fontSize: 22 }}>Готово</h2>
          <p role="status" style={{ margin: 0, maxWidth: 300 }}>
            {stage.text}
          </p>
          <button type="button" className="btn" onClick={() => go('', true)}>
            К записям
          </button>
        </div>
      )}

      {stage.kind === 'preview' && (
        <>
          <div className="scroll stack" style={{ gap: 22, paddingTop: 16, paddingBottom: 20 }}>
            <div className="card row" style={{ cursor: 'default' }}>
              <span className="rec-icon" style={{ width: 44, height: 44, borderRadius: 14, background: 'var(--surface-2)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconDb />
              </span>
              <span className="row-main">
                <span className="row-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {stage.file.name}
                </span>
                <span className="row-sub">
                  {fmtBytes(stage.file.size)} · создана {fmtDate(stage.loaded.manifest.createdAt).toLowerCase()} · {stage.loaded.manifest.withAudio ? 'с аудио' : 'без аудио'}
                </span>
              </span>
            </div>

            <Segmented
              label="Способ загрузки"
              value={mode}
              options={[
                { id: 'merge', label: 'Дополнить' },
                { id: 'replace', label: 'Заменить всё' },
              ]}
              onChange={setMode}
            />

            {mode === 'merge' ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                  <div className="stat">
                    <b style={{ color: 'var(--accent)' }}>{stage.plan.add.length}</b>
                    <span>{plural(stage.plan.add.length, 'новая', 'новых', 'новых')}</span>
                  </div>
                  <div className="stat">
                    <b>{stage.plan.update.length}</b>
                    <span>{plural(stage.plan.update.length, 'обновится', 'обновятся', 'обновятся')}</span>
                  </div>
                  <div className="stat">
                    <b style={{ color: 'var(--dim)' }}>{stage.plan.duplicates}</b>
                    <span>{plural(stage.plan.duplicates, 'повтор', 'повтора', 'повторов')}</span>
                  </div>
                </div>

                {stage.plan.add.length > 0 && (
                  <section className="stack" style={{ gap: 8 }}>
                    <h2 className="section-label">Добавятся</h2>
                    <div className="card" style={{ padding: '4px 0' }}>
                      {(showAll ? stage.plan.add : stage.plan.add.slice(0, 4)).map((r) => (
                        <div key={r.id} className="row" style={{ justifyContent: 'space-between', padding: '10px 16px' }}>
                          <span className="row-title" style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.title}
                          </span>
                          <span className="row-sub" style={{ flexShrink: 0 }}>
                            {fmtTime(r.durationMs)}
                          </span>
                        </div>
                      ))}
                      {!showAll && stage.plan.add.length > 4 && (
                        <button type="button" className="row" style={{ color: 'var(--muted)', fontSize: 13 }} onClick={() => setShowAll(true)}>
                          и ещё {stage.plan.add.length - 4}
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {stage.plan.update.length > 0 && (
                  <section className="stack" style={{ gap: 8 }}>
                    <h2 className="section-label">Обновятся</h2>
                    <div className="card" style={{ padding: '4px 0' }}>
                      {stage.plan.update.slice(0, 8).map((u) => (
                        <div key={u.merged.id} className="row" style={{ padding: '10px 16px' }}>
                          <span className="row-main">
                            <span className="row-title" style={{ fontSize: 14 }}>
                              {u.merged.title}
                            </span>
                            <span className="row-sub">Из копии: {u.reasons.join(', ')}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <p className="hint">
                  {stage.plan.duplicates > 0 && `Уже есть на устройстве и пропускаются: ${stage.plan.duplicates}. `}
                  {stage.plan.skippedDeleted > 0 && `Удалены вами после создания копии и не вернутся: ${stage.plan.skippedDeleted}. `}
                  {stage.plan.add.length + stage.plan.update.length === 0 && 'Всё из этой копии уже есть на устройстве.'}
                </p>
              </>
            ) : (
              <div className="alert alert-danger stack" role="alert" style={{ gap: 8 }}>
                <strong>Все записи на устройстве удалятся</strong>
                <span>
                  Сейчас на устройстве {stage.localCount} {plural(stage.localCount, 'запись', 'записи', 'записей')}. После замены останутся только{' '}
                  {stage.loaded.snapshot.records.length} из копии.
                </span>
                {stage.localCount > 0 && <span style={{ fontSize: 13 }}>Перед заменой приложение скачает копию текущих данных вместе с аудио.</span>}
              </div>
            )}
          </div>

          <div className="bottom-bar">
            {mode === 'merge' ? (
              <button
                type="button"
                className="btn btn-accent btn-block"
                onClick={apply}
                disabled={stage.plan.add.length + stage.plan.update.length === 0}
              >
                Дополнить: +{stage.plan.add.length} {plural(stage.plan.add.length, 'новая', 'новых', 'новых')}, {stage.plan.update.length} обновить
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger btn-block"
                onClick={() => {
                  if (confirm('Точно заменить все данные на устройстве?')) void apply();
                }}
              >
                Заменить все {stage.localCount} {plural(stage.localCount, 'запись', 'записи', 'записей')}
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
