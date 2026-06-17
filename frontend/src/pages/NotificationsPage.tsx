import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Notification } from '../types';
import { fmtDate, useToast } from '../lib/ui';

export function NotificationsPage() {
  const toast = useToast();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.notifications(false).then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const markRead = async (n: Notification) => {
    try { await api.markNotificationRead(n.id); setItems((xs) => xs.map((x) => x.id === n.id ? { ...x, read: true } : x)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const runDigest = async () => {
    try { const r = await api.digest(); toast(`Digest: ${r.count} jobs${r.sent ? ', emailed' : ''}`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Notifications</h1>
          <div className="page-sub">New-job alerts and daily digests</div>
        </div>
        <button className="btn" onClick={runDigest}>Run digest now</button>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : items.length === 0 ? <div className="card card-pad empty"><div className="big">🔔</div>No notifications.</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map((n) => (
              <div key={n.id} className="card card-pad row" style={{ opacity: n.read ? 0.6 : 1 }}>
                <span className="chip">{n.type}</span>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{n.title}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{n.body}</div>
                </div>
                <span className="faint" style={{ fontSize: 12 }}>{fmtDate(n.createdAt)}</span>
                {!n.read && <button className="btn btn-sm" onClick={() => markRead(n)}>Mark read</button>}
              </div>
            ))}
          </div>
        )}
    </>
  );
}
