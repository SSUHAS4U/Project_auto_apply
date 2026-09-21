import { useEffect, useMemo, useState } from 'react';
import { api, type ScoutedJob } from '../api/client';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { JobCardV2 } from '../components/JobCardV2';
import { useProfileSkills } from '../lib/useProfileSkills';

/**
 * The sources a scouted listing can actually carry.
 *
 * "Google" was in this list with no connector behind it, and Naukri/Indeed were here because
 * the aggregators were believed to deep-link to them. They do not — Jooble returns its own
 * redirect and names the real board separately, which is now what fills this filter. A
 * dropdown entry that can never match anything is a broken filter, not a feature.
 */
const SITE_META: Record<string, { label: string }> = {
  linkedin: { label: 'LinkedIn' },
  jooble: { label: 'Jooble' },
  careerjet: { label: 'Careerjet' },
  other: { label: 'Other boards' },
};

export function ScoutPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<ScoutedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [site, setSite] = useState('');
  const [withContacts, setWithContacts] = useState(false);
  const skills = useProfileSkills();

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

  const presentSites = useMemo(
    () => Array.from(new Set(jobs.map((j) => j.sourceSite).filter(Boolean) as string[])).sort(),
    [jobs]);

  const copy = (v: string) => { navigator.clipboard.writeText(v); toast('Copied', 'success'); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Scout <span className="chip">auto · hourly</span></h1>
          <div className="page-sub">
            Fresh listings found automatically every hour, using keywords scanned from your whole
            profile (role, experience level, skills) — from LinkedIn&apos;s public search (direct
            links) and the Jooble aggregator (a long tail of smaller boards) — with any contact
            details mined from the posting.
          </div>
        </div>
        <button className="btn btn-primary" onClick={runNow} disabled={running}>
          {running ? <span className="spinner" /> : <Icon name="search" size={14} />} Scout now
        </button>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Built from the sources PRESENT in the results, falling back to the known set, so
            the filter can never offer an option that matches nothing. */}
        <select className="select" style={{ width: 170 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sources</option>
          {presentSites.map((k) => <option key={k} value={k}>{SITE_META[k]?.label ?? k}</option>)}
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
            <div className="big"><Icon name="search" size={34} /></div>
            Nothing scouted yet. Click <b>Scout now</b> — results also arrive automatically every hour.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filtered.map((j) => {
              const meta = SITE_META[j.sourceSite ?? 'other'] ?? SITE_META.other;
              const emails = j.emails?.split(',').map((e) => e.trim()).filter(Boolean) ?? [];
              const phones = j.phones?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
              return (
                <JobCardV2 key={j.id}
                  title={j.title}
                  company={j.company}
                  location={j.location}
                  description={j.snippet}
                  url={j.url}
                  source={j.sourceSite ?? meta.label}
                  postedLabel={j.fetchedAt ? `seen ${fmtDate(j.fetchedAt)}` : j.postedHint}
                  score={typeof j.matchScore === 'number' ? j.matchScore : undefined}
                  skills={skills}
                  extras={<>
                    {emails.map((e) => (
                      <a key={e} className="btn btn-icon" href={`mailto:${e}`} title={`Email ${e}`}><Icon name="mail" size={14} /></a>
                    ))}
                    {phones.map((ph) => (
                      <button key={ph} className="btn btn-icon" onClick={() => copy(ph)} title={`Copy ${ph}`}><Icon name="phone" size={14} /></button>
                    ))}
                    <button className="btn btn-icon" onClick={() => remove(j.id)} title="Remove"><Icon name="x" size={14} /></button>
                  </>}
                  actions={<a className="btn btn-primary" href={j.url} target="_blank" rel="noreferrer">Open &amp; apply <Icon name="external" size={13} /></a>} />
              );
            })}
          </div>
        )}
    </>
  );
}
