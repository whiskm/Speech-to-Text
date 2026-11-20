export interface SpeechSegment {
  startMs: number;
  endMs: number;
  samples: Float32Array;
}

export interface SegmenterOptions {
  sampleRate?: number;
  frameMs?: number;
  /** Segments with less voiced audio than this are dropped as clicks and coughs. */
  minSpeechMs?: number;
  /** A pause this long closes the segment. */
  silenceCloseMs?: number;
  /** After this length the next quiet frame closes the segment. */
  softMaxMs?: number;
  /** Hard limit: Whisper works best on pieces up to 30 s. */
  maxMs?: number;
  /** Audio kept before the first voiced frame so word onsets are not cut. */
  prerollMs?: number;
  /** A frame is voiced when it is this many dB above the noise floor. */
  marginDb?: number;
}

/**
 * Energy-based voice activity detector. It cuts a mono PCM stream into speech pieces
 * at natural pauses, so silence never reaches the recogniser (Whisper invents
 * phrases like "Продолжение следует" on silence).
 */
export class Segmenter {
  private readonly sr: number;
  private readonly frameLen: number;
  private readonly frameMs: number;
  private readonly o: Required<Omit<SegmenterOptions, 'sampleRate' | 'frameMs'>>;

  private partial: Float32Array;
  private partialN = 0;
  private pos = 0; // samples consumed, i.e. the timeline
  private floorDb = -50;
  private framesSeen = 0;

  private preroll: Float32Array[] = [];
  private inSeg = false;
  private segFrames: Float32Array[] = [];
  private segStart = 0;
  private voicedFrames = 0;
  private silentRun = 0;

  constructor(
    private readonly emit: (s: SpeechSegment) => void,
    opts: SegmenterOptions = {},
  ) {
    this.sr = opts.sampleRate ?? 16000;
    this.frameMs = opts.frameMs ?? 30;
    this.frameLen = Math.round((this.sr * this.frameMs) / 1000);
    this.partial = new Float32Array(this.frameLen);
    this.o = {
      minSpeechMs: opts.minSpeechMs ?? 400,
      silenceCloseMs: opts.silenceCloseMs ?? 800,
      softMaxMs: opts.softMaxMs ?? 24000,
      maxMs: opts.maxMs ?? 29500,
      prerollMs: opts.prerollMs ?? 300,
      marginDb: opts.marginDb ?? 10,
    };
  }

  /** Current position on the timeline, in ms. */
  get positionMs(): number {
    return ((this.pos + this.partialN) / this.sr) * 1000;
  }

  push(samples: Float32Array): void {
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.frameLen - this.partialN, samples.length - i);
      this.partial.set(samples.subarray(i, i + take), this.partialN);
      this.partialN += take;
      i += take;
      if (this.partialN === this.frameLen) {
        const frame = this.partial;
        this.partial = new Float32Array(this.frameLen);
        this.partialN = 0;
        this.onFrame(frame);
      }
    }
  }

  /** Closes the open segment, if any. Call once when the stream ends. */
  flush(): void {
    if (this.partialN > 0 && this.inSeg) {
      const tail = this.partial.slice(0, this.partialN);
      this.segFrames.push(tail);
      this.pos += this.partialN;
      this.partialN = 0;
    }
    if (this.inSeg) this.close();
  }

  private onFrame(frame: Float32Array): void {
    const frameStart = this.pos;
    this.pos += frame.length;

    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] * frame[k];
    const db = 10 * Math.log10(sum / frame.length + 1e-12);

    // Noise floor: drops fast, rises slowly, barely moves during speech.
    this.framesSeen++;
    if (this.framesSeen === 1) this.floorDb = db;
    else if (this.framesSeen <= 10) this.floorDb = Math.min(this.floorDb, db);
    const voiced = this.framesSeen > 3 && db > this.floorDb + this.o.marginDb && db > -60;
    if (this.framesSeen <= 10) {
      // still measuring the room
    } else if (db < this.floorDb) this.floorDb += 0.2 * (db - this.floorDb);
    else this.floorDb += (voiced ? 0.0005 : 0.01) * (db - this.floorDb);

    const prerollFrames = Math.ceil(this.o.prerollMs / this.frameMs);

    if (!this.inSeg) {
      if (voiced) {
        this.inSeg = true;
        this.segFrames = [...this.preroll, frame];
        this.segStart = frameStart - this.preroll.reduce((n, f) => n + f.length, 0);
        this.preroll = [];
        this.voicedFrames = 1;
        this.silentRun = 0;
      } else {
        this.preroll.push(frame);
        if (this.preroll.length > prerollFrames) this.preroll.shift();
      }
      return;
    }

    this.segFrames.push(frame);
    if (voiced) {
      this.voicedFrames++;
      this.silentRun = 0;
    } else {
      this.silentRun++;
    }

    const lenMs = ((this.pos - this.segStart) / this.sr) * 1000;
    const silentMs = this.silentRun * this.frameMs;
    if (silentMs >= this.o.silenceCloseMs || (lenMs >= this.o.softMaxMs && !voiced) || lenMs >= this.o.maxMs) {
      this.close();
    }
  }

  private close(): void {
    // Keep at most `prerollMs` of trailing silence.
    const keepSilent = Math.ceil(this.o.prerollMs / this.frameMs);
    const drop = Math.max(0, this.silentRun - keepSilent);
    const frames = drop > 0 ? this.segFrames.slice(0, this.segFrames.length - drop) : this.segFrames;
    const voicedMs = this.voicedFrames * this.frameMs;

    if (voicedMs >= this.o.minSpeechMs && frames.length > 0) {
      const total = frames.reduce((n, f) => n + f.length, 0);
      const samples = new Float32Array(total);
      let off = 0;
      for (const f of frames) {
        samples.set(f, off);
        off += f.length;
      }
      const startMs = Math.max(0, (this.segStart / this.sr) * 1000);
      this.emit({ startMs, endMs: startMs + (total / this.sr) * 1000, samples });
    }

    // Trailing silence becomes preroll for the next segment.
    this.preroll = this.segFrames.slice(-Math.ceil(this.o.prerollMs / this.frameMs));
    this.inSeg = false;
    this.segFrames = [];
    this.voicedFrames = 0;
    this.silentRun = 0;
  }
}
