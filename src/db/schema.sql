-- Conveyor relational schema (SQLite).
-- All timestamps are stored as INTEGER epoch milliseconds so that scheduling
-- arithmetic (run_at <= now, backoff windows) stays index-friendly and
-- timezone-free. Rendering into local time is a presentation concern.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- uuid
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Membership join table doubles as the RBAC store. Deleting either side
-- removes the membership but never cascades into the other entity.
CREATE TABLE IF NOT EXISTS organization_members (
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

-- ---------------------------------------------------------------------------
-- Queue configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS retry_policies (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  strategy      TEXT NOT NULL CHECK (strategy IN ('none','fixed','linear','exponential')),
  max_attempts  INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  base_delay_ms INTEGER NOT NULL DEFAULT 1000 CHECK (base_delay_ms >= 0),
  max_delay_ms  INTEGER NOT NULL DEFAULT 60000 CHECK (max_delay_ms >= 0),
  jitter        INTEGER NOT NULL DEFAULT 0,     -- boolean: add 0..25% random jitter
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS queues (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  priority              INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  max_concurrency       INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrency >= 1),
  rate_limit_per_minute INTEGER,                -- NULL = unlimited
  is_paused             INTEGER NOT NULL DEFAULT 0,
  retry_policy_id       TEXT REFERENCES retry_policies(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_queues_project ON queues(project_id);

-- ---------------------------------------------------------------------------
-- Jobs & executions
-- ---------------------------------------------------------------------------

-- Lifecycle: waiting -> queued/scheduled -> claimed -> running -> completed
--                                                             \-> scheduled (retry)
--                                                             \-> dead (DLQ)
-- 'scheduled' covers delayed jobs, one-off future jobs and retry backoff waits.
-- 'waiting' is used for workflow dependencies (depends_on not yet completed).
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  queue_id        TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  handler         TEXT NOT NULL,                -- worker handler name
  payload         TEXT NOT NULL DEFAULT '{}',   -- JSON blob, opaque to the server
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('waiting','queued','scheduled','claimed','running','completed','dead','canceled')),
  priority        INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  run_at          INTEGER,                      -- when a scheduled job becomes eligible
  attempts        INTEGER NOT NULL DEFAULT 0,   -- executions started so far
  max_attempts    INTEGER NOT NULL DEFAULT 3,   -- snapshot of retry policy at creation
  timeout_ms      INTEGER NOT NULL DEFAULT 60000,
  idempotency_key TEXT,
  batch_id        TEXT,                         -- groups jobs created via the batch API
  schedule_id     TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  depends_on      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  claimed_by      TEXT REFERENCES workers(id) ON DELETE SET NULL,
  claimed_at      INTEGER,
  started_at      INTEGER,
  finished_at     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (queue_id, idempotency_key)
);

-- The claim path scans queued jobs per queue ordered by priority then age.
CREATE INDEX IF NOT EXISTS idx_jobs_claim     ON jobs(status, queue_id, priority DESC, created_at);
-- The scheduler promotes due scheduled jobs; partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_jobs_due       ON jobs(run_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_jobs_queue     ON jobs(queue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_batch     ON jobs(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_worker    ON jobs(claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_depends   ON jobs(depends_on) WHERE depends_on IS NOT NULL;

-- One row per execution attempt; the job row only holds current state.
CREATE TABLE IF NOT EXISTS job_executions (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id    TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  worker_id   TEXT REFERENCES workers(id) ON DELETE SET NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','completed','failed','timed_out','lost')),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  error       TEXT,
  output      TEXT                              -- JSON result returned by the handler
);

CREATE INDEX IF NOT EXISTS idx_executions_job    ON job_executions(job_id, attempt);
-- Throughput metrics and per-queue rate limiting both scan recent executions.
CREATE INDEX IF NOT EXISTS idx_executions_queue  ON job_executions(queue_id, started_at);
CREATE INDEX IF NOT EXISTS idx_executions_window ON job_executions(started_at);

CREATE TABLE IF NOT EXISTS job_logs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES job_executions(id) ON DELETE CASCADE,
  level        TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs(job_id, created_at);

-- ---------------------------------------------------------------------------
-- Recurring schedules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id              TEXT PRIMARY KEY,
  queue_id        TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  handler         TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  is_active       INTEGER NOT NULL DEFAULT 1,
  next_run_at     INTEGER NOT NULL,
  last_run_at     INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (queue_id, name)
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON scheduled_jobs(next_run_at) WHERE is_active = 1;

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  hostname          TEXT,
  pid               INTEGER,
  status            TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','draining','offline')),
  max_concurrency   INTEGER NOT NULL DEFAULT 4,
  queue_names       TEXT,                       -- JSON array; NULL = subscribe to all queues
  registered_at     INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workers_heartbeat ON workers(status, last_heartbeat_at);

-- Rolling heartbeat history (pruned by the scheduler) for the dashboard.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id          TEXT PRIMARY KEY,
  worker_id   TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  rss_bytes   INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_worker ON worker_heartbeats(worker_id, created_at);

-- ---------------------------------------------------------------------------
-- Dead letter queue
-- ---------------------------------------------------------------------------

-- Snapshot of a permanently failed job. The original job row stays (status
-- 'dead') for history; the DLQ entry is what operators act on.
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id    TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  handler     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  error       TEXT,
  attempts    INTEGER NOT NULL,
  moved_at    INTEGER NOT NULL,
  requeued_at INTEGER                            -- set when an operator retries it
);

CREATE INDEX IF NOT EXISTS idx_dlq_queue ON dead_letter_jobs(queue_id, moved_at DESC);
