/**
 * Streaming downsampler with a box filter. Speech above 8 kHz carries little
 * for recognition, so averaging is enough to avoid audible aliasing.
 */
export class Resampler {
  private readonly ratio: number;
  private carry = new Float32Array(0);
  private t = 0;

  constructor(inRate: number, outRate = 16000) {
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);

    const outLen = Math.max(0, Math.floor((buf.length - this.t) / this.ratio));
    const out = new Float32Array(outLen);
    let t = this.t;
    for (let k = 0; k < outLen; k++) {
      const a = Math.floor(t);
      const b = Math.max(a + 1, Math.floor(t + this.ratio));
      let sum = 0;
      for (let i = a; i < b; i++) sum += buf[i];
      out[k] = sum / (b - a);
      t += this.ratio;
    }
    const keepFrom = Math.floor(t);
    this.carry = buf.slice(keepFrom);
    this.t = t - keepFrom;
    return out;
  }
}
