import { useEffect, useState } from 'react';
import { api, type AdminUser, type AdminUserDetail, type SecretStatus } from '../api/client';
import { fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';

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

      <SecretsManager />

      <form className="card card-pad" onSubmit={onSearch} style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn btn-primary" type="submit">Search</button>
        {q && <button className="btn" type="button" onClick={() => { setQ(''); load(''); }}>Clear</button>}
      </form>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : users.length === 0 ? <div className="card card-pad empty"><div className="big"><Icon name="user" size={34} /></div>No users found.</div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 14 }}>
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
                  <span className="meta-item"><Icon name="clipboard" size={13} /> {u.applications} apps</span>
                  <span className="meta-item"><Icon name="bookmark" size={13} /> {u.savedJobs} saved</span>
                  {u.createdAt && <span className="meta-item"><Icon name="clock" size={13} /> {fmtDate(u.createdAt)}</span>}
                </div>

                <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 6 }}>
                  <button className="btn btn-sm" onClick={() => openView(u)}><Icon name="user" size={13} /> View</button>
                  {u.owner ? (
                    <span className="chip meta-item" title="The owner account is protected"><Icon name="shield" size={13} /> owner</span>
                  ) : (
                    <>
                      {u.isAdmin
                        ? <button className="btn btn-sm" disabled={busy === u.id} onClick={() => setRole(u, 'USER')}>Revoke admin</button>
                        : <button className="btn btn-sm" disabled={busy === u.id} onClick={() => setRole(u, 'ADMIN')}>Grant admin</button>}
                      <button className="btn btn-ghost btn-sm" disabled={busy === u.id} onClick={() => remove(u)} style={{ color: 'var(--danger,#ef4444)' }}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      {view && <UserModal u={view} onClose={() => setView(null)} />}
    </>
  );
}

function SecretsManager() {
  const toast = useToast();
  const [secrets, setSecrets] = useState<SecretStatus[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.adminSecrets().then(setSecrets).catch((e) => { toast(e.message, 'error'); setSecrets([]); });
  useEffect(() => { load(); }, []); // eslint-disable-line

  const save = async (s: SecretStatus) => {
    const value = (drafts[s.name] || '').trim();
    if (!value) { toast('Paste a value first', 'error'); return; }
    setBusy(s.name);
    try {
      await api.adminSetSecret(s.name, value);
      setDrafts((d) => ({ ...d, [s.name]: '' }));
      toast(`${s.label} saved (encrypted)`, 'success');
      load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  const remove = async (s: SecretStatus) => {
    if (!window.confirm(`Delete the saved ${s.label}? It reverts to the environment value (if any).`)) return;
    setBusy(s.name);
    try { await api.adminDeleteSecret(s.name); toast(`${s.label} deleted`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  const badge = (s: SecretStatus) => {
    if (s.source === 'saved') return <span className="badge badge-ats meta-item" title={s.updatedAt ? `Updated ${fmtDate(s.updatedAt)}` : ''}><Icon name="shield" size={12} /> Saved</span>;
    if (s.source === 'env') return <span className="badge meta-item" style={{ background: 'var(--card2,#1a1f2b)' }}><Icon name="gear" size={12} /> From env</span>;
    return <span className="badge" style={{ color: 'var(--text-faint,#7d8595)' }}>Not set</span>;
  };

  if (secrets === null) return <div className="card card-pad" style={{ marginBottom: 16 }}><span className="spinner" /></div>;
  const groups = [...new Set(secrets.map((s) => s.group))];

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div className="meta-item" style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}><Icon name="shield" size={16} /> API keys &amp; secrets</div>
      <div className="faint" style={{ fontSize: 12.5, marginBottom: 14 }}>
        Stored AES-256 encrypted. Values are <b>write-only</b> — once saved they can’t be viewed, only replaced or deleted.
        A saved value overrides the matching environment variable.
      </div>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 16 }}>
          <div className="faint" style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>{g}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {secrets.filter((s) => s.group === g).map((s) => (
              <div key={s.name} className="repeat-row" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{s.label} <span className="faint" style={{ fontWeight: 400, fontSize: 11.5 }}>({s.name})</span></div>
                  {badge(s)}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input" type="password" autoComplete="new-password" style={{ flex: 1 }}
                    placeholder={s.configured ? 'Enter a new value to replace…' : 'Paste the key…'}
                    value={drafts[s.name] || ''} onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') save(s); }} />
                  <button className="btn btn-primary btn-sm" disabled={busy === s.name} onClick={() => save(s)}>
                    {busy === s.name ? <span className="spinner" /> : 'Save'}
                  </button>
                  {s.source === 'saved' && (
                    <button className="btn btn-ghost btn-sm" disabled={busy === s.name} onClick={() => remove(s)}
                      style={{ color: 'var(--danger,#ef4444)' }} title="Delete saved value"><Icon name="trash" size={14} /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
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
