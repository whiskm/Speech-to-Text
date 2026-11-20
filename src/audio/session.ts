import { useSyncExternalStore } from 'react';
import { db, requestPersistentStorage } from '../lib/db';
import { defaultTitle } from '../lib/format';
import { sha256, uid } from '../lib/hash';
import { getSettings } from '../lib/settings';
import type { Rec, Scenario } from '../lib/types';
import { kickQueue, finalizeIfDone } from '../stt/queue';
import { recognizeAgain } from '../lib/records';
import { MicRecorder } from './recorder';
import type { SpeechSegment } from './segmenter';
import { encodeWav } from './wav';

export interface SessionState {
  recordId: string;
  paused: boolean;
  /**
   * `stalled`: no audio arrives, usually after the iPhone screen was locked; a tap may fix it.
   * `mic-ended`: the system took the microphone away; only saving is possible.
   */
  problem: 'stalled' | 'mic-ended' | null;
}

type LevelFn = (level: number) => void;

/**
 * The single live recording. It lives outside React so leaving the recording
 * screen does not stop the microphone.
 */
class Session {
  state: SessionState | null = null;
  private recorder: MicRecorder | null = null;
  private partIdx = 0;
  private chunkIdx = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private subs = new Set<() => void>();
  private levelSubs = new Set<LevelFn>();
  private wakeLock: WakeLockSentinel | null = null;
  private health: ReturnType<typeof setInterval> | undefined;
  private lastElapsed = -1;
  private stillTicks = 0;

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  onLevel(fn: LevelFn): () => void {
    this.levelSubs.add(fn);
    return () => this.levelSubs.delete(fn);
  }

  get elapsedMs(): number {
    return this.recorder?.elapsedMs ?? 0;
  }

  private emit() {
    this.subs.forEach((fn) => fn());
  }

  private setProblem(problem: SessionState['problem']) {
    if (!this.state || this.state.problem === problem) return;
    this.state = { ...this.state, problem };
    this.emit();
  }

  /**
   * Runs every second. Audio that stops arriving while not paused means the system
   * interrupted the microphone; this catches every cause, not only the known events.
   */
  private checkHealth = () => {
    const r = this.recorder;
    if (!this.state || !r) return;
    if (r.micEnded) {
      this.setProblem('mic-ended');
      return;
    }
    if (this.state.paused) {
      this.stillTicks = 0;
      return;
    }
    const now = r.elapsedMs;
    if (now === this.lastElapsed) this.stillTicks++;
    else {
      this.stillTicks = 0;
      if (this.state.problem === 'stalled') this.setProblem(null);
    }
    this.lastElapsed = now;
    if (this.stillTicks >= 3 || (r.suspended && this.stillTicks >= 1)) this.setProblem('stalled');
  };

  /** Tries to restart audio after an interruption. Call it from a tap on iPhone. */
  async wake(): Promise<boolean> {
    const r = this.recorder;
    if (!r || !this.state) return false;
    if (r.micEnded) {
      this.setProblem('mic-ended');
      return false;
    }
    const ok = await r.wake();
    this.stillTicks = 0;
    if (ok) this.setProblem(null);
    return ok;
  }

  /** Serialises database writes so pieces are stored in order. */
  private enqueue(job: () => Promise<unknown>) {
    this.writes = this.writes.then(job).catch((e) => console.error('write failed', e));
  }

  async start(scenario: Scenario): Promise<string> {
    if (this.state) return this.state.recordId;
    const settings = await getSettings();
    const now = Date.now();
    const rec: Rec = {
      id: uid(),
      title: defaultTitle(scenario, now),
      titleByUser: false,
      scenario,
      lang: settings.lang,
      source: 'mic',
      createdAt: now,
      updatedAt: now,
      durationMs: 0,
      status: 'recording',
      marks: [],
      chunksTotal: 0,
    };
    this.partIdx = 0;
    this.chunkIdx = 0;
    const recordId = rec.id;

    this.recorder = await MicRecorder.start({
      noiseSuppression: settings.noiseSuppression,
      onLevel: (v) => this.levelSubs.forEach((fn) => fn(v)),
      onSegment: (seg) => this.saveSegment(recordId, seg),
      onPart: (blob) => {
        const idx = this.partIdx++;
        this.enqueue(() => db.audioParts.add({ id: uid(), recordId, idx, blob }));
      },
      onTrouble: () => this.checkHealth(),
    });
    await db.records.add(rec);
    this.state = { recordId, paused: false, problem: null };
    this.lastElapsed = -1;
    this.stillTicks = 0;
    this.health = setInterval(this.checkHealth, 1000);
    void requestPersistentStorage();
    void this.lockScreen();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.emit();
    return recordId;
  }

  private saveSegment(recordId: string, seg: SpeechSegment) {
    const idx = this.chunkIdx++;
    const wav = encodeWav(seg.samples);
    this.enqueue(async () => {
      await db.transaction('rw', db.chunks, db.records, async () => {
        await db.chunks.add({ id: uid(), recordId, idx, startMs: seg.startMs, endMs: seg.endMs, wav, attempts: 0 });
        await db.records.where('id').equals(recordId).modify((r) => {
          r.chunksTotal += 1;
        });
      });
      kickQueue();
    });
  }

  pause() {
    if (!this.state || this.state.paused) return;
    this.recorder?.pause();
    this.state = { ...this.state, paused: true, problem: this.state.problem === 'mic-ended' ? 'mic-ended' : null };
    this.emit();
  }

  resume() {
    if (!this.state || !this.state.paused) return;
    this.recorder?.resume();
    this.state = { ...this.state, paused: false };
    this.emit();
  }

  async mark(): Promise<number> {
    if (!this.state) return 0;
    const t = Math.round(this.elapsedMs);
    const id = this.state.recordId;
    await db.records.where('id').equals(id).modify((r) => {
      r.marks.push(t);
    });
    return t;
  }

  /** Stops recording, joins the saved pieces into one audio file and queues recognition. */
  async finish(): Promise<string | null> {
    if (!this.state || !this.recorder) return null;
    const { recordId } = this.state;
    const recorder = this.recorder;
    const durationMs = Math.round(recorder.elapsedMs);
    clearInterval(this.health);
    await recorder.stop();
    await this.writes;
    this.recorder = null;
    this.state = null;
    this.releaseScreen();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.emit();
    await assembleAudio(recordId, recorder.mime, durationMs);
    return recordId;
  }

  private onVisibility = () => {
    if (document.visibilityState !== 'visible' || !this.state) return;
    void this.lockScreen();
    if (!this.state.paused) void this.wake();
  };

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };

  private async lockScreen() {
    try {
      if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // Not supported or denied: the recording still works while the screen is on.
    }
  }

  private releaseScreen() {
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }
}

export const session = new Session();

if (import.meta.env.DEV) {
  (window as unknown as { __session: Session }).__session = session;
}

export function useSession(): SessionState | null {
  return useSyncExternalStore(session.subscribe, () => session.state);
}

/** Joins MediaRecorder pieces into one file, stores it and moves the record to recognition. */
export async function assembleAudio(recordId: string, mime: string | undefined, durationMs?: number): Promise<void> {
  const parts = await db.audioParts.where('[recordId+idx]').between([recordId, -Infinity], [recordId, Infinity]).toArray();
  const rec = await db.records.get(recordId);
  if (!rec) return;
  const type = mime || parts[0]?.blob.type || 'audio/webm';
  const patch: Partial<Rec> = { status: 'processing', updatedAt: Date.now() };
  if (durationMs !== undefined) patch.durationMs = durationMs;
  if (parts.length) {
    const blob = new Blob(
      parts.map((p) => p.blob),
      { type },
    );
    const hash = await sha256(blob);
    await db.audio.put({ recordId, blob, mime: type, hash });
    Object.assign(patch, { audioHash: hash, audioMime: type, audioSize: blob.size });
    if (durationMs === undefined) patch.durationMs = await probeDuration(blob);
  }
  await db.transaction('rw', db.records, db.audioParts, async () => {
    await db.records.update(recordId, patch);
    await db.audioParts.where('recordId').equals(recordId).delete();
  });
  await finalizeIfDone(recordId);
  kickQueue();
}

function probeDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const done = (ms: number) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

/** After a crash or a closed tab, finishes recordings left in the "recording" state. */
export async function recoverInterrupted(): Promise<void> {
  const stuck = await db.records.where('status').equals('recording').toArray();
  for (const r of stuck) {
    if (session.state?.recordId === r.id) continue;
    if (r.source === 'file') {
      await recognizeAgain(r.id).catch(() => undefined);
      continue;
    }
    const lastChunk = await db.chunks.where('[recordId+idx]').between([r.id, -Infinity], [r.id, Infinity]).last();
    const lastSeg = await db.segments.where('[recordId+startMs]').between([r.id, -Infinity], [r.id, Infinity]).last();
    const guess = Math.max(lastChunk?.endMs ?? 0, lastSeg?.endMs ?? 0);
    await assembleAudio(r.id, undefined, guess || undefined);
  }
  kickQueue();
}
