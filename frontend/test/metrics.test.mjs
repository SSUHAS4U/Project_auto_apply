// How JobPilot counts. Every surface that shows a number uses this module, so a mistake here
// is a number the owner reads and believes.
//
// Two real defects are pinned below, both found by giving the fixtures distinct identities:
//
//  1. "Posts analysed" DOUBLE COUNTED. The worker emits two different post_analysed events —
//     one per keyword carrying "scanned N hiring post(s)", and one per post that became a lead.
//     The per-post events are a subset of what N already counted, but the old fallback added 1
//     for each of them, so every post that produced a lead was counted twice.
//  2. The dashboard tiles and the dashboard chart reported 2 and 8 for the SAME metric, because
//     the tiles de-duped across the window while the chart de-duped per bucket and summed.
//     Both now go through countJobs.
//
// Imported directly: Node strips the type annotations, so this runs the real module rather than
// a copy of it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { countJobs, jobKey, sinceFor } from '../src/lib/metrics.ts';

const ev = (o) => ({ id: Math.random().toString(36), createdAt: new Date().toISOString(), ...o });

describe('posts analysed', () => {
  test('sums the per-keyword counts', () => {
    const events = [
      ev({ type: 'post_analysed', detail: 'scanned 150 hiring post(s) for "java" — 3 recruiter email(s) so far' }),
      ev({ type: 'post_analysed', detail: 'scanned 90 hiring post(s) for "spring" — 1 recruiter email(s) so far' }),
    ];
    assert.equal(countJobs(events, ['post_analysed']), 240);
  });

  test('a per-post event adds NOTHING — the keyword total already counted it', () => {
    const events = [
      ev({ type: 'post_analysed', detail: 'scanned 150 hiring post(s) for "java" — 3 recruiter email(s) so far' }),
      // These three are posts the scan turned into leads. linkedin.js counted them in the 150.
      ev({ type: 'post_analysed', title: 'Hiring post', detail: 'Asha — posted an opening (91% sure)' }),
      ev({ type: 'post_analysed', title: 'Hiring post', detail: 'Rahul — posted an opening (84% sure)' }),
      ev({ type: 'post_analysed', title: 'Hiring post', detail: 'Meera — posted an opening (77% sure)' }),
    ];
    // The old fallback returned 153 by adding 1 per unmatched event.
    assert.equal(countJobs(events, ['post_analysed']), 150);
  });

  test('no keyword summary means no number, not a guessed one', () => {
    const events = [ev({ type: 'post_analysed', detail: 'Asha — posted an opening (91% sure)' })];
    // Reporting 1 here would be inventing a figure from an event that carries no count.
    assert.equal(countJobs(events, ['post_analysed']), 0);
  });
});

describe('distinct jobs', () => {
  test('the same job found by several searches counts once', () => {
    const events = ['pune', 'mumbai', 'remote', 'hyderabad'].map((city) =>
      ev({ type: 'job_identified', url: 'https://x.com/jobs/1', title: 'Java Dev', company: 'Acme', detail: city }));
    assert.equal(countJobs(events, ['job_identified']), 1);
  });

  test('falls back to title+company when there is no url', () => {
    const events = [
      ev({ type: 'job_identified', title: 'Java Dev', company: 'Acme' }),
      ev({ type: 'job_identified', title: 'java dev', company: 'ACME' }),   // same job, different case
      ev({ type: 'job_identified', title: 'Java Dev', company: 'Globex' }),
    ];
    assert.equal(countJobs(events, ['job_identified']), 2);
  });

  test('action events with no job identity each count', () => {
    // An email is an action, not a job: three emails are three emails.
    const events = [1, 2, 3].map(() => ev({ type: 'email_sent' }));
    assert.equal(countJobs(events, ['email_sent']), 3);
  });

  test('several types fold into one total', () => {
    const events = [
      ev({ type: 'applied', url: 'https://x.com/1' }),
      ev({ type: 'easy_apply', url: 'https://x.com/2' }),
      ev({ type: 'easy_apply', url: 'https://x.com/2' }),   // same job, two events
    ];
    assert.equal(countJobs(events, ['applied', 'easy_apply']), 2);
  });
});

describe('the skip predicate', () => {
  test('excludes what the caller dismissed, and nothing else', () => {
    // The portal board hides manual leads the owner has ticked off. It used to do this with its
    // own private copy of the counting loop, which is how two counters drift apart.
    const events = [
      ev({ type: 'manual_apply', url: 'https://x.com/1' }),
      ev({ type: 'manual_apply', url: 'https://x.com/2' }),
      ev({ type: 'manual_apply', url: 'https://x.com/3' }),
    ];
    const done = new Set(['https://x.com/2']);
    assert.equal(countJobs(events, ['manual_apply']), 3);
    assert.equal(countJobs(events, ['manual_apply'], { skip: (e) => done.has(e.url) }), 2);
  });
});

describe('job identity', () => {
  test('url wins; otherwise title+company, lowercased', () => {
    assert.equal(jobKey({ url: ' https://x.com/1 ', title: 'T', company: 'C' }), 'https://x.com/1');
    assert.equal(jobKey({ title: 'Java Dev', company: 'Acme' }), 'java dev|acme');
  });

  test('an event with neither is not a job, and must not collapse with other such events', () => {
    // '|' is the empty key. countJobs treats it as "no identity" and counts each one.
    assert.equal(jobKey({}), '|');
    const events = [ev({ type: 'reply_received' }), ev({ type: 'reply_received' })];
    assert.equal(countJobs(events, ['reply_received']), 2);
  });
});

describe('windows', () => {
  test('total is all time; the others are bounded and ordered', () => {
    assert.equal(sinceFor('total'), 0);
    const today = sinceFor('today');
    const week = sinceFor('week');
    const month = sinceFor('month');
    assert.ok(month < week && week < today, 'month should reach further back than week, week than today');
    assert.ok(today <= Date.now());
  });
});
