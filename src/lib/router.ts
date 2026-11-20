import { useEffect, useState } from 'react';

/**
 * Hash routes keep the app working offline and on Cloudflare Pages without server rewrites.
 * Routes: "" home, "record" live recording, "r/<id>" one recording, "records" list and search,
 * "settings", "import", "print/<id>".
 */
export function currentRoute(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function go(path: string, replace = false): void {
  const hash = '#/' + path.replace(/^\//, '');
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function back(fallback = ''): void {
  if (history.length > 1) history.back();
  else go(fallback, true);
}
