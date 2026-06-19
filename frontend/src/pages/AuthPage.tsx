import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setJwt } from '../api/client';
import { useToast } from '../lib/ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const toast = useToast();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const register = mode === 'register';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = register ? await api.register(email, password, fullName) : await api.login(email, password);
      setJwt(r.token);
      toast(register ? 'Account created — welcome!' : 'Welcome back!', 'success');
      nav('/');
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-logo">J</div>
          <div><div className="brand-name" style={{ fontSize: 19 }}>JobPilot</div>
            <div className="brand-sub">your personal job copilot</div></div>
        </div>
        <h2 style={{ margin: '0 0 4px' }}>{register ? 'Create your account' : 'Sign in'}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {register ? 'Track jobs, get AI matches, and apply faster.' : 'Welcome back — pick up where you left off.'}
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {register && (
            <label className="field">Full name
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Suhas S" required />
            </label>
          )}
          <label className="field">Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          </label>
          <label className="field">Password
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="6+ characters" required minLength={6} />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ justifyContent: 'center', marginTop: 4 }}>
            {busy ? <span className="spinner" /> : (register ? 'Create account' : 'Sign in')}
          </button>
        </form>
        <div className="muted" style={{ fontSize: 13, marginTop: 14, textAlign: 'center' }}>
          {register
            ? <>Already have an account? <a href="/login">Sign in</a></>
            : <>New here? <a href="/register">Create an account</a></>}
        </div>
      </div>
    </div>
  );
}
