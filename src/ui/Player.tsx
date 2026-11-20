import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { fmtTime } from '../lib/format';
import { IconPause, IconPlay } from './icons';

export interface PlayerHandle {
  seek: (ms: number) => void;
}

/** Audio player bar. Seeking from anywhere on the page goes through the handle. */
export const Player = forwardRef<PlayerHandle, { blob: Blob | undefined; durationMs: number }>(function Player({ blob, durationMs }, ref) {
  const audio = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const total = Math.max(durationMs, pos);

  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  useImperativeHandle(ref, () => ({
    seek(ms: number) {
      const a = audio.current;
      if (!a) return;
      a.currentTime = ms / 1000;
      setPos(ms);
      void a.play().catch(() => undefined);
    },
  }));

  if (!blob) {
    return (
      <div className="player">
        <span className="hint">Аудио нет на этом устройстве</span>
      </div>
    );
  }

  return (
    <div className="player">
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime * 1000)}
      />
      <button
        type="button"
        className="icon-btn"
        aria-label={playing ? 'Пауза' : 'Слушать запись'}
        onClick={() => {
          const a = audio.current;
          if (!a) return;
          if (a.paused) void a.play().catch(() => undefined);
          else a.pause();
        }}
      >
        {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(1, Math.round(total / 1000))}
        value={Math.round(pos / 1000)}
        aria-label="Позиция в записи"
        onChange={(e) => {
          const a = audio.current;
          if (a) a.currentTime = Number(e.target.value);
          setPos(Number(e.target.value) * 1000);
        }}
      />
      <span className="time">{fmtTime(pos)}</span>
    </div>
  );
});
