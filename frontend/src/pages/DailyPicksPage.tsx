import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Job } from '../types';
import { ApplyBadge, fmtDate, useToast } from '../lib/ui';
import { JobCardV2 } from '../components/JobCardV2';
import { useProfileSkills } from '../lib/useProfileSkills';
import { Icon } from '../components/Icon';

export function DailyPicksPage() {
  const toast = useToast();
  const [briefing, setBriefing] = useState('');
  const [generatedAt, setGeneratedAt] = useState<string | undefined>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const skills = useProfileSkills();

  const load = () => {
    setLoading(true);
    api.dailyPicks()
      .then((r) => { setBriefing(r.briefing); setGeneratedAt(r.generatedAt); setJobs(r.jobs); })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.dailyRun();
      if (r.status === 'busy') { toast('A run is already in progress…', 'info'); setRunning(false); return; }
      toast('Daily run started — fetching jobs & curating picks…', 'success');
      const poll = setInterval(async () => {
        try {
          const st = await api.opsStatus();
          if (!st.running) { clearInterval(poll); setRunning(false); load(); toast(st.last, 'success'); }
        } catch { clearInterval(poll); setRunning(false); }
      }, 5000);
    } catch (e) { toast((e as Error).message, 'error'); setRunning(false); }
  };

  const track = async (j: Job) => {
    try { await api.trackJob(j.id); toast(`Tracking “${j.title}”`, 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Daily picks <span className="chip">AI-curated</span></h1>
          <div className="page-sub">
            Reviewed separately from the main board. Verify each role, then apply yourself.
            {generatedAt && <> · updated {fmtDate(generatedAt)}</>}
          </div>
        </div>
        <button className="btn btn-primary" onClick={runNow} disabled={running}>
          {running ? <span className="spinner" /> : '⟳'} Run now
        </button>
      </div>

      {briefing && (
        <div className="card card-pad" style={{ marginBottom: 18, borderLeft: '3px solid var(--accent)' }}>
          <div className="section-title" style={{ marginBottom: 8 }}><span className="si"><Icon name="bot" size={15} /></span>Today's briefing</div>
          <div className="pre" style={{ background: 'transparent', border: 'none', padding: 0 }}>{briefing}</div>
        </div>
      )}

      {loading ? <div className="empty"><span className="spinner" /></div>
        : jobs.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big"><Icon name="sun" size={34} /></div>
            No picks yet. They generate every morning at 9:00, or click <b>Run now</b>.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {jobs.map((j) => (
              <JobCardV2 key={j.id}
                title={j.title}
                company={j.company}
                location={j.location}
                remote={j.remote}
                description={j.description}
                source={j.source}
                url={j.url}
                score={j.matchScore}
                salaryText={j.salaryText}
                skills={skills}
                extras={<ApplyBadge type={j.applyType} />}
                actions={<>
                  <a className="btn btn-primary btn-sm" href={j.url} target="_blank" rel="noreferrer">Open &amp; apply ↗</a>
                  <button className="btn btn-sm" onClick={() => track(j)}>Track</button>
                </>} />
            ))}
          </div>
        )}
    </>
  );
}
