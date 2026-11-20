import { decodeToSegments } from '../audio/decodeFile';
import { encodeWav } from '../audio/wav';
import { kickQueue, finalizeIfDone } from '../stt/queue';
import { db, requestPersistentStorage } from './db';
import { sha256, uid } from './hash';
import { getSettings } from './settings';
import type { Rec, Scenario } from './types';

/** Creates a record from an uploaded audio or video file and queues it for recognition. */
export async function importAudioFile(file: File, scenario: Scenario): Promise<string> {
  const settings = await getSettings();
  const now = Date.now();
  const hash = await sha256(file);
  const existing = await db.records.where('audioHash').equals(hash).first();
  if (existing) return existing.id;

  const title = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Аудиофайл';
  const rec: Rec = {
    id: uid(),
    title,
    titleByUser: false,
    scenario,
    lang: settings.lang,
    source: 'file',
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    status: 'recording',
    marks: [],
    chunksTotal: 0,
    audioHash: hash,
    audioMime: file.type || 'audio/mpeg',
    audioSize: file.size,
  };
  await db.transaction('rw', db.records, db.audio, async () => {
    await db.records.add(rec);
    await db.audio.put({ recordId: rec.id, blob: file, mime: rec.audioMime!, hash });
  });
  void requestPersistentStorage();
  void splitAudio(rec.id, file);
  return rec.id;
}

/**
 * Cuts stored audio into pieces for recognition. Used for uploaded files and for
 * "recognise again" on records that came from a backup without text.
 */
export async function splitAudio(recordId: string, blob: Blob): Promise<void> {
  let idx = 0;
  try {
    await db.records.update(recordId, { status: 'recording', error: undefined, chunksTotal: 0, updatedAt: Date.now() });
    const { durationMs } = await decodeToSegments(blob, async (seg) => {
      const i = idx++;
      await db.chunks.add({
        id: uid(),
        recordId,
        idx: i,
        startMs: seg.startMs,
        endMs: seg.endMs,
        wav: encodeWav(seg.samples),
        attempts: 0,
      });
      await db.records.update(recordId, { chunksTotal: i + 1 });
      kickQueue();
    });
    await db.records.update(recordId, { status: 'processing', durationMs: Math.round(durationMs), updatedAt: Date.now() });
    await finalizeIfDone(recordId);
  } catch (e) {
    await db.records.update(recordId, {
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      updatedAt: Date.now(),
    });
  }
}

/** Throws away recognised text and recognises the stored audio again. */
export async function recognizeAgain(recordId: string): Promise<void> {
  const audio = await db.audio.get(recordId);
  if (!audio) throw new Error('У записи нет аудио');
  await db.transaction('rw', db.segments, db.chunks, db.records, async () => {
    await db.segments.where('recordId').equals(recordId).delete();
    await db.chunks.where('recordId').equals(recordId).delete();
    await db.records.update(recordId, { textFix: undefined, fixProgress: undefined, fixError: undefined });
  });
  await splitAudio(recordId, audio.blob);
}

export async function deleteRecord(recordId: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.records, db.segments, db.chunks, db.audio, db.audioParts, db.messages, db.tombstones], async () => {
    await db.records.delete(recordId);
    await db.segments.where('recordId').equals(recordId).delete();
    await db.chunks.where('recordId').equals(recordId).delete();
    await db.audio.delete(recordId);
    await db.audioParts.where('recordId').equals(recordId).delete();
    await db.messages.where('recordId').equals(recordId).delete();
    await db.tombstones.put({ id: recordId, kind: 'record', deletedAt: now });
  });
}

export async function clearChat(recordId: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.messages, db.tombstones, async () => {
    const msgs = await db.messages.where('recordId').equals(recordId).toArray();
    await db.tombstones.bulkPut(msgs.map((m) => ({ id: m.id, kind: 'message' as const, deletedAt: now })));
    await db.messages.where('recordId').equals(recordId).delete();
  });
}

export async function renameRecord(recordId: string, title: string): Promise<void> {
  const t = title.trim();
  if (!t) return;
  await db.records.update(recordId, { title: t.slice(0, 120), titleByUser: true, updatedAt: Date.now() });
}
