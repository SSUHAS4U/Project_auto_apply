import { useEffect, useState } from 'react';
import { api, type AdminUser, type AdminUserDetail } from '../api/client';
import { fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

export function AdminPage() {
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<AdminUserDetail | null>(null);

  const load = (query = q) => {
    setLoading(true);
    api.adminUsers(query).then(setUsers).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(() => { load(''); }, []); // eslint-disable-line

  const onSearch = (e: React.FormEvent) => { e.preventDefault(); load(q.trim()); };

  const setRole = async (u: AdminUser, role: 'ADMIN' | 'USER') => {
    setBusy(u.id);
    try { await api.adminSetRole(u.id, role); toast(`${u.email} is now ${role}`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  const remove = async (u: AdminUser) => {
    if (!window.confirm(`Delete ${u.email}? This permanently removes their account and all their data.`)) return;
    setBusy(u.id);
    try { await api.adminDeleteUser(u.id); toast(`Deleted ${u.email}`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  const openView = async (u: AdminUser) => {
    try { setView(await api.adminUser(u.id)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Admin — users</h1>
          <div className="page-sub">{users.length} {users.length === 1 ? 'account' : 'accounts'} · grant admin, view, remove, search</div>
        </div>
      </div>

      <form className="card card-pad" onSubmit={onSearch} style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn btn-primary" type="submit">Search</button>
        {q && <button className="btn" type="button" onClick={() => { setQ(''); load(''); }}>Clear</button>}
      </form>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : users.length === 0 ? <div className="card card-pad empty"><div className="big">👤</div>No users found.</div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
            {users.map((u) => (
              <div key={u.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                    <div className="su-avatar" style={{ width: 38, height: 38, flexShrink: 0 }}>{(u.fullName || u.email)[0]?.toUpperCase()}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.fullName || '—'}</div>
                      <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</div>
                    </div>
                  </div>
                  <span className={`badge ${u.isAdmin ? 'badge-email' : 'badge-unknown'}`} style={{ flexShrink: 0 }}>{u.role}</span>
                </div>

                <div className="row" style={{ gap: 14, fontSize: 12.5, color: 'var(--muted)' }}>
                  <span>📋 {u.applications} apps</span>
                  <span>🔖 {u.savedJobs} saved</span>
                  {u.createdAt && <span>🗓 {fmtDate(u.createdAt)}</span>}
                </div>

                <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 6 }}>
                  <button className="btn btn-sm" onClick={() => openView(u)}>👁 View</button>
                  {u.isAdmin
                    ? <button className="btn btn-sm" disabled={busy === u.id} onClick={() => setRole(u, 'USER')}>Revoke admin</button>
                    : <button className="btn btn-sm" disabled={busy === u.id} onClick={() => setRole(u, 'ADMIN')}>Grant admin</button>}
                  <button className="btn btn-ghost btn-sm" disabled={busy === u.id} onClick={() => remove(u)} style={{ color: 'var(--danger,#ef4444)' }}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

      {view && <UserModal u={view} onClose={() => setView(null)} />}
    </>
  );
}

function UserModal({ u, onClose }: { u: AdminUserDetail; onClose: () => void }) {
  const row = (label: string, value?: string | number | null) =>
    (value === undefined || value === null || value === '') ? null : (
      <div className="kv-row" style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
        <div className="faint" style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 13.5 }}>{value}</div>
      </div>
    );
  return (
    <Modal title={u.fullName || u.email} onClose={onClose} wide
      footer={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      <div style={{ display: 'grid', gap: 2 }}>
        {row('Email', u.email)}
        {row('Role', u.role)}
        {row('Phone', u.phone)}
        {row('Location', u.location)}
        {row('Headline', u.headline)}
        {row('Current role', [u.currentTitle, u.currentCompany].filter(Boolean).join(' · '))}
        {row('Experience', u.yearsExperience ? `${u.yearsExperience} yrs` : undefined)}
        {row('Skills', u.skills && u.skills.length ? u.skills.join(', ') : undefined)}
        {row('Resume', u.resumeFilename)}
        {row('Applications', u.applications)}
        {row('Saved jobs', u.savedJobs)}
        {row('Joined', u.createdAt ? fmtDate(u.createdAt) : undefined)}
        {u.summary && (
          <div style={{ marginTop: 10 }}>
            <div className="faint" style={{ fontSize: 13, marginBottom: 4 }}>Summary</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{u.summary}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
