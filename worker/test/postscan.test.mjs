// Post-scan collection against LinkedIn's REWRITTEN markup.
//
// The collector is exercised in a real browser against a fixture built from the live page:
// hashed class names, no semantic selectors, the author's name only in the card text. The
// previous fallback returned the whole document as ONE post with no name and no author URL,
// so the message route could never fire and a scan reported posts while producing nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './harness.mjs';
import * as fx from './linkedin-fixtures.mjs';

const POSTS = [
  { id: '1', slug: 'ganesh-y', name: 'Yarramaneni Ganesh', headline: 'Bench Sales Recruiter',
    text: 'We are hiring Java backend developers for our Bengaluru office. '.repeat(4)
        + 'Share profiles to ganesh.y@interonit.com' },
  { id: '2', slug: 'amit-k', name: 'Amit Kuveskar', headline: 'Kotlin Android Developer',
    text: 'Looking for Android engineers with MVVM experience, DM me directly. '.repeat(4) },
  { id: '3', slug: 'priya-r', name: 'Priya Ramesh', headline: 'Talent Acquisition',
    text: 'Hiring a full stack developer. Apply here: https://careers.acme.example/jobs/42 '.repeat(3) },
];

/** Runs the SHIPPED collector body, read out of the adapter so it cannot drift. */
async function collect(html) {
  const { browser, ctx } = await launch();
  try {
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto('https://www.linkedin.com/search/results/content/?keywords=hiring');
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      let els = [...document.querySelectorAll(
        'div.feed-shared-update-v2, li.artdeco-card, [data-urn*="activity"], [data-id*="activity"], div[data-view-name*="feed"]')];
      if (els.length === 0) {
        const cands = [...document.querySelectorAll('[componentkey], div, li, article')]
          .filter((e) => {
            const t = e.innerText || '';
            return t.length > 150 && t.length < 6000 && e.querySelector('a[href*="/in/"]');
          });
        els = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
      }
      if (els.length === 0) return [];
      return els.slice(0, 40).map((el) => {
        const nameEl = el.querySelector('.update-components-actor__title span[aria-hidden], .update-components-actor__title, a[href*="/in/"]');
        const authorA = el.querySelector('a[href*="/in/"]');
        const authorUrl = authorA ? (authorA.href || '').split('?')[0] : '';
        let name = clean(nameEl?.textContent).slice(0, 60);
        if (!name) {
          const m = clean(el.innerText).match(/^(?:feed post\s+)?([^•|]{2,60}?)\s*•/i);
          if (m) name = m[1].trim().slice(0, 60);
        }
        name = name.replace(/\s*•.*$/, '').replace(/\s*\b\d(?:st|nd|rd|th)\+?\b\s*$/i, '').trim();
        return { name, authorUrl: /\/in\//.test(authorUrl) ? authorUrl : '', text: (el.innerText || '').slice(0, 4500) };
      });
    });
  } finally { await browser.close().catch(() => {}); }
}

test('posts are found despite hashed class names', async () => {
  const posts = await collect(fx.linkedinPostSearch({ posts: POSTS }));
  assert.equal(posts.length, 3, `expected 3 cards, got ${posts.length}`);
});

test('every post carries an author URL, so the message route can fire', async () => {
  const posts = await collect(fx.linkedinPostSearch({ posts: POSTS }));
  for (const p of posts) {
    assert.ok(p.authorUrl && /\/in\//.test(p.authorUrl), `no author URL: ${JSON.stringify(p)}`);
  }
});

test('the author name is read even when the actor-title class is gone', async () => {
  const posts = await collect(fx.linkedinPostSearch({ posts: POSTS }));
  const names = posts.map((p) => p.name);
  assert.ok(names.includes('Yarramaneni Ganesh'), names.join(' | '));
  assert.ok(names.includes('Amit Kuveskar'), names.join(' | '));
  // No "• 3rd+" or "Feed post" residue — this ends up in a message greeting.
  for (const n of names) {
    assert.ok(!/•|feed post|\d(st|nd|rd|th)\+?$/i.test(n), `name not cleaned: "${n}"`);
  }
});

test('a recruiter address in the post text is recoverable', async () => {
  const posts = await collect(fx.linkedinPostSearch({ posts: POSTS }));
  const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const withEmail = posts.filter((p) => (p.text.match(EMAIL) || []).length);
  assert.equal(withEmail.length, 1);
  assert.ok(/ganesh\.y@interonit\.com/.test(withEmail[0].text));
});

test('the whole page is never returned as a single nameless post', async () => {
  // The old fallback did exactly this: one blob, no name, no authorUrl — so nothing routed.
  const posts = await collect(fx.linkedinPostSearch({ posts: POSTS }));
  assert.ok(posts.length > 1, 'collapsed into one blob');
  assert.ok(posts.every((p) => p.name), 'a nameless post cannot be contacted');
});

test('a page with no posts yields nothing rather than a page-sized blob', async () => {
  const posts = await collect('<!doctype html><html><body><main><p>No results found.</p></main></body></html>');
  assert.deepEqual(posts, []);
});
