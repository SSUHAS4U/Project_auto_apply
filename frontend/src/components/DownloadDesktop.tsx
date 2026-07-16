// OS-aware "Download JobPilot Desktop" button. Serves the latest release binary for the
// visitor's platform from GitHub Releases, with links for the other platforms.

import { Icon } from './Icon';

const RELEASE_BASE = 'https://github.com/SSUHAS4U/Project_auto_apply/releases/latest/download';
const DOWNLOADS: Record<string, { label: string; file: string }> = {
  win: { label: 'Download for Windows', file: 'jobpilot-desktop-win-x64.exe' },
  macArm: { label: 'Download for Mac', file: 'jobpilot-desktop-macos-arm64' },
  linux: { label: 'Download for Linux', file: 'jobpilot-desktop-linux-x64' },
};

function detectOS(): string {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'win';
  if (/Mac/i.test(ua)) return 'macArm';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'win';
}

export function DownloadDesktop({ compact = false }: { compact?: boolean }) {
  const primary = detectOS();
  const others = Object.keys(DOWNLOADS).filter((k) => k !== primary);
  return (
    <div>
      <a className="btn btn-primary" href={`${RELEASE_BASE}/${DOWNLOADS[primary].file}`} download>
        <Icon name="download" size={14} /> {DOWNLOADS[primary].label}
      </a>
      {!compact && (
        <>
          <div className="row" style={{ gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            {others.map((k) => (
              <a key={k} href={`${RELEASE_BASE}/${DOWNLOADS[k].file}`} download className="faint"
                style={{ fontSize: 12.5, textDecoration: 'underline' }}>{DOWNLOADS[k].label}</a>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            Requires Google Chrome installed. On Mac/Linux, make it executable once:
            {' '}<code>chmod +x jobpilot-desktop-*</code>, then run it.
          </div>
        </>
      )}
    </div>
  );
}
