import { query, num } from '../db/index.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { matchScore } from '../lib/matching.js';
import { audit } from './activity.js';
import { trackRecords } from './orgs.js';

const shape = (p) =>
  p && {
    ...p,
    budget: num(p.budget),
    committed: num(p.committed),
    released: num(p.released),
    available: num(p.budget) - num(p.committed),
    deadline: p.deadline instanceof Date ? p.deadline.toISOString().slice(0, 10) : String(p.deadline).slice(0, 10),
  };

export const isAcceptingApplications = (p) =>
  p.status === 'open' && p.deadline >= new Date().toISOString().slice(0, 10) && p.available > 0;

export async function createProgram(company, userId, d) {
  const [p] = await query(
    `INSERT INTO programs (company_id, title, description, cause, states, budget, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [company.id, d.title, d.description, d.cause, d.states, d.budget, d.deadline],
  );
  await audit(userId, 'program_created', 'program', p.id, { budget: d.budget });
  return shape(p);
}

export async function getProgram(id) {
  const [p] = await query(
    `SELECT p.*, c.name AS company_name, c.user_id AS company_user_id
       FROM programs p JOIN companies c ON c.id = p.company_id WHERE p.id = $1`,
    [id],
  );
  if (!p) throw notFound('Program');
  return shape(p);
}

/** Load a program and assert the given company owns it. */
export async function ownedProgram(company, id) {
  const p = await getProgram(id);
  if (!company || p.company_id !== company.id) throw forbidden('This program belongs to another company.');
  return p;
}

export async function programsForCompany(companyId) {
  const rows = await query(
    `SELECT p.*,
            count(pr.id) FILTER (WHERE pr.status IN ('submitted','shortlisted'))::int AS pending_proposals,
            count(pr.id)::int AS total_proposals
       FROM programs p LEFT JOIN proposals pr ON pr.program_id = p.id
      WHERE p.company_id = $1
      GROUP BY p.id ORDER BY p.created_at DESC`,
    [companyId],
  );
  return rows.map(shape);
}

export async function setProgramStatus(company, userId, id, status) {
  const p = await ownedProgram(company, id);
  if (p.status === status) throw conflict(`Program is already ${status}.`);
  await query('UPDATE programs SET status = $2 WHERE id = $1', [id, status]);
  await audit(userId, `program_${status}`, 'program', id);
}

/**
 * Programs an NGO can browse, ranked by match score.
 * Filtering happens in SQL; scoring happens in JS (it needs the NGO's track record and is
 * cheap at this scale). Already-applied programs are flagged, not hidden.
 */
export async function browseForNgo(ngo, { q = '', cause = '', state = '', sort = 'match' } = {}) {
  const params = [ngo.id];
  const where = ["p.status = 'open'", 'p.deadline >= CURRENT_DATE', 'p.committed < p.budget'];
  if (q) {
    params.push(`%${q.trim().slice(0, 100)}%`);
    where.push(`(p.title ILIKE $${params.length} OR p.description ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (cause) {
    params.push(cause);
    where.push(`p.cause = $${params.length}`);
  }
  if (state) {
    params.push(state);
    where.push(`($${params.length} = ANY(p.states) OR 'Pan-India' = ANY(p.states))`);
  }
  const rows = await query(
    `SELECT p.*, c.name AS company_name, pr.id AS my_proposal_id, pr.status AS my_proposal_status
       FROM programs p
       JOIN companies c ON c.id = p.company_id
       LEFT JOIN proposals pr ON pr.program_id = p.id AND pr.ngo_id = $1
      WHERE ${where.join(' AND ')}`,
    params,
  );
  const record = (await trackRecords([ngo.id])).get(ngo.id);
  const list = rows.map((r) => ({ ...shape(r), match: matchScore(r, ngo, record) }));
  const sorters = {
    match: (a, b) => b.match.score - a.match.score || a.deadline.localeCompare(b.deadline),
    deadline: (a, b) => a.deadline.localeCompare(b.deadline),
    budget: (a, b) => b.available - a.available,
  };
  return list.sort(sorters[sort] || sorters.match);
}
