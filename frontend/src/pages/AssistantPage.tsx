import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AssistantJob } from '../types';
import { ApplyBadge, useToast } from '../lib/ui';
import { ModelSwitcher } from '../components/ModelSwitcher';
import { Icon } from '../components/Icon';

interface Msg { role: 'user' | 'assistant'; content: string; jobs?: AssistantJob[]; }

const GREETING: Msg = {
  role: 'assistant',
  content: "Hi Suhas 👋 I'm your JobPilot agent. I can search your job database and actually edit your profile — try \"find fresher java jobs in India\" or \"add Kafka to my skills and set notice period to 30 days\".",
};
const SUGGESTIONS = [
  'Find fresher java backend jobs in India',
  'Remote react roles posted this week',
  'Add Docker & Kafka to my skills',
  'Set my expected CTC to 8 LPA',
  'How many jobs have I applied to?',
];

export function AssistantPage({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api.aiStatus().then((s) => setEnabled(s.enabled)).catch(() => {}); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    const next = [...msgs, { role: 'user' as const, content: q }];
    setMsgs(next); setInput(''); setBusy(true);
    try {
      const payload = next.filter((m) => m !== GREETING).map((m) => ({ role: m.role, content: m.content }));
      const r = await api.assistantChat(payload);
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, jobs: r.jobs }]);
    } catch (e) {
      toast((e as Error).message, 'error');
      setMsgs((m) => [...m, { role: 'assistant', content: `⚠ ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  };

  const showSuggestions = msgs.length === 1 && !busy;

  return (
    <>
      {!embedded && (
        <div className="page-head">
          <div>
            <h1 className="page-title">Assistant</h1>
            <div className="page-sub">Find jobs from your database · get profile help</div>
          </div>
          <ModelSwitcher />
        </div>
      )}

      <div className={`chat-wrap ${embedded ? 'chat-embedded' : ''}`}>
        <div className="chat-log" ref={logRef}>
          {msgs.map((m, i) => (
            <Fragment key={i}>
              <div className={`chat-row ${m.role}`}>
                <div className={`chat-avatar ${m.role === 'user' ? 'me' : 'ai'}`}>{m.role === 'user' ? 'S' : <Icon name="bot" size={16} />}</div>
                <div className={`bubble ${m.role}`}>{m.content}</div>
              </div>
              {m.jobs && m.jobs.length > 0 && (
                <div className="chat-jobs">
                  {m.jobs.map((j) => (
                    <a key={j.id} className="chat-jobcard" href={j.url} target="_blank" rel="noreferrer">
                      <div className="jt">{j.title}</div>
                      <div className="muted" style={{ margin: '3px 0 6px' }}>{j.company} · {j.location || '—'}</div>
                      <div className="row" style={{ gap: 6 }}>
                        <ApplyBadge type={j.applyType} /><span className="faint">★ {j.matchScore}</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </Fragment>
          ))}
          {busy && (
            <div className="chat-row assistant">
              <div className="chat-avatar ai"><Icon name="bot" size={16} /></div>
              <div className="bubble assistant"><span className="typing"><span /><span /><span /></span></div>
            </div>
          )}
          {showSuggestions && (
            <div className="chat-suggests">
              {SUGGESTIONS.map((s) => <button key={s} className="chat-suggest" onClick={() => send(s)}>{s}</button>)}
            </div>
          )}
        </div>
        <div className="chat-input">
          <input className="input grow" value={input} placeholder={enabled ? 'Ask anything about jobs or your profile…' : 'Set an AI model in Settings to chat'}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} disabled={!enabled} />
          <button className="btn btn-primary" onClick={() => send()} disabled={busy || !enabled || !input.trim()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
          </button>
        </div>
      </div>
    </>
  );
}
