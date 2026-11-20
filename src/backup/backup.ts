import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8 } from 'fflate';
import { db } from '../lib/db';
import { saveMeta } from '../lib/settings';
import type { Rec } from '../lib/types';
import { planMerge, type MergePlan, type Snapshot } from './merge';
import { sanitizeSnapshot } from './sanitize';

/** Backup id from before the app was called Pith. Kept so old and new backups open everywhere. */
export const BACKUP_APP = 'tihaya-komnata';
export const BACKUP_FORMAT = 1;

export interface Manifest {
  app: string;
  format: number;
  createdAt: number;
  withAudio: boolean;
  records: number;
}

const AUDIO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

function extFor(mime: string): string {
  return AUDIO_EXT[mime.split(';')[0]] ?? 'bin';
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Builds a backup .zip. Audio is stored without recompression because it is already compressed. */
export async function createBackup(withAudio: boolean): Promise<{ blob: Blob; name: string }> {
  const [records, segments, messages, tombstones] = await Promise.all([
    db.records.toArray(),
    db.segments.toArray(),
    db.messages.toArray(),
    db.tombstones.toArray(),
  ]);
  const snapshot: Snapshot = { records, segments, messages, tombstones };
  const manifest: Manifest = { app: BACKUP_APP, format: BACKUP_FORMAT, createdAt: Date.now(), withAudio, records: records.length };

  const out: Uint8Array[] = [];
  let failed: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else out.push(chunk);
  });
  const addText = (name: string, text: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(strToU8(text), true);
  };
  addText('manifest.json', JSON.stringify(manifest, null, 2));
  addText('data.json', JSON.stringify(snapshot));

  if (withAudio) {
    for (const r of records) {
      const a = await db.audio.get(r.id);
      if (!a) continue;
      const f = new ZipPassThrough(`audio/${r.id}.${extFor(a.mime)}`);
      zip.add(f);
      const reader = a.blob.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          f.push(new Uint8Array(0), true);
          break;
        }
        f.push(value);
      }
    }
  }
  zip.end();
  if (failed) throw failed;
  return { blob: new Blob(out as BlobPart[], { type: 'application/zip' }), name: `pith-${today()}.zip` };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function backupAndDownload(withAudio: boolean): Promise<string> {
  const { blob, name } = await createBackup(withAudio);
  downloadBlob(blob, name);
  await saveMeta({ lastBackupAt: Date.now() });
  return name;
}

export interface LoadedBackup {
  manifest: Manifest;
  snapshot: Snapshot;
  /** Audio file parts by record id. */
  audio: Map<string, { parts: Uint8Array[]; mime: string }>;
}

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(AUDIO_EXT).map(([m, e]) => [e, m]));

/** Reads a backup file in a streaming way, so large audio is never copied into one buffer. */
export async function readBackup(file: Blob): Promise<LoadedBackup> {
  const files = new Map<string, Uint8Array[]>();
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  let bad = false;
  unzip.onfile = (f) => {
    const name = f.name;
    if (name !== 'manifest.json' && name !== 'data.json' && !/^audio\/[A-Za-z0-9_-]{8,64}\.[a-z0-9]{2,5}$/.test(name)) return;
    const parts: Uint8Array[] = [];
    files.set(name, parts);
    f.ondata = (err, data) => {
      if (err) bad = true;
      else parts.push(data);
    };
    f.start();
  };
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      unzip.push(value);
    }
  } catch {
    throw new Error('Файл повреждён или это не резервная копия.');
  }
  if (bad) throw new Error('Файл повреждён или это не резервная копия.');

  const text = (name: string) => {
    const parts = files.get(name);
    if (!parts) return null;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.length;
    }
    return strFromU8(buf);
  };

  let manifest: Manifest;
  let data: unknown;
  try {
    manifest = JSON.parse(text('manifest.json') ?? 'null') as Manifest;
    data = JSON.parse(text('data.json') ?? 'null');
  } catch {
    throw new Error('Это не резервная копия Pith.');
  }
  if (!manifest || manifest.app !== BACKUP_APP) throw new Error('Это не резервная копия Pith.');
  if (manifest.format > BACKUP_FORMAT) throw new Error('Копия сделана более новой версией приложения. Обновите приложение.');

  const snapshot = sanitizeSnapshot(data);
  const audio = new Map<string, { parts: Uint8Array[]; mime: string }>();
  for (const [name, parts] of files) {
    const m = name.match(/^audio\/([A-Za-z0-9_-]+)\.([a-z0-9]+)$/);
    if (m) audio.set(m[1], { parts, mime: MIME_BY_EXT[m[2]] ?? 'application/octet-stream' });
  }
  return { manifest, snapshot, audio };
}

export async function localSnapshot(): Promise<Snapshot> {
  const [records, segments, messages, tombstones] = await Promise.all([
    db.records.toArray(),
    db.segments.toArray(),
    db.messages.toArray(),
    db.tombstones.toArray(),
  ]);
  return { records, segments, messages, tombstones };
}

export async function planImport(loaded: LoadedBackup): Promise<MergePlan> {
  return planMerge(await localSnapshot(), loaded.snapshot, new Set(loaded.audio.keys()));
}

async function writeAudio(rec: Rec, loaded: LoadedBackup): Promise<boolean> {
  const a = loaded.audio.get(rec.id);
  if (!a || !rec.audioHash) return false;
  const mime = rec.audioMime || a.mime;
  await db.audio.put({ recordId: rec.id, blob: new Blob(a.parts as BlobPart[], { type: mime }), mime, hash: rec.audioHash });
  return true;
}

/** Applies an additive merge. Returns how many records were added and updated. */
export async function applyMerge(loaded: LoadedBackup, plan: MergePlan): Promise<{ added: number; updated: number }> {
  const recById = new Map([...plan.add, ...plan.update.map((u) => u.merged)].map((r) => [r.id, r]));
  await db.transaction('rw', [db.records, db.segments, db.messages, db.audio], async () => {
    await db.records.bulkPut([...plan.add, ...plan.update.map((u) => u.merged)]);
    await db.segments.bulkPut(plan.segmentsPut);
    await db.messages.bulkPut(plan.messagesPut);
    for (const id of plan.audioFor) {
      const rec = recById.get(id);
      if (rec) await writeAudio(rec, loaded);
    }
  });
  return { added: plan.add.length, updated: plan.update.length };
}

/** Replaces everything with the backup. The caller must save a safety copy first. */
export async function applyReplace(loaded: LoadedBackup): Promise<number> {
  const { snapshot } = loaded;
  await db.transaction('rw', [db.records, db.segments, db.messages, db.audio, db.tombstones, db.chunks, db.audioParts], async () => {
    await Promise.all([
      db.records.clear(),
      db.segments.clear(),
      db.messages.clear(),
      db.audio.clear(),
      db.tombstones.clear(),
      db.chunks.clear(),
      db.audioParts.clear(),
    ]);
    const recs = snapshot.records.map((r) => (loaded.audio.has(r.id) ? r : { ...r, audioHash: undefined, audioMime: undefined, audioSize: undefined }));
    await db.records.bulkPut(recs);
    await db.segments.bulkPut(snapshot.segments);
    await db.messages.bulkPut(snapshot.messages);
    await db.tombstones.bulkPut(snapshot.tombstones);
    for (const r of recs) await writeAudio(r, loaded);
  });
  return snapshot.records.length;
}
