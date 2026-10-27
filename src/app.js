import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './middleware/auth.js';
import { CAUSES, STATES } from './lib/constants.js';
import { scoreLabel } from './lib/matching.js';
import authRoutes from './routes/auth.js';
import ngoRoutes from './routes/ngo.js';
import companyRoutes from './routes/company.js';
import adminRoutes from './routes/admin.js';
import commonRoutes from './routes/common.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.set('trust proxy', 1); // behind Render/Railway proxy → correct secure cookies & rate-limit IPs

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
      },
    },
  }));
  app.use(express.static(path.join(root, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());

  // One-shot flash messages carried across a redirect in a short-lived cookie.
  app.use((req, res, next) => {
    res.locals.flash = null;
    if (req.cookies.flash) {
      try { res.locals.flash = JSON.parse(req.cookies.flash); } catch { /* ignore malformed */ }
      res.clearCookie('flash');
    }
    res.flash = (type, msg) => res.cookie('flash', JSON.stringify({ type, msg }), { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    next();
  });

  // View helpers
  Object.assign(app.locals, {
    CAUSES, STATES, scoreLabel,
    inr: (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }),
    fmtDate: (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''),
    fmtDateTime: (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''),
    daysLeft: (d) => Math.ceil((Date.parse(d) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5),
  });
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.values = {};
    res.locals.errors = {};
    res.locals.formError = null;
    next();
  });

  app.use(loadUser);

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(authRoutes);
  app.use(commonRoutes);
  app.use('/ngo', ngoRoutes);
  app.use('/company', companyRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', status: 404, message: 'We could not find that page.' }));

  // Central error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      err.status = 400; err.expose = true; err.message = 'Evidence file must be 2 MB or smaller.';
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = !err.expose
      ? 'Something went wrong on our side. Please try again.'
      : err.fieldErrors ? Object.values(err.fieldErrors)[0] : err.message;
    // For failed form posts, bounce back to the page with a message instead of a dead-end error page.
    if (req.method === 'POST' && status < 500 && !res.headersSent) {
      res.flash('error', message);
      return res.redirect(safeBack(req));
    }
    if (status === 401) return res.redirect('/login');
    res.status(status).render('error', { title: 'Error', status, message });
  });

  return app;
}

/** Same-origin path from the Referer header, so redirects can never leave the site. */
function safeBack(req) {
  try {
    const ref = new URL(req.get('Referer') || '/', `${req.protocol}://${req.get('host')}`);
    if (ref.host === req.get('host')) return ref.pathname + ref.search;
  } catch { /* fall through */ }
  return '/';
}
