import type { ReactNode } from 'react';
import type { Scenario } from '../lib/types';

function Svg({ size = 20, children, fill = false, width = 1.7 }: { size?: number; children: ReactNode; fill?: boolean; width?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconBack = (p: P) => (
  <Svg {...p} width={1.8}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
);
export const IconMic = (p: P) => (
  <Svg {...p} width={1.6}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 15V4M8 8l4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M8 11l4 4 4-4M5 20h14" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p} fill>
    <path d="M8 5.5v13l10-6.5z" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p} fill>
    <rect x="6.5" y="5" width="4" height="14" rx="1.2" />
    <rect x="13.5" y="5" width="4" height="14" rx="1.2" />
  </Svg>
);
export const IconBookmark = (p: P) => (
  <Svg {...p}>
    <path d="M7 4h10v16l-5-3.5L7 20z" />
  </Svg>
);
export const IconChat = (p: P) => (
  <Svg {...p} width={2}>
    <path d="M4 5h16v10H10l-5 4v-4H4z" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p} width={2}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p} width={2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p} fill>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </Svg>
);
export const IconDb = (p: P) => (
  <Svg {...p}>
    <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" />
    <path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const IconWave = (p: P) => (
  <Svg {...p} width={1.8}>
    <path d="M3 12h3M9 8v8M13 5v14M17 9v6" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p} width={1.8}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const IconChevron = (p: P) => (
  <Svg {...p} width={1.8}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export function ScenarioIcon({ scenario, size }: { scenario: Scenario; size?: number }) {
  switch (scenario) {
    case 'lecture':
      return (
        <Svg size={size}>
          <path d="M3 8.5l9-4.5 9 4.5-9 4.5z" />
          <path d="M7 10.5v4.5c0 1.6 2.2 3 5 3s5-1.4 5-3v-4.5" />
        </Svg>
      );
    case 'meeting':
      return (
        <Svg size={size}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
          <circle cx="17" cy="9" r="2.4" />
          <path d="M17 14c2.4 0 4 1.6 4 4.5" />
        </Svg>
      );
    case 'talk':
      return (
        <Svg size={size}>
          <path d="M4 5h16v10H10l-5 4v-4H4z" />
        </Svg>
      );
    case 'note':
      return (
        <Svg size={size}>
          <path d="M4 20h4L19.5 8.5l-4-4L4 16z" />
          <path d="M13.5 6.5l4 4" />
        </Svg>
      );
  }
}
