import { useEffect, useMemo, useState } from 'react';
import { api, type ScoutedJob } from '../api/client';
import { fmtDate, useToast } from '../lib/ui';

const SITE_META: Record<string, { label: string; color: string }> = {
  linkedin: { label: 'LinkedIn', color: '#0a66c2' },
  naukri: { label: 'Naukri', color: '#2557a7' },
  indeed: { label: 'Indeed', color: '#7a5af8' },
  google: { label: 'Google', color: '#34a853' },
  jooble: { label: 'Jooble', color: '#8a3ffc' },
  careerjet: { label: 'Careerjet', color: '#f97316' },
  other: { label: 'Web', color: '#64748b' },
};

export function ScoutPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<ScoutedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [site, setSite] = useState('');
  const [withContacts, setWithContacts] = useState(false);

  const load = () => {
    setLoading(true);
    api.scoutJobs().then(setJobs).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.scoutRun();
      const sites = Object.entries(r.bySite ?? {}).map(([k, v]) => `${k} +${v}`).join(' · ');
      toast(`Scout done — ${r.kept} new of ${r.found} found${sites ? ` (${sites})` : ''}`, 'success');
      for (const [ch, status] of Object.entries(r.channels ?? {})) {
        if (status.startsWith('error')) toast(`${ch} channel failed: ${status.slice(0, 140)}`, 'error');
        else if (status === 'not configured') toast(`${ch} is not configured — add its key in Admin → API keys`, 'error');
      }
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const remove = async (id: string) => {
    try { await api.scoutDelete(id); setJobs((js) => js.filter((j) => j.id !== id)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const filtered = useMemo(() => jobs.filter((j) =>
    (!site || j.sourceSite === site) && (!withContacts || j.emails || j.phones)), [jobs, site, withContacts]);

  const copy = (v: string) => { navigator.clipboard.writeText(v); toast('Copied', 'success'); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Scout <span className="chip">auto · hourly</span></h1>
          <div className="page-sub">
            Fresh listings found automatically every hour, using keywords scanned from your whole
            profile (role, experience level, skills) across LinkedIn, Naukri, Indeed &amp; the web —
            with any contact details mined from the posting.
          </div>
        </div>
        <button className="btn btn-primary" onClick={runNow} disabled={running}>
          {running ? <span className="spinner" /> : '🔎'} Scout now
        </button>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 160 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sources</option>
          {Object.entries(SITE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <label className="row" style={{ gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={withContacts} onChange={(e) => setWithContacts(e.target.checked)} />
          Has contact details
        </label>
        <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {filtered.length} listing{filtered.length === 1 ? '' : 's'} · refreshed automatically every hour
        </span>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : filtered.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">🔎</div>
            Nothing scouted yet. Click <b>Scout now</b> — results also arrive automatically every hour.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filtered.map((j) => {
              const meta = SITE_META[j.sourceSite ?? 'other'] ?? SITE_META.other;
              return (
                <div key={j.id} className="card card-pad">
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <a href={j.url} target="_blank" rel="noreferrer" className="pick-title" style={{ textDecoration: 'none' }}>
                        {j.title} ↗
                      </a>
                      <div className="job-company" style={{ marginTop: 4, fontSize: 13 }}>
                        <span className="chip" style={{ background: meta.color + '22', color: meta.color, borderColor: meta.color + '55' }}>
                          {meta.label}
                        </span>
                        {j.company && <> · {j.company}</>}
                        {j.location && <> · {j.location}</>}
                        {j.postedHint && <> · <span className="faint">{j.postedHint}</span></>}
                        {j.fetchedAt && <> · <span className="faint">seen {fmtDate(j.fetchedAt)}</span></>}
                      </div>
                    </div>
                    {typeof j.matchScore === 'number' && (
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div className="score" style={{ fontSize: 18 }}>{j.matchScore}</div>
                        <div className="faint" style={{ fontSize: 10.5, letterSpacing: '.04em' }}>MATCH</div>
                      </div>
                    )}
                  </div>

                  {j.snippet && <div className="job-desc" style={{ marginTop: 10, fontSize: 13 }}>{j.snippet}</div>}

                  <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
                    {j.emails?.split(',').map((e) => e.trim()).filter(Boolean).map((e) => (
                      <a key={e} className="btn btn-sm" href={`mailto:${e}`} title="Email this contact">✉ {e}</a>
                    ))}
                    {j.phones?.split(',').map((p) => p.trim()).filter(Boolean).map((p) => (
                      <button key={p} className="btn btn-sm" onClick={() => copy(p)} title="Copy number">📞 {p}</button>
                    ))}
                    {j.matchedKeywords && (
                      <span className="faint" style={{ fontSize: 12 }}>matched: {j.matchedKeywords}</span>
                    )}
                    <span style={{ marginLeft: 'auto' }} />
                    <a className="btn btn-primary btn-sm" href={j.url} target="_blank" rel="noreferrer">Open &amp; apply ↗</a>
                    <button className="btn btn-ghost btn-sm" onClick={() => remove(j.id)} title="Remove from scout list">✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </>
  );
}
