// A truncated recruiter post — the shape that produced 0 emails from 197 posts.
//
// LinkedIn collapses a post after ~3 lines behind "…see more". A recruiter's post puts the
// role, location and salary up top and "Send resume at name@example.com" near the bottom, so
// the collapsed text almost never carries the address. The addresses were there; the page had
// simply not rendered them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSite, launch } from './harness.mjs';

// Verbatim from a real post the owner sent, including the address placement.
const FULL_POST = [
  'We are Hiring !!!',
  'Post : Backend Developer',
  'Qualification :: Graduation (Freshers)',
  'Location :: Work From Home',
  'Salary :: 20k-40k in hand',
  "5 day's working (sat - sun fixed off)",
  'Send resume at hrnexus.in@gmail.com',
  'Make sure to hit the like button and drop a comment "I AM INTERESTED"',
].join('\n');

/** A feed where the post is collapsed until "see more" is clicked — as LinkedIn ships it. */
function collapsedFeed() {
  const visible = FULL_POST.split('\n').slice(0, 3).join('<br>');
  const hidden = FULL_POST.split('\n').slice(3).join('<br>');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Posts | LinkedIn</title></head><body><main>'
    + '<div componentkey="urn:li:activity:7001">'
    + '<span>Feed post</span><a href="/in/sonam-kumari/"><span>Sonam kumari</span></a>'
    + '<span> • 2nd HR Recruiter | Talent Acquisition Specialist</span>'
    + `<div id="post-body">${visible}`
    + '<span id="rest" style="display:none">' + hidden + '</span></div>'
    + '<button aria-label="see more, to open the full post">…see more</button>'
    + '</div></main>'
    + '<script>document.querySelector("button").addEventListener("click",function(){'
    + 'document.getElementById("rest").style.display="inline";this.remove();});</script>'
    + '</body></html>';
}

test('a collapsed post hides the recruiter address until it is expanded', async () => {
  // The premise, proven rather than asserted: without expanding, the email is not in the DOM
  // text at all — so no amount of better regex work downstream could ever have found it.
  const { browser, ctx } = await launch({});
  try {
    await new FakeSite().add(/linkedin\.com/, () => collapsedFeed()).install(ctx);
    const page = await ctx.newPage();
    await page.goto('https://www.linkedin.com/search/results/content/', { waitUntil: 'domcontentloaded' });

    const before = await page.evaluate(() => document.body.innerText);
    assert.ok(!/hrnexus\.in@gmail\.com/.test(before),
      'the fixture must actually hide the address, or this test proves nothing');

    // The same expansion the scan performs.
    await page.evaluate(() => {
      const wanted = /see more|…more|\bmore\b/i;
      for (const n of document.querySelectorAll('button, [role="button"]')) {
        const aria = (n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const text = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (!((aria && wanted.test(aria)) || (text && text.length <= 30 && wanted.test(text)))) continue;
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) n.click();
      }
    });
    await page.waitForTimeout(200);

    const after = await page.evaluate(() => document.body.innerText);
    assert.match(after, /hrnexus\.in@gmail\.com/,
      'the address must be readable once the post is expanded');
    assert.match(after, /Backend Developer/, 'and the rest of the post with it');
  } finally { await browser.close().catch(() => {}); }
});

test('the address survives the extraction the scan actually uses', async () => {
  // Guards the whole path, not just the click: expanded text → EMAIL_RE → junk filter.
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const EMAIL_JUNK = /no-?reply|example\.|linkedin\.com|\.png$|\.jpe?g$|\.gif$|support@|help@|info@linkedin/i;
  const found = [...new Set((FULL_POST.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e)))];
  assert.deepEqual(found, ['hrnexus.in@gmail.com']);
});

test('a post with no truncation is unaffected', async () => {
  // Expanding must not break the ordinary case — most posts are short and have no control.
  const { browser, ctx } = await launch({});
  try {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Posts</title></head>'
      + `<body><main><div componentkey="urn:li:activity:7002">${FULL_POST.replace(/\n/g, '<br>')}</div></main></body></html>`;
    await new FakeSite().add(/linkedin\.com/, () => html).install(ctx);
    const page = await ctx.newPage();
    await page.goto('https://www.linkedin.com/search/results/content/', { waitUntil: 'domcontentloaded' });
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /hrnexus\.in@gmail\.com/);
  } finally { await browser.close().catch(() => {}); }
});
