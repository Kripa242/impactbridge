import { query, tx, num, isUniqueViolation, isCheckViolation } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from '../lib/constants.js';
import { matchScore } from '../lib/matching.js';
import { audit, notify } from './activity.js';
import { trackRecords } from './orgs.js';
import { getProgram, isAcceptingApplications } from './programs.js';

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const shapeP = (p) => p && { ...p, amount: num(p.amount), released: num(p.released) };
const shapeM = (m) => m && { ...m, amount: num(m.amount), due_date: String(m.due_date).slice(0, 10) };

// Allowed proposal status transitions for a company decision.
const TRANSITIONS = {
  shortlist: { from: ['submitted'], to: 'shortlisted' },
  approve: { from: ['submitted', 'shortlisted'], to: 'approved' },
  reject: { from: ['submitted', 'shortlisted'], to: 'rejected' },
};

// ------------------------------------------------------------------ submit
/**
 * NGO applies to a program with a milestone plan.
 * Requested amount is derived from the milestones, so the two can never disagree.
 */
export async function submitProposal(ngo, userId, programId, d) {
  if (!ngo) throw forbidden('Complete your NGO profile before applying.');
  if (ngo.status !== 'verified') throw forbidden('Only verified NGOs can apply. Your profile is ' + ngo.status + '.');

  const program = await getProgram(programId);
  if (!isAcceptingApplications(program)) throw conflict('This program is no longer accepting applications.');

  const amount = Math.round(d.milestones.reduce((s, m) => s + m.amount, 0) * 100) / 100;
  if (amount > program.available) {
    throw badRequest(`Your milestones total ${inr(amount)}, but only ${inr(program.available)} of this program's budget is still available.`);
  }
  if (d.milestones.some((m) => m.due < program.deadline)) {
    throw badRequest(`Milestones must be due after the application deadline (${program.deadline}).`);
  }

  try {
    return await tx(async (q) => {
      const [p] = await q(
        `INSERT INTO proposals (program_id, ngo_id, title, summary, amount) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [program.id, ngo.id, d.title, d.summary, amount],
      );
      for (const [i, m] of d.milestones.entries()) {
        await q(
          'INSERT INTO milestones (proposal_id, seq, title, amount, due_date) VALUES ($1,$2,$3,$4,$5)',
          [p.id, i + 1, m.title, m.amount, m.due],
        );
      }
      await audit(userId, 'proposal_submitted', 'proposal', p.id, { amount, milestones: d.milestones.length }, q);
      await notify(program.company_user_id, `${ngo.name} applied to “${program.title}” for ${inr(amount)}`, `/company/proposals/${p.id}`, q);
      return shapeP(p);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You have already applied to this program.');
    throw err;
  }
}

// ------------------------------------------------------------------ read
export async function getProposal(id) {
  const [p] = await query(
    `SELECT pr.*, n.name AS ngo_name, n.user_id AS ngo_user_id, n.csr1_number, n.causes AS ngo_causes,
            n.states AS ngo_states, n.description AS ngo_description, n.status AS ngo_status,
            pg.title AS program_title, pg.company_id, pg.cause, pg.states AS program_states,
            c.name AS company_name, c.user_id AS company_user_id,
            coalesce((SELECT sum(amount) FROM milestones WHERE proposal_id = pr.id AND status = 'approved'), 0) AS released
       FROM proposals pr
       JOIN ngos n ON n.id = pr.ngo_id
       JOIN programs pg ON pg.id = pr.program_id
       JOIN companies c ON c.id = pg.company_id
      WHERE pr.id = $1`,
    [id],
  );
  if (!p) throw notFound('Proposal');
  const milestones = (await query('SELECT * FROM milestones WHERE proposal_id = $1 ORDER BY seq', [id])).map(shapeM);
  return { ...shapeP(p), milestones };
}

/** Load a proposal and check the viewer may see it (owning NGO, owning company, or admin). */
export async function viewableProposal(user, id) {
  const p = await getProposal(id);
  const ok = user.role === 'admin' || p.ngo_user_id === user.id || p.company_user_id === user.id;
  if (!ok) throw forbidden('You cannot view this proposal.');
  return p;
}

/** Proposals for one program, each with the NGO's match score, best first. */
export async function proposalsForProgram(program) {
  const rows = await query(
    `SELECT pr.*, n.name AS ngo_name, n.causes, n.states, n.csr1_number,
            (SELECT count(*)::int FROM milestones m WHERE m.proposal_id = pr.id) AS milestone_count,
            (SELECT count(*)::int FROM milestones m WHERE m.proposal_id = pr.id AND m.status = 'approved') AS milestones_done
       FROM proposals pr JOIN ngos n ON n.id = pr.ngo_id
      WHERE pr.program_id = $1`,
    [program.id],
  );
  const records = await trackRecords(rows.map((r) => r.ngo_id));
  const order = { submitted: 0, shortlisted: 0, approved: 1, completed: 2, rejected: 3 };
  return rows
    .map((r) => ({ ...shapeP(r), match: matchScore(program, r, records.get(r.ngo_id)) }))
    .sort((a, b) => order[a.status] - order[b.status] || b.match.score - a.match.score);
}

export async function proposalsForNgo(ngoId) {
  const rows = await query(
    `SELECT pr.*, pg.title AS program_title, c.name AS company_name,
            (SELECT count(*)::int FROM milestones m WHERE m.proposal_id = pr.id) AS milestone_count,
            (SELECT count(*)::int FROM milestones m WHERE m.proposal_id = pr.id AND m.status = 'approved') AS milestones_done,
            (SELECT count(*)::int FROM milestones m WHERE m.proposal_id = pr.id AND m.status = 'revision') AS needs_revision
       FROM proposals pr JOIN programs pg ON pg.id = pr.program_id JOIN companies c ON c.id = pg.company_id
      WHERE pr.ngo_id = $1 ORDER BY pr.created_at DESC`,
    [ngoId],
  );
  return rows.map(shapeP);
}

// ------------------------------------------------------------------ decide
/**
 * Company shortlists / approves / rejects a proposal.
 * Approval commits budget. The program row is locked (SELECT … FOR UPDATE) so two approvals
 * racing each other cannot both pass the "enough budget left" check; the status update is
 * conditional so a stale tab cannot decide an already-decided proposal.
 */
export async function decideProposal(company, userId, proposalId, action, note) {
  const t = TRANSITIONS[action];
  if (!t) throw badRequest('Unknown action.');
  if (action === 'reject' && !note) throw badRequest('Please give the NGO a reason for rejection.');

  try {
    return await tx(async (q) => {
      const [p] = await q(
        `SELECT pr.*, n.user_id AS ngo_user_id, n.name AS ngo_name
           FROM proposals pr JOIN ngos n ON n.id = pr.ngo_id WHERE pr.id = $1`,
        [proposalId],
      );
      if (!p) throw notFound('Proposal');
      const [program] = await q('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [p.program_id]);
      if (!company || program.company_id !== company.id) throw forbidden('This proposal belongs to another company.');
      if (!t.from.includes(p.status)) throw conflict(`This proposal is already ${p.status}.`);

      if (action === 'approve') {
        const available = num(program.budget) - num(program.committed);
        if (num(p.amount) > available) {
          throw conflict(`Approving needs ${inr(p.amount)} but only ${inr(available)} of the program budget is uncommitted.`);
        }
        await q('UPDATE programs SET committed = committed + $2 WHERE id = $1', [program.id, p.amount]);
      }
      const [updated] = await q(
        `UPDATE proposals SET status = $2, decision_note = $3, decided_at = now()
          WHERE id = $1 AND status = ANY($4::text[]) RETURNING *`,
        [p.id, t.to, note || null, t.from],
      );
      if (!updated) throw conflict('This proposal was just updated by someone else. Refresh and try again.');

      await audit(userId, `proposal_${t.to}`, 'proposal', p.id, note ? { note } : null, q);
      const msg = {
        shortlisted: `Your proposal “${p.title}” was shortlisted by ${company.name}.`,
        approved: `Your proposal “${p.title}” was approved for ${inr(p.amount)}! Submit evidence for milestone 1 when ready.`,
        rejected: `Your proposal “${p.title}” was not selected: ${note}`,
      }[t.to];
      await notify(p.ngo_user_id, msg, `/ngo/proposals/${p.id}`, q);
      return shapeP(updated);
    });
  } catch (err) {
    if (isCheckViolation(err)) throw conflict('That would exceed the program budget.');
    throw err;
  }
}

// ------------------------------------------------------------------ milestones
async function lockMilestone(q, milestoneId) {
  const [m] = await q(
    `SELECT m.*, pr.status AS proposal_status, pr.program_id, pr.title AS proposal_title, pr.id AS proposal_id,
            n.user_id AS ngo_user_id, n.name AS ngo_name, c.user_id AS company_user_id, c.id AS company_id
       FROM milestones m
       JOIN proposals pr ON pr.id = m.proposal_id
       JOIN ngos n ON n.id = pr.ngo_id
       JOIN programs pg ON pg.id = pr.program_id
       JOIN companies c ON c.id = pg.company_id
      WHERE m.id = $1 FOR UPDATE OF m`,
    [milestoneId],
  );
  if (!m) throw notFound('Milestone');
  return m;
}

/**
 * NGO submits evidence (report + optional file) for a milestone.
 * Rules: proposal must be approved; milestones are completed strictly in order;
 * only pending or sent-back milestones accept evidence.
 */
export async function submitEvidence(ngo, userId, milestoneId, { note }, file) {
  if (file) {
    if (!ALLOWED_MIME.includes(file.mimetype)) throw badRequest('Evidence must be a PDF, PNG or JPEG file.');
    if (file.size > MAX_UPLOAD_BYTES) throw badRequest('Evidence file must be 2 MB or smaller.');
  }
  return tx(async (q) => {
    const m = await lockMilestone(q, milestoneId);
    if (!ngo || m.ngo_user_id !== userId) throw forbidden('This milestone belongs to another NGO.');
    if (m.proposal_status !== 'approved') throw conflict('Evidence can only be submitted for approved proposals.');
    if (!['pending', 'revision'].includes(m.status)) throw conflict(`Milestone ${m.seq} is already ${m.status}.`);
    const [blocking] = await q(
      `SELECT seq FROM milestones WHERE proposal_id = $1 AND seq < $2 AND status <> 'approved' ORDER BY seq LIMIT 1`,
      [m.proposal_id, m.seq],
    );
    if (blocking) throw conflict(`Milestone ${blocking.seq} must be approved before you submit milestone ${m.seq}.`);

    let fileId = m.evidence_file_id;
    if (file) {
      const [f] = await q(
        'INSERT INTO files (uploaded_by, filename, mime, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [userId, file.originalname.slice(0, 200), file.mimetype, file.size, file.buffer],
      );
      fileId = f.id;
    }
    await q(
      `UPDATE milestones SET status = 'submitted', evidence_note = $2, evidence_file_id = $3, submitted_at = now()
        WHERE id = $1`,
      [m.id, note, fileId],
    );
    await audit(userId, 'milestone_submitted', 'proposal', m.proposal_id, { seq: m.seq, file: !!file }, q);
    await notify(m.company_user_id, `${m.ngo_name} submitted evidence for milestone ${m.seq} of “${m.proposal_title}”`,
      `/company/proposals/${m.proposal_id}`, q);
    return m.proposal_id;
  });
}

/**
 * Company reviews submitted evidence.
 *  approve → tranche released (program.released += amount); when the last milestone is
 *            approved the proposal becomes 'completed'.
 *  revise  → sent back to the NGO with a note; counts against first-time acceptance.
 */
export async function reviewMilestone(company, userId, milestoneId, action, note) {
  if (!['approve', 'revise'].includes(action)) throw badRequest('Unknown action.');
  if (action === 'revise' && !note) throw badRequest('Tell the NGO what needs to change.');
  try {
    return await tx(async (q) => {
      const m = await lockMilestone(q, milestoneId);
      if (!company || m.company_id !== company.id) throw forbidden('This milestone belongs to another company.');
      if (m.status !== 'submitted') throw conflict(`Milestone ${m.seq} is ${m.status}, not awaiting review.`);

      if (action === 'approve') {
        await q('SELECT id FROM programs WHERE id = $1 FOR UPDATE', [m.program_id]);
        await q(`UPDATE milestones SET status='approved', review_note=$2, reviewed_at=now() WHERE id=$1`, [m.id, note || null]);
        await q('UPDATE programs SET released = released + $2 WHERE id = $1', [m.program_id, m.amount]);
        const [{ remaining }] = await q(
          "SELECT count(*)::int AS remaining FROM milestones WHERE proposal_id = $1 AND status <> 'approved'",
          [m.proposal_id],
        );
        if (remaining === 0) {
          await q("UPDATE proposals SET status = 'completed' WHERE id = $1", [m.proposal_id]);
          await audit(userId, 'proposal_completed', 'proposal', m.proposal_id, null, q);
        }
        await audit(userId, 'milestone_approved', 'proposal', m.proposal_id, { seq: m.seq, released: num(m.amount) }, q);
        await notify(m.ngo_user_id,
          remaining === 0
            ? `All milestones of “${m.proposal_title}” approved — project completed 🎉`
            : `Milestone ${m.seq} approved — ${inr(m.amount)} released.`,
          `/ngo/proposals/${m.proposal_id}`, q);
      } else {
        await q(
          `UPDATE milestones SET status='revision', review_note=$2, reviewed_at=now(), revision_count = revision_count + 1
            WHERE id=$1`,
          [m.id, note],
        );
        await audit(userId, 'milestone_sent_back', 'proposal', m.proposal_id, { seq: m.seq, note }, q);
        await notify(m.ngo_user_id, `Milestone ${m.seq} needs changes: ${note}`, `/ngo/proposals/${m.proposal_id}`, q);
      }
      return m.proposal_id;
    });
  } catch (err) {
    if (isCheckViolation(err)) throw conflict('Release would exceed the committed amount.');
    throw err;
  }
}

/** Evidence file, only for the owning NGO, owning company or an admin. */
export async function evidenceFile(user, fileId) {
  const [f] = await query(
    `SELECT f.*, n.user_id AS ngo_user_id, c.user_id AS company_user_id
       FROM files f
       JOIN milestones m ON m.evidence_file_id = f.id
       JOIN proposals pr ON pr.id = m.proposal_id
       JOIN ngos n ON n.id = pr.ngo_id
       JOIN programs pg ON pg.id = pr.program_id
       JOIN companies c ON c.id = pg.company_id
      WHERE f.id = $1 LIMIT 1`,
    [fileId],
  );
  if (!f) throw notFound('File');
  if (!(user.role === 'admin' || user.id === f.ngo_user_id || user.id === f.company_user_id)) {
    throw forbidden('You cannot download this file.');
  }
  return f;
}
