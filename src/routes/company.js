import { Router } from 'express';
import { requireRole, requireCompanyProfile } from '../middleware/auth.js';
import { validate, companyProfileSchema, programSchema } from '../lib/validation.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { saveCompany, trackRecords } from '../services/orgs.js';
import { createProgram, ownedProgram, programsForCompany, setProgramStatus } from '../services/programs.js';
import { proposalsForProgram, viewableProposal, decideProposal, reviewMilestone } from '../services/proposals.js';
import { complianceSummary, complianceCsv } from '../services/compliance.js';
import { auditTrail } from '../services/activity.js';
import { matchScore } from '../lib/matching.js';
import { renderFormError, idParam } from './_form.js';

const router = Router();
router.use(requireRole('company'));

// ---------------- profile ----------------
router.get('/setup', (req, res) => {
  const c = req.company;
  res.render('company/setup', {
    title: 'Company profile',
    values: c ? { name: c.name, cin: c.cin, fiscalYear: c.fiscal_year, obligation: Number(c.csr_obligation) } : {},
  });
});

router.post('/setup', async (req, res) => {
  try {
    const data = validate(companyProfileSchema, req.body);
    const first = !req.company;
    await saveCompany(req.user.id, data);
    res.flash('success', first ? 'Company profile saved. Create your first CSR program next.' : 'Company profile updated.');
    res.redirect(first ? '/company/programs/new' : '/company/dashboard');
  } catch (err) {
    renderFormError(res, err, 'company/setup', { title: 'Company profile' });
  }
});

router.use(requireCompanyProfile);

// ---------------- compliance dashboard ----------------
router.get('/dashboard', async (req, res) => {
  const [summary, programs] = await Promise.all([complianceSummary(req.company), programsForCompany(req.company.id)]);
  res.render('company/dashboard', { title: 'CSR dashboard', summary, programs });
});

router.get('/report.csv', async (req, res) => {
  const csv = await complianceCsv(req.company);
  const fname = `csr-report-${req.company.fiscal_year}.csv`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
  res.send('﻿' + csv); // BOM so Excel opens ₹ / unicode correctly
});

// ---------------- programs ----------------
router.get('/programs', async (req, res) => {
  res.render('company/programs', { title: 'CSR programs', programs: await programsForCompany(req.company.id) });
});

router.get('/programs/new', (req, res) => {
  res.render('company/program-new', { title: 'New CSR program', values: { states: [] } });
});

router.post('/programs', async (req, res) => {
  try {
    const data = validate(programSchema, req.body);
    const p = await createProgram(req.company, req.user.id, data);
    res.flash('success', 'Program published. Verified NGOs that match it will see it ranked at the top.');
    res.redirect(`/company/programs/${p.id}`);
  } catch (err) {
    renderFormError(res, err, 'company/program-new', { title: 'New CSR program' });
  }
});

router.get('/programs/:id', async (req, res) => {
  const program = await ownedProgram(req.company, idParam(req));
  const proposals = await proposalsForProgram(program);
  res.render('company/program', { title: program.title, program, proposals });
});

router.post('/programs/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['open', 'closed'].includes(status)) throw badRequest('Unknown status.');
  const id = idParam(req);
  await setProgramStatus(req.company, req.user.id, id, status);
  res.flash('success', status === 'closed' ? 'Program closed to new applications.' : 'Program reopened.');
  res.redirect(`/company/programs/${id}`);
});

// ---------------- proposals & milestone reviews ----------------
router.get('/proposals/:id', async (req, res) => {
  const proposal = await viewableProposal(req.user, idParam(req));
  if (proposal.company_user_id !== req.user.id) throw forbidden();
  const program = await ownedProgram(req.company, proposal.program_id);
  const record = (await trackRecords([proposal.ngo_id])).get(proposal.ngo_id);
  const match = matchScore(program, { causes: proposal.ngo_causes, states: proposal.ngo_states }, record);
  res.render('company/proposal', {
    title: proposal.title, proposal, program, match, trail: await auditTrail('proposal', proposal.id),
  });
});

router.post('/proposals/:id/decision', async (req, res) => {
  const id = idParam(req);
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const p = await decideProposal(req.company, req.user.id, id, req.body.action, note);
  res.flash('success', { shortlisted: 'Proposal shortlisted.', approved: 'Proposal approved — budget committed.', rejected: 'Proposal rejected and the NGO notified.' }[p.status]);
  res.redirect(`/company/proposals/${id}`);
});

router.post('/milestones/:id/review', async (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const proposalId = await reviewMilestone(req.company, req.user.id, idParam(req), req.body.action, note);
  res.flash('success', req.body.action === 'approve' ? 'Milestone approved — tranche released.' : 'Sent back to the NGO with your note.');
  res.redirect(`/company/proposals/${proposalId}`);
});

export default router;
