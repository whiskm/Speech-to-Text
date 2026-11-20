import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../lib/db';
import { fmtTime } from '../lib/format';
import type { Rec } from '../lib/types';
import { ScenarioIcon } from '../ui/icons';
import { BackButton } from '../ui/kit';
import { recMeta } from '../ui/recMeta';

interface Hit {
  rec: Rec;
  snippet?: string;
  t?: number;
}

function snippetAround(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text.slice(0, 120);
  const from = Math.max(0, i - 50);
  return (from > 0 ? '…' : '') + text.slice(from, i + q.length + 70) + (i + q.length + 70 < text.length ? '…' : '');
}

async function search(query: string): Promise<Hit[]> {
  const records = await db.records.orderBy('createdAt').reverse().toArray();
  const q = query.trim().toLowerCase();
  if (!q) return records.map((rec) => ({ rec }));

  const hits = new Map<string, Hit>();
  for (const rec of records) {
    const inTitle = rec.title.toLowerCase().includes(q);
    const brief = rec.ai?.brief.find((b) => b.text.toLowerCase().includes(q));
    const notes = rec.ai?.notes?.toLowerCase().includes(q) ? rec.ai.notes : undefined;
    if (inTitle || brief || notes) {
      hits.set(rec.id, { rec, snippet: brief ? brief.text : notes ? snippetAround(notes, q) : undefined, t: brief?.t });
    }
  }
  const segs = await db.segments.filter((s) => !s.noise && s.text.toLowerCase().includes(q)).toArray();
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const s of segs) {
    const rec = byId.get(s.recordId);
    if (!rec || hits.get(rec.id)?.snippet) continue;
    hits.set(rec.id, { rec, snippet: snippetAround(s.text, q), t: s.startMs });
  }
  return records.filter((r) => hits.has(r.id)).map((r) => hits.get(r.id)!);
}

export function Records({ focusSearch }: { focusSearch: boolean }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const hits = useLiveQuery(() => search(debounced), [debounced]);

  return (
    <main className="screen">
      <div className="topbar">
        <BackButton />
        <h1>Все записи</h1>
      </div>
      <div style={{ padding: '12px 0 16px' }}>
        <label htmlFor="q" className="sr-only">
          Поиск по записям
        </label>
        <input
          id="q"
          type="search"
          className="input"
          style={{ borderRadius: 23, background: 'var(--surface)', paddingLeft: 18 }}
          placeholder="Найти слово во всех записях"
          value={query}
          autoFocus={focusSearch}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {hits && hits.length === 0 && <div className="empty">{debounced ? 'Ничего не нашлось.' : 'Записей пока нет.'}</div>}
      {hits && hits.length > 0 && (
        <div className="card" style={{ padding: '4px 0', marginBottom: 24 }}>
          {hits.map(({ rec, snippet, t }) => (
            <a key={rec.id} href={`#/r/${rec.id}`} className="row rec-row" style={{ alignItems: 'flex-start' }}>
              <span className="rec-icon">
                <ScenarioIcon scenario={rec.scenario} size={18} />
              </span>
              <span className="row-main">
                <span className="row-title">{rec.title}</span>
                <span className="row-sub">{recMeta(rec)}</span>
                {snippet && (
                  <span className="row-sub serif" style={{ color: 'var(--text-2)', fontSize: 14 }}>
                    {t !== undefined && <span style={{ color: 'var(--accent)', fontFamily: 'var(--sans)' }}>{fmtTime(t)} </span>}
                    {snippet}
                  </span>
                )}
              </span>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
