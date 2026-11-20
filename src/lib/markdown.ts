import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Renders model-written markdown. The output is sanitised because model text is untrusted. */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
