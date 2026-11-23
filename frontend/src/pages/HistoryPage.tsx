import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SentMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { CompanyLogo } from '../components/CompanyLogo';
import { useToast } from '../lib/ui';
import { ago } from '../lib/outreach';

type Channel = 'all' | 'EMAIL' | 'WHATSAPP';

const STATUS: Record<SentMessage['status'], { label: string; chip: string; icon: string; why: string }> = {
  SENT: { label: 'Sent', chip: 'chip-ok', icon: 'check', why: 'Your mail server accepted it.' },
  FAILED: { label: 'Failed', chip: 'chip-danger', icon: 'alert', why: 'It did not go out — the reason is below.' },
  OPENED: { label: 'Opened in WhatsApp', chip: 'chip-neutral', icon: 'chat', why: 'WhatsApp was opened with the message ready. JobPilot can\'t see whether you pressed Send.' },
};

/** The employer's domain from a recruiter address, for the logo — never a free-mail domain. */
function domainOf(recipient: string): string | undefined {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(recipient.trim());
  if (!m) return undefined;
  const d = m[1].toLowerCase();
  return /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|proton(mail)?|rediffmail|zoho|aol|gmx)\./.test(d) ? undefined : d;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Documents → History: every message sent from Compose — who, which company and role, by
 * email or WhatsApp, with what attached, and whether it went out. One flat list, newest first;
 * a row opens the exact text that was sent.
 */
export function HistoryPage() {
  const toast = useToast();
  const [items, setItems] = useState<SentMessage[] | null>(null);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState<Channel>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<SentMessage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.history().then((r) => { setItems(r); setError(''); }).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((m) => (channel === 'all' || m.channel === channel)
      && (!needle || [m.company, m.roleTitle, m.recipient, m.subject].some((v) => (v ?? '').toLowerCase().includes(needle))));
  }, [items, channel, q]);

  const companies = useMemo(() => new Set((items ?? []).filter((m) => m.status !== 'FAILED')
    .map((m) => (m.company || m.recipient).trim().toLowerCase())).size, [items]);
  const counts = useMemo(() => ({
    all: items?.length ?? 0,
    EMAIL: (items ?? []).filter((m) => m.channel === 'EMAIL').length,
    WHATSAPP: (items ?? []).filter((m) => m.channel === 'WHATSAPP').length,
  }), [items]);

  const remove = async (m: SentMessage) => {
    setBusy(true);
    try {
      await api.historyDelete(m.id);
      setItems((list) => (list ?? []).filter((x) => x.id !== m.id));
      setOpen(null);
      setConfirm(false);
      toast('Removed from history', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">History</h1>
          <div className="page-sub">
            {items && items.length > 0
              ? <>{companies} {companies === 1 ? 'company' : 'companies'} contacted · {counts.EMAIL} by email · {counts.WHATSAPP} on WhatsApp</>
              : 'Everything you send from Compose & send, by email or WhatsApp.'}
          </div>
        </div>
        <div className="page-acts">
          <Link to="/compose" className="btn btn-primary"><Icon name="pen" size={14} /> Compose</Link>
        </div>
      </div>

      <div className="card hist">
        <div className="hist-bar">
          <div className="seg" role="tablist" aria-label="Channel">
            {([['all', 'All'], ['EMAIL', 'Email'], ['WHATSAPP', 'WhatsApp']] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={channel === k} className={`seg-btn ${channel === k ? 'active' : ''}`} onClick={() => setChannel(k)}>
                {l} <span className="hist-n">{counts[k]}</span>
              </button>
            ))}
          </div>
          <div className="hist-search">
            <Icon name="search" size={14} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, role, recipient…" aria-label="Search history" />
          </div>
        </div>

        {items === null && !error && <div className="list-empty"><span className="spinner" /> Loading your history…</div>}
        {error && (
          <div className="list-empty" role="alert">
            <Icon name="alert" size={14} /> Couldn't load your history: {error}
            <button className="btn btn-sm" onClick={load} style={{ marginLeft: 'auto' }}><Icon name="refresh" size={13} /> Retry</button>
          </div>
        )}
        {items?.length === 0 && (
          <div className="hist-empty">
            <span className="hist-empty-ic"><Icon name="clock" size={18} /></span>
            <div className="hist-empty-t">Nothing sent yet</div>
            <div className="hist-empty-d">Messages appear here when you send one from Compose &amp; send — by email, or by opening it in WhatsApp.</div>
            <Link to="/compose" className="btn btn-sm" style={{ marginTop: 6 }}>Go to Compose &amp; send</Link>
          </div>
        )}
        {items && items.length > 0 && shown.length === 0 && (
          <div className="list-empty"><Icon name="search" size={14} /> Nothing matches {q ? `“${q}”` : 'this filter'}.</div>
        )}

        {shown.map((m) => {
          const st = STATUS[m.status] ?? STATUS.SENT;
          const attached = [m.resumeAttached && (m.resumeName || 'résumé'), m.coverAttached && 'cover letter'].filter(Boolean).join(' + ');
          return (
            <button key={m.id} className="hist-row" onClick={() => { setOpen(m); setConfirm(false); }}>
              <CompanyLogo company={m.company || undefined} label={m.company || m.recipient} url={domainOf(m.recipient) ? `https://${domainOf(m.recipient)}` : undefined} size={36} />
              <span className="hist-main">
                <span className="hist-t">{m.company || m.recipient}{m.roleTitle && <span className="hist-role"> · {m.roleTitle}</span>}</span>
                <span className="hist-s">
                  <Icon name={m.channel === 'EMAIL' ? 'mail' : 'chat'} size={12} /> {m.recipient}
                  {m.subject ? ` · ${m.subject}` : ''}
                  {attached ? ` · ${attached}` : ''}
                </span>
              </span>
              <span className={`chip ${st.chip} hist-chip`}><Icon name={st.icon} size={11} /> {st.label}</span>
              <span className="list-when" title={when(m.createdAt)}>{ago(m.createdAt)}</span>
            </button>
          );
        })}
      </div>

      {open && (
        <Modal title={open.company || open.recipient} onClose={() => setOpen(null)} wide
          footer={
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {confirm ? (
                <>
                  <span className="faint" style={{ fontSize: 13, marginRight: 'auto' }}>Remove this entry? The message itself is not recalled.</span>
                  <button className="btn" onClick={() => setConfirm(false)}>Keep</button>
                  <button className="btn btn-danger" onClick={() => remove(open)} disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="trash" size={14} />} Remove</button>
                </>
              ) : (
                <>
                  <button className="btn btn-ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={() => setConfirm(true)}><Icon name="trash" size={14} /> Remove from history</button>
                  <button className="btn" onClick={() => navigator.clipboard.writeText(open.body ?? '').then(() => toast('Message copied', 'success'), () => toast('Copy failed', 'error'))}><Icon name="copy" size={14} /> Copy message</button>
                  <button className="btn btn-primary" onClick={() => setOpen(null)}>Done</button>
                </>
              )}
            </div>
          }>
          <div className="hist-detail">
            <div className={`chip ${(STATUS[open.status] ?? STATUS.SENT).chip}`} style={{ justifySelf: 'start' }}>
              <Icon name={(STATUS[open.status] ?? STATUS.SENT).icon} size={11} /> {(STATUS[open.status] ?? STATUS.SENT).label}
            </div>
            <div className="faint" style={{ fontSize: 12.5 }}>{(STATUS[open.status] ?? STATUS.SENT).why}</div>
            {open.error && <div className="cp-note cp-note-err"><Icon name="alert" size={15} /><div>{open.error}</div></div>}
            <dl className="hist-kv">
              <dt>When</dt><dd>{when(open.createdAt)}</dd>
              <dt>Channel</dt><dd>{open.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}</dd>
              <dt>To</dt><dd>{open.recipient}</dd>
              {open.roleTitle && <><dt>Role</dt><dd>{open.roleTitle}</dd></>}
              {open.subject && <><dt>Subject</dt><dd>{open.subject}</dd></>}
              <dt>Résumé</dt><dd>{open.resumeAttached ? (open.resumeName || 'Attached') : 'Not sent'}</dd>
              <dt>Cover letter</dt><dd>{open.coverAttached ? (open.channel === 'EMAIL' ? 'Attached as PDF' : 'Linked') : 'Not sent'}</dd>
            </dl>
            <div className="hist-h">Message</div>
            <pre className="hist-body">{open.body || '—'}</pre>
            {open.coverLetter && (
              <details>
                <summary className="hist-h" style={{ cursor: 'pointer' }}>Cover letter</summary>
                <pre className="hist-body">{open.coverLetter}</pre>
              </details>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
