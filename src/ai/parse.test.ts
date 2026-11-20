import { describe, expect, it } from 'vitest';
import { fmtTime, parseTime, plural } from '../lib/format';
import { isArtefact } from '../stt/noise';
import { parseJsonReply } from './client';
import { normalizeResult } from './pipeline';
import { buildPrompt } from './prompts';

describe('parseJsonReply', () => {
  it('reads plain JSON', () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
  });
  it('reads JSON inside a fence with text around it', () => {
    expect(parseJsonReply('Вот ответ:\n```json\n{"title":"Тема"}\n```\nГотово')).toEqual({ title: 'Тема' });
  });
  it('throws a readable error on garbage', () => {
    expect(() => parseJsonReply('не знаю')).toThrow(/формате/);
  });
});

describe('normalizeResult', () => {
  it('converts times and drops broken items', () => {
    const r = normalizeResult(
      {
        title: ' Термодинамика ',
        noise: [3, '4', -1, 'x'],
        brief: [{ text: 'ΔU = Q − A', time: '13:25' }, { text: '' }, 'Просто строка'],
        notes: '## Тема',
        terms: [{ term: 'Энергия', definition: 'Работа' }, { definition: 'без термина' }],
        tasks: [{ text: 'Написать тексты', who: 'Аня', due: '25 нояб', time: '1:08:12' }, { who: 'никто' }],
        decisions: ['Запуск 2 декабря', 5],
      },
      'deepseek-chat',
      42,
    );
    expect(r.title).toBe('Термодинамика');
    expect(r.noise).toEqual([3, 4]);
    expect(r.brief).toEqual([{ text: 'ΔU = Q − A', t: 805000 }, { text: 'Просто строка', t: undefined }]);
    expect(r.terms).toHaveLength(1);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks![0]).toMatchObject({ text: 'Написать тексты', who: 'Аня', due: '25 нояб', t: 4092000, done: false, updatedAt: 42 });
    expect(r.decisions).toEqual(['Запуск 2 декабря']);
  });
});

describe('format', () => {
  it('formats and parses times', () => {
    expect(fmtTime(83000)).toBe('1:23');
    expect(fmtTime(4000000)).toBe('1:06:40');
    expect(parseTime('1:06:40')).toBe(4000000);
    expect(parseTime('12:40')).toBe(760000);
    expect(parseTime('12 минут')).toBeUndefined();
  });
  it('picks Russian plural forms', () => {
    expect(plural(1, 'запись', 'записи', 'записей')).toBe('запись');
    expect(plural(3, 'запись', 'записи', 'записей')).toBe('записи');
    expect(plural(11, 'запись', 'записи', 'записей')).toBe('записей');
    expect(plural(22, 'запись', 'записи', 'записей')).toBe('записи');
  });
});

describe('isArtefact', () => {
  const base = { avg_logprob: -0.2, no_speech_prob: 0.05, compression_ratio: 1.2 };
  it('flags typical Whisper inventions', () => {
    expect(isArtefact({ ...base, text: 'Продолжение следует...' })).toBe(true);
    expect(isArtefact({ ...base, text: 'Субтитры сделал DimaTorzok' })).toBe(true);
    expect(isArtefact({ ...base, text: '...' })).toBe(true);
    expect(isArtefact({ text: 'что-то', avg_logprob: -1.5, no_speech_prob: 0.9, compression_ratio: 1 })).toBe(true);
  });
  it('keeps real speech', () => {
    expect(isArtefact({ ...base, text: 'Запишите: дельта U равно Q минус A.' })).toBe(false);
  });
});

describe('buildPrompt', () => {
  it('asks for noise ids only when hiding the hall is on', () => {
    expect(buildPrompt('lecture', '#1 [0:01] текст', true)).toContain('"noise"');
    expect(buildPrompt('lecture', '#1 [0:01] текст', false)).not.toContain('"noise"');
  });
});
