// A small, consistent inline-SVG icon set (Lucide-style, 24×24, 2px stroke) so the app
// uses real vector icons instead of emoji. currentColor lets them theme automatically.

const PATHS: Record<string, JSX.Element> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  live: <><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8M12 18v3" /><path d="m10 9 4 2-4 2V9z" fill="currentColor" stroke="none" /></>,
  link: <><path d="M9 12h6" /><path d="M10 7H8a5 5 0 0 0 0 10h2" /><path d="M14 7h2a5 5 0 0 1 0 10h-2" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  file: <><path d="M14 3v5h5" /><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M9 13h6M9 17h4" /></>,
  bot: <><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 2h8" /><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" /></>,
  pen: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></>,
  clipboard: <><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><path d="M9 13l2 2 4-4" /></>,
  bookmark: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.6 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.2 6.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>,
  shield: <><path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5l-8-3z" /><path d="m9 12 2 2 4-4" /></>,
};

export function Icon({ name, size = 18, className, style }:
  { name: string; size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}
      aria-hidden="true">
      {PATHS[name] ?? PATHS.dashboard}
    </svg>
  );
}

/** The JobPilot brand mark — a paper-plane (send) in a rounded gradient tile. */
export function Logo({ size = 34 }: { size?: number }) {
  const id = 'jp-logo-grad';
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-label="JobPilot">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" /><stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill={`url(#${id})`} />
      <path d="M29 12 12 19.5l6.2 2.3L21 29l3.1-5.8L29 12z" fill="#fff" opacity="0.96" />
      <path d="m18.2 21.8 6.9-9.8-6.9 9.8 2.8 1.2-2.8-1.2z" fill="#c7d2fe" />
    </svg>
  );
}
