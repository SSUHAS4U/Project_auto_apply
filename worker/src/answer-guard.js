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
