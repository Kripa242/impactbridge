import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore } from '../src/lib/matching.js';
import { validate, ngoProfileSchema, proposalSchema, companyProfileSchema } from '../src/lib/validation.js';

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('match score: cause + geography + neutral track record', () => {
  const r = matchScore({ cause: 'education', states: ['Karnataka', 'Kerala'] }, { causes: ['education'], states: ['Karnataka'] });
  assert.equal(r.breakdown.cause, 50);
  assert.equal(r.breakdown.geo, 23); // 15 + 15 * 1/2, rounded
  assert.equal(r.breakdown.track, 10);
});

test('match score: pan-India counts as coverage; poor track record lowers score', () => {
  const r = matchScore({ cause: 'environment', states: ['Pan-India'] }, { causes: ['education'], states: ['Goa'] }, { approved: 1, revisions: 3 });
  assert.deepEqual(r.breakdown, { cause: 0, geo: 30, track: 5 });
});

test('NGO validation normalises and checks registration formats', () => {
  const ok = validate(ngoProfileSchema, {
    name: 'Seva', description: 'A long enough description of what this NGO does.',
    csr1Number: 'csr00012345', pan: 'aaatr1234k', reg12a: '12A/2020/1', reg80g: '80G/2020/1',
    causes: 'education', states: 'Kerala',
  });
  assert.equal(ok.csr1Number, 'CSR00012345');
  assert.deepEqual(ok.causes, ['education']);
  assert.throws(() => validate(ngoProfileSchema, { csr1Number: 'X1', pan: '123' }), (e) =>
    !!(e.fieldErrors.csr1Number && e.fieldErrors.pan && e.fieldErrors.causes));
});

test('proposal validation drops blank rows and enforces date order', () => {
  const base = { title: 'Water for all', summary: 'Install filtration units in thirty village schools.' };
  const ok = validate(proposalSchema, {
    ...base,
    milestones: [{ title: 'Survey', amount: '1,00,000', due: day(20) }, { title: '', amount: '', due: '' }],
  });
  assert.equal(ok.milestones.length, 1);
  assert.equal(ok.milestones[0].amount, 100000);
  assert.throws(() => validate(proposalSchema, {
    ...base, milestones: [{ title: 'B', amount: 5, due: day(40) }, { title: 'Second', amount: 5, due: day(20) }],
  }), (e) => /chronological|at least/.test(Object.values(e.fieldErrors).join(' ')));
});

test('company validation checks CIN and fiscal year', () => {
  assert.throws(() => validate(companyProfileSchema, { name: 'Acme', cin: 'BAD', fiscalYear: '2026-28', obligation: '-5' }),
    (e) => !!(e.fieldErrors.cin && e.fieldErrors.fiscalYear && e.fieldErrors.obligation));
});
