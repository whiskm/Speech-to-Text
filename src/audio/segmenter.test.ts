import { describe, expect, it } from 'vitest';
import { Resampler } from './resample';
import { Segmenter, type SpeechSegment } from './segmenter';
import { encodeWav } from './wav';

const SR = 16000;

/** Quiet noise with tone bursts, a stand-in for speech with pauses. */
function signal(parts: { ms: number; amp: number }[]): Float32Array {
  const total = parts.reduce((n, p) => n + Math.round((p.ms / 1000) * SR), 0);
  const out = new Float32Array(total);
  let off = 0;
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  for (const p of parts) {
    const len = Math.round((p.ms / 1000) * SR);
    for (let i = 0; i < len; i++) {
      const noise = rnd() * 0.002;
      out[off + i] = noise + (p.amp ? p.amp * Math.sin((2 * Math.PI * 220 * i) / SR) : 0);
    }
    off += len;
  }
  return out;
}

function run(samples: Float32Array, block = 2048): SpeechSegment[] {
  const found: SpeechSegment[] = [];
  const s = new Segmenter((x) => found.push(x));
  for (let i = 0; i < samples.length; i += block) s.push(samples.subarray(i, i + block));
  s.flush();
  return found;
}

describe('Segmenter', () => {
  it('keeps short pauses inside one piece and skips long silence', () => {
    const segs = run(
      signal([
        { ms: 1000, amp: 0 },
        { ms: 2000, amp: 0.3 },
        { ms: 1500, amp: 0 },
        { ms: 1000, amp: 0.3 },
        { ms: 3000, amp: 0 },
        { ms: 1500, amp: 0.3 },
        { ms: 3000, amp: 0 },
      ]),
    );
    // 1.5 s pause stays inside the piece; 3 s pauses split it.
    expect(segs).toHaveLength(2);
    expect(segs[0].startMs).toBeGreaterThan(600);
    expect(segs[0].startMs).toBeLessThan(1050);
    expect(segs[0].endMs - segs[0].startMs).toBeGreaterThan(4400);
    expect(segs[0].endMs - segs[0].startMs).toBeLessThan(5300);
    expect(segs[1].startMs).toBeGreaterThan(8100);
    expect(segs[1].startMs).toBeLessThan(8550);
  });

  it('builds pieces of 10 s or more from phrases with short pauses', () => {
    const parts = [{ ms: 500, amp: 0 }];
    for (let i = 0; i < 20; i++) parts.push({ ms: 2500, amp: 0.3 }, { ms: 900, amp: 0 });
    const segs = run(signal(parts));
    expect(segs.length).toBeGreaterThanOrEqual(3);
    for (const s of segs.slice(0, -1)) {
      expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(9000);
      expect(s.endMs - s.startMs).toBeLessThanOrEqual(30000);
    }
  });

  it('splits long continuous speech into pieces under 30 seconds', () => {
    const segs = run(signal([{ ms: 500, amp: 0 }, { ms: 70000, amp: 0.3 }, { ms: 1000, amp: 0 }]));
    expect(segs.length).toBe(3);
    for (const s of segs) expect(s.endMs - s.startMs).toBeLessThanOrEqual(30000);
    const covered = segs.reduce((n, s) => n + (s.endMs - s.startMs), 0);
    expect(covered).toBeGreaterThan(69000);
  });

  it('drops short clicks', () => {
    const segs = run(signal([{ ms: 1000, amp: 0 }, { ms: 120, amp: 0.5 }, { ms: 2000, amp: 0 }]));
    expect(segs).toHaveLength(0);
  });

  it('closes an open segment on flush', () => {
    const segs = run(signal([{ ms: 600, amp: 0 }, { ms: 1500, amp: 0.3 }]));
    expect(segs).toHaveLength(1);
  });

  it('keeps sample counts consistent with timings', () => {
    const segs = run(signal([{ ms: 800, amp: 0 }, { ms: 3000, amp: 0.2 }, { ms: 1200, amp: 0 }]));
    for (const s of segs) expect(Math.abs((s.samples.length / SR) * 1000 - (s.endMs - s.startMs))).toBeLessThan(1);
  });
});

function tone(rate: number, hz: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}

/** Gain in dB of a pure tone through the resampler, measured away from the edges. */
function gainDb(rate: number, hz: number): number {
  const r = new Resampler(rate, 16000);
  const input = tone(rate, hz, 1);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += 2048) parts.push(r.process(input.subarray(i, i + 2048)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  const mid = out.subarray(1000, out.length - 1000);
  const rms = Math.sqrt(mid.reduce((n, v) => n + v * v, 0) / mid.length);
  return 20 * Math.log10(rms / Math.SQRT1_2 + 1e-12);
}

describe('Resampler', () => {
  it('turns 48 kHz into 16 kHz across blocks and keeps the level', () => {
    const r = new Resampler(48000, 16000);
    const input = new Float32Array(48000).fill(0.5);
    let total = 0;
    let last = 0;
    for (let i = 0; i < input.length; i += 1000) {
      const out = r.process(input.subarray(i, i + 1000));
      total += out.length;
      if (out.length) last = out[out.length - 1];
    }
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(81);
    expect(last).toBeCloseTo(0.5, 4);
  });

  it('handles 44.1 kHz', () => {
    const r = new Resampler(44100, 16000);
    const out = r.process(new Float32Array(44100));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(81);
  });

  for (const rate of [48000, 44100]) {
    it(`keeps speech flat at ${rate} Hz`, () => {
      for (const hz of [300, 1000, 3000, 5000]) expect(Math.abs(gainDb(rate, hz))).toBeLessThan(0.1);
      expect(gainDb(rate, 6000)).toBeGreaterThan(-1);
    });

    it(`suppresses everything above 8.8 kHz by more than 60 dB at ${rate} Hz`, () => {
      // Each of these would fold back into the 0–8 kHz speech band.
      for (const hz of [9000, 10000, 12000, 14000, 16000, 20000]) expect(gainDb(rate, hz)).toBeLessThan(-60);
    });
  }
});

describe('encodeWav', () => {
  it('writes a 44-byte header and 2 bytes per sample', () => {
    const blob = encodeWav(new Float32Array(1600));
    expect(blob.size).toBe(44 + 3200);
    expect(blob.type).toBe('audio/wav');
  });
});
