export type Scenario = 'lecture' | 'meeting' | 'talk' | 'note';
export type Lang = 'auto' | 'ru' | 'en';
export type RecordStatus = 'recording' | 'processing' | 'ready' | 'error';

/** One point of the short summary. `t` is the offset in the recording, in ms. */
export interface BriefItem {
  text: string;
  t?: number;
}

export interface Term {
  term: string;
  definition: string;
}

export interface Task {
  id: string;
  text: string;
  who?: string;
  due?: string;
  t?: number;
  done: boolean;
  updatedAt: number;
}

/** Everything the language model produced for one recording. */
export interface AiResult {
  brief: BriefItem[];
  /** Markdown: lecture notes, talk summary or cleaned note text. */
  notes?: string;
  terms?: Term[];
  decisions?: string[];
  tasks?: Task[];
  questions?: string[];
  model: string;
  createdAt: number;
}

export interface Rec {
  id: string;
  title: string;
  titleByUser: boolean;
  scenario: Scenario;
  lang: Lang;
  source: 'mic' | 'file';
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  status: RecordStatus;
  error?: string;
  /** Offsets in ms where the user pressed "mark". */
  marks: number[];
  /** Number of audio pieces sent (or queued) for recognition. */
  chunksTotal: number;
  audioHash?: string;
  audioMime?: string;
  audioSize?: number;
  ai?: AiResult;
  aiPending?: boolean;
  aiError?: string;
}

/** A recognised piece of text with its position in the recording. */
export interface Segment {
  id: string;
  recordId: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Hidden from summaries: silence artefacts or voices from the hall. */
  noise: boolean;
  noiseReason?: 'artefact' | 'hall';
  updatedAt: number;
}

/** A piece of 16 kHz WAV audio waiting for recognition. */
export interface Chunk {
  id: string;
  recordId: string;
  idx: number;
  startMs: number;
  endMs: number;
  wav: Blob;
  attempts: number;
  lastError?: string;
}

/** MediaRecorder output saved while recording, joined into one file on stop. */
export interface AudioPart {
  id: string;
  recordId: string;
  idx: number;
  blob: Blob;
}

export interface AudioFile {
  recordId: string;
  blob: Blob;
  mime: string;
  hash: string;
}

export interface Message {
  id: string;
  recordId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

/** Remembers deleted items so an old backup does not bring them back. */
export interface Tombstone {
  id: string;
  kind: 'record' | 'message';
  deletedAt: number;
}

export interface KeyValue {
  key: string;
  value: unknown;
}
