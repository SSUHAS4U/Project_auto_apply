import { useEffect, useState } from 'react';
import { api, type AdminUser } from '../api/client';
import { fmtDate, useToast } from '../lib/ui';

export function AdminPage() {
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

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

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Admin — users</h1>
          <div className="page-sub">Everyone using JobPilot. Grant admin, remove accounts, search.</div>
        </div>
      </div>

      <form className="card card-pad" onSubmit={onSearch} style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
        <input className="input" placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary" type="submit">Search</button>
        {q && <button className="btn" type="button" onClick={() => { setQ(''); load(''); }}>Clear</button>}
      </form>

      {loading ? <div className="empty"><span className="spinner" /></div> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12 }}>
                <th style={{ padding: '10px 12px' }}>Name</th>
                <th style={{ padding: '10px 12px' }}>Email</th>
                <th style={{ padding: '10px 12px' }}>Role</th>
                <th style={{ padding: '10px 12px' }}>Apps</th>
                <th style={{ padding: '10px 12px' }}>Saved</th>
                <th style={{ padding: '10px 12px' }}>Joined</th>
                <th style={{ padding: '10px 12px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{u.fullName || '—'}</td>
                  <td style={{ padding: '10px 12px' }}>{u.email}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span className={`badge ${u.isAdmin ? 'badge-email' : 'badge-unknown'}`}>{u.role}</span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>{u.applications}</td>
                  <td style={{ padding: '10px 12px' }}>{u.savedJobs}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--muted)' }}>{u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <div className="row" style={{ gap: 6 }}>
                      {u.isAdmin
                        ? <button className="btn btn-sm" disabled={busy === u.id} onClick={() => setRole(u, 'USER')}>Revoke admin</button>
                        : <button className="btn btn-sm" disabled={busy === u.id} onClick={() => setRole(u, 'ADMIN')}>Grant admin</button>}
                      <button className="btn btn-ghost btn-sm" disabled={busy === u.id} onClick={() => remove(u)} style={{ color: 'var(--danger,#ef4444)' }}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
