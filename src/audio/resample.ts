function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Streaming downsampler with a windowed-sinc low-pass filter (Blackman window).
 *
 * Passband is flat to about 6.5 kHz, and everything above 8.8 kHz is suppressed by
 * more than 60 dB before decimation. A plain average of neighbouring samples
 * suppressed 8–16 kHz by only 4–10 dB, which folded hiss from "с", "ш", "щ" back
 * into the speech band and hurt recognition.
 */
export class Resampler {
  private readonly step: number; // input samples per output sample, as num / den
  private readonly num: number;
  private readonly den: number;
  private readonly half: number;
  /** One kernel of 2 * half + 1 taps per fractional phase (den phases). */
  private readonly kernels: Float32Array[];
  private buf: Float32Array;
  /** Position of the next output sample in the buffer, times den. */
  private pos: number;
  private readonly passthrough: boolean;

  constructor(inRate: number, outRate = 16000, opts: { cutoffHz?: number; halfWidth?: number } = {}) {
    this.passthrough = inRate === outRate;
    const g = gcd(Math.round(inRate), Math.round(outRate));
    this.num = Math.round(inRate) / g;
    this.den = Math.round(outRate) / g;
    this.step = this.num / this.den;
    // About 1.7 ms of history on each side at 48 kHz.
    this.half = opts.halfWidth ?? Math.ceil(80 * Math.max(1, this.step / 3));
    const fc = Math.min(opts.cutoffHz ?? 7300, outRate / 2) / inRate; // cycles per input sample

    const phases = this.den <= 1000 ? this.den : 1000;
    this.kernels = [];
    for (let ph = 0; ph < phases; ph++) {
      const frac = ph / phases;
      const k = new Float32Array(2 * this.half + 1);
      let sum = 0;
      for (let j = -this.half; j <= this.half; j++) {
        const x = j - frac; // distance from the exact output position, in input samples
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = (x + this.half + 1) / (2 * this.half + 2); // 0..1 across the window
        const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
        const v = sinc * blackman;
        k[j + this.half] = v;
        sum += v;
      }
      for (let i = 0; i < k.length; i++) k[i] /= sum; // unity gain at 0 Hz
      this.kernels.push(k);
    }
    // Leading zeros give the filter its history, so output sample 0 sits at input sample 0.
    this.buf = new Float32Array(this.half);
    this.pos = this.half * this.den;
  }

  process(input: Float32Array): Float32Array {
    if (this.passthrough) return input;
    const buf = new Float32Array(this.buf.length + input.length);
    buf.set(this.buf);
    buf.set(input, this.buf.length);

    const out: number[] = [];
    const taps = 2 * this.half + 1;
    const phases = this.kernels.length;
    for (;;) {
      const center = Math.floor(this.pos / this.den);
      if (center + this.half >= buf.length) break;
      const frac = (this.pos % this.den) / this.den;
      const kernel = this.kernels[Math.min(phases - 1, Math.round(frac * phases))];
      const start = center - this.half;
      let acc = 0;
      for (let t = 0; t < taps; t++) acc += buf[start + t] * kernel[t];
      out.push(acc);
      this.pos += this.num;
    }

    // Keep only what future outputs still need.
    const keepFrom = Math.max(0, Math.floor(this.pos / this.den) - this.half);
    this.buf = buf.slice(keepFrom);
    this.pos -= keepFrom * this.den;
    return Float32Array.from(out);
  }

  /** Output samples per input sample, for callers that size buffers. */
  get ratio(): number {
    return 1 / this.step;
  }
}
