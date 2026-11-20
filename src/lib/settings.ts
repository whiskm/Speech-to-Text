import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Lang } from './types';

export type ProviderId = 'deepseek' | 'openai' | 'openrouter' | 'custom';

export interface Settings {
  lang: Lang;
  noiseSuppression: boolean;
  hideHall: boolean;
  autoAi: boolean;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  accessCode: string;
  backupWithAudio: boolean;
}

export interface Meta {
  lastBackupAt?: number;
  backupSnoozeUntil?: number;
}

export const PROVIDERS: Record<ProviderId, { label: string; baseUrl: string; model: string }> = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  custom: { label: 'Другой, совместимый с OpenAI', baseUrl: '', model: '' },
};

export const DEFAULT_SETTINGS: Settings = {
  lang: 'auto',
  noiseSuppression: true,
  hideHall: true,
  autoAi: true,
  provider: 'deepseek',
  baseUrl: PROVIDERS.deepseek.baseUrl,
  model: PROVIDERS.deepseek.model,
  apiKey: '',
  accessCode: '',
  backupWithAudio: false,
};

export async function getSettings(): Promise<Settings> {
  const row = await db.kv.get('settings');
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const cur = await getSettings();
  await db.kv.put({ key: 'settings', value: { ...cur, ...patch } });
}

export function useSettings(): Settings | undefined {
  return useLiveQuery(getSettings, []);
}

export async function getMeta(): Promise<Meta> {
  const row = await db.kv.get('meta');
  return (row?.value as Meta) ?? {};
}

export async function saveMeta(patch: Partial<Meta>): Promise<void> {
  const cur = await getMeta();
  await db.kv.put({ key: 'meta', value: { ...cur, ...patch } });
}

export function useMeta(): Meta | undefined {
  return useLiveQuery(getMeta, []);
}

export function hasAi(s: Settings | undefined): boolean {
  return !!s && s.apiKey.trim() !== '' && s.baseUrl.trim() !== '' && s.model.trim() !== '';
}
