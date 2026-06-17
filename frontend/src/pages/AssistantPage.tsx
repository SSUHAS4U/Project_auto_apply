import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AssistantJob } from '../types';
import { ApplyBadge, useToast } from '../lib/ui';

interface Msg { role: 'user' | 'assistant'; content: string; jobs?: AssistantJob[]; }

const GREETING: Msg = {
  role: 'assistant',
  content: "Hi! I'm your JobPilot assistant. Ask me to find jobs (\"show me remote java roles\"), or help fill your profile. I search the jobs already in your database.",
};

export function AssistantPage() {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<{ enabled: boolean; provider: string; remainingToday: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api.aiStatus().then(setAi).catch(() => {}); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...msgs, { role: 'user' as const, content: text }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const payload = next.filter((m) => m !== GREETING).map((m) => ({ role: m.role, content: m.content }));
      const r = await api.assistantChat(payload);
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, jobs: r.jobs }]);
    } catch (e) {
      toast((e as Error).message, 'error');
      setMsgs((m) => [...m, { role: 'assistant', content: `⚠ ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Assistant</h1>
          <div className="page-sub">Find jobs by describing what you want · get help filling your profile</div>
        </div>
        {ai && <span className="chip">{ai.enabled ? `${ai.provider} · ${ai.remainingToday} left` : 'AI off'}</span>}
      </div>

      <div className="chat-wrap">
        <div className="chat-log" ref={logRef}>
          {msgs.map((m, i) => (
            <Fragment key={i}>
              <div className={`bubble ${m.role}`}>{m.content}</div>
              {m.jobs && m.jobs.length > 0 && (
                <div className="chat-jobs">
                  {m.jobs.map((j) => (
                    <a key={j.id} className="chat-jobcard" href={j.url} target="_blank" rel="noreferrer">
                      <div className="jt">{j.title}</div>
                      <div className="muted">{j.company} · {j.location || '—'}</div>
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <ApplyBadge type={j.applyType} /><span className="faint">★ {j.matchScore}</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </Fragment>
          ))}
          {busy && <div className="bubble assistant"><span className="spinner" /></div>}
        </div>
        <div className="chat-input">
          <input className="input grow" value={input} placeholder="Ask me anything about jobs or your profile…"
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} disabled={ai !== null && !ai.enabled} />
          <button className="btn btn-primary" onClick={send} disabled={busy || (ai !== null && !ai.enabled)}>Send</button>
        </div>
      </div>
    </>
  );
}
