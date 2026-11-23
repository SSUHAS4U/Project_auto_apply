// Compose & send / History rules: which résumé to suggest, which pasted values may overwrite a
// field, and when to warn "you already wrote to them". Imported directly (Node strips the types).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { suggestResume, resumeLabel, mergeDetected, previousContacts, ago } from '../src/lib/outreach.ts';

const R = (id, name, role, hasPdf = true, defaultResume = false) => ({ id, name, role, hasPdf, defaultResume });

describe('suggestResume', () => {
  const lib = [
    R('fs', 'Suhas Full Stack', 'Full Stack Developer'),
    R('java', 'Suhas_Java_SpringBoot', 'Java Backend Developer', true, true),
    R('data', 'Data resume', 'Data Analyst'),
    R('draft', 'React draft', 'React Developer', false),
  ];
  test('the role tag beats the name, and words count', () => {
    assert.equal(suggestResume(lib, 'Java Developer').id, 'java');
    assert.equal(suggestResume(lib, 'Senior Data Analyst').id, 'data');
    assert.equal(suggestResume(lib, 'Full Stack Engineer').id, 'fs');
  });
  test('a résumé without a PDF is never suggested', () => {
    assert.notEqual(suggestResume(lib, 'React Developer')?.id, 'draft');
  });
  test('a tie goes to the default', () => {
    assert.equal(suggestResume(lib, 'Developer').id, 'java');
  });
  test('nothing in common, an empty role or an empty library → null (ask, don\'t guess)', () => {
    assert.equal(suggestResume(lib, 'Chartered Accountant'), null);
    assert.equal(suggestResume(lib, ''), null);
    assert.equal(suggestResume([], 'Java Developer'), null);
  });
  test('a single résumé with a shared word is suggested', () => {
    assert.equal(suggestResume([R('one', 'CV', 'Software Developer')], 'Software Developer').id, 'one');
  });
});

describe('resumeLabel', () => {
  test('name · role, default and not-compiled markers', () => {
    assert.equal(resumeLabel(R('a', 'Java', 'Backend', true, true)), 'Java · Backend (default)');
    assert.equal(resumeLabel(R('b', 'Draft', null, false)), 'Draft — not compiled yet');
  });
});

describe('mergeDetected', () => {
  const empty = { role: '', company: '', to: '', subject: '', phone: '' };
  test('fills empty fields', () => {
    assert.deepEqual(mergeDetected(empty, new Set(), { role: 'Dev', to: 'hr@x.co' }), { role: 'Dev', to: 'hr@x.co' });
  });
  test('never overwrites what the user typed', () => {
    const cur = { ...empty, role: 'Software Developer', company: 'EdHike' };
    const out = mergeDetected(cur, new Set(['role', 'company']), { role: 'Engineer', company: 'Bluechip', to: 'hr@b.co' });
    assert.deepEqual(out, { to: 'hr@b.co' });
  });
  test('a typed field the user CLEARED can be filled again', () => {
    assert.deepEqual(mergeDetected(empty, new Set(['role']), { role: 'Dev' }), { role: 'Dev' });
  });
  test('replaces a value an earlier paste filled; an empty detection clears nothing', () => {
    const cur = { ...empty, to: 'old@a.co', subject: 'Old' };
    assert.deepEqual(mergeDetected(cur, new Set(), { to: 'new@b.co', subject: '  ' }), { to: 'new@b.co' });
  });
  test('an unchanged value is not reported as a change', () => {
    assert.deepEqual(mergeDetected({ ...empty, to: 'a@b.co' }, new Set(), { to: 'a@b.co' }), {});
  });
});

describe('previousContacts', () => {
  const H = [
    { company: 'EdHike Pvt Ltd', recipient: 'hr@edhike.com', createdAt: '2026-11-01T10:00:00Z', channel: 'EMAIL', status: 'SENT' },
    { company: 'Bluechip', recipient: '+918796166228', createdAt: '2026-11-20T10:00:00Z', channel: 'WHATSAPP', status: 'OPENED' },
    { company: 'Acme', recipient: 'jobs@acme.com', createdAt: '2026-11-21T10:00:00Z', channel: 'EMAIL', status: 'FAILED' },
  ];
  test('matches by email, by phone tail, and by company with suffixes ignored', () => {
    assert.equal(previousContacts(H, { email: 'HR@edhike.com' }).length, 1);
    assert.equal(previousContacts(H, { phone: '87961 66228' })[0].company, 'Bluechip');
    assert.equal(previousContacts(H, { company: 'edhike' }).length, 1);
    assert.equal(previousContacts(H, { company: 'EdHike Technologies' }).length, 1);
  });
  test('a failed send is not a contact; nothing given matches nothing', () => {
    assert.equal(previousContacts(H, { email: 'jobs@acme.com', company: 'Acme' }).length, 0);
    assert.equal(previousContacts(H, {}).length, 0);
    assert.equal(previousContacts([], { company: 'EdHike' }).length, 0);
  });
  test('a two-letter company name is too short to match on', () => {
    assert.equal(previousContacts([{ ...H[0], company: 'HP' }], { company: 'HP' }).length, 0);
  });
  test('newest first', () => {
    const both = previousContacts(H, { company: 'EdHike', phone: '8796166228' });
    assert.deepEqual(both.map((h) => h.company), ['Bluechip', 'EdHike Pvt Ltd']);
  });
});

describe('ago', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  test('today, yesterday, days, then a date', () => {
    assert.equal(ago('2026-11-23T01:00:00Z', now), 'today');
    assert.equal(ago('2026-11-22T12:00:00Z', now), 'yesterday');
    assert.equal(ago('2026-11-19T12:00:00Z', now), '4 days ago');
    assert.match(ago('2026-10-01T12:00:00Z', now), /1|Oct/);
    assert.equal(ago('not a date', now), '');
  });
});
