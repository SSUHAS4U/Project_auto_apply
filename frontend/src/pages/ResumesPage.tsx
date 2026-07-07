import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type ResumeDoc } from '../api/client';
import { Modal } from '../components/Modal';
import { fmtDate, useToast } from '../lib/ui';

/**
 * Overleaf-style LaTeX resume builder:
 * left — your named resumes (base + per-JD tailored copies);
 * right — LaTeX editor with compile-to-PDF preview (free texlive.net service).
 */
export function ResumesPage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const [docs, setDocs] = useState<ResumeDoc[]>([]);
  const [sel, setSel] = useState<ResumeDoc | null>(null);
  const [name, setName] = useState('');
  const [latex, setLatex] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [tailorOpen, setTailorOpen] = useState(false);
  const [jdName, setJdName] = useState('');
  const [jdUrl, setJdUrl] = useState('');
  const [jdText, setJdText] = useState('');
  const pdfUrlRef = useRef('');

  const setPreview = (blob: Blob | null) => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    const url = blob ? URL.createObjectURL(blob) : '';
    pdfUrlRef.current = url;
    setPdfUrl(url);
  };

  const pick = (d: ResumeDoc) => {
    setSel(d);
    setName(d.name);
    setLatex(d.latex);
    setDirty(false);
    setPreview(null);
    if (d.hasPdf) {
      api.resumePdf(d.id).then(setPreview).catch(() => {});
    }
  };

  const load = (selectId?: string) =>
    api.resumeList().then((list) => {
      setDocs(list);
      const want = selectId ?? params.get('id') ?? sel?.id;
      const d = list.find((x) => x.id === want) ?? list[0];
      if (d) pick(d);
      else { setSel(null); setName(''); setLatex(''); }
      return list;
    }).catch((e) => toast(e.message, 'error'));

  useEffect(() => { load(); }, []); // eslint-disable-line

  const create = async (blank: boolean) => {
    setBusy('create');
    try {
      const d = await api.resumeCreate({
        name: blank ? 'Blank resume' : 'My resume',
        blank: blank ? 'true' : 'false',
      });
      toast(blank ? 'Blank resume created' : 'Starter resume created from your profile', 'success');
      await load(d.id);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const duplicate = async () => {
    if (!sel) return;
    setBusy('dup');
    try {
      const d = await api.resumeCreate({ name: `${sel.name} (copy)`, fromId: sel.id });
      toast('Duplicated', 'success');
      await load(d.id);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const save = async () => {
    if (!sel) return;
    setBusy('save');
    try {
      await api.resumeUpdate(sel.id, { name, latex });
      setDirty(false);
      toast('Saved', 'success');
      await load(sel.id);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const compile = async () => {
    if (!sel) return;
    setBusy('compile');
    try {
      if (dirty) { await api.resumeUpdate(sel.id, { name, latex }); setDirty(false); }
      const blob = await api.resumeCompile(sel.id);
      setPreview(blob);
      toast('Compiled ✓', 'success');
      await load(sel.id);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  const download = async () => {
    if (!sel) return;
    try {
      const blob = pdfUrl ? await (await fetch(pdfUrl)).blob() : await api.resumePdf(sel.id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[^A-Za-z0-9 _-]/g, '') || 'resume'}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const setBase = async () => {
    if (!sel) return;
    try { await api.resumeSetBase(sel.id); toast('Set as base resume ✓', 'success'); await load(sel.id); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const remove = async () => {
    if (!sel) return;
    if (!confirm(`Delete "${sel.name}"? This cannot be undone.`)) return;
    try { await api.resumeDelete(sel.id); toast('Deleted', 'success'); setSel(null); await load(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const tailor = async () => {
    if (!jdText.trim()) { toast('Paste the job description first', 'error'); return; }
    setBusy('tailor');
    try {
      const d = await api.resumeTailor({ name: jdName || 'Tailored resume', jobUrl: jdUrl, jdText });
      setTailorOpen(false);
      setJdName(''); setJdUrl(''); setJdText('');
      toast('Tailored copy created from your base resume ✓ — review, then compile', 'success');
      await load(d.id);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Resumes <span className="chip">LaTeX → PDF</span></h1>
          <div className="page-sub">
            Your base resume plus per-JD tailored copies. Edit the LaTeX, compile to PDF (free
            texlive.net), and the extension will ask which one to upload on every application.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => create(true)} disabled={!!busy}>＋ Blank</button>
          <button className="btn btn-primary" onClick={() => create(false)} disabled={!!busy}>
            {busy === 'create' ? <span className="spinner" /> : '＋'} From profile
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 14, alignItems: 'start' }}>
        {/* ---- document list ---- */}
        <div className="card" style={{ overflow: 'hidden' }}>
          {docs.length === 0 && (
            <div className="card-pad faint" style={{ fontSize: 13 }}>
              No resumes yet — create one from your profile or start blank.
            </div>
          )}
          {docs.map((d) => (
            <div key={d.id} onClick={() => pick(d)}
              style={{
                padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                background: sel?.id === d.id ? 'var(--card2, rgba(99,102,241,.12))' : 'transparent',
                borderLeft: sel?.id === d.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                {d.base && <span title="Base resume">⭐</span>}
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                {d.hasPdf ? '📄 PDF ready' : '— not compiled'} · {d.updatedAt ? fmtDate(d.updatedAt) : ''}
              </div>
            </div>
          ))}
        </div>

        {/* ---- editor + preview ---- */}
        {sel ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ width: 260 }} value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="Resume name" />
              <button className="btn" onClick={save} disabled={!!busy || !dirty}>
                {busy === 'save' ? <span className="spinner" /> : '💾'} Save
              </button>
              <button className="btn btn-primary" onClick={compile} disabled={!!busy}>
                {busy === 'compile' ? <span className="spinner" /> : '⚙'} Compile → PDF
              </button>
              <button className="btn" onClick={download} disabled={!pdfUrl && !sel.hasPdf}>⬇ PDF</button>
              <button className="btn" onClick={() => setTailorOpen(true)}>🧵 Tailor to a JD</button>
              <span style={{ marginLeft: 'auto' }} />
              {!sel.base && <button className="btn btn-ghost btn-sm" onClick={setBase}>⭐ Set as base</button>}
              <button className="btn btn-ghost btn-sm" onClick={duplicate} disabled={!!busy}>⧉ Duplicate</button>
              <button className="btn btn-ghost btn-sm" onClick={remove} style={{ color: 'var(--red, #f87171)' }}>🗑</button>
            </div>
            {sel.jobUrl && (
              <div className="faint" style={{ fontSize: 12 }}>
                Tailored for: <a href={sel.jobUrl} target="_blank" rel="noreferrer">{sel.jobUrl}</a>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: pdfUrl ? '1fr 1fr' : '1fr', gap: 10, minHeight: 520 }}>
              <textarea
                value={latex}
                onChange={(e) => { setLatex(e.target.value); setDirty(true); }}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 520, resize: 'vertical',
                  fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5, lineHeight: 1.5,
                  background: 'var(--card, #161a23)', color: 'var(--text, #e7e9ee)',
                  border: '1px solid var(--border, #2b3243)', borderRadius: 10, padding: 12, outline: 'none',
                }} />
              {pdfUrl && (
                <iframe title="PDF preview" src={pdfUrl}
                  style={{ width: '100%', minHeight: 520, border: '1px solid var(--border, #2b3243)', borderRadius: 10, background: '#fff' }} />
              )}
            </div>
            {dirty && <div className="faint" style={{ fontSize: 12 }}>Unsaved changes — Save or Compile (compiling saves first).</div>}
          </div>
        ) : (
          <div className="card card-pad empty">
            <div className="big">📄</div>
            Create your first resume — <b>From profile</b> gives you a compilable one-page LaTeX
            starter filled with your details; <b>Blank</b> gives a minimal skeleton.
          </div>
        )}
      </div>

      {tailorOpen && (
        <Modal title="Tailor base resume to a job description" onClose={() => setTailorOpen(false)} wide
          footer={
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setTailorOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={tailor} disabled={busy === 'tailor'}>
                {busy === 'tailor' ? <span className="spinner" /> : '🧵'} Create tailored copy
              </button>
            </div>
          }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="faint" style={{ fontSize: 13 }}>
              The AI rewrites a COPY of your base resume (⭐) to emphasise this JD — it never
              invents experience. Your base stays untouched.
            </div>
            <input className="input" placeholder="Name for this copy (e.g. 'Backend – Razorpay')"
              value={jdName} onChange={(e) => setJdName(e.target.value)} />
            <input className="input" placeholder="Job posting URL (optional)"
              value={jdUrl} onChange={(e) => setJdUrl(e.target.value)} />
            <textarea className="input" rows={10} placeholder="Paste the full job description here…"
              value={jdText} onChange={(e) => setJdText(e.target.value)}
              style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </Modal>
      )}
    </>
  );
}
