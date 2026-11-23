import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ResumeDoc } from '../api/client';
import { Icon } from './Icon';
import { fmtDate, useToast } from '../lib/ui';
import { isDesktopApp } from '../lib/desktop';

/**
 * Profile → Résumé: the ONE résumé library. Files uploaded here and résumés built in
 * Documents → Resumes are rows of the same table (resume_doc), so a résumé made in either
 * place shows in both, and Compose offers all of them when you send.
 *
 * Each résumé names the role it targets, which is how Compose suggests the right one for a
 * job. One is the default — the file the auto-apply worker and the extension attach.
 */
export function ResumeLibrary({ onDefaultChange }: { onDefaultChange?: (filename: string) => void }) {
  const toast = useToast();
  const [items, setItems] = useState<ResumeDoc[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.resumeList()
    .then((list) => { setItems(list); setLoadError(''); })
    .catch((e) => setLoadError((e as Error).message));
  useEffect(() => { load(); }, []);

  const upload = async (file?: File) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setBusy('upload');
    try {
      const d = await api.resumeUpload(file, role.trim());
      setRole('');
      toast(d.defaultResume ? `"${d.name}" added — it's your default résumé` : `"${d.name}" added for ${d.role}`, 'success');
      if (d.defaultResume) onDefaultChange?.(d.filename ?? d.name);
      await load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const saveRole = async (d: ResumeDoc) => {
    setBusy(d.id);
    try {
      await api.resumeUpdate(d.id, { role: roleDraft.trim() });
      setEditing(null);
      await load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const makeDefault = async (d: ResumeDoc) => {
    setBusy(d.id);
    try {
      const r = await api.resumeMakeDefault(d.id);
      toast(`"${d.name}" is now your default résumé`, 'success');
      onDefaultChange?.(r.filename ?? `${d.name}.pdf`);
      await load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const remove = async (d: ResumeDoc) => {
    setBusy(d.id);
    try {
      await api.resumeDelete(d.id);
      setConfirmDelete(null);
      toast(`"${d.name}" deleted`, 'success');
      await load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const view = async (d: ResumeDoc) => {
    // In the desktop app a blob: URL can't open a window (the shell only opens http/https),
    // so there it downloads; in a browser it opens in a new tab.
    const win = isDesktopApp() ? null : window.open('', '_blank');
    try {
      const blob = await api.resumePdf(d.id);
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = d.filename || `${d.name.replace(/[^A-Za-z0-9 _-]/g, '') || 'resume'}.pdf`;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      toast((e as Error).message, 'error');
    }
  };

  const roleMissing = !role.trim();

  return (
    <section className="card pf-sec">
      <div className="pf-sec-h">
        <span className="pf-sec-ic"><Icon name="file" size={15} /></span>
        <div className="pf-sec-t">
          <h3>Résumé library</h3>
          <div className="pf-sec-sub">Upload one per role. Résumés you build in Documents → Resumes appear here too, and Compose asks which one to send.</div>
        </div>
      </div>
      <div className="pf-sec-b rl">
        <div className="rl-add">
          <label className="field rl-role">Role this résumé is for
            <input className="input" value={role} onChange={(e) => setRole(e.target.value)} maxLength={120}
              placeholder="e.g. Java Backend Developer" onKeyDown={(e) => { if (e.key === 'Enter' && !roleMissing) fileRef.current?.click(); }} />
          </label>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={roleMissing || busy === 'upload'}
            title={roleMissing ? 'Name the role first — Compose uses it to suggest this résumé' : 'Choose a PDF or Word file'}>
            {busy === 'upload' ? <span className="spinner" /> : <Icon name="plus" size={14} />} Upload résumé
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,application/pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </div>
        {roleMissing && <div className="field-hint" style={{ marginTop: 6 }}>Name the role first — Compose uses it to suggest the right résumé for each job. PDF or Word, up to 10 MB.</div>}

        <div className="rl-list">
          {items === null && !loadError && <div className="list-empty"><span className="spinner" /> Loading your résumés…</div>}
          {loadError && (
            <div className="list-empty" role="alert">
              <Icon name="alert" size={14} /> Couldn't load your résumés: {loadError}
              <button className="btn btn-sm" onClick={load} style={{ marginLeft: 'auto' }}><Icon name="refresh" size={13} /> Retry</button>
            </div>
          )}
          {items?.length === 0 && (
            <div className="list-empty">
              <Icon name="file" size={14} /> No résumés yet. Name a role above and upload one, or build one in&nbsp;<Link to="/resumes">Documents → Resumes</Link>.
            </div>
          )}
          {items?.map((d) => {
            const uploaded = d.source === 'uploaded' || d.uploaded;
            return (
              <div key={d.id} className="rl-row">
                <span className="list-ico" style={{ background: 'var(--sunken)', color: 'var(--text-dim)' }}><Icon name={uploaded ? 'file' : 'pen'} size={15} /></span>
                <div className="list-body">
                  <div className="rl-name">
                    <span className="list-t" title={d.name}>{d.name}</span>
                    {d.defaultResume && <span className="chip chip-ok"><Icon name="check" size={11} /> Default</span>}
                  </div>
                  {editing === d.id ? (
                    <div className="rl-edit">
                      <input className="input" autoFocus value={roleDraft} maxLength={120} placeholder="Role, e.g. Data Analyst"
                        onChange={(e) => setRoleDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveRole(d); if (e.key === 'Escape') setEditing(null); }} />
                      <button className="btn btn-sm" onClick={() => saveRole(d)} disabled={busy === d.id}>Save</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="list-s">
                      <button className="rl-role-btn" onClick={() => { setEditing(d.id); setRoleDraft(d.role ?? ''); }} title="Change the role">
                        {d.role ? d.role : <i>No role — add one</i>} <Icon name="pen" size={11} />
                      </button>
                      {' · '}{uploaded ? 'Uploaded' : 'Built in Documents'}
                      {!d.hasPdf && ' · not compiled yet'}
                      {d.updatedAt ? ` · ${fmtDate(d.updatedAt)}` : ''}
                    </div>
                  )}
                </div>
                <div className="rl-acts">
                  {confirmDelete === d.id ? (
                    <>
                      <span className="faint" style={{ fontSize: 12.5 }}>Delete{uploaded ? '' : ' from Documents too'}?</span>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(d)} disabled={busy === d.id}>Delete</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      {d.hasPdf
                        ? <button className="btn btn-sm btn-ghost" onClick={() => view(d)} title="Open the file"><Icon name="eye" size={14} /><span className="rl-lbl">View</span></button>
                        : <Link className="btn btn-sm btn-ghost" to={`/resumes?id=${d.id}`} title="Open it in the editor and press Recompile"><Icon name="external" size={13} /><span className="rl-lbl">Compile</span></Link>}
                      {!d.defaultResume && d.hasPdf && (
                        <button className="btn btn-sm" onClick={() => makeDefault(d)} disabled={busy === d.id} title="Attach this one when nothing else is chosen">
                          {busy === d.id ? <span className="spinner" /> : <Icon name="star" size={13} />}<span className="rl-lbl">Make default</span>
                        </button>
                      )}
                      <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(d.id)} title="Delete" aria-label={`Delete ${d.name}`}
                        style={{ color: 'var(--danger)' }}><Icon name="trash" size={14} /></button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
