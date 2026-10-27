import { Router } from 'express';
import multer from 'multer';
import { requireRole, requireNgoProfile } from '../middleware/auth.js';
import { validate, ngoProfileSchema, proposalSchema, evidenceSchema } from '../lib/validation.js';
import { MAX_UPLOAD_BYTES, MAX_MILESTONES } from '../lib/constants.js';
import { forbidden } from '../lib/errors.js';
import { saveNgo, trackRecords } from '../services/orgs.js';
import { browseForNgo, getProgram, isAcceptingApplications } from '../services/programs.js';
import { submitProposal, proposalsForNgo, viewableProposal, submitEvidence } from '../services/proposals.js';
import { auditTrail } from '../services/activity.js';
import { matchScore } from '../lib/matching.js';
import { renderFormError, idParam } from './_form.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

router.use(requireRole('ngo'));

// ---------------- profile & verification ----------------
const profileValues = (n) => n && {
  name: n.name, description: n.description, csr1Number: n.csr1_number, pan: n.pan,
  reg12a: n.reg_12a, reg80g: n.reg_80g, causes: n.causes, states: n.states,
};

router.get('/profile', (req, res) => {
  res.render('ngo/profile', { title: 'NGO profile', values: profileValues(req.ngo) || {} });
});

router.post('/profile', async (req, res) => {
  try {
    const data = validate(ngoProfileSchema, req.body);
    const { requeued } = await saveNgo(req.user.id, data);
    res.flash(requeued ? 'info' : 'success', requeued
      ? 'Profile submitted. Our team will verify your registration details — usually within a day.'
      : 'Profile updated.');
    res.redirect('/ngo/profile');
  } catch (err) {
    renderFormError(res, err, 'ngo/profile', { title: 'NGO profile' });
  }
});

// ---------------- browse & apply ----------------
router.get('/programs', requireNgoProfile, async (req, res) => {
  const filters = {
    q: String(req.query.q || ''), cause: String(req.query.cause || ''),
    state: String(req.query.state || ''), sort: String(req.query.sort || 'match'),
  };
  const programs = await browseForNgo(req.ngo, filters);
  res.render('ngo/programs', { title: 'CSR programs', programs, filters });
});

async function programPage(req, res, extra = {}) {
  const program = await getProgram(idParam(req));
  const record = (await trackRecords([req.ngo.id])).get(req.ngo.id);
  const mine = (await proposalsForNgo(req.ngo.id)).find((p) => p.program_id === program.id);
  const view = {
    title: program.title, program, mine, match: matchScore(program, req.ngo, record),
    accepting: isAcceptingApplications(program), MAX_MILESTONES, ...extra,
  };
  return extra.err ? renderFormError(res, extra.err, 'ngo/program', view) : res.render('ngo/program', view);
}

router.get('/programs/:id', requireNgoProfile, (req, res) => programPage(req, res));

router.post('/programs/:id/apply', requireNgoProfile, async (req, res) => {
  try {
    const data = validate(proposalSchema, req.body);
    const p = await submitProposal(req.ngo, req.user.id, idParam(req), data);
    res.flash('success', 'Proposal submitted. You will be notified when the company responds.');
    res.redirect(`/ngo/proposals/${p.id}`);
  } catch (err) {
    if (!err.expose) throw err;
    await programPage(req, res, { err, values: req.body });
  }
});

// ---------------- proposals & milestones ----------------
router.get('/proposals', requireNgoProfile, async (req, res) => {
  res.render('ngo/proposals', { title: 'My proposals', proposals: await proposalsForNgo(req.ngo.id) });
});

router.get('/proposals/:id', requireNgoProfile, async (req, res) => {
  const proposal = await viewableProposal(req.user, idParam(req));
  if (proposal.ngo_user_id !== req.user.id) throw forbidden();
  const nextOpen = proposal.milestones.find((m) => m.status !== 'approved');
  res.render('ngo/proposal', {
    title: proposal.title, proposal, nextOpenId: nextOpen?.id, trail: await auditTrail('proposal', proposal.id),
  });
});

router.post('/milestones/:id/evidence', requireNgoProfile, upload.single('evidence'), async (req, res) => {
  const { note } = validate(evidenceSchema, req.body);
  const proposalId = await submitEvidence(req.ngo, req.user.id, idParam(req), { note }, req.file);
  res.flash('success', 'Evidence submitted for review.');
  res.redirect(`/ngo/proposals/${proposalId}`);
});

export default router;
