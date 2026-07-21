# JobPilot Desktop

The whole JobPilot experience in one installable app: the full dashboard **and** the local
automation worker **and** its live terminal — no separate browser tab, no console window.

You install it once, sign in with your JobPilot account, and click **Connect** in the
built-in terminal. That's it: the worker runs inside the app, its live logs stream into the
terminal panel (the terminal icon sits right next to **Watch live**), and your login is
remembered between launches.

## How it fits together

- **Window = the dashboard.** The built React app (`../frontend/dist`) is served on a fixed
  loopback port so your login (localStorage) persists across restarts.
- **Backend** stays remote (your GCP deployment). Set it once in `desktop.config.json`
  (`backendUrl`) — the same value your web dashboard uses (`VITE_API_BASE`). The app injects
  it into the dashboard and passes it to the worker, so there is one source of truth.
- **Worker** is spawned as a child process with the backend URL + your connect token from
  env, so it never prompts on a console. Its output streams into the in-app terminal.

## First run (from source)

```bash
# 1. build the dashboard the app will serve
cd frontend && npm run build            # uses your VITE_API_BASE

# 2. set the backend once
cd ../desktop
cp desktop.config.example.json desktop.config.json   # then edit backendUrl

# 3. install + run
npm install
npm start
```

Sign in, open the terminal (icon beside **Watch live**), click **Connect** — a Chrome window
opens for you to sign into LinkedIn/Indeed once; after that the automation runs on schedule
and you watch it live.

## Building installers

```bash
npm run build:frontend      # dashboard
npm run dist:win            # or dist:mac / dist:linux
```

Installers land in `dist/`. The worker's `node_modules` (Playwright) and the dashboard are
bundled as app resources. The worker drives your **system Google Chrome** (nothing extra to
download).

> Note: the packaged app runs the worker with the app's own runtime (`ELECTRON_RUN_AS_NODE`),
> so end users don't need Node installed.
