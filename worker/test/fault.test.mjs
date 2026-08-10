// Every fault must be actionable. That is the whole contract.
//
// Six releases were spent guessing at causes because failures surfaced as symptoms — "the job
// page did not render", "answer failed", "the run was stopped" — with no evidence and no
// instruction. These tests enforce that a registered fault cannot be added without deciding
// what it means and what to do about it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAULTS, fault, codeFault } from '../src/fault.js';

test('every fault says what, why, and what to do', () => {
  for (const [id, f] of Object.entries(FAULTS)) {
    assert.ok(f.what && f.what.length > 20, `${id}: 'what' must describe the failure`);
    assert.ok(f.why && f.why.length > 20, `${id}: 'why' must give the mechanism, not a restatement`);
    assert.ok(f.action && f.action.length > 20, `${id}: 'action' must say what to DO`);
    assert.equal(typeof f.owner, 'boolean', `${id}: must declare whether a person has to act`);
  }
});

test('no fault fobs the reader off with "investigate"', () => {
  // The exact words that made previous failure messages useless. An action the reader cannot
  // perform is not an action, and it is how a whole day went to chasing a phantom.
  const USELESS = /\b(investigate|check the logs|try again later|contact support|unknown|see above)\b/i;
  for (const [id, f] of Object.entries(FAULTS)) {
    assert.ok(!USELESS.test(f.action), `${id}: "${f.action}" tells the reader nothing they can do`);
  }
});

test('an owner-actionable fault names where to go', () => {
  // If a person must act, the instruction has to name the screen. "Fix your profile" is not
  // an instruction; "Automation → questions" is.
  for (const [id, f] of Object.entries(FAULTS)) {
    if (!f.owner) continue;
    // A destination is a named JobPilot screen OR a specific URL. Both tell the reader where
    // to go; "check the settings" does not, and that is the distinction being enforced.
    assert.match(f.action, /Connections|Automation|Profile|Documents|Settings|Setup|Applications|https?:\/\/|\w+\.com\//,
      `${id}: an owner action must name the screen or the URL — got "${f.action}"`);
  }
});

test('an unregistered fault id is itself reported as a bug', () => {
  // Adding a failure path without deciding what the owner should do is the habit this module
  // exists to break, so it must not fail silently.
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { fault('SOMETHING_NEW', { url: 'x' }); } finally { console.log = orig; }
  assert.match(lines.join('\n'), /no guidance registered/i);
});

test('a code fault carries the stack that identifies the line', () => {
  // "ReferenceError: title is not defined" failed 38 applications and was diagnosable from one
  // stack frame — but nothing recorded it, so it cost a release instead of a minute.
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    let e;
    try { null.foo(); } catch (caught) { e = caught; }
    codeFault(e, 'easyApply');
  } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /automation itself threw/i);
  assert.match(out, /code change/i, 'it must say a code change is needed, not ask the owner to fix it');
});
