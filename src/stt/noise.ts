/** Phrases Whisper invents on silence or music, mostly learned from subtitled videos. */
const ARTEFACTS = [
  'продолжение следует',
  'субтитры',
  'спасибо за просмотр',
  'подписывайтесь на канал',
  'ставьте лайк',
  'редактор субтитров',
  'корректор',
  'dimatorzok',
  'thanks for watching',
  'thank you for watching',
  'subtitles by',
  'amara.org',
  'please subscribe',
];

export interface RawSegment {
  text: string;
  avg_logprob: number | null;
  no_speech_prob: number | null;
  compression_ratio: number | null;
}

/** True when a recognised segment is almost certainly not real speech. */
export function isArtefact(s: RawSegment): boolean {
  const t = s.text.trim().toLowerCase();
  if (t === '' || /^[\s.,!?…-]*$/.test(t)) return true;
  if (t.length < 80 && ARTEFACTS.some((a) => t.includes(a))) return true;
  if (s.no_speech_prob !== null && s.avg_logprob !== null && s.no_speech_prob > 0.6 && s.avg_logprob < -1) return true;
  if (s.compression_ratio !== null && s.compression_ratio > 2.6) return true;
  return false;
}
