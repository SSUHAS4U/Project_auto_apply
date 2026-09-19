# Security Policy

## Credential Management

**All secrets and API keys must be stored in environment variables only.**

Never commit real credentials to this repository. Use the following approach:

1. Copy `.env.example` to `.env` (git-ignored) and fill in your values locally.
2. On deployment platforms (Render, Vercel), set credentials through the dashboard environment variable settings.
3. For GitHub Actions, use repository secrets.

### Required Credentials

| Credential | Environment Variable | Where to obtain |
|------------|---------------------|----------------|
| API Token | `JOBPILOT_API_TOKEN` | Generate: `openssl rand -hex 32` |
| Database URL | `SPRING_DATASOURCE_URL` | Supabase → Settings → Database |
| Database Password | `SPRING_DATASOURCE_PASSWORD` | Supabase → Settings → Database |
| Gmail App Password | `SPRING_MAIL_PASSWORD` | Google Account → Security → App passwords |
| Groq API Key | `JOBPILOT_GROQ_API_KEY` | https://console.groq.com/keys |
| Gemini API Key | `JOBPILOT_GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| Adzuna App ID & Key | `JOBPILOT_ADZUNA_APP_ID`, `JOBPILOT_ADZUNA_APP_KEY` | https://developer.adzuna.com |
| Jooble Key | `JOBPILOT_JOOBLE_KEY` | https://jooble.org/api/about |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue.
2. Email the maintainer directly with details of the vulnerability.
3. Allow reasonable time for a fix before public disclosure.

## Security Checklist

- [ ] All API keys rotated and set via environment variables only
- [ ] `JOBPILOT_API_TOKEN` set to a strong random value (not a default)
- [ ] `.env` files are in `.gitignore` and never committed
- [ ] 2FA enabled on GitHub, hosting platforms, and email accounts
- [ ] Gmail app password is unique to this application
