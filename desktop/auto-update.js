// Self-update, so a fix reaches the machine that needs it without a reinstall.
//
// The desktop app bundles the dashboard AND the worker, so every adapter fix — a selector,
// a URL, a gate rule — only reaches the owner through a new installer. During active
// debugging that meant download-uninstall-reinstall on every iteration, which is enough
// friction that people simply keep running the broken build and report it as still broken.
//
// electron-updater reads `latest.yml` from the GitHub release and compares SEMVER against
// app.getVersion(). CI derives that version from the tag (desktop-vN -> 1.0.N), because
// package.json sat at 1.0.0 for every release and a fixed version makes updating impossible
// by definition.
const { app, dialog } = require('electron');

/** Check on launch, then every few hours for a long-running install. */
const RECHECK_MS = 4 * 60 * 60 * 1000;

/**
 * @param log   sink for the in-app terminal, so the owner sees updates happening
 * @param isBusy () => boolean — true while automation is mid-run
 */
function initAutoUpdate({ log = () => {}, isBusy = () => false } = {}) {
  // Unpackaged (npm start) has no update feed and electron-updater throws on it.
  if (!app.isPackaged) { log('  (dev build — auto-update disabled)\n'); return null; }

  let updater;
  try { ({ autoUpdater: updater } = require('electron-updater')); }
  catch (e) { log(`  auto-update unavailable: ${String(e.message).slice(0, 90)}\n`); return null; }

  // Download in the background, but NEVER restart under the owner's feet: a run mid-flight is
  // an hour of applications, and electron-updater's default quitAndInstall would drop it.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;

  let pending = null;

  updater.on('checking-for-update', () => log('  Checking for a JobPilot update…\n'));
  updater.on('update-not-available', () => log(`  JobPilot is up to date (v${app.getVersion()}).\n`));
  updater.on('error', (err) => {
    // An update failure must never take the app down with it — the automation is the point.
    log(`  Update check failed: ${String(err && err.message).slice(0, 120)}\n`);
  });
  updater.on('download-progress', (p) => {
    if (Math.round(p.percent) % 25 === 0) log(`  Downloading update… ${Math.round(p.percent)}%\n`);
  });

  updater.on('update-downloaded', async (info) => {
    pending = info;
    log(`\n  ✓ JobPilot ${info.version} downloaded.\n`);
    if (isBusy()) {
      // Mid-run: say so and install when the app is next closed. Interrupting to install would
      // throw away the very work the update was meant to fix.
      log('    Automation is running — it will install when you next close JobPilot.\n');
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'JobPilot update ready',
      message: `JobPilot ${info.version} is ready to install.`,
      detail: 'Restarting takes a few seconds. Your logins and settings are kept.',
    }).catch(() => ({ response: 1 }));
    if (response === 0) { setImmediate(() => updater.quitAndInstall()); }
    else log('    It will install when you next close JobPilot.\n');
  });

  const check = () => updater.checkForUpdates().catch((e) => {
    log(`  Update check failed: ${String(e && e.message).slice(0, 120)}\n`);
  });

  // A moment after launch, so it never competes with the window opening.
  setTimeout(check, 8000);
  setInterval(check, RECHECK_MS);

  return { check, hasPending: () => !!pending };
}

module.exports = { initAutoUpdate };
