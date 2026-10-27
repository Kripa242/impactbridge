import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate, registerSchema, loginSchema } from '../lib/validation.js';
import { register, authenticate } from '../services/users.js';
import { startSession, endSession, homeFor } from '../middleware/auth.js';
import { renderFormError } from './_form.js';

const router = Router();

// Brute-force protection for credential endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).render(req.path === '/login' ? 'auth/login' : 'auth/register', {
      title: 'Slow down', values: req.body, errors: {}, next: '',
      formError: 'Too many attempts. Please wait a few minutes and try again.',
    }),
});

// Only allow redirecting to local paths after login (prevents open redirects).
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/register', { title: 'Create account', values: { role: req.query.role } });
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const data = validate(registerSchema, req.body);
    const user = await register(data);
    startSession(res, user);
    res.flash('success', `Welcome, ${user.name}! Let's set up your profile.`);
    res.redirect(user.role === 'company' ? '/company/setup' : '/ngo/profile');
  } catch (err) {
    renderFormError(res, err, 'auth/register', { title: 'Create account', values: { ...req.body, password: '' } });
  }
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Log in', next: safeNext(req.query.next) || '' });
});

router.post('/login', authLimiter, async (req, res) => {
  const next = safeNext(req.body.next);
  try {
    const { email, password } = validate(loginSchema, req.body);
    const user = await authenticate(email, password);
    startSession(res, user);
    res.redirect(next || homeFor(user));
  } catch (err) {
    renderFormError(res, err, 'auth/login', { title: 'Log in', next: next || '', values: { email: req.body.email } });
  }
});

router.post('/logout', (req, res) => {
  endSession(res);
  res.redirect('/');
});

export default router;
