// The last check before an answer reaches a real employer's form.
//
// A run typed 800000 into "What is your expected hourly rate in USD?". That is the owner's
// expected annual CTC in rupees — roughly $9,600/hour. It was not a wrong lookup; the value was
// correct for the question it was stored against and catastrophic for the question being asked.
//
// The layers around this one decide WHAT to answer. This one decides whether the answer is
// SAFE to submit, and it is deliberately the dumbest link in the chain: it knows nothing about
// the candidate, only about units. A number meant per-year cannot be submitted per-hour; a
// rupee figure cannot be submitted as dollars.
//
// It fails CLOSED. Refusing to answer costs one paused application that the owner completes in
// the dashboard; submitting a wrong one cannot be taken back — it is already in front of a
// hiring manager, and it makes the candidate look careless in a way no later correction fixes.
// That asymmetry is the whole design.

/** Periods a money question can be asking about. */
const HOURLY = /\b(per|an|\/)\s*(hour|hr)\b|\bhourly\b|\brate\s*\/\s*h/i;
const DAILY = /\b(per|a|\/)\s*day\b|\bday\s*rate\b|\bdaily\s*rate\b/i;
const MONTHLY = /\b(per|a|\/)\s*month\b|\bmonthly\b|\bpm\b/i;
const ANNUAL = /\b(per|a|\/)\s*(year|yr|annum)\b|\bannual|\bctc\b|\blpa\b|\bp\.?a\.?\b/i;

/** Currencies, by symbol or code. */
const CURRENCIES = [
  { code: 'INR', re: /₹|\binr\b|\brs\.?\b|\brupees?\b|\blakhs?\b|\blpa\b|\bcrore/i },
  { code: 'USD', re: /\$|\busd\b|\bdollars?\b/i },
  { code: 'EUR', re: /€|\beur\b|\beuros?\b/i },
  { code: 'GBP', re: /£|\bgbp\b|\bpounds?\b/i },
  { code: 'AUD', re: /\baud\b/i },
  { code: 'CAD', re: /\bcad\b/i },
];

/** Is this question asking for an amount of money at all? */
const MONEY = /\b(ctc|salary|compensation|pay|rate|remuneration|stipend|package|wage|budget)\b/i;

/** What period does the question want? null when it does not say. */
export function askedPeriod(label) {
  const l = String(label || '');
  if (HOURLY.test(l)) return 'hour';
  if (DAILY.test(l)) return 'day';
  if (MONTHLY.test(l)) return 'month';
  if (ANNUAL.test(l)) return 'year';
  return null;
}

/** What currency does the question want? null when it does not say. */
export function askedCurrency(label) {
  const l = String(label || '');
  for (const c of CURRENCIES) if (c.re.test(l)) return c.code;
  return null;
}

/**
 * Roughly, what period does a bare number imply for a software salary?
 *
 * Not a conversion — a sanity check. Nobody's hourly rate is 800000 in any currency, and
 * nobody's annual package is 25. When the magnitude flatly contradicts the period asked for,
 * the value is being reused from a different question and must not be submitted.
 */
function impliedPeriod(amount) {
  if (amount >= 50_000) return 'year';     // an annual figure in any currency
  if (amount >= 5_000) return 'month';     // plausibly monthly, or a small annual in USD
  return null;                             // small enough to be an hourly or daily rate
}

/** Digits out of "₹8,00,000" / "800000" / "$45.50". Null when there is no number. */
export function amountOf(value) {
  const m = String(value == null ? '' : value).replace(/[,\s]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * May this value be submitted for this question?
 *
 * @returns {{ok: boolean, reason: string}} — `reason` is written for the owner to read in the
 *          dashboard, so it names the question and the mismatch rather than a rule number.
 */
export function isAnswerSafe(label, value, opts = {}) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, reason: 'no value to submit' };

  // Only money answers are guarded here. Years-of-experience, names and yes/no cannot be wrong
  // in a way this check would catch, and refusing them would block applications for no gain.
  if (!MONEY.test(String(label || ''))) return { ok: true, reason: '' };

  const amount = amountOf(text);
  if (amount == null) return { ok: true, reason: '' };   // free text, e.g. "negotiable"

  // CURRENCY. The stored figure's currency comes from the profile (rupees for this owner); the
  // question names its own. A number is not convertible by retyping it.
  const wantCur = askedCurrency(label);
  const haveCur = (opts.currency || 'INR').toUpperCase();
  if (wantCur && wantCur !== haveCur) {
    return {
      ok: false,
      reason: `asks for ${wantCur} and the saved figure is in ${haveCur} — `
        + `submitting ${amount} unconverted would be wrong by roughly the exchange rate`,
    };
  }

  // PERIOD. This is the case that actually happened: an annual package typed into an hourly box.
  const wantPeriod = askedPeriod(label);
  const havePeriod = impliedPeriod(amount);
  if (wantPeriod && havePeriod && wantPeriod !== havePeriod) {
    return {
      ok: false,
      reason: `asks for a ${wantPeriod}ly figure and ${amount} reads as ${havePeriod}ly — `
        + 'the saved value belongs to a different question',
    };
  }

  // A magnitude nobody means, whatever the period. Catches a stray extra zero, and a rupee
  // figure pasted into a dollar box when the question never named its currency.
  if (wantPeriod === 'hour' && amount > 10_000) {
    return { ok: false, reason: `${amount} is not an hourly rate in any currency` };
  }
  return { ok: true, reason: '' };
}

// ── Layer two: does this answer actually answer THIS question? ────────────────
//
// The unit guard above catches a right value in the wrong denomination. It cannot catch a
// value of the wrong KIND — and that failure has happened here before: "how many years of Go?"
// was once answered with 520010, the owner's PIN code. Both are numbers, both came from a real
// profile field, and nothing between the lookup and the form asked whether a six-digit number
// could be a number of years.
//
// So classify what the question is asking FOR, and check the answer is that shape. Entirely
// deterministic: no model call, no quota, nothing to be unavailable, and the same verdict every
// time. A model asked to mark its own homework can be wrong twice in the same direction; a
// range check on "years of experience" cannot.

/** What kind of thing is this question asking for? */
export function questionShape(label) {
  const l = String(label || '').toLowerCase();
  // Widened after a live run answered "how much exp do you have in docker" with "Yes".
  //
  // Employers write this a dozen ways — "total it exp", "yrs exp", "how long have you worked
  // with X" — and the first version only matched "how many years". Every phrasing the
  // classifier misses is a question this layer silently stops guarding, which is worse than
  // not having it: the shape check looks present and is absent exactly where it is needed.
  // So match on the ASKING ("how many/much/long") together with the SUBJECT (exp/experience),
  // as well as the common fixed phrases.
  if (/\b(how many years|how much (exp|experience)|years? of|yrs?\.? of|yrs?\.? exp|total (it )?exp|total experience|experience (in|with) years|years? exp)\b/.test(l)
      || (/\b(exp|experience|worked|working)\b/.test(l) && /\bhow (many|much|long)\b/.test(l))) return 'years';
  if (/\be-?mail\b/.test(l)) return 'email';
  if (/\b(phone|mobile|contact number|whatsapp)\b/.test(l)) return 'phone';
  if (/\b(url|link|profile|portfolio|github|linkedin|website)\b/.test(l)) return 'url';
  if (/\b(pin ?code|postal|zip)\b/.test(l)) return 'postcode';
  // Asked last: "are you willing to relocate for a salary of…" is a yes/no, but a money
  // question mentioning "do you" is not — the money guard owns those.
  if (/^(are|is|do|does|have|has|can|will|would|did)\b|\b(yes\s*\/\s*no)\b/.test(l)) return 'boolean';
  return 'text';
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const URLISH = /^(https?:\/\/|www\.)\S+$|^[a-z0-9-]+\.[a-z]{2,}\/\S*$/i;
const YESNO = /^(yes|no|y|n|true|false|agree|disagree|i agree|confirmed?)$/i;

/**
 * Is the answer the right SHAPE for the question?
 *
 * Only rejects when it is confident the answer cannot be right. An unrecognised question is
 * 'text' and passes — being strict about free text would block far more good applications than
 * it would ever save, and the cost of a refusal is a paused application while the cost of
 * silence is only ever paid on the shapes checked here.
 */
export function isAnswerShaped(label, value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, reason: 'no value to submit' };
  const shape = questionShape(label);
  const n = amountOf(text);

  switch (shape) {
    case 'years': {
      // The 520010 case. A number of years is small, and a professional lifetime caps it.
      if (n == null) return { ok: false, reason: `asks for a number of years and got "${text}"` };
      if (!/^\d+(\.\d+)?$/.test(text.replace(/\s|years?|yrs?/gi, '')))
        return { ok: false, reason: `asks for a number of years and got "${text}"` };
      if (n < 0 || n > 60) return { ok: false, reason: `${n} is not a number of years of experience` };
      return { ok: true, reason: '' };
    }
    case 'email':
      return EMAIL.test(text) ? { ok: true, reason: '' }
        : { ok: false, reason: `asks for an email address and got "${text}"` };
    case 'url':
      return URLISH.test(text) ? { ok: true, reason: '' }
        : { ok: false, reason: `asks for a link and got "${text}"` };
    case 'phone': {
      const digits = text.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 ? { ok: true, reason: '' }
        : { ok: false, reason: `asks for a phone number and got "${text}"` };
    }
    case 'postcode': {
      const digits = text.replace(/\D/g, '');
      return digits.length >= 4 && digits.length <= 10 ? { ok: true, reason: '' }
        : { ok: false, reason: `asks for a postal code and got "${text}"` };
    }
    case 'boolean':
      // A yes/no question answered with a number is the classic wrong-field symptom.
      return YESNO.test(text) ? { ok: true, reason: '' }
        : { ok: false, reason: `asks yes or no and got "${text}"` };
    default:
      return { ok: true, reason: '' };
  }
}

/**
 * Every check, in one call, so a caller cannot apply one and forget the other.
 * Shape first: "is this even the right kind of thing?" precedes "is it in the right units?".
 */
export function validateAnswer(label, value, opts = {}) {
  const shaped = isAnswerShaped(label, value);
  if (!shaped.ok) return shaped;
  return isAnswerSafe(label, value, opts);
}
