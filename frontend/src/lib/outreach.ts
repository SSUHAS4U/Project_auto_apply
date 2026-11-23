// Pure rules behind Compose & send and History — kept out of the components so they are tested
// directly (test/outreach.test.mjs) rather than only through a render.

/** The parts of a résumé these rules read. Structural, so tests can pass plain objects. */
export type ResumeLike = {
  id: string; name: string; role?: string | null; hasPdf: boolean; defaultResume?: boolean;
};

/** The parts of a history row these rules read. */
export type SentLike = {
  company?: string | null; recipient: string; createdAt: string; channel: string; status: string;
};

const WORD = /[a-z0-9+#]+/g;
/** Words that say nothing about WHICH résumé fits ("senior", "developer" alone still counts). */
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'at', 'to', 'with', 'resume', 'cv', 'final', 'v1', 'v2', 'v3', 'pdf', 'docx']);

function words(s: string | null | undefined): string[] {
  return ((s ?? '').toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w));
}

/**
 * The library résumé that best fits the role: the most words shared between the role and the
 * résumé's role tag (weighted double) and name. Only résumés that can be sent (have a PDF)
 * qualify. Returns null when nothing shares a word — the caller then asks rather than guesses.
 */
export function suggestResume<T extends ResumeLike>(resumes: T[], role: string): T | null {
  const want = new Set(words(role));
  if (want.size === 0) return null;
  let best: T | null = null;
  let bestScore = 0;
  for (const r of resumes) {
    if (!r.hasPdf) continue;
    const tag = new Set(words(r.role));
    const name = new Set(words(r.name));
    let score = 0;
    for (const w of want) {
      if (tag.has(w)) score += 2;
      else if (name.has(w)) score += 1;
    }
    // Ties go to the default résumé, then to list order (the newest first, as the API sends it).
    if (score > bestScore || (score === bestScore && score > 0 && r.defaultResume && !best?.defaultResume)) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/** How a résumé is named in a picker: "Name · Role", with what stops it being sent. */
export function resumeLabel(r: ResumeLike): string {
  const parts = [r.name];
  if (r.role) parts.push(r.role);
  let label = parts.join(' · ');
  if (r.defaultResume) label += ' (default)';
  if (!r.hasPdf) label += ' — not compiled yet';
  return label;
}

export type Fillable = 'role' | 'company' | 'to' | 'subject' | 'phone';

/**
 * Which detected values to write into the form. A field the user typed in is theirs and is
 * never overwritten; an empty field, or one an earlier paste filled, takes the new value. An
 * empty detection never clears anything. Returns only the fields that change.
 */
export function mergeDetected(
  current: Record<Fillable, string>,
  typedByUser: ReadonlySet<Fillable>,
  detected: Partial<Record<Fillable, string>>,
): Partial<Record<Fillable, string>> {
  const out: Partial<Record<Fillable, string>> = {};
  for (const key of Object.keys(detected) as Fillable[]) {
    const v = (detected[key] ?? '').trim();
    if (!v) continue;
    if (typedByUser.has(key) && current[key].trim()) continue;
    if (current[key] === v) continue;
    out[key] = v;
  }
  return out;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|technologies|technology|solutions|india)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Earlier messages to the same place — same recipient (email, or phone by its last 10 digits),
 * or the same company by name. Failed sends don't count: nothing reached them. Newest first.
 */
export function previousContacts<T extends SentLike>(
  history: T[], target: { company?: string; email?: string; phone?: string },
): T[] {
  const co = norm(target.company);
  const email = (target.email ?? '').trim().toLowerCase();
  const phone = (target.phone ?? '').replace(/\D/g, '').slice(-10);
  return history.filter((h) => {
    if (h.status === 'FAILED') return false;
    const rec = h.recipient.trim().toLowerCase();
    if (email && rec === email) return true;
    if (phone.length === 10 && rec.replace(/\D/g, '').endsWith(phone)) return true;
    return co.length >= 3 && norm(h.company) === co;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** "today", "yesterday", "3 days ago", else the date — for "you wrote to them …". */
export function ago(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((day(now) - day(d)) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
