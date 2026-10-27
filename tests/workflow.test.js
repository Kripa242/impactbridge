import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, query } from '../src/db/index.js';
import * as users from '../src/services/users.js';
import * as orgs from '../src/services/orgs.js';
import * as programs from '../src/services/programs.js';
import * as proposals from '../src/services/proposals.js';
import { complianceSummary, complianceCsv } from '../src/services/compliance.js';

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const rejects = (p, status, re) =>
  assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));

let admin, companyUser, company, ngoUser, ngo, ngo2User, ngo2, program;

async function makeNgo(email, csr1) {
  const u = await users.register({ name: email, email, password: 'password123', role: 'ngo' });
  const { ngo: n } = await orgs.saveNgo(u.id, {
    name: `NGO ${email}`, description: 'We run community learning centres for children in rural areas.',
    csr1Number: csr1, pan: 'AAATR1234K', reg12a: '12A-ABC-001', reg80g: '80G-ABC-001',
    causes: ['education'], states: ['Karnataka'],
  });
  return [u, n];
}

const plan = (amounts) => ({
  title: 'Digital classrooms', summary: 'Set up smart classrooms in ten government schools with teacher training.',
  milestones: amounts.map((a, i) => ({ title: `Phase ${i + 1}`, amount: a, due: day(30 * (i + 1)) })),
});

before(async () => {
  await initDb({ dataDir: 'memory://' });
  admin = await users.ensureAdmin('admin@test.dev', 'adminpass123');
  companyUser = await users.register({ name: 'Acme', email: 'csr@acme.test', password: 'password123', role: 'company' });
  company = await orgs.saveCompany(companyUser.id, { name: 'Acme Ltd', cin: 'L17110MH1973PLC019786', fiscalYear: '2026-27', obligation: 1000000 });
  [ngoUser, ngo] = await makeNgo('a@ngo.test', 'CSR00000001');
  [ngo2User, ngo2] = await makeNgo('b@ngo.test', 'CSR00000002');
  program = await programs.createProgram(company, companyUser.id, {
    title: 'Rural education 2026', description: 'Funding learning programs in rural Karnataka schools.',
    cause: 'education', states: ['Karnataka'], budget: 500000, deadline: day(7),
  });
});
after(closeDb);

test('duplicate email registration is rejected', async () => {
  await rejects(users.register({ name: 'x', email: 'csr@acme.test', password: 'password123', role: 'ngo' }), 409);
});

test('wrong password and unknown email give the same error', async () => {
  await rejects(users.authenticate('csr@acme.test', 'nope'), 401, /Incorrect/);
  await rejects(users.authenticate('ghost@acme.test', 'nope'), 401, /Incorrect/);
});

test('unverified NGO cannot apply', async () => {
  await rejects(proposals.submitProposal(ngo, ngoUser.id, program.id, plan([100000])), 403, /verified/);
});

test('admin verification is one-shot', async () => {
  ngo = await orgs.reviewNgo(admin.id, ngo.id, 'verified');
  ngo2 = await orgs.reviewNgo(admin.id, ngo2.id, 'verified');
  await rejects(orgs.reviewNgo(admin.id, ngo.id, 'rejected', 'late'), 409);
});

test('changing registration numbers sends a verified NGO back to pending', async () => {
  const [u, n] = await makeNgo('c@ngo.test', 'CSR00000003');
  await orgs.reviewNgo(admin.id, n.id, 'verified');
  const { ngo: same, requeued: r1 } = await orgs.saveNgo(u.id, {
    name: 'Renamed', description: n.description, csr1Number: n.csr1_number, pan: n.pan,
    reg12a: n.reg_12a, reg80g: n.reg_80g, causes: n.causes, states: n.states,
  });
  assert.equal(r1, false);
  assert.equal(same.status, 'verified');
  const { ngo: changed, requeued } = await orgs.saveNgo(u.id, {
    name: 'Renamed', description: n.description, csr1Number: n.csr1_number, pan: 'AAATR9999K',
    reg12a: n.reg_12a, reg80g: n.reg_80g, causes: n.causes, states: n.states,
  });
  assert.equal(requeued, true);
  assert.equal(changed.status, 'pending');
});

let p1, p2;
test('verified NGO applies; amount is the milestone total; second application is blocked', async () => {
  p1 = await proposals.submitProposal(ngo, ngoUser.id, program.id, plan([200000, 100000]));
  assert.equal(p1.amount, 300000);
  await rejects(proposals.submitProposal(ngo, ngoUser.id, program.id, plan([1000])), 409, /already applied/);
});

test('requests larger than the available budget are refused', async () => {
  await rejects(proposals.submitProposal(ngo2, ngo2User.id, program.id, plan([400000, 200000])), 400, /available/);
  p2 = await proposals.submitProposal(ngo2, ngo2User.id, program.id, plan([250000]));
});

test('approval commits budget and can never over-commit', async () => {
  await proposals.decideProposal(company, companyUser.id, p1.id, 'approve');
  let pg = await programs.getProgram(program.id);
  assert.equal(pg.committed, 300000);
  // p2 asks 250k but only 200k left now
  await rejects(proposals.decideProposal(company, companyUser.id, p2.id, 'approve'), 409, /uncommitted/);
  await rejects(proposals.decideProposal(company, companyUser.id, p1.id, 'approve'), 409, /already approved/);
  await rejects(proposals.decideProposal(company, companyUser.id, p2.id, 'reject'), 400, /reason/);
  await proposals.decideProposal(company, companyUser.id, p2.id, 'reject', 'Budget fully allocated');
  pg = await programs.getProgram(program.id);
  assert.equal(pg.committed, 300000);
});

test('concurrent approvals cannot both pass the budget check', async () => {
  const pg = await programs.createProgram(company, companyUser.id, {
    title: 'Race condition program', description: 'Testing concurrent approvals of proposals here.',
    cause: 'education', states: ['Karnataka'], budget: 100000, deadline: day(7),
  });
  const a = await proposals.submitProposal(ngo, ngoUser.id, pg.id, plan([70000]));
  const b = await proposals.submitProposal(ngo2, ngo2User.id, pg.id, plan([70000]));
  const results = await Promise.allSettled([
    proposals.decideProposal(company, companyUser.id, a.id, 'approve'),
    proposals.decideProposal(company, companyUser.id, b.id, 'approve'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await programs.getProgram(pg.id)).committed, 70000);
});

test('another company cannot decide or review this company\'s work', async () => {
  const u = await users.register({ name: 'Other', email: 'other@co.test', password: 'password123', role: 'company' });
  const other = await orgs.saveCompany(u.id, { name: 'Other Co', cin: 'U17110MH1973PTC019786', fiscalYear: '2026-27', obligation: 10 });
  await rejects(proposals.decideProposal(other, u.id, p1.id, 'shortlist'), 403);
  await rejects(programs.ownedProgram(other, program.id), 403);
});

test('milestones must be completed in order, and approvals release funds', async () => {
  const detail = await proposals.getProposal(p1.id);
  const [m1, m2] = detail.milestones;
  await rejects(proposals.submitEvidence(ngo, ngoUser.id, m2.id, { note: 'x'.repeat(25) }), 409, /Milestone 1 must be approved/);
  await rejects(proposals.submitEvidence(ngo2, ngo2User.id, m1.id, { note: 'x'.repeat(25) }), 403);

  const pdf = { originalname: 'report.pdf', mimetype: 'application/pdf', size: 4, buffer: Buffer.from('%PDF') };
  await proposals.submitEvidence(ngo, ngoUser.id, m1.id, { note: 'Classrooms installed in 5 schools.' }, pdf);
  await rejects(proposals.submitEvidence(ngo, ngoUser.id, m1.id, { note: 'again '.repeat(5) }), 409, /already submitted/);

  await rejects(proposals.reviewMilestone(company, companyUser.id, m1.id, 'revise'), 400);
  await proposals.reviewMilestone(company, companyUser.id, m1.id, 'revise', 'Please attach attendance registers');
  await proposals.submitEvidence(ngo, ngoUser.id, m1.id, { note: 'Attached registers for all five schools.' });
  await proposals.reviewMilestone(company, companyUser.id, m1.id, 'approve');
  assert.equal((await programs.getProgram(program.id)).released, 200000);

  await proposals.submitEvidence(ngo, ngoUser.id, m2.id, { note: 'Teacher training completed for 40 teachers.' });
  await proposals.reviewMilestone(company, companyUser.id, m2.id, 'approve');
  const done = await proposals.getProposal(p1.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.released, 300000);
});

test('evidence rejects disallowed file types', async () => {
  const exe = { originalname: 'x.exe', mimetype: 'application/x-msdownload', size: 10, buffer: Buffer.from('MZ') };
  await rejects(proposals.submitEvidence(ngo, ngoUser.id, 1, { note: 'x'.repeat(25) }, exe), 400, /PDF/);
});

test('compliance summary and CSV reflect committed and released money', async () => {
  const fresh = (await query('SELECT * FROM companies WHERE id = $1', [company.id]))[0];
  const s = await complianceSummary(fresh);
  assert.equal(s.obligation, 1000000);
  assert.equal(s.committed, 370000);
  assert.equal(s.released, 300000);
  assert.equal(s.unallocated, 630000);
  const csv = await complianceCsv(fresh);
  assert.match(csv, /Digital classrooms/);
  assert.match(csv, /CSR00000001/);
});

test('track record lowers after a milestone is sent back', async () => {
  const rec = (await orgs.trackRecords([ngo.id])).get(ngo.id);
  assert.deepEqual(rec, { approved: 2, revisions: 1 });
});
