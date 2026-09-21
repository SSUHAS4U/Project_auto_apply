import { useEffect, useRef, useState } from 'react';

/**
 * "Sign in with Google", rendered by Google Identity Services itself.
 *
 * Google draws the button (its own iframe, its own branding rules) and hands back an ID token
 * ("credential"). That token is sent to OUR server, which verifies signature, audience, issuer,
 * expiry and email_verified before signing anyone in — see GoogleIdTokenVerifier. The browser's
 * word is never taken for who signed in.
 *
 * Renders nothing when there is no client id (the server has no JOBPILOT_GOOGLE_CLIENT_ID), and
 * reports a plain message if Google's script can't load (blocked, offline) instead of leaving a
 * blank gap where the button should be.
 */

interface GsiButtonConfig {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with';
  shape?: 'rectangular' | 'pill';
  logo_alignment?: 'left' | 'center';
  width?: number;
}
interface GsiApi {
  initialize: (cfg: { client_id: string; callback: (r: { credential?: string }) => void; ux_mode?: 'popup' }) => void;
  renderButton: (el: HTMLElement, cfg: GsiButtonConfig) => void;
}
declare global {
  interface Window { google?: { accounts?: { id?: GsiApi } } }
}

const SRC = 'https://accounts.google.com/gsi/client';
let loading: Promise<GsiApi> | null = null;

/** Load Google's script once per page; every button shares it. */
function loadGsi(): Promise<GsiApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (!loading) {
    loading = new Promise<GsiApi>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('no gsi')));
      s.onerror = () => { loading = null; reject(new Error('blocked')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export function GoogleButton({ clientId, text, onCredential }: {
  clientId: string;
  text: 'signin_with' | 'signup_with' | 'continue_with';
  onCredential: (credential: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Keep the latest handler without re-rendering Google's button on every parent render.
  const handler = useRef(onCredential);
  handler.current = onCredential;

  useEffect(() => {
    let alive = true;
    loadGsi().then((gsi) => {
      if (!alive || !host.current) return;
      gsi.initialize({
        client_id: clientId,
        ux_mode: 'popup',
        callback: (r) => { if (r.credential) handler.current(r.credential); },
      });
      const dark = document.documentElement.dataset.theme === 'dark';
      host.current.innerHTML = '';
      gsi.renderButton(host.current, {
        type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', text,
        shape: 'rectangular', logo_alignment: 'center',
        // Google caps the width at 400px; match the form column, never overflow a phone.
        width: Math.min(400, Math.max(200, Math.round(host.current.getBoundingClientRect().width))),
      });
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [clientId, text]);

  if (failed) {
    return <div className="gsi-failed">Google sign-in couldn't load here (it may be blocked). Use your email and password instead.</div>;
  }
  return <div className="gsi-host" ref={host} />;
}
