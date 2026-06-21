import { useEffect, useState } from 'react';
import { api, type QaPair } from '../api/client';
import { fmtDate, useToast } from '../lib/ui';

export function AnswersPage() {
  const toast = useToast();
  const [items, setItems] = useState<QaPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.qaList().then(setItems).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const remove = async (item: QaPair) => {
    if (!window.confirm('Delete this saved answer?')) return;
    setBusy(item.id);
    try { await api.qaDelete(item.id); toast('Deleted', 'success'); setItems((x) => x.filter((i) => i.id !== item.id)); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Autofill answers</h1>
          <div className="page-sub">Questions the extension has answered or you've saved — reused to autofill forms.</div>
        </div>
        <button className="btn" onClick={load}>↻ Refresh</button>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start', borderLeft: '3px solid var(--accent)' }}>
        <span style={{ fontSize: 20 }}>💬</span>
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
          When you click <b>✨ AI answer</b> or <b>💾 Save</b> on a form question in the extension, it lands here.
          The extension reuses these to fill matching questions instantly — delete any you don't want reused.
        </div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : items.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">💬</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No saved answers yet</div>
            <div className="muted" style={{ maxWidth: 460, margin: '0 auto' }}>
              Open a job application form, click the extension's <b>✨ AI answer</b> or <b>💾 Save</b> on a question,
              and it'll appear here.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map((item) => (
              <div key={item.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontWeight: 600 }}>{item.question}</div>
                  <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                    <span className={`badge ${item.source === 'ai' ? 'badge-url' : 'badge-email'}`}>{item.source}</span>
                    <button className="btn btn-ghost btn-sm" disabled={busy === item.id} onClick={() => remove(item)}
                      style={{ color: 'var(--danger,#ef4444)' }}>🗑 Delete</button>
                  </div>
                </div>
                <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{item.answer}</div>
                {item.updatedAt && <div className="faint" style={{ fontSize: 11 }}>Updated {fmtDate(item.updatedAt)}</div>}
              </div>
            ))}
          </div>
        )}
    </>
  );
}
