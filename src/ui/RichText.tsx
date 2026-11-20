import { useMemo, type MouseEvent } from 'react';
import { parseTime } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

/** Turns "[12:40]" in sanitised HTML into buttons that jump the player to that moment. */
export function linkifyTimes(html: string): string {
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (whole, t: string) => {
    const ms = parseTime(t);
    return ms === undefined ? whole : `<button type="button" class="tref" data-t="${ms}" aria-label="Слушать с ${t}">${t}</button>`;
  });
}

export function onTimeClick(e: MouseEvent, seek: (ms: number) => void): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.tref');
  if (btn?.dataset.t) seek(Number(btn.dataset.t));
}

export function RichText({ md, seek, className = 'md' }: { md: string; seek?: (ms: number) => void; className?: string }) {
  const html = useMemo(() => linkifyTimes(renderMarkdown(md)), [md]);
  return <div className={className} onClick={seek ? (e) => onTimeClick(e, seek) : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}
