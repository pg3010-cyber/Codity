# Conveyor — Distributed Job Scheduler

Conveyor is a production-inspired job scheduling platform: a central API server owns the
job store and scheduling loop, while any number of stateless worker processes claim and
execute jobs over HTTP. It ships with a live web dashboard, retries with configurable
backoff, a dead letter queue, cron schedules, and role-based multi-tenant access.

```
 Dashboard (SPA) ──┐
                   ├──► API Server ──► SQLite (WAL)
 Worker ×N ────────┘      │
                          └─ Scheduler loop (promote / cron / reap)
```

## Features

- **Auth & tenancy** — JWT auth; users belong to organizations with roles
  (`owner` / `admin` / `member` / `viewer`); organizations own projects; projects own queues.
- **Queue configuration** — priority (1–10), max concurrency, per-minute rate limit,
  pause/resume, attachable retry policies, live statistics.
- **Job types** — immediate, delayed (`delay_ms`), one-off scheduled (`run_at`),
  recurring (cron via `scheduled_jobs`), and batch creation (atomic, grouped by `batch_id`).
- **Full lifecycle** — `waiting → queued/scheduled → claimed → running → completed`,
  with automatic retries and a dead letter queue for permanent failures.
- **Retry strategies** — `none`, `fixed`, `linear`, `exponential`, optional jitter,
  capped by `max_delay_ms`.
- **Workers** — poll & atomically claim jobs, execute handlers concurrently with
  per-job timeouts, stream structured logs, heartbeat every 5s, drain gracefully on
  SIGINT/SIGTERM. Dead workers are detected by heartbeat timeout and their in-flight
  jobs are recovered through the normal retry path.
- **Observability** — execution history per attempt, per-job logs, worker heartbeat
  history, queue/system metrics, throughput timeseries.
- **Dashboard** — overview with throughput chart, project/queue management, job
  explorer with filters and pagination, job detail (executions, logs, payload),
  worker monitor, DLQ with one-click requeue. Live views poll every 3 seconds.
- **Bonus features implemented** — workflow dependencies (`depends_on`), per-queue
  rate limiting, role-based access control, idempotent job creation and reporting.

## Requirements

- Node.js ≥ 18 (uses built-in `fetch` and `node:test`)
- npm

## Setup

```bash
npm install
npm run seed        # optional: demo user, project, queues and jobs
npm start           # API server + dashboard on http://localhost:4000
npm run worker      # in a second terminal: start a worker
```

Open **http://localhost:4000** and sign in with the seeded account
(`demo@conveyor.dev` / `password123`) or register a new one.

Run more workers to see distribution in action:

```bash
node worker/index.js --name w2 --concurrency 8
node worker/index.js --name emails-only --queues emails --concurrency 2
```

Configuration is via environment variables (see [.env.example](.env.example)); every
value has a working local default.

> If `npm install` fails building `better-sqlite3` on a machine without a C++
> toolchain, it normally isn't needed — prebuilt binaries are downloaded for common
> Node versions. On a restricted network, download the prebuilt
> `better-sqlite3-v11.x-node-v115-win32-x64.tar.gz` from the project's GitHub releases
> and extract it into `node_modules/better-sqlite3/`.

## Tests

```bash
npm test
```

32 tests cover the critical paths: retry backoff math, atomic claiming under
concurrent load, concurrency/rate limits, pause/resume, priority ordering, the full
success and failure lifecycle, DLQ requeue, idempotency (creation and reporting),
batches, workflow dependencies, cron scheduling, dead-worker recovery, auth, and RBAC.
Tests run against an in-memory SQLite database through the real HTTP stack.

## Project layout

```
src/
  server.js          entry point: HTTP server + scheduler loop
  app.js             Express app, routing, error handling
  config.js          environment configuration
  db/                connection + schema.sql (full DDL with comments)
  routes/            REST endpoints (auth, orgs, projects, queues, jobs,
                     schedules, workers, dlq, metrics, workerApi)
  services/
    claims.js        atomic job claiming (the concurrency-critical path)
    lifecycle.js     guarded state transitions, retries, DLQ
    scheduler.js     tick loop: promote due jobs, run cron, reap dead workers
    retry.js         backoff computation
  middleware/        JWT + worker-token auth
worker/
  index.js           worker process (poll, execute, heartbeat, drain)
  handlers.js        job handler registry (echo, sleep, send_email, …)
public/              dashboard SPA (no build step)
tests/               node:test suite against the real HTTP app
scripts/seed.js      demo data
docs/                architecture, ER diagram, API reference, design decisions
```

## Documentation

- [Architecture](docs/architecture.md) — components, data flow, reliability model
- [ER diagram & database design](docs/er-diagram.md) — schema, keys, indexes, cascades
- [API reference](docs/api.md) — every endpoint with request/response shapes
- [Design decisions](docs/design-decisions.md) — major trade-offs and why
