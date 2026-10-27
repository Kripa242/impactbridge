# ImpactBridge

**CSR fund matching and milestone-based disbursement for companies and NGOs in India.**

> Live app: `<add your Render URL here>` · Demo video: `<add link>`

## Problem statement

Under Section 135 of the Companies Act, 2013, qualifying companies must spend 2% of their average net profit on CSR activities listed in Schedule VII. In practice, CSR teams struggle with two things:

1. **Finding the right implementing partner.** CSR managers need NGOs that are *legally eligible* (registered on the MCA CSR-1 portal, with 12A/80G) and that actually work on the cause and in the region they want to fund. Discovery happens through personal networks, emails and spreadsheets.
2. **Proving the money was used.** Funds are often released up front, with impact reported loosely at year-end. Boards and auditors need to see what was committed, what was spent, and on what evidence — and unspent CSR has regulatory consequences.

NGOs face the mirror image: no visibility into which companies are funding their cause, opaque decisions, and unpredictable fund flows.

## Target users

| Role | Who | What they need |
|---|---|---|
| **Company (CSR manager)** | CSR / sustainability team at a company with a CSR obligation | Publish programs, find fitting verified NGOs, release funds against evidence, track compliance |
| **NGO** | Programme / fundraising lead at a registered NGO | Get verified once, find relevant programs, apply, get paid per milestone |
| **Platform admin** | ImpactBridge operations | Verify NGO registration details before they can receive money |

## Solution

ImpactBridge turns the CSR funding cycle into a structured workflow:

**Verify → Match → Commit → Release → Report**

- NGOs are verified before they can apply.
- Programs and proposals are ranked by an explainable match score.
- Approving a proposal *commits* budget atomically — a program can never be promised more than it has.
- Money is *released* milestone by milestone, in order, only after the company accepts evidence.
- The company dashboard tracks obligation vs committed vs released and exports a CSV report.

## Key features (core workflows)

1. **NGO onboarding & verification**
   - NGO submits CSR-1, PAN, 12A and 80G numbers (format-validated), cause areas and states.
   - Admin verifies or rejects with a reason; the NGO is notified.
   - Only `verified` NGOs can apply. Changing any registration number on a verified profile automatically sends it back to the verification queue.
2. **CSR programs & explainable matching**
   - Companies publish programs (Schedule VII cause, states, budget, deadline).
   - NGOs browse open programs ranked by a 0–100 match score: cause fit (50) + geographic overlap (30, Pan-India aware) + track record (20, share of milestones accepted first time). Every score shows its reasons.
   - Search, filter by cause/state, sort by match/deadline/budget.
3. **Proposals with milestone plans**
   - NGO applies with 1–8 milestones (title, amount, due date). The requested amount *is* the sum of milestones, so they can't disagree. Dates must be chronological and after the application deadline.
   - One proposal per NGO per program (DB unique constraint); requests above the available budget are refused.
   - Company sees proposals ranked by match score and can shortlist, approve or reject (reason required).
4. **Budget commitment (concurrency-safe)**
   - Approval runs in a transaction that locks the program row (`SELECT … FOR UPDATE`), re-checks remaining budget, then commits it. Status updates are conditional (`WHERE status = ANY(...)`), so stale tabs or double clicks can't decide twice.
   - A `CHECK (committed <= budget AND released <= committed)` constraint is the last line of defence.
5. **Milestone evidence & fund release**
   - NGO submits a progress report and optional evidence file (PDF/PNG/JPEG, ≤ 2 MB) for the next milestone — milestones must be completed in order.
   - Company approves (tranche released, program `released` updated) or requests changes with a note. When the last milestone is approved the proposal becomes `completed`.
   - Evidence downloads are authorised per file (owning NGO, funding company, admin).
6. **Compliance dashboard & report**
   - Obligation, committed, released, unallocated; progress bar; breakdown by cause; review queue; overdue milestone alert.
   - CSV export per funded project (Excel-friendly, with formula-injection protection).
7. **Notifications & audit trail** — every state change writes an audit log entry and notifies the other party in the same transaction.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22, Express 5 | Simple, mature, native async error handling |
| Views | Server-rendered EJS + small vanilla JS | Fast pages, works without JS, no build step; JS only enhances (milestone builder, confirmations, double-submit guard) |
| Database | PostgreSQL (`pg`) | Relational data with real transactions, row locks, CHECK/UNIQUE constraints and arrays |
| Local DB | PGlite (embedded Postgres in WASM) | Same SQL dialect locally and in tests with zero setup |
| Auth | bcrypt + JWT in an httpOnly, SameSite=Lax cookie | No session store needed; cookie isn't readable by JS |
| Validation | Zod | Declarative schemas, per-field error messages |
| Security | helmet (CSP), express-rate-limit | Security headers, brute-force protection on login/register |
| Uploads | multer (memory) → Postgres `BYTEA` | Files persist with the data on hosts with ephemeral disks (Render free tier) |
| Tests | `node:test` | Built in, no extra tooling |

## Architecture

```
Browser ──HTTP──► Express app (src/app.js)
                   ├─ helmet, static, body/cookie parsing, flash messages
                   ├─ loadUser middleware ── verifies JWT, loads user + company/NGO
                   ├─ routes/ (thin: parse → validate → call service → render/redirect)
                   │    auth.js · ngo.js · company.js · admin.js · common.js
                   ├─ services/ (business rules & SQL, transaction boundaries)
                   │    users · orgs · programs · proposals · compliance · activity
                   ├─ lib/ (pure: validation schemas, match scoring, constants, errors)
                   └─ db/ (adapter: pg in prod, PGlite locally; schema.sql applied on boot)
                                  │
                                  ▼
                             PostgreSQL
```

**Data model**

```
users ─┬─ companies ── programs ──┐
       └─ ngos ───────────────────┴── proposals ── milestones ── files
notifications (per user) · audit_log (actor, action, entity)
```

Key decisions:
- **Business rules live in services, not routes**, and are covered by tests that run against a real Postgres engine (PGlite in memory).
- **Money invariants are enforced twice**: in application logic (clear error messages) and in DB constraints (can't be bypassed).
- **Errors**: services throw `AppError`s with safe messages; forms re-render with field-level errors and the user's input; other failed POSTs redirect back with a flash message; unexpected errors are logged and shown generically.
- **Dates** are kept as `YYYY-MM-DD` strings end-to-end to avoid IST/UTC off-by-one bugs.

## Security

- Passwords hashed with bcrypt; login returns the same error (and similar timing) for unknown email and wrong password.
- Session JWT in an `httpOnly`, `SameSite=Lax`, `Secure` (in production) cookie; `JWT_SECRET` required in production.
- Role-based authorisation on every route plus ownership checks in services (a company can only act on its own programs; an NGO only on its own proposals).
- Content-Security-Policy via helmet; all output escaped by EJS.
- Rate limiting on login/registration; post-login redirects restricted to local paths.
- Upload type/size checks on client and server; files served with `nosniff` and only to authorised users.
- All SQL is parameterised. No secrets in the repository (`.env` is git-ignored).

## Local setup

Requirements: Node.js 22+.

```bash
git clone <repo-url> && cd impactbridge
npm install
cp .env.example .env        # optional; defaults work locally
npm run dev                 # http://localhost:3000
```

With no `DATABASE_URL`, the app uses an embedded Postgres in `./.data`. With `SEED_DEMO=true` (the default in `.env.example`) an empty database is filled with fictional demo organisations.

Run tests:

```bash
npm test
```

### Demo accounts (password `demo1234`)

| Role | Email | Try this |
|---|---|---|
| Company | `csr@tatvasteel.demo` | Review milestone 2 of "Reading Corners", decide on the water proposal, export the CSV |
| Company | `csr@nimbussoft.demo` | Compare two proposals with different match scores |
| NGO (verified) | `team@akshara.demo` | Funded project in progress; browse ranked programs |
| NGO (verified) | `contact@udaan.demo` | Proposal awaiting decision |
| NGO (pending) | `info@greenroots.demo` | See the "awaiting verification" experience |
| Admin | `admin@impactbridge.demo` | Verify Green Roots Society |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Production | Postgres connection string. Empty → embedded PGlite in `./.data` |
| `JWT_SECRET` | Production | Long random string for signing session tokens |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional | Creates the platform admin on boot if missing |
| `SEED_DEMO` | Optional | `true` seeds demo data into an empty database |
| `PGSSL` | Optional | `false` to disable SSL to Postgres |
| `PORT` | Optional | Default `3000` |
| `NODE_ENV` | Production | `production` enables secure cookies |

## Deployment

The repo includes a Render Blueprint (`render.yaml`) that creates a free Postgres database and the web service:

1. Push the repo to GitHub.
2. On [Render](https://render.com): **New → Blueprint**, select the repo, and apply.
3. Optionally set `ADMIN_EMAIL` / `ADMIN_PASSWORD`. `JWT_SECRET` is generated automatically.
4. Open the service URL. Demo data is seeded on first boot.

Any host with Node 22 and Postgres works: set the environment variables above and run `npm ci && npm start`. The schema is applied automatically on boot (idempotent).

## Project structure

```
src/
  app.js            Express app, middleware, error handling
  server.js         Boot: DB init, admin, demo seed, graceful shutdown
  db/               schema.sql, adapter (pg / PGlite), demo seed
  lib/              validation, matching, constants, errors
  middleware/       authentication & role guards
  routes/           auth, ngo, company, admin, common
  services/         business logic & SQL
views/              EJS templates (partials, ngo/, company/, admin/)
public/             styles.css, app.js
tests/              unit + workflow tests
```

## Limitations & next steps

- NGO verification is manual against entered numbers; integrating MCA CSR-1 / Income Tax verification APIs would automate it.
- Fund release is recorded in-app; integrating a payment rail (e.g. bank transfer APIs) would execute it.
- Email notifications (currently in-app only) and multi-user company teams with approver roles.

## AI usage

AI assistance (Claude) was used for brainstorming, scaffolding and code generation. The design, business rules and tests were reviewed and verified by running the application and the test suite.
