# Design Decisions

The guiding constraint: **correctness of the concurrency-critical paths first, and a
system a reviewer can clone, run, and break in five minutes.** Every trade-off below
follows from that.

## 1. SQLite as the job store (and the PostgreSQL path)

**Decision:** better-sqlite3 in WAL mode, one connection owned by the API server.

**Why.** A job scheduler's hardest problem is *atomic claiming under concurrency*.
SQLite's single-writer model makes the claim transaction trivially serializable —
the entire eligible-job selection (pause state, concurrency limit, rate limit,
priority ordering) and the claim UPDATE execute as one uninterruptible unit. That
turns the most dangerous race in the system into code that is easy to read and easy
to test. It also makes the project runnable with `npm install && npm start` — no
Docker, no external services — which is worth a lot in an evaluated assignment.

**Trade-off accepted.** One writer caps horizontal scale of the *server* (workers
scale freely). The claim logic deliberately keeps the guarded
`UPDATE … WHERE status='queued'` even though SQLite doesn't strictly need it, so the
port to PostgreSQL is mechanical: same schema, same guard, plus
`SELECT … FOR UPDATE SKIP LOCKED` in the candidate query. The seam is one function
(`services/claims.js`).

**Rejected alternative:** Redis-backed queues (BullMQ-style). Fast, but pushes the
interesting engineering (atomicity, retry state machines, DLQ) into a black box, and
the assignment is precisely about designing those.

## 2. Workers speak HTTP, never SQL

**Decision:** workers are stateless processes using a small worker API
(`register / claim / start / complete / fail / logs / heartbeat / deregister`) with a
shared-secret token.

**Why.** If workers opened the database directly, "distributed" would mean "shared
file". Going through the API means workers can run on any machine, the server is the
single point where invariants are enforced, and worker credentials (infrastructure)
are cleanly separated from user JWTs. It also forces the reporting endpoints to be
**idempotent** — a worker retrying a `complete` call after a network blip must be
harmless — which is exactly the discipline a real distributed system needs.

**Trade-off:** one HTTP round-trip per lifecycle step (~ms locally). Irrelevant next
to job execution time; batching exists where it matters (log entries).

## 3. At-least-once delivery, not exactly-once

**Decision:** a job may execute more than once in rare failure windows (worker dies
after doing the work, before reporting). Never zero times.

**Why.** Exactly-once between separate processes requires distributed transactions
between the job store and the side effects of the job itself — impossible in general
(the email is already sent). Instead the platform gives handlers the tools to make
duplicates safe: idempotency keys at creation, attempt numbers in the execution
context, replay-safe reporting, and documentation that handlers should be idempotent.
This mirrors what SQS, Sidekiq and Cloud Tasks actually promise.

## 4. State transitions guarded by `WHERE` clauses, not application checks

**Decision:** every lifecycle mutation is
`UPDATE … WHERE id=? AND status=<expected> AND claimed_by=<worker>`, and
`changes === 1` decides success.

**Why.** Read-then-write ("fetch job, check status in JS, update") is a TOCTOU race
the moment there are two actors — a reassigned worker's stale report could clobber a
newer state. Compare-and-swap in the database makes stale actors fail closed. This
one pattern is what makes duplicate reports no-ops, dead-worker recovery safe, and
the DLQ requeue race-free.

## 5. Retry waits are rows, not timers

**Decision:** a failed attempt sets `status='scheduled', run_at=now+backoff`; a 1s
scheduler tick promotes due jobs. No `setTimeout` per job anywhere.

**Why.** In-memory timers die with the process. A `run_at` column survives restarts,
is inspectable in the dashboard ("retrying in 12s"), and is served by a tiny partial
index. The same mechanism uniformly handles delayed jobs, one-off scheduled jobs and
retry backoff — one code path instead of three. Cost: up to 1s of promotion latency,
which is well inside tolerance for background jobs.

Cron scheduling advances `next_run_at` from *now* rather than from the previous
fire time — a deliberately chosen "skip missed runs" policy so a server that was down
for an hour doesn't stampede 60 copies of a per-minute job. The alternative
(catch-up semantics) suits billing-style jobs; for that, the payload carries the
scheduled time so handlers can detect gaps.

## 6. Heartbeat reaping routes through the normal failure path

**Decision:** dead-worker recovery closes the execution as `lost` and then calls the
*same* `applyFailure` used by ordinary failures.

**Why.** A lost worker is just another way an attempt can fail. Reusing the path
means retry budgets, backoff and DLQ behave identically however the failure happened
— no special-case state machine to get wrong. The 30s timeout is 6 missed heartbeats
at the 5s cadence: late enough to survive a GC pause or blip, early enough that
stuck jobs recover fast.

## 7. Queue-level concurrency and rate limits enforced at claim time

**Decision:** `max_concurrency` counts `claimed + running` rows; the per-minute rate
limit counts executions started in the rolling window plus currently-claimed jobs —
both evaluated inside the claim transaction.

**Why.** Enforcing limits where work is *handed out* is the only place with a global
view; workers can't self-limit a shared queue. Counting claimed-but-not-started jobs
closes the gap where N claims sneak through before any of them starts. The rate
limiter slightly *under*-admits (a claimed job that later fails to start still
consumed a slot for a moment) — chosen over the alternative of over-admitting,
because rate limits usually protect downstream systems.

## 8. Server-rendered-nothing: a dependency-free SPA

**Decision:** vanilla JS + hash routing + 3s polling; no framework, no build step.

**Why.** The dashboard's job is operational visibility, not app complexity. Zero
build tooling means the reviewer runs one process and gets the UI; polling against
the same public REST API keeps one source of truth and proves the API is sufficient
for real clients. WebSockets were skipped consciously: at a 3s cadence, polling a
handful of aggregate endpoints is cheaper than managing socket lifecycles, and the
API layer stays stateless. The seam to add them later is small (the views are
already re-render functions).

## 9. RBAC via org-scoped roles resolved per resource

**Decision:** roles live on the organization membership; every handler resolves
`resource → project → org → caller's role` and 404s (not 403s) on foreign resources.

**Why.** One authority table, no per-resource ACLs to drift out of sync, and
existence of other tenants' resources is never leaked. The role ladder
(viewer/member/admin/owner) maps to real operational duties: read, submit work,
change configuration, destroy.

## 10. What was deliberately left out

- **Queue sharding / multi-server** — designed for (claims are one function, ids are
  UUIDs, workers are location-agnostic) but not built; it would be dishonest
  complexity at this scale.
- **Payload encryption at rest** and **per-project worker tokens** — noted as the
  next security steps for multi-tenant production.
- **Retention sweeps** for completed jobs — the cascade design makes this a
  one-statement cron job; omitted to keep every job inspectable during evaluation.
- **AI failure summaries** — an LLM call over `job_logs` + executions at
  dead-letter time would bolt onto `applyFailure` cleanly, but a bonus feature that
  needs an API key would hurt the "clone and run" property.
