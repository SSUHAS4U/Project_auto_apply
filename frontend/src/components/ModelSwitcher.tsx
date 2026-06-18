import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../lib/ui';

type Status = { enabled: boolean; provider: string; remainingToday: number; providers: { provider: string; configured: boolean }[] };

const META: Record<string, { label: string; sub: string; dot: string }> = {
  auto: { label: 'Auto', sub: 'best available', dot: 'var(--accent-hi)' },
  groq: { label: 'Groq', sub: 'llama-3.3-70b · fast', dot: '#f97316' },
  gemini: { label: 'Gemini', sub: '2.5-flash', dot: '#4285f4' },
  ollama: { label: 'Ollama', sub: 'local', dot: '#22c55e' },
};

/** Compact AI model selector used in page headers. */
export function ModelSwitcher({ onChange }: { onChange?: (provider: string) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () => api.aiStatus().then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = async (provider: string) => {
    setOpen(false);
    try {
      await api.aiSetProvider(provider);
      await load();
      onChange?.(provider);
      toast(`AI model → ${META[provider]?.label ?? provider}`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const current = status?.provider ?? 'auto';
  const m = META[current] ?? META.auto;
  const options = ['auto', 'groq', 'gemini', 'ollama'];

  return (
    <div className="model-switch" ref={ref}>
      <button className="model-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="model-dot" style={{ background: m.dot }} />
        <span className="model-name">{m.label}</span>
        {status && <span className="model-meta">{status.remainingToday} left</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="model-menu" role="listbox">
          {options.map((id) => {
            const meta = META[id];
            const cfg = id === 'auto' ? status?.enabled : status?.providers.find((p) => p.provider === id)?.configured;
            return (
              <button key={id} className={`model-opt ${current === id ? 'sel' : ''}`} role="option" aria-selected={current === id}
                onClick={() => pick(id)} disabled={!cfg && id !== 'auto'}>
                <span className="model-dot" style={{ background: meta.dot }} />
                <span className="grow"><span className="model-name">{meta.label}</span><span className="model-opt-sub">{meta.sub}</span></span>
                {current === id ? <span className="model-check">✓</span> : !cfg && <span className="model-opt-sub">no key</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
