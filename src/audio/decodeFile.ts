import { Segmenter, type SpeechSegment } from './segmenter';

/**
 * Decodes an audio or video file to 16 kHz mono and cuts it into speech segments.
 * The browser resamples while decoding, so memory use is about 64 KB per second of audio.
 */
export async function decodeToSegments(
  file: Blob,
  onSegment: (seg: SpeechSegment) => Promise<void> | void,
): Promise<{ durationMs: number }> {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 16000, 16000);
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('Браузер не смог прочитать этот файл. Подойдут MP3, M4A, WAV, OGG, WEBM и видео MP4.');
  }

  let mono: Float32Array;
  if (audio.numberOfChannels === 1) {
    mono = audio.getChannelData(0);
  } else {
    mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
  }

  const found: SpeechSegment[] = [];
  const seg = new Segmenter((s) => found.push(s));
  const step = 16000 * 10;
  for (let i = 0; i < mono.length; i += step) {
    seg.push(mono.subarray(i, Math.min(mono.length, i + step)));
    while (found.length) await onSegment(found.shift()!);
  }
  seg.flush();
  while (found.length) await onSegment(found.shift()!);
  return { durationMs: (mono.length / 16000) * 1000 };
}
