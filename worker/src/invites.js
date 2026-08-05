// Invitation capacity management.
//
// LinkedIn allows roughly 100 invitations a week, and PENDING ones keep counting against you.
// Once you are over the line it stops rendering the Connect control on every profile and shows
// Follow instead — which looks exactly like a broken selector. This account hit that wall with
// 155 invitations still outstanding, most of them long past any chance of being accepted.
//
// So capacity has to be MANAGED, not just consumed. This withdraws invitations old enough to be
// dead weight, on a weekly cadence, and is deliberately timid: an invitation is withdrawn ONLY
// when its age was positively read from the page AND exceeds the configured threshold. Anything
// unreadable is left alone. Withdrawing is not reversible — LinkedIn blocks re-inviting the same
// person for about three weeks — so the failure mode must be "did nothing", never "withdrew
// something recent".
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, humanDelay } from './browser.js';

/** Never touch anything younger than this, whatever the caller asks for. */
export const MIN_AGE_DAYS = 14;
/** Default threshold when no setting is supplied. */
export const DEFAULT_AGE_DAYS = 21;
/** Most to withdraw in one pass — a slow drip reads like a person tidying up. */
export const DEFAULT_MAX = 40;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const stampFile = () => path.join(APP_DIR, '.invite-cleanup.json');

/** When the last cleanup ran. Stored next to the profile so it survives restarts. */
export function lastCleanupAt() {
  try {
    return new Date(JSON.parse(fs.readFileSync(stampFile(), 'utf8')).at).getTime() || 0;
  } catch { return 0; }
}

function markCleanupDone(withdrew) {
  try {
    fs.writeFileSync(stampFile(), JSON.stringify({ at: new Date().toISOString(), withdrew }));
  } catch { /* a missing stamp only means we try again sooner */ }
}

/** Weekly cadence. The capacity this frees takes days to matter, so daily runs buy nothing. */
export function cleanupDue(now = Date.now()) {
  return now - lastCleanupAt() >= WEEK_MS;
}

/**
 * "3 weeks ago" → 21. Returns null when the age cannot be determined, which is the signal to
 * leave that invitation alone. Deliberately strict: no readable unit, no withdrawal.
 */
export function ageInDays(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  const UNIT = { day: 1, week: 7, month: 30, year: 365 };
  const m = s.match(/(\d+)\s*(day|week|month|year)s?\s*ago/);
  if (m) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n * UNIT[m[2]] : null;
  }
  // LinkedIn writes exactly-one as "a week ago".
  const one = s.match(/\ba\s+(day|week|month|year)\s+ago/);
  return one ? UNIT[one[1]] : null;
}

/** Should this row be withdrawn? Pure, so the rule is testable without a browser. */
export function shouldWithdraw(row, thresholdDays) {
  const cutoff = Math.max(MIN_AGE_DAYS, Number(thresholdDays) || DEFAULT_AGE_DAYS);
  const age = ageInDays(row && row.ageText);
  if (age === null) return false;          // unreadable age → never touch it
  return age >= cutoff;
}

/**
 * Withdraw pending invitations older than the threshold.
 *
 * Returns { checked, withdrew, skippedUnknownAge, pending }. Never throws — outreach has to
 * keep running whatever happens in here.
 */
export async function withdrawStaleInvites(page, api, state, opts = {}) {
  const thresholdDays = Math.max(MIN_AGE_DAYS, Number(opts.olderThanDays) || DEFAULT_AGE_DAYS);
  const max = Math.max(1, Number(opts.max) || DEFAULT_MAX);
  const out = { checked: 0, withdrew: 0, skippedUnknownAge: 0, pending: null };

  console.log(`\n  ══ Invitation cleanup — only invites older than ${thresholdDays} days ══`);
  await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/',
    { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanDelay(4000, 6000);

  out.pending = await page.evaluate(() => {
    const m = (document.body && document.body.innerText || '').match(/People \((\d+)\)/);
    return m ? Number(m[1]) : null;
  }).catch(() => null);
  if (out.pending != null) console.log(`     ${out.pending} invitations pending`);

  for (let pass = 0; pass < 10 && out.withdrew < max; pass++) {
    if (state && (state.stopped || state.paused)) break;
    // The list is virtualised and the control only exists once a row has rendered, so scroll,
    // then take ONE actionable row at a time — the DOM is rebuilt after each withdrawal.
    await page.evaluate(() => window.scrollBy(0, 1100)).catch(() => {});
    await humanDelay(1400, 2200);

    const row = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
        const label = (b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '');
        return /withdraw/i.test(label) && !b.hasAttribute('data-jp-keep');
      });
      if (!btns.length) return null;
      const b = btns[0];
      let box = b;
      for (let up = 0; up < 8 && box.parentElement; up++) {
        box = box.parentElement;
        if (/ago/i.test(box.innerText || '') && box.querySelector('a[href*="/in/"]')) break;
      }
      const t = clean(box.innerText);
      const age = (t.match(/(\d+\s*(?:day|week|month|year)s?\s*ago)/i)
        || t.match(/\b(a\s+(?:day|week|month|year)\s+ago)/i) || [])[1] || '';
      b.setAttribute('data-jp-wd', '1');
      return { ageText: age, who: clean(box.querySelector('a[href*="/in/"]') && box.querySelector('a[href*="/in/"]').innerText).slice(0, 40) };
    }).catch(() => null);

    if (!row) { if (pass > 3) break; continue; }
    out.checked++;

    if (!shouldWithdraw(row, thresholdDays)) {
      if (!row.ageText) out.skippedUnknownAge++;
      // Mark it kept so the next pass looks past it rather than re-reading the same row.
      await page.evaluate(() => {
        const b = document.querySelector('[data-jp-wd]');
        if (b) { b.removeAttribute('data-jp-wd'); b.setAttribute('data-jp-keep', '1'); }
      }).catch(() => {});
      continue;
    }

    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-jp-wd]');
      if (!b) return false;
      b.removeAttribute('data-jp-wd');
      b.click();
      return true;
    }).catch(() => false);
    if (!clicked) continue;
    await humanDelay(1200, 2000);

    // LinkedIn asks to confirm. ONLY a control that literally says Withdraw counts — a loose
    // "primary button in the dialog" match would happily click something else entirely.
    await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]') || document;
      const ok = [...d.querySelectorAll('button')]
        .find((b) => /^withdraw$/i.test((b.innerText || '').trim()));
      if (ok) ok.click();
    }).catch(() => {});
    await humanDelay(1600, 2600);

    out.withdrew++;
    console.log(`     ↩ withdrew ${row.who || 'an invitation'} (sent ${row.ageText})`);
    if (api && api.event) {
      await api.event({
        runId: state && state.runId, portal: 'linkedin', type: 'info',
        detail: `withdrew a stale invitation (${row.ageText}) to free connection capacity`,
      }).catch(() => {});
    }
  }

  markCleanupDone(out.withdrew);
  console.log(`     cleanup: ${out.withdrew} withdrawn, ${out.checked} inspected`
    + (out.skippedUnknownAge ? `, ${out.skippedUnknownAge} left alone (age unreadable)` : ''));
  if (out.checked === 0) {
    console.log('     ⓘ no withdraw controls were found. Nothing was changed.');
    console.log('       LinkedIn renders them lazily; if this repeats, withdraw a few by hand at');
    console.log('       linkedin.com/mynetwork/invitation-manager/sent/ to free capacity.');
  }
  return out;
}
