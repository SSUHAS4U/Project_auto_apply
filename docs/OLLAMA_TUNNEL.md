# Using your local Ollama from the deployed (cloud) app — securely

Your deployed backend can't reach `http://localhost:11434` on your laptop. The fix is a
**secure tunnel** that exposes your local Ollama at a public HTTPS URL, locked down so only your
backend can call it. We do **not** expose Ollama openly — every request must carry a secret header.

> If you don't need local Ollama in the cloud, just use **Groq** (already configured, free, fast).
> This is only for running your own local model from the deployed app.

## Recommended: Cloudflare Tunnel (free, no open ports)

### 1. Run Ollama on your laptop
```bash
ollama serve
ollama pull llama3.1
```

### 2. Install cloudflared and create a tunnel
```bash
# Windows: winget install Cloudflare.cloudflared   (or download the .exe)
cloudflared tunnel login
cloudflared tunnel create jobpilot-ollama
```

### 3. Protect it with a secret header (gateway)
Run a tiny auth gateway so only requests with your secret reach Ollama. Easiest: a Cloudflare
**Worker** in front, or a local reverse proxy. The simplest secure option without extra infra is to
put a shared-secret check in a one-line caddy/nginx, but the **zero-infra** route is:

**Quick tunnel + shared-secret check via the app:** point the tunnel straight at Ollama and set a
hard-to-guess hostname; then *also* require the secret header below. (Cloudflare Access service
tokens give true auth — see step 5 for the stronger option.)

```bash
cloudflared tunnel --url http://localhost:11434
# prints e.g. https://random-words.trycloudflare.com
```

### 4. Point the deployed backend at it (with a secret header)
In your host's env vars (Render/Railway/Fly):
```
JOBPILOT_OLLAMA_URL=https://your-tunnel-host.trycloudflare.com
JOBPILOT_OLLAMA_MODEL=llama3.1
JOBPILOT_OLLAMA_AUTH_HEADER=CF-Access-Client-Id      # or any header your gateway checks
JOBPILOT_OLLAMA_AUTH_VALUE=<your-service-token>
JOBPILOT_AI_PROVIDER=ollama
```
The backend now sends `JOBPILOT_OLLAMA_AUTH_HEADER: JOBPILOT_OLLAMA_AUTH_VALUE` on every Ollama call.

### 5. Stronger auth — Cloudflare Access service token (recommended for "no compromise")
1. Create a **named tunnel** with a stable hostname (e.g. `ollama.yourdomain.com`).
2. In Cloudflare Zero Trust → **Access → Applications**, add a **self-hosted** app for that hostname.
3. Create a **Service Token** (Client ID + Client Secret).
4. Set a policy: *Allow* only requests with that service token.
5. Configure the backend to send both header pairs:
   - `JOBPILOT_OLLAMA_AUTH_HEADER=CF-Access-Client-Id`, `JOBPILOT_OLLAMA_AUTH_VALUE=<client-id>`

   (If two headers are needed — Client-Id and Client-Secret — front Ollama with a 5-line proxy that
   maps one `Authorization: Bearer <token>` header to both Access headers, and point the app's single
   `auth-header`/`auth-value` at that proxy. The app supports one secret header out of the box.)

Now only requests bearing your token reach Ollama; the URL is useless to anyone else.

## Alternative: ngrok with basic auth
```bash
ngrok http 11434 --basic-auth="user:strongpass"
```
Then set `JOBPILOT_OLLAMA_URL` to the ngrok https URL and
`JOBPILOT_OLLAMA_AUTH_HEADER=Authorization`,
`JOBPILOT_OLLAMA_AUTH_VALUE=Basic <base64(user:strongpass)>`.

## Security notes
- Never expose `:11434` directly to the internet without an auth gateway.
- Keep the token in host env vars only (never in git).
- Your laptop must be **on** for cloud Ollama to work; if it sleeps, the app falls back to Groq
  automatically (provider fallback chain).
- Rotate the token if it leaks (change the env var + the gateway).
