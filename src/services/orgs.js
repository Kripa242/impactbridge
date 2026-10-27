import { query, tx, isUniqueViolation } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit, notify } from './activity.js';

// ---------------- Companies ----------------
export async function companyByUser(userId) {
  const [c] = await query('SELECT * FROM companies WHERE user_id = $1', [userId]);
  return c || null;
}

export async function saveCompany(userId, d) {
  const [c] = await query(
    `INSERT INTO companies (user_id, name, cin, fiscal_year, csr_obligation)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET name = EXCLUDED.name, cin = EXCLUDED.cin, fiscal_year = EXCLUDED.fiscal_year,
           csr_obligation = EXCLUDED.csr_obligation, updated_at = now()
     RETURNING *`,
    [userId, d.name, d.cin, d.fiscalYear, d.obligation],
  );
  await audit(userId, 'company_profile_saved', 'company', c.id);
  return c;
}

// ---------------- NGOs ----------------
export async function ngoByUser(userId) {
  const [n] = await query('SELECT * FROM ngos WHERE user_id = $1', [userId]);
  return n || null;
}

export async function ngoById(id) {
  const [n] = await query('SELECT * FROM ngos WHERE id = $1', [id]);
  return n || null;
}

const REGULATORY_FIELDS = ['csr1_number', 'pan', 'reg_12a', 'reg_80g'];

/**
 * Create or update an NGO profile.
 * Business rule: changing any registration number on a verified/rejected profile sends it
 * back to the admin queue — companies must never fund against unverified credentials.
 */
export async function saveNgo(userId, d) {
  const row = {
    name: d.name, description: d.description, csr1_number: d.csr1Number, pan: d.pan,
    reg_12a: d.reg12a, reg_80g: d.reg80g, causes: d.causes, states: d.states,
  };
  try {
    return await tx(async (q) => {
      const [existing] = await q('SELECT * FROM ngos WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!existing) {
        const [n] = await q(
          `INSERT INTO ngos (user_id, name, description, csr1_number, pan, reg_12a, reg_80g, causes, states)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [userId, row.name, row.description, row.csr1_number, row.pan, row.reg_12a, row.reg_80g, row.causes, row.states],
        );
        await audit(userId, 'ngo_submitted_for_verification', 'ngo', n.id, null, q);
        await notifyAdmins(q, `${n.name} submitted their profile for verification`, '/admin/ngos');
        return { ngo: n, requeued: true };
      }
      const regChanged = REGULATORY_FIELDS.some((f) => existing[f] !== row[f]);
      const requeue = regChanged && existing.status !== 'pending';
      const [n] = await q(
        `UPDATE ngos SET name=$2, description=$3, csr1_number=$4, pan=$5, reg_12a=$6, reg_80g=$7,
                causes=$8, states=$9, updated_at=now(),
                status = CASE WHEN $10::boolean THEN 'pending' ELSE status END,
                review_note = CASE WHEN $10::boolean THEN NULL ELSE review_note END
          WHERE id = $1 RETURNING *`,
        [existing.id, row.name, row.description, row.csr1_number, row.pan, row.reg_12a, row.reg_80g,
          row.causes, row.states, requeue],
      );
      await audit(userId, requeue ? 'ngo_resubmitted_for_verification' : 'ngo_profile_updated', 'ngo', n.id, null, q);
      if (requeue) await notifyAdmins(q, `${n.name} changed registration details — re-verification needed`, '/admin/ngos');
      return { ngo: n, requeued: requeue };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Another NGO is already registered with this CSR-1 number.');
    throw err;
  }
}

async function notifyAdmins(q, message, link) {
  const admins = await q("SELECT id FROM users WHERE role = 'admin'");
  for (const a of admins) await notify(a.id, message, link, q);
}

export async function ngosForReview(status = 'pending') {
  return query(
    `SELECT n.*, u.email FROM ngos n JOIN users u ON u.id = n.user_id
      WHERE n.status = $1 ORDER BY n.updated_at ASC`,
    [status],
  );
}

export async function ngoStatusCounts() {
  const rows = await query('SELECT status, count(*)::int AS n FROM ngos GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Admin decision. Only pending profiles can be decided — guards against double-clicks / stale tabs. */
export async function reviewNgo(adminId, ngoId, decision, note) {
  if (!['verified', 'rejected'].includes(decision)) throw badRequest('Unknown decision.');
  if (decision === 'rejected' && !note) throw badRequest('Give the NGO a reason so they can fix their profile.');
  return tx(async (q) => {
    const [n] = await q(
      `UPDATE ngos SET status = $2, review_note = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [ngoId, decision, note || null],
    );
    if (!n) {
      const [exists] = await q('SELECT status FROM ngos WHERE id = $1', [ngoId]);
      if (!exists) throw notFound('NGO');
      throw conflict(`This NGO is already ${exists.status}.`);
    }
    await audit(adminId, `ngo_${decision}`, 'ngo', ngoId, note ? { note } : null, q);
    await notify(
      n.user_id,
      decision === 'verified'
        ? 'Your NGO profile is verified — you can now apply to CSR programs.'
        : `Your NGO profile needs changes: ${note}`,
      decision === 'verified' ? '/ngo/programs' : '/ngo/profile',
      q,
    );
    return n;
  });
}

/** First-time-acceptance track record for many NGOs at once: Map(ngoId -> {approved, revisions}). */
export async function trackRecords(ngoIds) {
  const map = new Map();
  if (!ngoIds.length) return map;
  const rows = await query(
    `SELECT p.ngo_id,
            count(*) FILTER (WHERE m.status = 'approved')::int AS approved,
            coalesce(sum(m.revision_count), 0)::int AS revisions
       FROM milestones m JOIN proposals p ON p.id = m.proposal_id
      WHERE p.ngo_id = ANY($1::int[])
      GROUP BY p.ngo_id`,
    [ngoIds],
  );
  for (const r of rows) map.set(r.ngo_id, { approved: r.approved, revisions: r.revisions });
  return map;
}
