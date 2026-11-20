import type { Scenario } from './types';

/** 83 000 ms → "1:23", 4 000 000 ms → "1:06:40". */
export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Parses "mm:ss" or "h:mm:ss" into ms. Returns undefined for anything else. */
export function parseTime(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const h = m[1] ? Number(m[1]) : 0;
  return ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

const MONTHS = ['янв', 'февр', 'марта', 'апр', 'мая', 'июня', 'июля', 'авг', 'сент', 'окт', 'нояб', 'дек'];

export function fmtDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = 24 * 3600 * 1000;
  if (ts >= startOfToday) return 'Сегодня';
  if (ts >= startOfToday - day) return 'Вчера';
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function daysSince(ts: number, now = Date.now()): number {
  return Math.floor((now - ts) / (24 * 3600 * 1000));
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
}

/** Russian plural: plural(5, 'запись', 'записи', 'записей') → "записей". */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export const SCENARIO_LABEL: Record<Scenario, string> = {
  lecture: 'Лекция',
  meeting: 'Встреча',
  talk: 'Разговор',
  note: 'Заметка',
};

export const SCENARIO_GENITIVE: Record<Scenario, string> = {
  lecture: 'лекции',
  meeting: 'встречи',
  talk: 'разговора',
  note: 'заметки',
};

export const SCENARIO_HINT: Record<Scenario, string> = {
  lecture: 'После записи: выжимка, конспект с формулами и терминами, чат по лекции.',
  meeting: 'После записи: принятые решения, задачи со сроками и открытые вопросы.',
  talk: 'После записи: о чём договорились и главные мысли каждой стороны.',
  note: 'После записи: чистый текст без «эээ» и повторов, готовый к отправке.',
};

/** Label of the second tab on the record screen. */
export const SCENARIO_RESULT_TAB: Record<Scenario, string> = {
  lecture: 'Конспект',
  meeting: 'Итоги',
  talk: 'Итоги',
  note: 'Заметка',
};

export function defaultTitle(scenario: Scenario, ts: number): string {
  return `${SCENARIO_LABEL[scenario]}, ${fmtDateTime(ts)}`;
}
