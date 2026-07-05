# API Reference

Base URL: `http://localhost:4000/api`

## Conventions

- **Auth (users):** `Authorization: Bearer <jwt>` — obtained from `/auth/register` or `/auth/login`.
- **Auth (workers):** `X-Worker-Token: <shared secret>` on all `/worker/*` endpoints.
- **Timestamps** are epoch milliseconds.
- **Pagination:** list endpoints accept `?page` (default 1) and `?limit` (default 25, max 100)
  and return `{ data, pagination: { page, limit, total, pages } }`.
- **Errors** are structured and stable:

```json
{ "error": { "code": "bad_request", "message": "Validation failed",
             "details": [{ "field": "email", "message": "is required" }] } }
```

Codes: `bad_request` 400 · `unauthorized` 401 · `forbidden` 403 · `not_found` 404 ·
`conflict` 409 · `internal_error` 500.

- **Roles:** minimum role required is noted per endpoint
  (`viewer` < `member` < `admin` < `owner`). Resources in organizations you don't
  belong to return **404**.

---

## Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create user + personal org. Body: `email`, `password` (≥8), `name`, `organization_name?` → `201 { token, user, organization }` |
| POST | `/auth/login` | — | Body: `email`, `password` → `{ token, user }` |
| GET | `/auth/me` | user | Current user + org memberships with roles |

## Organizations

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/members` | viewer | List members with roles |
| POST | `/orgs/:orgId/members` | admin | Add existing user by `email` with `role` (`admin`/`member`/`viewer`) |
| DELETE | `/orgs/:orgId/members/:userId` | admin | Remove a member (owner cannot be removed) |

## Projects

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects` | user | All projects across the caller's orgs (with queue counts) |
| POST | `/projects` | admin | Body: `org_id`, `name`, `description?` |
| GET | `/projects/:id` | viewer | Project detail + caller's role |
| PATCH | `/projects/:id` | admin | Update `name` / `description` |
| DELETE | `/projects/:id` | owner | Cascades to queues, jobs, history |

## Retry policies

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:id/retry-policies` | viewer | List |
| POST | `/projects/:id/retry-policies` | admin | Body: `name`, `strategy` (`none`/`fixed`/`linear`/`exponential`), `max_attempts` (default 3), `base_delay_ms` (1000), `max_delay_ms` (60000), `jitter` (false) |

Delay formula per failed attempt *n*: fixed → `base`; linear → `base·n`;
exponential → `base·2^(n-1)`; all capped at `max_delay_ms`, plus 0–25% jitter if enabled.

## Queues

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:id/queues` | viewer | List with live stats (depth, by-status counts, last-hour completed/failed/avg duration) |
| POST | `/projects/:id/queues` | admin | Body: `name` (lowercase slug), `priority?` 1–10, `max_concurrency?`, `rate_limit_per_minute?`, `retry_policy_id?` |
| GET | `/queues/:id` | viewer | Queue + stats |
| PATCH | `/queues/:id` | admin | Update any config field |
| POST | `/queues/:id/pause` · `/resume` | admin | Stop/restart claiming (jobs keep accumulating while paused) |
| DELETE | `/queues/:id` | admin | Cascades to jobs and history |

## Jobs

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/queues/:id/jobs` | member | Create a job (see body below). `201`, or `200` with `deduplicated: true` when the idempotency key already exists |
| POST | `/queues/:id/jobs/batch` | member | Body: `{ jobs: [spec, …] }` (≤500). Atomic — one invalid spec rejects all. → `{ batch_id, created, job_ids }` |
| GET | `/queues/:id/jobs` | viewer | Paginated; filters: `?status=`, `?handler=`, `?batch_id=` |
| GET | `/jobs/:id` | viewer | Job + executions + logs (≤500) + DLQ entry if dead |
| GET | `/batches/:batchId` | viewer | Per-status counts for the batch |
| POST | `/jobs/:id/cancel` | member | Allowed in `waiting`/`queued`/`scheduled`; otherwise 409 |
| POST | `/jobs/:id/retry` | member | Requeue a `dead`/`canceled` job with a fresh attempt budget |

Job creation body:

```json
{
  "handler": "send_email",          // required — worker handler name
  "payload": { "to": "a@b.c" },     // JSON, opaque to the server
  "priority": 5,                    // 1–10, higher first
  "delay_ms": 60000,                // OR "run_at": <epoch ms> → scheduled job
  "max_attempts": 3,                // overrides the queue's retry policy
  "timeout_ms": 60000,              // per-attempt execution timeout
  "idempotency_key": "order-42",    // unique per queue → deduplicates
  "depends_on": "job_…"             // waits until that job completes
}
```

## Recurring schedules

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/queues/:id/schedules` | viewer | List cron definitions with next/last run |
| POST | `/queues/:id/schedules` | member | Body: `name`, `cron_expression` (validated), `handler`, `payload?` |
| PATCH | `/schedules/:id` | member | Update `cron_expression` / `handler` / `payload` / `is_active` |
| DELETE | `/schedules/:id` | member | Remove the definition (already-materialized jobs remain) |

## Dead letter queue

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/dlq` | viewer | Paginated entries across visible queues; `?include_requeued=true` to include history |
| POST | `/dlq/:id/retry` | member | Requeue the dead job (attempts reset); 409 if already requeued |

## Workers (monitoring)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/workers` | user | Fleet with status, subscriptions, active job counts |
| GET | `/workers/:id` | user | Worker + last 60 heartbeats + last 20 executions |

## Metrics

| Method | Path | Description |
|---|---|---|
| GET | `/metrics/overview` | Backlog / in-flight / by-status counts, last-hour throughput & failure rate & avg duration, worker fleet status, DLQ depth |
| GET | `/metrics/throughput?minutes=30` | Per-minute `{ minute, completed, failed }` buckets (5–180 min) |

## Worker API (`X-Worker-Token`)

| Method | Path | Description |
|---|---|---|
| POST | `/worker/register` | Body: `name`, `hostname?`, `pid?`, `max_concurrency?`, `queue_names?` (omit = all queues) → `{ worker_id }` |
| POST | `/worker/heartbeat` | Body: `worker_id`, `active_jobs`, `rss_bytes?`. Silent >30s ⇒ reaped |
| POST | `/worker/claim` | Body: `worker_id`. `200` with the job (payload parsed) or `204` when nothing is eligible |
| POST | `/worker/jobs/:id/start` | claimed → running; increments attempts, opens an execution → `{ execution_id, attempt }` |
| POST | `/worker/jobs/:id/complete` | Body: `worker_id`, `output?`. Idempotent — duplicates return `applied: false` |
| POST | `/worker/jobs/:id/fail` | Body: `worker_id`, `error`, `timed_out?` → `{ outcome: "retry_scheduled" \| "dead_lettered", retryInMs? }` |
| POST | `/worker/jobs/:id/logs` | Body: `execution_id?`, `entries: [{ level, message, ts? }]` (≤100 per call) |
| POST | `/worker/deregister` | Graceful shutdown notice |

## Health

`GET /api/health` → `{ "status": "ok", "ts": … }` (unauthenticated, for probes).
