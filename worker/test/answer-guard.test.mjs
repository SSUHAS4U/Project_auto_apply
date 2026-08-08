// The last check before an answer reaches a real employer.
//
// A run typed 800000 into "What is your expected hourly rate in USD?" — the owner's expected
// ANNUAL package in RUPEES, which reads as roughly $9,600 an hour. The lookup was not wrong;
// the value was right for the question it was stored against and catastrophic for the one being
// asked. This guard knows nothing about the candidate, only about units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnswerSafe, askedPeriod, askedCurrency, amountOf } from '../src/answer-guard.js';

test('THE case: an annual rupee package is refused for an hourly USD rate', () => {
  const v = isAnswerSafe('what is your expected hourly rate in usd?', '800000', { currency: 'INR' });
  assert.equal(v.ok, false, 'this exact answer was submitted to a real employer');
  assert.match(v.reason, /usd|hour/i, `the reason must be readable: ${v.reason}`);
});

test('the same figure is fine for the question it belongs to', () => {
  // The guard must not block the ordinary path — an expected-CTC question answered with the
  // expected CTC is exactly right, and refusing it would pause every application.
  assert.equal(isAnswerSafe('please enter your expected ctc in inr', '800000', { currency: 'INR' }).ok, true);
  assert.equal(isAnswerSafe('current annual salary (₹)', '400000', { currency: 'INR' }).ok, true);
});

test('a genuine hourly rate passes', () => {
  assert.equal(isAnswerSafe('expected hourly rate in usd', '45', { currency: 'USD' }).ok, true);
  assert.equal(isAnswerSafe('hourly rate', '1200', { currency: 'INR' }).ok, true);
});

test('a currency mismatch is refused even when the period matches', () => {
  const v = isAnswerSafe('expected annual salary in usd', '800000', { currency: 'INR' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /USD/);
});

test('non-money questions are never blocked', () => {
  // Years of experience, names and yes/no cannot be wrong in a way this check would catch, and
  // refusing them would stop applications for no gain.
  for (const [q, a] of [
    ['how many years of work experience do you have with java?', '1'],
    ['location (city)', 'vijayawada'],
    ['are you authorised to work in india?', 'Yes'],
    ['linkedin profile url', 'http://www.linkedin.com/in/s-suhas'],
  ]) {
    assert.equal(isAnswerSafe(q, a).ok, true, `${q} must not be blocked`);
  }
});

test('free text and empty values behave sensibly', () => {
  assert.equal(isAnswerSafe('expected ctc', 'negotiable').ok, true, 'no number to get wrong');
  assert.equal(isAnswerSafe('expected ctc', '').ok, false, 'an empty answer is not an answer');
  assert.equal(isAnswerSafe('expected ctc', null).ok, false);
});

test('an absurd hourly figure is refused even when no currency is named', () => {
  assert.equal(isAnswerSafe('what is your hourly rate?', '800000').ok, false);
});

test('the period and currency readers handle real question wording', () => {
  assert.equal(askedPeriod('expected hourly rate in usd'), 'hour');
  assert.equal(askedPeriod('salary per annum'), 'year');
  assert.equal(askedPeriod('expected ctc'), 'year');
  assert.equal(askedPeriod('monthly salary'), 'month');
  assert.equal(askedPeriod('what is your notice period'), null, 'not a money period');
  assert.equal(askedCurrency('rate in USD'), 'USD');
  assert.equal(askedCurrency('expected ctc in inr'), 'INR');
  assert.equal(askedCurrency('salary in ₹'), 'INR');
  assert.equal(askedCurrency('expected salary'), null);
});

test('amounts are read out of formatted money', () => {
  assert.equal(amountOf('₹8,00,000'), 800000);
  assert.equal(amountOf('$45.50'), 45.5);
  assert.equal(amountOf('negotiable'), null);
});
