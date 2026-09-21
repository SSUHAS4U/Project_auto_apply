// The fit bands and the company-domain lookup — two small modules that every job surface leans
// on. Imported directly (Node strips the types), so this runs the real code.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { FIT_BANDS, clampScore, fitFrom, fitFromScore } from '../src/lib/fit.ts';
import { companyDomain } from '../src/lib/companyDomain.ts';

describe('fit bands', () => {
  test('every boundary lands in the band it opens', () => {
    const at = (n) => fitFromScore(n).band;
    assert.equal(at(0), 'weak');
    assert.equal(at(39), 'weak');
    assert.equal(at(40), 'fair');
    assert.equal(at(54), 'fair');
    assert.equal(at(55), 'good');
    assert.equal(at(74), 'good');
    assert.equal(at(75), 'great');
    assert.equal(at(100), 'great');
  });

  test('out-of-range and fractional scores are clamped and rounded, never a new band', () => {
    assert.equal(clampScore(-12), 0);
    assert.equal(clampScore(140), 100);
    assert.equal(clampScore(54.5), 55);            // rounds up into Good, as the number shown does
    assert.equal(fitFromScore(54.5).band, 'good');
    assert.equal(fitFromScore(-5).band, 'weak');
    assert.equal(fitFromScore(999).band, 'great');
  });

  test('the bands tile 0–100 with no gap and no overlap, so the scale is honest', () => {
    assert.equal(FIT_BANDS[0].from, 0);
    assert.equal(FIT_BANDS.at(-1).to, 100);
    for (let i = 1; i < FIT_BANDS.length; i++) assert.equal(FIT_BANDS[i].from, FIT_BANDS[i - 1].to);
  });

  test('an AI verdict overrides the label and picks its own band', () => {
    assert.deepEqual(fitFrom(60, 'Strong fit'), { band: 'great', label: 'Strong fit', index: 3 });
    assert.equal(fitFrom(80, 'Poor match').band, 'weak');
    assert.equal(fitFrom(80, 'Partial match').band, 'fair');
  });

  test('a verdict with no recognisable word keeps the score\'s band — never uncoloured', () => {
    assert.equal(fitFrom(62, 'Worth a look').band, 'good');
    assert.equal(fitFrom(62, 'Worth a look').label, 'Worth a look');
    assert.equal(fitFrom(62, '   ').label, 'Good fit');
  });
});

describe('company domain for logos', () => {
  test('a posting on the company\'s own careers site yields the company domain', () => {
    assert.equal(companyDomain('https://careers.cognizant.com/global/en/job/123'), 'cognizant.com');
    assert.equal(companyDomain('https://careers.adobe.com/us/en/job/R158234'), 'adobe.com');
    assert.equal(companyDomain('https://www.tcs.com/careers/india/job'), 'tcs.com');
    assert.equal(companyDomain('https://careers.google.com/jobs/results/1'), 'google.com');
  });

  test('two-label country suffixes keep the company label', () => {
    assert.equal(companyDomain('https://jobs.infosys.co.in/apply'), 'infosys.co.in');
    assert.equal(companyDomain('https://careers.acme.com.au/x'), 'acme.com.au');
  });

  test('job boards and applicant-tracking hosts are never mistaken for the employer', () => {
    for (const u of [
      'https://www.linkedin.com/jobs/view/4000000000',
      'https://in.indeed.com/viewjob?jk=abc',
      'https://www.naukri.com/job-listings-x',
      'https://boards.greenhouse.io/razorpay/jobs/1',
      'https://jobs.lever.co/cred/abc',
      'https://jobs.ashbyhq.com/zepto/1',
      'https://adobe.wd5.myworkdayjobs.com/en-US/external/job/1',
      'https://www.google.com/search?q=java+jobs',
      'https://docs.google.com/forms/d/e/x/viewform',
    ]) assert.equal(companyDomain(u), null, u);
  });

  test('anything that is not a public http(s) site returns null', () => {
    for (const u of [undefined, null, '', 'not a url', 'mailto:hr@acme.com', 'javascript:alert(1)',
      'http://localhost:5173/jobs', 'http://192.168.1.4/x', 'ftp://acme.com/file']) {
      assert.equal(companyDomain(u), null, String(u));
    }
  });
});
