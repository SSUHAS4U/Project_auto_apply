import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type ResumeDoc } from '../api/client';
import { Modal } from '../components/Modal';
import { fmtDate, useToast } from '../lib/ui';

/**
 * Overleaf-style workbench: files panel · LaTeX editor · live PDF preview.
 * Desktop: three panes with a draggable splitter. Mobile: the files panel is a
 * drawer and Code/PDF are switched with a segmented control.
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
  const [filesOpen, setFilesOpen] = useState(false);   // mobile drawer
  const [mobileTab, setMobileTab] = useState<'code' | 'pdf'>('code');
  const [notesOpen, setNotesOpen] = useState(true);
  const [pdfPct, setPdfPct] = useState(46);            // preview pane width %
  const [tailorOpen, setTailorOpen] = useState(false);
  const [jdName, setJdName] = useState('');
  const [jdUrl, setJdUrl] = useState('');
  const [jdText, setJdText] = useState('');
  const pdfUrlRef = useRef('');
  const bodyRef = useRef<HTMLDivElement>(null);

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
    setNotesOpen(true);
    setFilesOpen(false);
    setPreview(null);
    if (d.hasPdf) api.resumePdf(d.id).then(setPreview).catch(() => {});
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
      setMobileTab('pdf');
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
      toast('Tailored copy created ✓ — see "What changed", then compile', 'success');
      await load(d.id);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  // Splitter drag (desktop). Two subtleties: the PDF iframe swallows mousemove the
  // instant the cursor crosses it (drag would freeze) — an .ov-dragging class turns
  // its pointer-events off for the duration; and updates are rAF-throttled so the
  // pane resizes once per frame instead of once per pixel.
  const dragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    document.body.classList.add('ov-dragging');
    let lastX = e.clientX;
    let raf = 0;
    const applyX = () => {
      raf = 0;
      const r = body.getBoundingClientRect();
      const pct = ((r.right - lastX) / r.width) * 100;
      setPdfPct(Math.min(72, Math.max(18, pct)));
    };
    const onMove = (ev: MouseEvent) => {
      lastX = ev.clientX;
      if (!raf) raf = requestAnimationFrame(applyX);
    };
    const onUp = () => {
      document.body.classList.remove('ov-dragging');
      if (raf) cancelAnimationFrame(raf);
      applyX();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const B = ({ id, label, ico, onClick, disabled, cls, title }: {
    id?: string; label: string; ico: string; onClick: () => void;
    disabled?: boolean; cls?: string; title?: string;
  }) => (
    <button className={`ov-btn ${cls ?? ''}`} onClick={onClick} disabled={disabled} title={title ?? label}>
      {busy === id ? <span className="spinner" /> : ico}<span className="ov-label">{label}</span>
    </button>
  );

  // Editor shortcuts: Ctrl/Cmd+S saves, Ctrl/Cmd+Enter compiles.
  const onKey = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !sel) return;
    if (e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty && !busy) save(); }
    if (e.key === 'Enter') { e.preventDefault(); if (!busy) compile(); }
  };

  return (
    <div className="ov" onKeyDown={onKey}>
      {/* ---- toolbar ---- */}
      <div className="ov-top">
        <button className="ov-btn ov-files-btn" onClick={() => setFilesOpen((v) => !v)} title="Your resumes">☰<span className="ov-label">Files</span></button>
        {sel ? (
          <>
            <input className="ov-name" value={name} placeholder="Resume name"
              onChange={(e) => { setName(e.target.value); setDirty(true); }} />
            <B id="save" label={dirty ? 'Save*' : 'Save'} ico="💾" onClick={save} disabled={!!busy || !dirty} />
            <B id="compile" label="Recompile" ico="▶" cls="green" onClick={compile} disabled={!!busy} />
            <B label="PDF" ico="⬇" onClick={download} disabled={!pdfUrl && !sel.hasPdf} title="Download PDF" />
            <B label="Tailor" ico="🧵" onClick={() => setTailorOpen(true)} title="Tailor to a job description" />
            <span style={{ flex: 1 }} />
            {!sel.base && <B label="Base" ico="⭐" onClick={setBase} title="Make this the base resume" />}
            <B id="dup" label="Copy" ico="⧉" onClick={duplicate} disabled={!!busy} title="Duplicate" />
            <B label="" ico="🗑" cls="danger" onClick={remove} title="Delete" />
            <div className="ov-seg">
              <button className={mobileTab === 'code' ? 'on' : ''} onClick={() => setMobileTab('code')}>Code</button>
              <button className={mobileTab === 'pdf' ? 'on' : ''} onClick={() => setMobileTab('pdf')}>PDF</button>
            </div>
          </>
        ) : <span className="faint" style={{ fontSize: 13 }}>Create a resume to start editing</span>}
      </div>

      {/* ---- body ---- */}
      <div className="ov-body" ref={bodyRef}>
        <aside className={`ov-files ${filesOpen ? 'open' : ''}`}>
          <div className="ov-files-head">
            Resumes
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="ov-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => create(true)} disabled={!!busy} title="New blank resume">＋ Blank</button>
              <button className="ov-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => create(false)} disabled={!!busy} title="Starter pre-filled from your profile">＋ Profile</button>
            </span>
          </div>
          <div className="ov-files-list">
            {docs.length === 0 && (
              <div className="faint" style={{ padding: 14, fontSize: 12.5 }}>
                No resumes yet — create one from your profile, or blank.
              </div>
            )}
            {docs.map((d) => (
              <div key={d.id} className={`ov-file ${sel?.id === d.id ? 'sel' : ''}`} onClick={() => pick(d)}>
                <div className="ov-file-name">📄<span>{d.name}</span>{d.base && <span title="Base resume">⭐</span>}</div>
                <div className="ov-file-sub">
                  {d.hasPdf ? 'PDF ready' : 'not compiled'}{d.updatedAt ? ` · ${fmtDate(d.updatedAt)}` : ''}
                </div>
              </div>
            ))}
          </div>
        </aside>
        {filesOpen && <div className="ov-scrim" onClick={() => setFilesOpen(false)} />}

        {sel ? (
          <>
            <section className={`ov-edit ${mobileTab === 'pdf' ? 'hide' : ''}`}>
              {sel.tailorNotes && (
                <div className="ov-notes">
                  <div className="ov-notes-head" onClick={() => setNotesOpen((v) => !v)}>
                    🧵 What the AI changed for this JD {notesOpen ? '▾' : '▸'}
                    {sel.jobUrl && (
                      <a href={sel.jobUrl} target="_blank" rel="noreferrer"
                        style={{ marginLeft: 'auto', fontWeight: 500, fontSize: 12 }}
                        onClick={(e) => e.stopPropagation()}>job posting ↗</a>
                    )}
                  </div>
                  {notesOpen && <pre>{sel.tailorNotes}</pre>}
                </div>
              )}
              <textarea className="ov-code" value={latex} spellCheck={false}
                onChange={(e) => { setLatex(e.target.value); setDirty(true); }} />
            </section>
            <div className="ov-divider" onMouseDown={dragStart} onDoubleClick={() => setPdfPct(46)}
              title="Drag to resize · double-click to reset" />
            <section className={`ov-view ${mobileTab === 'code' ? 'hide' : ''}`} style={{ width: `${pdfPct}%` }}>
              {pdfUrl
                ? <iframe title="PDF preview" src={pdfUrl} />
                : <div className="ov-empty">No PDF yet — hit <b style={{ color: '#7ee787' }}>▶ Recompile</b> to build one from the LaTeX source.</div>}
            </section>
          </>
        ) : (
          <section className="ov-edit">
            <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
              <div className="big">📄</div>
              <b>＋ Profile</b> gives you a compilable one-page LaTeX starter pre-filled with your
              details; <b>＋ Blank</b> gives a minimal skeleton. Same LaTeX as Overleaf.
            </div>
          </section>
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
              The AI rewrites a COPY of your base resume (⭐) for this JD — reordering skills and
              bullets, mirroring the JD's keywords where you genuinely have them, never inventing
              experience. You'll get a "What changed" report on the copy. Your base stays untouched.
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
    </div>
  );
}
