// The people search — where the connections wall gets its evidence.
//
// A real run rejected all ~300 people with "no recruiter title and no posts to judge",
// including profiles literally titled "techrecruiter" and "HR". The wall was not being
// strict; it was being handed an empty headline for everybody.
//
// The card renders on ONE line — "Karthick M • 2nd Technical Recruiter at Acme" — so the
// headline follows the bullet. Taking split('•')[0] returned the empty string before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSite, launch } from './harness.mjs';
import { collectPeople } from '../src/portals/outreach.js';

/** A people-results page shaped like the live one: name, degree and headline on one line. */
function peopleSearch(rows) {
  const li = (r) => `
    <li class="artdeco-list__item">
      <a href="https://www.linkedin.com/in/${r.slug}/" aria-label="${r.name}">${r.name}</a>
      <span> • ${r.degree}${r.social ? ` • ${r.social}` : ''} • ${r.headline}</span>
    </li>`;
  return '<!doctype html><html><head><meta charset="utf-8"><title>People | LinkedIn</title></head>'
    + `<body><main><div class="search-results-container"><ul>${rows.map(li).join('')}</ul></div></main></body></html>`;
}

const ROWS = [
  { name: 'Karthick M', slug: 'karthick-m', degree: '2nd', headline: 'Technical Recruiter at Acme' },
  { name: 'P Sneha Sri techrecruiter', slug: 'sneha-sri', degree: '3rd+', headline: 'Talent Acquisition Specialist' },
  { name: 'S MUTHUKRISHNAN, HR', slug: 'muthu-hr', degree: '2nd', headline: 'HR Manager at Globex' },
  { name: 'Ravi Kumar', slug: 'ravi-k', degree: '3rd+', headline: 'Senior Software Engineer at Initech' },
];

async function collect(html) {
  const { browser, ctx } = await launch({});
  try {
    await new FakeSite().add(/linkedin\.com/, () => html).install(ctx);
    const page = await ctx.newPage();
    await page.goto('https://www.linkedin.com/search/results/people/', { waitUntil: 'domcontentloaded' });
    return await collectPeople(page);
  } finally { await browser.close().catch(() => {}); }
}

test('every person comes back with a non-empty headline', async () => {
  // THE bug: this was empty for all four, which is what refused ~300 people in one run.
  const people = await collect(peopleSearch(ROWS));
  assert.equal(people.length, 4, `expected 4 people, got ${people.length}`);
  for (const p of people) {
    assert.ok(p.headline && p.headline.trim().length > 0,
      `${p.name} has no headline — the wall would refuse them for lack of evidence`);
  }
});

test('the connection-degree marker is not mistaken for the headline', async () => {
  // "2nd" / "3rd+" sits between the name and the headline. Leaving it in front produced
  // headlines like "2nd Technical Recruiter", and a note opening "Hi Karthick M • 2nd,".
  const people = await collect(peopleSearch(ROWS));
  for (const p of people) {
    assert.ok(!/^\s*\d(st|nd|rd|th)\+?\b/i.test(p.headline),
      `degree marker leaked into the headline: "${p.headline}"`);
    assert.ok(!/•/.test(p.name), `bullet leaked into the name: "${p.name}"`);
    assert.ok(!/\b\d(st|nd|rd|th)\+?\s*$/i.test(p.name), `degree leaked into the name: "${p.name}"`);
  }
});

test('the headline carries the words the wall actually reads', async () => {
  // The wall decides on "Recruiter" / "Talent Acquisition" / "HR". If those survive the
  // extraction, an obvious recruiter is approved without costing a model call — and an
  // engineer is still refused, which is the half that must not break.
  const people = await collect(peopleSearch(ROWS));
  const by = Object.fromEntries(people.map((p) => [p.name, p.headline]));
  assert.match(by['Karthick M'], /Technical Recruiter at Acme/);
  assert.match(by['P Sneha Sri techrecruiter'], /Talent Acquisition Specialist/);
  assert.match(by['S MUTHUKRISHNAN, HR'], /HR Manager/);
  assert.match(by['Ravi Kumar'], /Software Engineer/);
});

test('a page with no results yields nobody rather than junk', async () => {
  const people = await collect(peopleSearch([]));
  assert.deepEqual(people, []);
});

test('LinkedIn social proof is not mistaken for a headline', () => {
  // A run sent "is a mutual connection" as the headline for 147 people, "are mutual
  // connections" for 43 more and variants for another 67 — roughly 257 of ~700. Their real
  // headline was elsewhere in the card, so the wall found no recruiter title, had no posts to
  // fall back on, and refused them: 688 rejected as "no recruiter title and no posts to judge"
  // while genuine recruiters came through fine. These are the exact strings from that log.
  const rows = [
    { name: 'Priya R', slug: 'priya-r', degree: '2nd', social: 'Arun is a mutual connection',
      headline: 'Technical Recruiter at Acme' },
    { name: 'Sneha B', slug: 'sneha-b', degree: '3rd+', social: 'are mutual connections',
      headline: 'Senior Recruiter | IT Recruitment' },
    { name: 'Kiran M', slug: 'kiran-m', degree: '2nd', social: 'is a mutual connection · 7K followers',
      headline: 'Talent Acquisition Specialist' },
    { name: 'Ravi K', slug: 'ravi-k', degree: '2nd', social: '', headline: 'Senior Software Engineer' },
  ];
  return collect(peopleSearch(rows)).then((people) => {
    assert.equal(people.length, 4);
    for (const p of people) {
      assert.ok(!/mutual connection|followers?$/i.test(p.headline),
        `social proof leaked into the headline for ${p.name}: "${p.headline}"`);
      assert.ok(p.headline.trim().length > 0, `${p.name} lost their headline entirely`);
    }
    const by = Object.fromEntries(people.map((p) => [p.name, p.headline]));
    assert.match(by['Priya R'], /Technical Recruiter at Acme/);
    assert.match(by['Sneha B'], /Senior Recruiter/);
    assert.match(by['Kiran M'], /Talent Acquisition Specialist/);
    // And the half that must not break: a non-recruiter is still read correctly, so the wall
    // can still refuse them for the right reason.
    assert.match(by['Ravi K'], /Senior Software Engineer/);
  });
});
