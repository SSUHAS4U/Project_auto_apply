// OS-aware "Download JobPilot" button. Serves the latest desktop-app installer for the
// visitor's platform from GitHub Releases, with links for the other platforms.

import { useEffect, useState } from 'react';
import { Icon } from './Icon';

const REPO = 'SSUHAS4U/Project_auto_apply';
const RELEASE_BASE = `https://github.com/${REPO}/releases/latest/download`;

// `match` finds this platform's asset in the release; `file` is the stable fallback name.
const DOWNLOADS: Record<string, { label: string; file: string; match: RegExp }> = {
  win: { label: 'Download for Windows', file: 'JobPilot-Windows-Setup.exe', match: /windows.*\.exe$/i },
  macArm: { label: 'Download for Mac', file: 'JobPilot-macOS.dmg', match: /macos.*\.dmg$/i },
  linux: { label: 'Download for Linux', file: 'JobPilot-Linux.AppImage', match: /linux.*\.appimage$/i },
};

function detectOS(): string {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'win';
  if (/Mac/i.test(ua)) return 'macArm';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'win';
}

type Release = { tag: string; assets: { name: string; url: string }[] };

export function DownloadDesktop({ compact = false }: { compact?: boolean }) {
  const primary = detectOS();
  const others = Object.keys(DOWNLOADS).filter((k) => k !== primary);
  const [rel, setRel] = useState<Release | null>(null);

  // Resolve the ACTUAL release so the download carries the version in its filename
  // (JobPilot-desktop-v79-Windows-Setup.exe) — a fixed name gives no way to tell a fresh
  // download from an old one already in your Downloads folder. If GitHub can't be reached we
  // fall back to the stable /releases/latest/download/<fixed name> URL, which always works.
  useEffect(() => {
    let alive = true;
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no release'))))
      .then((d) => {
        if (!alive) return;
        setRel({
          tag: d.tag_name,
          assets: (d.assets || []).map((a: { name: string; browser_download_url: string }) =>
            ({ name: a.name, url: a.browser_download_url })),
        });
      })
      .catch(() => { /* fixed-name fallback below */ });
    return () => { alive = false; };
  }, []);

  // Prefer the asset whose name carries the version; else the stable fallback URL.
  const hrefFor = (key: string) => {
    const d = DOWNLOADS[key];
    const versioned = rel?.assets.find((a) => a.name.includes(rel.tag) && d.match.test(a.name));
    return versioned?.url ?? `${RELEASE_BASE}/${d.file}`;
  };
  const fileFor = (key: string) => {
    const d = DOWNLOADS[key];
    return rel?.assets.find((a) => a.name.includes(rel.tag) && d.match.test(a.name))?.name ?? d.file;
  };

  return (
    <div>
      <a className="btn btn-primary" href={hrefFor(primary)} download>
        <Icon name="download" size={14} /> {DOWNLOADS[primary].label}
        {rel && <span style={{ opacity: 0.85, marginLeft: 6 }}>· {rel.tag}</span>}
      </a>
      {!compact && (
        <>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            You'll get <code>{fileFor(primary)}</code> — the version is in the filename, so you can
            always tell which build you're running.
          </div>
          <div className="row" style={{ gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            {others.map((k) => (
              <a key={k} href={hrefFor(k)} download className="faint"
                style={{ fontSize: 12.5, textDecoration: 'underline' }}>{DOWNLOADS[k].label}</a>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            Requires Google Chrome installed. Run the installer, sign in, then connect LinkedIn /
            Indeed once on the Connections page. On Linux, make the AppImage executable first:{' '}
            <code>chmod +x JobPilot-*-Linux.AppImage</code>.
          </div>
        </>
      )}
    </div>
  );
}
