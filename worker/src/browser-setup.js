// Self-contained automation browser.
//
// The worker used to drive the user's INSTALLED Chrome. That meant Chrome had to be present,
// its version could change under us, and every run put a visible window on screen. This module
// fetches and manages our own browser instead, so the app owns its runtime end to end.
//
// We use Camoufox — a Firefox build patched for Playwright (same Juggler protocol) and
// hardened against fingerprinting, which is what job boards actually check. It lives beside
// the app, is downloaded once, and is reused forever after.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// Computed locally (not imported from browser.js) so the two modules don't form an import cycle.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();

const REPO = 'daijro/camoufox';
const ROOT = () => path.join(APP_DIR, 'browsers');
const MANIFEST = () => path.join(ROOT(), 'camoufox.json');

/** win / mac / linux + the arch tokens that appear in release asset names. */
function platformTokens() {
  const arch = process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'x64', 'amd64'];
  if (process.platform === 'win32') return { os: ['win'], arch, exe: 'camoufox.exe' };
  if (process.platform === 'darwin') return { os: ['mac', 'osx', 'darwin'], arch, exe: 'camoufox' };
  return { os: ['lin'], arch, exe: 'camoufox' };
}

/** Walk the extracted tree for the launcher binary. */
function findExe(dir, exeName, depth = 0) {
  if (depth > 6) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === exeName.toLowerCase()) return full;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findExe(path.join(dir, e.name), exeName, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST(), 'utf8'));
    if (m && m.exe && fs.existsSync(m.exe)) return m;
  } catch { /* re-download */ }
  return null;
}

/** Stream a URL to disk, reporting progress on one rewritten line. */
async function download(url, dest, log) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'JobPilot' } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') || 0);
  const mb = (n) => (n / 1048576).toFixed(1);
  let done = 0, lastPct = -1;
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    done += chunk.length;
    out.write(chunk);
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct >= 0 && pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      log(`     downloading browser … ${pct}%  (${mb(done)} / ${mb(total)} MB)`);
    }
  }
  await new Promise((r) => out.end(r));
}

function extract(archive, destDir, log) {
  fs.mkdirSync(destDir, { recursive: true });
  log('     extracting …');
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${destDir}" -Force`], { encoding: 'utf8' })
    : spawnSync('unzip', ['-q', '-o', archive, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`extract failed: ${(r.stderr || r.error?.message || '').slice(0, 200)}`);
}

/**
 * Return a ready-to-launch Camoufox executable path, downloading it on first use.
 * Returns null (never throws) when it can't be provided, so the caller can fall back to a
 * system browser rather than leaving the user with nothing.
 */
export async function ensureBrowser(log = console.log) {
  const cached = readManifest();
  if (cached) return cached.exe;

  const { os: osTok, arch: archTok, exe } = platformTokens();
  try {
    fs.mkdirSync(ROOT(), { recursive: true });
    log('\n  No automation browser yet — fetching one (one time, ~80-150 MB).');

    const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'JobPilot', Accept: 'application/vnd.github+json' },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub API ${r.status}`))));

    const asset = (rel.assets || []).find((a) => {
      const n = a.name.toLowerCase();
      return n.endsWith('.zip') && osTok.some((t) => n.includes(t)) && archTok.some((t) => n.includes(t));
    }) || (rel.assets || []).find((a) => {
      const n = a.name.toLowerCase();
      return n.endsWith('.zip') && osTok.some((t) => n.includes(t));
    });
    if (!asset) throw new Error(`no build for ${process.platform}/${process.arch} in ${rel.tag_name}`);

    log(`     ${rel.tag_name} · ${asset.name}`);
    const tmp = path.join(os.tmpdir(), asset.name);
    await download(asset.browser_download_url, tmp, log);

    const dir = path.join(ROOT(), 'camoufox');
    fs.rmSync(dir, { recursive: true, force: true });
    extract(tmp, dir, log);
    fs.rmSync(tmp, { force: true });

    const found = findExe(dir, exe);
    if (!found) throw new Error('binary not found inside the archive');
    if (process.platform !== 'win32') { try { fs.chmodSync(found, 0o755); } catch { /* best effort */ } }

    fs.writeFileSync(MANIFEST(), JSON.stringify({ version: rel.tag_name, exe: found }, null, 2));
    log(`  ✓ Automation browser ready (${rel.tag_name}).\n`);
    return found;
  } catch (e) {
    log(`  ! Could not set up the bundled browser: ${e.message}`);
    log('    Falling back to Google Chrome on this machine.\n');
    return null;
  }
}
