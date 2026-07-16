import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Notification } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from '../components/Icon';

const ICON: Record<string, string> = { daily: 'sun', digest: 'mail', ingest: 'refresh', new_jobs: 'compass', reminder: 'clock' };

export function NotificationsPage() {
  const toast = useToast();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'unread'>('all');

  const load = () => {
    setLoading(true);
    api.notifications(false).then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const markRead = async (n: Notification) => {
    try { await api.markNotificationRead(n.id); setItems((xs) => xs.map((x) => x.id === n.id ? { ...x, read: true } : x)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const markAllRead = async () => {
    const unread = items.filter((n) => !n.read);
    await Promise.all(unread.map((n) => api.markNotificationRead(n.id).catch(() => {})));
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    toast('All marked read', 'success');
  };
  const runDigest = async () => {
    try { const r = await api.digest(); toast(`Digest: ${r.count} jobs${r.sent ? ', emailed' : ''}`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const unreadCount = useMemo(() => items.filter((n) => !n.read).length, [items]);
  const rows = tab === 'unread' ? items.filter((n) => !n.read) : items;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Notifications</h1>
          <div className="page-sub">{unreadCount} unread · job alerts, daily picks & digests</div>
        </div>
        <div className="row">
          {unreadCount > 0 && <button className="btn btn-sm" onClick={markAllRead}><Icon name="check" size={13} /> Mark all read</button>}
          <button className="btn btn-sm" onClick={runDigest}>Run digest now</button>
        </div>
      </div>

      <div className="tabs">
        <div className={`tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>All <span className="faint">{items.length}</span></div>
        <div className={`tab ${tab === 'unread' ? 'active' : ''}`} onClick={() => setTab('unread')}>Unread <span className="faint">{unreadCount}</span></div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : rows.length === 0 ? <div className="card card-pad empty"><div className="big"><Icon name="bell" size={34} /></div>{tab === 'unread' ? "You're all caught up." : 'No notifications yet.'}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((n) => (
              <div key={n.id} className={`notif ${n.read ? 'read' : ''}`} onClick={() => !n.read && markRead(n)}>
                <div className="notif-ico"><Icon name={ICON[n.type] ?? 'bell'} size={16} /></div>
                <div className="grow">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontWeight: 600 }}>{n.title}{!n.read && <span className="notif-dot" />}</div>
                    <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(n.createdAt)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{n.body}</div>
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  );
}
