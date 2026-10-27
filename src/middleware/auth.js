import jwt from 'jsonwebtoken';
import { forbidden } from '../lib/errors.js';
import { findUser } from '../services/users.js';
import { unreadCount } from '../services/activity.js';
import { companyByUser, ngoByUser } from '../services/orgs.js';

const COOKIE = 'ib_session';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  return s || 'dev-only-insecure-secret';
};

export function startSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, secret(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true, // not readable by JS → XSS cannot steal it
    sameSite: 'lax', // not sent on cross-site POSTs → basic CSRF protection
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}

export const endSession = (res) => res.clearCookie(COOKIE);

/**
 * Resolve the logged-in user (if any) on every request and expose it to views.
 * The user is re-read from the DB so deleted accounts / role changes take effect immediately.
 */
export async function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.unread = 0;
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, secret());
    const user = await findUser(payload.sub);
    if (!user) {
      endSession(res);
      return next();
    }
    req.user = user;
    res.locals.user = user;
    res.locals.unread = await unreadCount(user.id);
    if (user.role === 'company') req.company = res.locals.company = await companyByUser(user.id);
    if (user.role === 'ngo') req.ngo = res.locals.ngo = await ngoByUser(user.id);
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      endSession(res);
      return next();
    }
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  const back = encodeURIComponent(req.originalUrl);
  res.redirect(`/login?next=${back}`);
}

export const requireRole = (...roles) => [
  requireAuth,
  (req, res, next) => (roles.includes(req.user.role) ? next() : next(forbidden())),
];

/** Company pages (other than setup) need a company profile first. */
export function requireCompanyProfile(req, res, next) {
  if (req.company) return next();
  res.flash('info', 'Set up your company profile first.');
  res.redirect('/company/setup');
}

/** NGO pages (other than profile) need an NGO profile first. */
export function requireNgoProfile(req, res, next) {
  if (req.ngo) return next();
  res.flash('info', 'Complete your NGO profile first — it is sent to our team for verification.');
  res.redirect('/ngo/profile');
}

/** Where each role lands after login. */
export const homeFor = (user) =>
  ({ admin: '/admin/ngos', company: '/company/dashboard', ngo: '/ngo/programs' })[user.role] || '/';
