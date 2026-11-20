import { Resampler } from './resample';
import { Segmenter, type SpeechSegment } from './segmenter';

export interface RecorderOptions {
  noiseSuppression: boolean;
  /** 0..1 loudness, about 30 times per second. */
  onLevel: (level: number) => void;
  onSegment: (seg: SpeechSegment) => void;
  /** A piece of the compressed recording, every 10 s. */
  onPart: (blob: Blob) => void;
  /** The microphone track or the audio graph changed state; the caller re-checks health. */
  onTrouble?: () => void;
}

/** iPhone, iPad and Safari on Mac all run WebKit, where a 16 kHz AudioContext is unreliable for microphone input. */
export function isAppleWebKit(): boolean {
  return (
    navigator.vendor === 'Apple Computer, Inc.' ||
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const m of options) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * Records the microphone two ways at once: MediaRecorder keeps a compact copy for
 * playback, and an AudioWorklet feeds 16 kHz PCM to the speech segmenter.
 */
export class MicRecorder {
  private stream!: MediaStream;
  private ctx!: AudioContext;
  private node!: AudioWorkletNode;
  private media!: MediaRecorder;
  private segmenter!: Segmenter;
  private resampler: Resampler | null = null;
  private track!: MediaStreamTrack;
  private stopped: Promise<void> | null = null;
  private userPaused = false;
  mime = '';

  private constructor(private readonly opts: RecorderOptions) {}

  static async start(opts: RecorderOptions): Promise<MicRecorder> {
    const r = new MicRecorder(opts);
    await r.init();
    return r;
  }

  get elapsedMs(): number {
    return this.segmenter.positionMs;
  }

  /** The system took the microphone away for good (a phone call, for example). */
  get micEnded(): boolean {
    return this.track.readyState === 'ended';
  }

  /** The audio graph is not running, usually after the screen was locked on iPhone. */
  get suspended(): boolean {
    return this.ctx.state !== 'running';
  }

  /**
   * Restarts audio after an interruption. On iPhone this may only work from a tap,
   * so the caller shows a button when it returns false.
   */
  async wake(): Promise<boolean> {
    if (this.micEnded) return false;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // Needs a user gesture on some browsers.
      }
    }
    if (!this.userPaused && this.media.state === 'paused') this.media.resume();
    return this.ctx.state === 'running';
  }

  private async init(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: this.opts.noiseSuppression,
        echoCancellation: false,
        autoGainControl: true,
      },
    });

    this.track = this.stream.getAudioTracks()[0];
    this.track.addEventListener('ended', () => this.opts.onTrouble?.());
    this.track.addEventListener('mute', () => this.opts.onTrouble?.());

    // A 16 kHz context lets Chrome resample with a proper filter. Firefox refuses to mix
    // sample rates and WebKit can distort the microphone, so those use the native rate
    // and our own resampler.
    let source: MediaStreamAudioSourceNode | null = null;
    if (!isAppleWebKit()) {
      try {
        this.ctx = new AudioContext({ sampleRate: 16000 });
        source = this.ctx.createMediaStreamSource(this.stream);
      } catch {
        await this.ctx?.close().catch(() => undefined);
        source = null;
      }
    }
    if (!source) {
      this.ctx = new AudioContext();
      source = this.ctx.createMediaStreamSource(this.stream);
    }
    this.ctx.addEventListener('statechange', () => this.opts.onTrouble?.());
    if (this.ctx.sampleRate !== 16000) this.resampler = new Resampler(this.ctx.sampleRate, 16000);
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    await this.ctx.resume();

    this.segmenter = new Segmenter(this.opts.onSegment);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    let levelAcc = 0;
    let levelN = 0;
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const block = e.data;
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      levelAcc += sum / block.length;
      levelN++;
      if (levelN >= 2) {
        const db = 10 * Math.log10(levelAcc / levelN + 1e-12);
        this.opts.onLevel(Math.max(0, Math.min(1, (db + 60) / 45)));
        levelAcc = 0;
        levelN = 0;
      }
      this.segmenter.push(this.resampler ? this.resampler.process(block) : block);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.ctx.destination);

    this.mime = pickMime();
    this.media = new MediaRecorder(this.stream, {
      ...(this.mime ? { mimeType: this.mime } : {}),
      audioBitsPerSecond: 32000,
    });
    this.mime = this.media.mimeType || this.mime || 'audio/webm';
    this.media.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.opts.onPart(e.data);
    };
    this.media.start(10000);
  }

  pause(): void {
    this.userPaused = true;
    this.node.port.postMessage({ active: false });
    if (this.media.state === 'recording') this.media.pause();
    this.opts.onLevel(0);
  }

  resume(): void {
    this.userPaused = false;
    void this.wake();
    this.node.port.postMessage({ active: true });
    if (this.media.state === 'paused') this.media.resume();
  }

  /** Stops both pipelines and waits for the last MediaRecorder piece. */
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopped = new Promise<void>((resolve) => {
      const finish = () => {
        this.segmenter.flush();
        this.stream.getTracks().forEach((t) => t.stop());
        this.ctx.close().catch(() => undefined);
        resolve();
      };
      if (this.media.state === 'inactive') {
        finish();
        return;
      }
      this.media.addEventListener('stop', () => finish(), { once: true });
      this.node.port.postMessage({ active: false });
      this.media.stop();
    });
    return this.stopped;
  }
}
