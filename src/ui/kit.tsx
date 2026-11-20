import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { back } from '../lib/router';
import { IconBack } from './icons';

export function BackButton({ fallback = '', label = 'Назад' }: { fallback?: string; label?: string }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} onClick={() => back(fallback)}>
      <IconBack />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  role = 'pressed',
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  role?: 'pressed' | 'tab';
}) {
  return (
    <div className="segmented" role={role === 'tab' ? 'tablist' : 'group'} aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role={role === 'tab' ? 'tab' : undefined}
          aria-selected={role === 'tab' ? value === o.id : undefined}
          aria-pressed={role === 'pressed' ? value === o.id : undefined}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Flips at once and saves in the background; follows the stored value when it changes elsewhere. */
export function Switch({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  const [on, setOn] = useState(checked);
  useEffect(() => setOn(checked), [checked]);
  return (
    <input
      id={id}
      type="checkbox"
      className="switch"
      checked={on}
      onChange={(e) => {
        setOn(e.target.checked);
        onChange(e.target.checked);
      }}
    />
  );
}

export function Sheet({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="grip" />
        {children}
      </div>
    </div>
  );
}

/* Toasts: a tiny global store so any module can show a message. */
let toastText: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toastSubs = new Set<() => void>();

export function toast(text: string, ms = 3200): void {
  toastText = text;
  toastSubs.forEach((f) => f());
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastText = null;
    toastSubs.forEach((f) => f());
  }, ms);
}

export function Toaster() {
  const text = useSyncExternalStore(
    (f) => {
      toastSubs.add(f);
      return () => toastSubs.delete(f);
    },
    () => toastText,
  );
  if (!text) return null;
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function Spinner() {
  return <div className="spinner" role="progressbar" aria-label="Загрузка" />;
}
