// The decision gates: what gets applied to, and who gets contacted.
//
// Both portals used to apply to anything scoring 25+ on keyword overlap, which is how a Python
// role reached a Java/MERN résumé and got submitted. Outreach had no gate at all — every /in/
// link on a search page was invited or messaged. These two helpers are the ONLY place either
// decision is made, so LinkedIn and Indeed can't drift apart.

/** Default when the backend didn't send one (older plan payloads). */
const DEFAULT_FIT_MIN = 75;
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

  let v;
  try {
    v = await api.evaluate(post);
  } catch {
    return { ok: false, score: 0, techMatch: false, manual: true,
      reason: 'evaluation service unreachable', label: 'could not evaluate — left for manual' };
  }

  const score = Number(v.score ?? 0);
  const techMatch = v.techMatch === true;
  const reason = (v.reason || '').trim();
  const missing = Array.isArray(v.missing) ? v.missing.filter(Boolean).slice(0, 3) : [];

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
