import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { ngosForReview, ngoStatusCounts, reviewNgo } from '../services/orgs.js';
import { idParam } from './_form.js';

const router = Router();
router.use(requireRole('admin'));

router.get('/ngos', async (req, res) => {
  const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const [ngos, counts] = await Promise.all([ngosForReview(status), ngoStatusCounts()]);
  res.render('admin/ngos', { title: 'NGO verification', ngos, counts, status });
});

router.post('/ngos/:id/review', async (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const n = await reviewNgo(req.user.id, idParam(req), req.body.decision, note);
  res.flash('success', `${n.name} ${n.status === 'verified' ? 'verified' : 'rejected'}.`);
  res.redirect('/admin/ngos');
});

export default router;
