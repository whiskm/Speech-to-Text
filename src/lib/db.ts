import Dexie, { type EntityTable } from 'dexie';
import type { AudioFile, AudioPart, Chunk, KeyValue, Message, Rec, Segment, Tombstone } from './types';

class AppDB extends Dexie {
  records!: EntityTable<Rec, 'id'>;
  segments!: EntityTable<Segment, 'id'>;
  chunks!: EntityTable<Chunk, 'id'>;
  audioParts!: EntityTable<AudioPart, 'id'>;
  audio!: EntityTable<AudioFile, 'recordId'>;
  messages!: EntityTable<Message, 'id'>;
  tombstones!: EntityTable<Tombstone, 'id'>;
  kv!: EntityTable<KeyValue, 'key'>;

  constructor() {
    // Internal name from before the app was called Pith. Changing it would hide existing recordings.
    super('tihaya-komnata');
    this.version(1).stores({
      records: 'id, createdAt, updatedAt, status, audioHash',
      segments: 'id, recordId, [recordId+startMs]',
      chunks: 'id, recordId, [recordId+idx]',
      audioParts: 'id, recordId, [recordId+idx]',
      audio: 'recordId, hash',
      messages: 'id, recordId, [recordId+createdAt]',
      tombstones: 'id',
      kv: 'key',
    });
  }
}

export const db = new AppDB();

/** Asks the browser not to evict our data when the disk gets full. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
