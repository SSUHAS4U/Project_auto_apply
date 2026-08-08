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

// ── Layer two: is the answer even the right KIND of thing? ────────────────────
//
// The unit guard catches a right value in the wrong denomination. It cannot catch a value of
// the wrong kind, and that has happened here: "how many years of Go?" was once answered with
// 520010 — the owner's PIN code. Both numbers, both from a real profile field, and nothing
// between the lookup and the form asked whether six digits could be a number of years.
import { isAnswerShaped, questionShape, validateAnswer } from '../src/answer-guard.js';

test('THE 520010 case: a PIN code is not a number of years', () => {
  const v = isAnswerShaped('how many years of work experience do you have with go?', '520010');
  assert.equal(v.ok, false);
  assert.match(v.reason, /years/i, v.reason);
});

test('real years-of-experience answers pass', () => {
  for (const a of ['1', '0', '3', '2.5', '10 years']) {
    assert.equal(isAnswerShaped('how many years of experience do you have with java?', a).ok, true, a);
  }
});

test('a yes/no question answered with a number is refused', () => {
  // The classic wrong-field symptom: a profile number landing in a consent radio.
  assert.equal(isAnswerShaped('are you authorised to work in india?', '520010').ok, false);
  assert.equal(isAnswerShaped('are you authorised to work in india?', 'Yes').ok, true);
  assert.equal(isAnswerShaped('do you require visa sponsorship?', 'No').ok, true);
});

test('emails, links and phone numbers must look like themselves', () => {
  assert.equal(isAnswerShaped('email address', 'vijayawada').ok, false);
  assert.equal(isAnswerShaped('email address', 'dev.suhas4u@gmail.com').ok, true);
  assert.equal(isAnswerShaped('linkedin profile url', 'Computer Science graduate').ok, false);
  assert.equal(isAnswerShaped('linkedin profile url', 'http://www.linkedin.com/in/s-suhas').ok, true);
  assert.equal(isAnswerShaped('mobile number', 'yes').ok, false);
  assert.equal(isAnswerShaped('mobile number', '+91 98765 43210').ok, true);
});

test('free text is never blocked', () => {
  // Being strict here would refuse far more good applications than it could ever save.
  assert.equal(questionShape('summary'), 'text');
  assert.equal(isAnswerShaped('summary', 'Computer Science Engineering graduate').ok, true);
  assert.equal(isAnswerShaped('why do you want this role?', 'anything at all').ok, true);
});

test('validateAnswer applies BOTH layers, shape first', () => {
  // One call, so a caller cannot apply one check and forget the other.
  assert.equal(validateAnswer('how many years of go?', '520010').ok, false, 'shape must catch it');
  assert.equal(validateAnswer('expected hourly rate in usd', '800000', { currency: 'INR' }).ok, false,
    'units must catch it');
  assert.equal(validateAnswer('how many years of java?', '1').ok, true, 'a good answer passes both');
  assert.equal(validateAnswer('please enter your expected ctc in inr', '800000', { currency: 'INR' }).ok, true);
});

test('every way an employer phrases a years question is caught', () => {
  // A live run answered "how much exp do you have in docker" with "Yes" — the classifier only
  // matched "how many years", so the shape check looked present and was absent exactly where it
  // was needed. Each of these is real employer wording seen in a run.
  for (const q of [
    'how much exp do you have in docker',
    "what's your total it exp",
    'how many years of experience do you have with java?',
    'yrs of exp in react',
    'how long have you worked with kubernetes',
  ]) {
    assert.equal(questionShape(q), 'years', `not classified as a years question: "${q}"`);
    assert.equal(isAnswerShaped(q, 'Yes').ok, false, `"Yes" must be refused for: "${q}"`);
    assert.equal(isAnswerShaped(q, '1').ok, true, `"1" must be accepted for: "${q}"`);
  }
});

test('widening the years pattern did not swallow other question types', () => {
  // The risk of matching more broadly is stealing questions from the other shapes.
  assert.equal(questionShape('are you authorised to work in india?'), 'boolean');
  assert.equal(questionShape('email address'), 'email');
  assert.equal(questionShape('expected ctc'), 'text');
  assert.equal(questionShape('summary'), 'text');
});
