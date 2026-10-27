-- ImpactBridge schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('company', 'ngo', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  cin            TEXT NOT NULL,
  fiscal_year    TEXT NOT NULL,
  csr_obligation NUMERIC(14, 2) NOT NULL CHECK (csr_obligation >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ngos (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  csr1_number TEXT NOT NULL UNIQUE,
  pan         TEXT NOT NULL,
  reg_12a     TEXT NOT NULL,
  reg_80g     TEXT NOT NULL,
  causes      TEXT[] NOT NULL,
  states      TEXT[] NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS programs (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  cause       TEXT NOT NULL,
  states      TEXT[] NOT NULL,
  budget      NUMERIC(14, 2) NOT NULL CHECK (budget > 0),
  committed   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  released    NUMERIC(14, 2) NOT NULL DEFAULT 0,
  deadline    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last line of defence: the database itself refuses over-commitment / over-release.
  CONSTRAINT programs_money_guard CHECK (
    committed >= 0 AND committed <= budget AND released >= 0 AND released <= committed
  )
);
CREATE INDEX IF NOT EXISTS programs_open_idx ON programs (status, deadline);
CREATE INDEX IF NOT EXISTS programs_company_idx ON programs (company_id);

CREATE TABLE IF NOT EXISTS files (
  id          SERIAL PRIMARY KEY,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id            SERIAL PRIMARY KEY,
  program_id    INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  ngo_id        INTEGER NOT NULL REFERENCES ngos(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  amount        NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted', 'shortlisted', 'approved', 'rejected', 'completed')),
  decision_note TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, ngo_id)
);
CREATE INDEX IF NOT EXISTS proposals_ngo_idx ON proposals (ngo_id);

CREATE TABLE IF NOT EXISTS milestones (
  id               SERIAL PRIMARY KEY,
  proposal_id      INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  title            TEXT NOT NULL,
  amount           NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  due_date         DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'submitted', 'approved', 'revision')),
  evidence_note    TEXT,
  evidence_file_id INTEGER REFERENCES files(id),
  review_note      TEXT,
  revision_count   INTEGER NOT NULL DEFAULT 0,
  submitted_at     TIMESTAMPTZ,
  reviewed_at      TIMESTAMPTZ,
  UNIQUE (proposal_id, seq)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  link       TEXT,
  is_read    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, is_read);

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
