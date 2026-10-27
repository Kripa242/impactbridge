import { Router } from 'express';
import { query, num } from '../db/index.js';
import { requireAuth, homeFor } from '../middleware/auth.js';
import { listNotifications, markAllRead } from '../services/activity.js';
import { evidenceFile } from '../services/proposals.js';
import { idParam } from './_form.js';

const router = Router();

router.get('/', async (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  const [stats] = await query(
    `SELECT (SELECT count(*)::int FROM ngos WHERE status = 'verified') AS ngos,
            (SELECT count(*)::int FROM programs WHERE status = 'open' AND deadline >= CURRENT_DATE) AS programs,
            (SELECT coalesce(sum(released), 0) FROM programs) AS released`,
  );
  res.render('home', { title: 'ImpactBridge', stats: { ...stats, released: num(stats.released) } });
});

router.get('/notifications', requireAuth, async (req, res) => {
  const items = await listNotifications(req.user.id);
  await markAllRead(req.user.id);
  res.locals.unread = 0;
  res.render('notifications', { title: 'Notifications', items });
});

/** Evidence download — authorised per file (owning NGO, funding company, admin). */
router.get('/files/:id', requireAuth, async (req, res) => {
  const f = await evidenceFile(req.user, idParam(req));
  const safeName = f.filename.replace(/[^\w.\- ]/g, '_');
  res.set({
    'Content-Type': f.mime,
    'Content-Length': f.size,
    'Content-Disposition': `inline; filename="${safeName}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.send(Buffer.from(f.data));
});

export default router;
