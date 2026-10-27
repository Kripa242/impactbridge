import { query } from '../db/index.js';

// Both helpers accept an optional `q` (a transaction-scoped query fn) so they commit
// atomically with the change they describe.

export async function notify(userId, message, link = null, q = query) {
  await q('INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)', [userId, message, link]);
}

export async function audit(actorId, action, entity, entityId, detail = null, q = query) {
  await q(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entity, entityId, detail ? JSON.stringify(detail) : null],
  );
}

export async function listNotifications(userId, limit = 50) {
  return query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [userId, limit],
  );
}

export async function unreadCount(userId) {
  const [row] = await query(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = false',
    [userId],
  );
  return row.n;
}

export async function markAllRead(userId) {
  await query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [userId]);
}

export async function auditTrail(entity, entityId) {
  return query(
    `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity = $1 AND a.entity_id = $2 ORDER BY a.created_at, a.id`,
    [entity, entityId],
  );
}
