import { Resampler } from './resample';
import { Segmenter, type SpeechSegment } from './segmenter';

export interface RecorderOptions {
  noiseSuppression: boolean;
  /** 0..1 loudness, about 30 times per second. */
  onLevel: (level: number) => void;
  onSegment: (seg: SpeechSegment) => void;
  /** A piece of the compressed recording, every 10 s. */
  onPart: (blob: Blob) => void;
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
  private stopped: Promise<void> | null = null;
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

  private async init(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: this.opts.noiseSuppression,
        echoCancellation: false,
        autoGainControl: true,
      },
    });

    // 16 kHz context lets the browser resample with a proper filter. Firefox refuses
    // to mix sample rates, so fall back to the native rate and resample ourselves.
    let source: MediaStreamAudioSourceNode;
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
      source = this.ctx.createMediaStreamSource(this.stream);
    } catch {
      await this.ctx?.close().catch(() => undefined);
      this.ctx = new AudioContext();
      source = this.ctx.createMediaStreamSource(this.stream);
    }
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
    this.node.port.postMessage({ active: false });
    if (this.media.state === 'recording') this.media.pause();
    this.opts.onLevel(0);
  }

  resume(): void {
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
