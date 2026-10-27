import { query, num } from '../db/index.js';
import { CAUSES } from '../lib/constants.js';

/**
 * CSR compliance picture for a company.
 *  obligation   – the 2% amount the board must spend this fiscal year (entered by the company)
 *  committed    – money promised to NGOs through approved proposals
 *  released     – money actually disbursed after milestone evidence was approved ("spent")
 *  unallocated  – obligation not yet committed to any project (the risk number)
 */
export async function complianceSummary(company) {
  const obligation = num(company.csr_obligation);
  const [totals] = await query(
    `SELECT coalesce(sum(budget),0) AS budgeted, coalesce(sum(committed),0) AS committed,
            coalesce(sum(released),0) AS released, count(*)::int AS programs
       FROM programs WHERE company_id = $1`,
    [company.id],
  );
  const committed = num(totals.committed);
  const released = num(totals.released);

  const byCauseRows = await query(
    `SELECT cause, sum(committed) AS committed, sum(released) AS released
       FROM programs WHERE company_id = $1 GROUP BY cause HAVING sum(committed) > 0 ORDER BY sum(committed) DESC`,
    [company.id],
  );
  const byCause = byCauseRows.map((r) => ({
    cause: r.cause, label: CAUSES[r.cause] || r.cause, committed: num(r.committed), released: num(r.released),
  }));

  const [pending] = await query(
    `SELECT
       (SELECT count(*)::int FROM proposals pr JOIN programs p ON p.id = pr.program_id
         WHERE p.company_id = $1 AND pr.status IN ('submitted','shortlisted')) AS proposals,
       (SELECT count(*)::int FROM milestones m JOIN proposals pr ON pr.id = m.proposal_id
          JOIN programs p ON p.id = pr.program_id
         WHERE p.company_id = $1 AND m.status = 'submitted') AS milestones`,
    [company.id],
  );

  const reviewQueue = await query(
    `SELECT m.id, m.seq, m.title, m.amount, m.submitted_at, pr.id AS proposal_id, pr.title AS proposal_title, n.name AS ngo_name
       FROM milestones m JOIN proposals pr ON pr.id = m.proposal_id JOIN ngos n ON n.id = pr.ngo_id
       JOIN programs p ON p.id = pr.program_id
      WHERE p.company_id = $1 AND m.status = 'submitted' ORDER BY m.submitted_at LIMIT 10`,
    [company.id],
  );

  const [overdue] = await query(
    `SELECT count(*)::int AS n FROM milestones m JOIN proposals pr ON pr.id = m.proposal_id
       JOIN programs p ON p.id = pr.program_id
      WHERE p.company_id = $1 AND pr.status = 'approved' AND m.status IN ('pending','revision') AND m.due_date < CURRENT_DATE`,
    [company.id],
  );

  const pct = (a) => (obligation > 0 ? Math.min(100, Math.round((a / obligation) * 1000) / 10) : 0);
  return {
    obligation,
    committed,
    released,
    budgeted: num(totals.budgeted),
    unallocated: Math.max(0, obligation - committed),
    committedPct: pct(committed),
    releasedPct: pct(released),
    programs: totals.programs,
    byCause,
    pendingProposals: pending.proposals,
    pendingMilestones: pending.milestones,
    overdueMilestones: overdue.n,
    reviewQueue: reviewQueue.map((r) => ({ ...r, amount: num(r.amount) })),
  };
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection from user-supplied text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per funded project — the shape a CSR committee / annual report needs. */
export async function complianceCsv(company) {
  const rows = await query(
    `SELECT pg.title AS program, pg.cause, n.name AS ngo, n.csr1_number, array_to_string(pg.states, '; ') AS states,
            pr.title AS project, pr.status, pr.amount AS approved_amount, pr.decided_at,
            coalesce(sum(m.amount) FILTER (WHERE m.status='approved'), 0) AS released,
            count(m.id) FILTER (WHERE m.status='approved')::int AS milestones_done, count(m.id)::int AS milestones_total
       FROM proposals pr
       JOIN programs pg ON pg.id = pr.program_id
       JOIN ngos n ON n.id = pr.ngo_id
       LEFT JOIN milestones m ON m.proposal_id = pr.id
      WHERE pg.company_id = $1 AND pr.status IN ('approved','completed')
      GROUP BY pr.id, pg.id, n.id ORDER BY pg.title, n.name`,
    [company.id],
  );
  const header = ['Program', 'Schedule VII cause', 'Implementing NGO', 'CSR-1 number', 'States', 'Project',
    'Status', 'Approved amount (INR)', 'Released amount (INR)', 'Milestones done', 'Milestones total', 'Approved on'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.program, CAUSES[r.cause] || r.cause, r.ngo, r.csr1_number, r.states, r.project, r.status,
      num(r.approved_amount).toFixed(2), num(r.released).toFixed(2), r.milestones_done, r.milestones_total,
      r.decided_at ? new Date(r.decided_at).toISOString().slice(0, 10) : '',
    ].map(csvCell).join(','));
  }
  const summary = await complianceSummary(company);
  lines.push('');
  lines.push(['Fiscal year', company.fiscal_year].map(csvCell).join(','));
  lines.push(['CSR obligation (INR)', summary.obligation.toFixed(2)].map(csvCell).join(','));
  lines.push(['Committed (INR)', summary.committed.toFixed(2)].map(csvCell).join(','));
  lines.push(['Released (INR)', summary.released.toFixed(2)].map(csvCell).join(','));
  lines.push(['Unallocated (INR)', summary.unallocated.toFixed(2)].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
