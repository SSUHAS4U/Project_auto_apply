// The decision gates: what gets applied to, and who gets contacted.
//
// Both portals used to apply to anything scoring 25+ on keyword overlap, which is how a Python
// role reached a Java/MERN résumé and got submitted. Outreach had no gate at all — every /in/
// link on a search page was invited or messaged. These two helpers are the ONLY place either
// decision is made, so LinkedIn and Indeed can't drift apart.

/** Default when the backend didn't send one (older plan payloads). */
// Matches the backend default. Only used when an older plan payload omits fitMin — the
// setting in Schedule is the real control.
const DEFAULT_FIT_MIN = 50;
const DEFAULT_PERSON_CONF = 80;

/**
 * Should we apply to this posting?
 *
 * Returns { ok, score, techMatch, reason, label } — `label` is the one-line explanation shown
 * in the terminal so every skip says WHY, instead of the job silently vanishing.
 */
export async function shouldApply(api, post, plan = {}) {
  const min = Number(plan.fitMin ?? DEFAULT_FIT_MIN);
  const description = post.description || '';

  // Nothing to judge: the description is the evidence. Applying blind is the behaviour we're
  // removing, so this becomes a manual lead rather than an automatic submit.
  if (description.trim().length < 80) {
    return { ok: false, score: 0, techMatch: false, manual: true,
      reason: 'could not read the job description', label: 'no description to judge' };
  }

  // Rate limits are TEMPORARY, and a job verdict is not urgent. Both free tiers refill on a
  // per-minute window, so waiting beats giving up: a real run pushed 24 consecutive jobs to
  // "not evaluated (AI unavailable) — left for manual review" inside one search, which is a
  // whole page of results thrown onto a manual pile that nobody works through. Back off and
  // ask again; only a persistent failure degrades to manual.
  let v;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      v = await api.evaluate(post);
      // A keyword-sourced verdict means the backend's chain failed too — same situation as a
      // thrown error, and worth the same wait rather than being accepted as an answer.
      if (v && v.source !== 'keyword') break;
      if (attempt === 2) break;
    } catch {
      if (attempt === 2) {
        return { ok: false, score: 0, techMatch: false, manual: true,
          reason: 'evaluation service unreachable', label: 'could not evaluate — left for manual' };
      }
    }
    // 8s, then 20s. Long enough for a per-minute window to move, short enough that a blocked
    // run still makes progress through its list. The harness collapses it, like humanDelay.
    const backoff = process.env.JOBPILOT_TEST_NO_PACING === '1' ? 0 : (attempt === 0 ? 8000 : 20000);
    await new Promise((r) => setTimeout(r, backoff));
  }
  if (!v) {
    return { ok: false, score: 0, techMatch: false, manual: true,
      reason: 'evaluation service unreachable', label: 'could not evaluate — left for manual' };
  }

  const score = Number(v.score ?? 0);
  const techMatch = v.techMatch === true;
  const reason = (v.reason || '').trim();
  const missing = Array.isArray(v.missing) ? v.missing.filter(Boolean).slice(0, 3) : [];

  // There is nothing to judge the job AGAINST. This is not a verdict about the job, and it must
  // never be reported as one: presenting it as "stack mismatch (fit 0)" made an empty profile
  // look like 57 unsuitable jobs, which is unfixable by anyone reading the log. Name the cause.
  if (v.source === 'no_profile') {
    return { ok: false, score: 0, techMatch: false, manual: true,
      reason: reason || 'profile is empty',
      label: 'cannot judge fit — your Profile has no skills saved (fill in Profile, then run again)' };
  }

  // `source: "keyword"` means the AI could not render a verdict and this is keyword overlap —
  // the very signal that approved a Python role at 38 for a Java résumé. It is not a safe
  // substitute for the rubric, so an unevaluated job becomes a manual lead. A missed job costs
  // a click; a wrong application costs credibility with a real employer.
  if (v.source === 'keyword') {
    return { ok: false, score, techMatch: false, manual: true,
      reason: reason || 'AI evaluator unavailable',
      label: `not evaluated (AI unavailable) — left for manual review` };
  }

  // BOTH conditions, per the spec: a high score with the wrong stack is still the wrong job.
  if (!techMatch) {
    return { ok: false, score, techMatch, reason,
      label: `stack mismatch (fit ${score})${missing.length ? ` — missing ${missing.join(', ')}` : ''}` };
  }
  if (score < min) {
    return { ok: false, score, techMatch, reason,
      label: `fit ${score} < ${min}${reason ? ` — ${reason}` : ''}` };
  }
  return { ok: true, score, techMatch, reason, label: `fit ${score}${reason ? ` — ${reason}` : ''}` };
}

/**
 * Should we contact this person? Their headline is checked first (free and exact); their recent
 * posts are only read when the headline is ambiguous.
 *
 * Returns { ok, reason, topic, confidence } — `topic` is what they posted about, which the
 * message generator uses so the note references something real.
 */
export async function shouldContact(api, person, plan = {}, posts = []) {
  const min = Number(plan.personConfMin ?? DEFAULT_PERSON_CONF);
  let v;
  try {
    v = await api.verifyPerson({ name: person.name, headline: person.headline || '', posts });
  } catch {
    return { ok: false, reason: 'verification unavailable', topic: '', confidence: 0 };
  }
  const confidence = Number(v.confidence ?? 0);
  if (!v.contact) return { ok: false, reason: v.reason || 'not a hiring contact', topic: '', confidence };
  if (confidence < min) {
    return { ok: false, reason: `only ${confidence}% sure they hire (need ${min}%)`, topic: v.topic || '', confidence };
  }
  return { ok: true, reason: v.reason || '', topic: v.topic || '', confidence,
    isRecruiter: !!v.isRecruiter, hiringNow: !!v.hiringNow };
}

/**
 * Final check immediately before sending: the anti-spam limits and the duplicate guard.
 *
 * Separate from shouldContact on purpose. shouldContact answers "is this the right kind of
 * person" and costs a model call; this answers "have we already, or too often" and also RECORDS
 * the attempt. Doing both in one server call is what makes it safe against a retry sending twice.
 */
export async function claimOutreach(api, { portal = 'linkedin', company, role, recruiterUrl,
                                          recruiterName, resumeVersion, email, channel = 'message' }) {
  try {
    const r = await api.outreachClaim({ portal, company: company || '', role: role || '',
      recruiterUrl: recruiterUrl || '', recruiterName: recruiterName || '',
      resumeVersion: resumeVersion || '',
      // Passing the address too is what lets ONE check answer "have we contacted this person by
      // ANY channel?" — the same recruiter appears in several posts, one with an email and one
      // with only a profile, and they must not get both.
      email: email || '', channel });
    // `=== true`, not truthy: only an explicit boolean is permission to contact someone.
    // A stray string or a malformed reply must never read as a yes.
    return r && r.ok === true ? { ok: true } : { ok: false, reason: (r && r.reason) || 'blocked' };
  } catch {
    // Fail CLOSED: if we can't confirm this isn't a duplicate, don't send. An unsent message
    // costs nothing; a second one to the same recruiter costs credibility.
    return { ok: false, reason: 'could not check the outreach limits' };
  }
}
