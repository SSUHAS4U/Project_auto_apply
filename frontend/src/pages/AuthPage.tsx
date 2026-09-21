import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setJwt, setAdminUI, type AuthResult } from '../api/client';
import { useToast } from '../lib/ui';
import { isDesktopApp } from '../lib/desktop';
import { Icon, Logo } from '../components/Icon';
import { GoogleButton } from '../components/GoogleButton';

/**
 * Log in and create an account.
 *
 * Sign-up is closed on this deployment once the first account exists (see AuthService). The
 * page asks the server (/api/auth/config) rather than guessing, and when sign-up is closed the
 * register route explains that instead of offering a form the server will refuse.
 *
 * Google sign-in appears only when the server has a client id AND this is a browser: the
 * desktop app opens pop-ups in the system browser, where Google's result can't reach the app,
 * so there it says to use email and password rather than showing a button that can't finish.
 */
type Config = { googleClientId: string; registrationOpen: boolean };

/** Advisory strength checks. Only the server's 6-character minimum is enforced. */
function strength(pw: string) {
  const checks = [
    { ok: pw.length >= 8, label: '8+ characters' },
    { ok: /\d/.test(pw), label: 'A number' },
    { ok: /[A-Z]/.test(pw), label: 'An uppercase letter' },
    { ok: /[^A-Za-z0-9]/.test(pw), label: 'A symbol' },
  ];
  return { checks, score: checks.filter((c) => c.ok).length };
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const toast = useToast();
  const nav = useNavigate();
  const register = mode === 'register';
  const desktopApp = isDesktopApp();
  const [config, setConfig] = useState<Config | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // If the server can't say, assume the safe thing: no Google button, sign-up not offered.
    api.authConfig().then(setConfig).catch(() => setConfig({ googleClientId: '', registrationOpen: false }));
  }, []);
  useEffect(() => { setError(''); }, [mode]);

  const signedIn = (r: AuthResult, welcome: string) => {
    setJwt(r.token);
    setAdminUI(!!r.user?.isAdmin);
    toast(welcome, 'success');
    nav('/');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (register && !agreed) { setError('Tick the box to agree to the terms before creating your account.'); return; }
    setBusy(true);
    try {
      const r = register ? await api.register(email, password, fullName) : await api.login(email, password);
      signedIn(r, register ? 'Account created. Welcome to JobPilot.' : 'Welcome back.');
    } catch (err) {
      setError(friendly((err as Error).message, register));
    } finally { setBusy(false); }
  };

  const google = async (credential: string) => {
    setError('');
    setBusy(true);
    try { signedIn(await api.googleLogin(credential), 'Signed in with Google.'); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const pw = strength(password);
  const closed = register && config !== null && !config.registrationOpen;
  const showGoogle = !!config?.googleClientId && !desktopApp;

  return (
    <div className="auth">
      <div className="auth-l">
        <div className="auth-top">
          <Link to="/" className="brand auth-brand"><Logo size={28} /><span className="brand-name">JobPilot</span></Link>
          {register
            ? <span>Have an account? <Link to="/login">Log in</Link></span>
            : !closed && config?.registrationOpen && <span>New here? <Link to="/register">Create an account</Link></span>}
        </div>

        {closed ? (
          <div className="auth-form">
            <span className="auth-lock"><Icon name="shield" size={20} /></span>
            <h1>Sign-up is invite only</h1>
            <p className="auth-lead">This JobPilot is private to its owner, so new accounts are closed. If you were given
              access, log in with the email you were invited with.</p>
            <Link className="btn btn-lg btn-primary btn-block" to="/login">Log in</Link>
            <div className="notice-sm"><Icon name="gear" size={14} /><span><b>Running your own copy?</b> Set
              <code>JOBPILOT_REGISTRATION_OPEN=true</code> on the server to allow new accounts.</span></div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit} noValidate>
            <div>
              <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
              <p className="auth-lead">{register
                ? 'Setup takes about ten minutes. Nothing is sent until you say so.'
                : 'Log in to see where your last run got to.'}</p>
            </div>

            {showGoogle && (
              <>
                <GoogleButton clientId={config!.googleClientId} text={register ? 'signup_with' : 'signin_with'} onCredential={google} />
                <div className="or">or with email</div>
              </>
            )}

            {register && (
              <label className="field">Full name
                <input className="input input-lg" id="auth-name" autoComplete="name" value={fullName}
                  onChange={(e) => setFullName(e.target.value)} placeholder="As on your résumé" required />
              </label>
            )}
            <label className="field">Email
              <span className="input-icon"><Icon name="mail" size={16} />
                <input className="input input-lg" id="auth-email" type="email" autoComplete="email" value={email}
                  onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
              </span>
              {register && <span className="field-hint">Recruiters' replies are tracked against this address.</span>}
            </label>
            <label className="field">
              Password
              <span className="input-icon"><Icon name="shield" size={16} />
                <input className={`input input-lg ${error && !register ? 'is-error' : ''}`} id="auth-pass"
                  type={showPw ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'}
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder={register ? 'At least 6 characters' : 'Your password'} required minLength={6} />
                <button type="button" className="input-end" onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'}>
                  <Icon name={showPw ? 'eyeOff' : 'eye'} size={15} />
                </button>
              </span>
              {register && password && (
                <>
                  <span className={`pw-meter s${pw.score}`} aria-hidden="true"><i /><i /><i /><i /></span>
                  <ul className="pw-reqs" aria-label="Password strength">
                    {pw.checks.map((c) => <li key={c.label} className={c.ok ? 'ok' : ''}><Icon name={c.ok ? 'check' : 'circle'} size={12} />{c.label}</li>)}
                  </ul>
                </>
              )}
            </label>

            {register && (
              <label className="consent">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>I agree to the terms and privacy policy. JobPilot may fill in applications in my name, but only
                  after I turn auto apply on.</span>
              </label>
            )}

            {error && <div className="form-error" role="alert"><Icon name="alert" size={14} />{error}</div>}

            <button className="btn btn-lg btn-primary btn-block" type="submit" disabled={busy || !email || password.length < 6 || (register && !fullName.trim())}>
              {busy ? <span className="spinner" /> : register ? <>Create account <Icon name="chevron" size={14} /></> : 'Log in'}
            </button>

            {desktopApp && config?.googleClientId && (
              <div className="notice-sm"><Icon name="alert" size={14} /><span>Google sign-in works on the web dashboard. In the
                desktop app, log in with your email and password.</span></div>
            )}
          </form>
        )}

        <div className="auth-legal">Sign-in attempts are rate limited · Sessions last 30 days on this device</div>
      </div>

      <aside className="auth-r" aria-label="About JobPilot">
        <div>
          <h2>{register ? 'What happens after you sign up' : 'Pick up where you left off'}</h2>
          <p className="auth-r-sub">{register
            ? 'About ten minutes from account to your first scored jobs.'
            : 'Your tracker, your matches and every run so far are waiting.'}</p>
        </div>
        <ol className="setup">
          <Step done={register} ico="check" t="Create your account" d="Email and password, or Google" tm={register ? 'now' : ''} />
          <Step ico="file" t="Upload your résumé" d="Skills and experience are read from it" tm="2 min" />
          <Step ico="link" t="Connect LinkedIn or Indeed" d="You sign in yourself, in the desktop app" tm="3 min" />
          <Step ico="target" t="Review your first matches" d="Every job scored, with the reasons shown" tm="5 min" />
        </ol>
      </aside>
    </div>
  );
}

function Step({ ico, t, d, tm, done }: { ico: string; t: string; d: string; tm: string; done?: boolean }) {
  return (
    <li className={`setup-step ${done ? 'done' : ''}`}>
      <span className="setup-ic"><Icon name={ico} size={16} /></span>
      <div><div className="setup-t">{t}</div><div className="setup-d">{d}</div></div>
      {tm && <span className="setup-tm">{tm}</span>}
    </li>
  );
}

/** The server's words where they're already clear; a what-to-do-next where they're terse. */
function friendly(msg: string, register: boolean): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid email or password')) return "That email and password don't match an account. Check both, or continue with Google.";
  if (m.includes('already exists')) return 'An account with that email already exists. Log in instead.';
  if (m.includes('registration is closed')) return 'Sign-up is invite only on this server. Log in with the email you were invited with.';
  if (m.includes('too many')) return msg.charAt(0).toUpperCase() + msg.slice(1) + '.';
  if (m.includes('failed to fetch') || m.includes('networkerror')) return "Can't reach the JobPilot server. Check your connection and try again.";
  return register ? `Couldn't create the account: ${msg}` : `Couldn't log in: ${msg}`;
}
