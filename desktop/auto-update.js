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
    return null;
  });

  /**
   * The "Update now" button: check, download, and install in one press.
   *
   * The automatic path has not been reaching this owner. It defers whenever the worker is
   * running — which is always, because the worker auto-starts — and the install-on-quit hook
   * never fired. A button removes every one of those conditions and, just as importantly,
   * SAYS what happened, instead of being a background process you have to take on faith.
   */
  const checkAndInstall = async () => {
    if (pending) {
      log(`\n  Installing JobPilot ${pending.version}…\n`);
      setTimeout(() => updater.quitAndInstall(false, true), 400);
      return { state: 'installing', version: pending.version };
    }
    const r = await check();
    const info = r && r.updateInfo;
    if (!info || info.version === app.getVersion()) {
      return { state: 'current', version: app.getVersion() };
    }
    // checkForUpdates already started the download (autoDownload). Wait for it to land so one
    // press is enough; if it is still going after two minutes, say so rather than hanging.
    const downloaded = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 120000);
      updater.once('update-downloaded', () => { clearTimeout(t); resolve(true); });
    });
    if (downloaded && pending) {
      log(`\n  Installing JobPilot ${pending.version}…\n`);
      setTimeout(() => updater.quitAndInstall(false, true), 400);
      return { state: 'installing', version: pending.version };
    }
    return { state: 'downloading', version: info.version };
  };

  // A moment after launch, so it never competes with the window opening.
  setTimeout(check, 8000);
  setInterval(check, RECHECK_MS);

  return {
    check,
    checkAndInstall,
    hasPending: () => !!pending,
    /**
     * Install now. Called from the shutdown path once the worker has stopped.
     *
     * autoInstallOnAppQuit alone was not enough: this app's before-quit handler calls
     * preventDefault(), stops the worker, then quits again — and the worker AUTO-STARTS, so
     * "busy" is the normal state and every downloaded update deferred to a quit sequence that
     * electron-updater's own hook may never see. Doing it explicitly removes that dependency.
     */
    installIfPending: () => {
      if (!pending) return false;
      log(`\n  Installing JobPilot ${pending.version}…\n`);
      try { updater.quitAndInstall(false, true); return true; } catch { return false; }
    },
  };
}

module.exports = { initAutoUpdate };
