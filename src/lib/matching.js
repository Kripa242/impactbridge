import { PAN_INDIA } from './constants.js';

/**
 * Score how well an NGO fits a CSR program (0–100) and explain why.
 *
 *  - Cause fit (50):   the program's Schedule VII cause is one the NGO works on.
 *  - Geography (30):   overlap between program states and NGO operating states.
 *                      Pan-India on either side counts as full coverage.
 *  - Track record (20): share of the NGO's reviewed milestones approved first time
 *                      (approved / (approved + sent back)). NGOs with no history get a
 *                      neutral 10 so newcomers are not buried.
 *
 * Pure function — no I/O — so it is easy to unit test and reuse in both directions
 * (programs ranked for an NGO, proposals ranked for a company).
 */
export function matchScore(program, ngo, record = { approved: 0, revisions: 0 }) {
  const reasons = [];
  let cause = 0;
  let geo = 0;
  let track = 0;

  if ((ngo.causes || []).includes(program.cause)) {
    cause = 50;
    reasons.push('Works on this cause area');
  } else {
    reasons.push('Different cause focus');
  }

  const pStates = program.states || [];
  const nStates = ngo.states || [];
  if (pStates.includes(PAN_INDIA) || nStates.includes(PAN_INDIA)) {
    geo = nStates.length && pStates.length ? 30 : 0;
    if (geo) reasons.push('Pan-India coverage');
  } else {
    const overlap = pStates.filter((s) => nStates.includes(s));
    if (overlap.length) {
      geo = Math.round(15 + 15 * (overlap.length / pStates.length));
      reasons.push(`Operates in ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? '…' : ''}`);
    } else {
      reasons.push('No overlap in operating states');
    }
  }

  const reviewed = (record.approved || 0) + (record.revisions || 0);
  if (reviewed === 0) {
    track = 10;
    reasons.push('New on ImpactBridge');
  } else {
    track = Math.round(20 * (record.approved / reviewed));
    reasons.push(`${record.approved}/${reviewed} milestones accepted first time`);
  }

  return { score: cause + geo + track, breakdown: { cause, geo, track }, reasons };
}

/** Human label for a score, used for badges. */
export function scoreLabel(score) {
  if (score >= 75) return 'Strong match';
  if (score >= 50) return 'Good match';
  if (score >= 30) return 'Partial match';
  return 'Weak match';
}
