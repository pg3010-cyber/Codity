// State transitions for the job lifecycle. Every transition is guarded by a
// WHERE clause on the expected current state, so replays (worker retries a
// report after a network blip) and stale workers cannot corrupt state —
// this is what makes the reporting endpoints idempotent.

const { getDb } = require('../db');
const { id } = require('../ids');
const { computeRetryDelay, DEFAULT_POLICY } = require('./retry');
const log = require('../logger');

function getQueuePolicy(db, queueId) {
  const row = db
    .prepare(
      `SELECT p.* FROM queues q
       LEFT JOIN retry_policies p ON p.id = q.retry_policy_id
       WHERE q.id = ?`
    )
    .get(queueId);
  return row && row.strategy ? row : DEFAULT_POLICY;
}

// claimed -> running: increments attempts and opens an execution record.
function startJob(jobId, workerId) {
  const db = getDb();
  const now = Date.now();

  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE jobs
         SET status = 'running', started_at = @now, attempts = attempts + 1, updated_at = @now
         WHERE id = @jobId AND status = 'claimed' AND claimed_by = @workerId`
      )
      .run({ jobId, workerId, now });
    if (result.changes !== 1) return null;

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    const executionId = id('exe');
    db.prepare(
      `INSERT INTO job_executions (id, job_id, queue_id, worker_id, attempt, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    ).run(executionId, jobId, job.queue_id, workerId, job.attempts, now);

    return { job, executionId };
  })();
}

// running -> completed: closes the execution and releases dependents.
function completeJob(jobId, workerId, output) {
  const db = getDb();
  const now = Date.now();

  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE jobs
         SET status = 'completed', finished_at = @now, last_error = NULL,
             claimed_by = NULL, updated_at = @now
         WHERE id = @jobId AND status = 'running' AND claimed_by = @workerId`
      )
      .run({ jobId, workerId, now });
    if (result.changes !== 1) return false;

    closeExecution(db, jobId, {
      status: 'completed',
      finishedAt: now,
      output: output !== undefined ? JSON.stringify(output) : null,
    });

    // Workflow dependencies: jobs waiting on this one become eligible.
    db.prepare(
      `UPDATE jobs SET status = 'queued', updated_at = @now
       WHERE depends_on = @jobId AND status = 'waiting'`
    ).run({ jobId, now });

    return true;
  })();
}

// running -> scheduled (retry) or dead (DLQ), depending on the queue's
// retry policy and how many attempts the job has burned.
function failJob(jobId, workerId, errorMessage, { timedOut = false } = {}) {
  const db = getDb();
  const now = Date.now();

  return db.transaction(() => {
    const job = db
      .prepare(
        `SELECT * FROM jobs
         WHERE id = ? AND status = 'running' AND claimed_by = ?`
      )
      .get(jobId, workerId);
    if (!job) return null;

    closeExecution(db, jobId, {
      status: timedOut ? 'timed_out' : 'failed',
      finishedAt: now,
      error: errorMessage,
    });

    return applyFailure(db, job, errorMessage, now);
  })();
}

// Shared failure routing: retry with backoff, or move to the DLQ.
// Also used by the scheduler when a worker dies mid-job.
function applyFailure(db, job, errorMessage, now) {
  const policy = getQueuePolicy(db, job.queue_id);
  const delay =
    job.attempts < job.max_attempts ? computeRetryDelay(policy, job.attempts) : null;

  if (delay !== null) {
    db.prepare(
      `UPDATE jobs
       SET status = 'scheduled', run_at = @runAt, last_error = @error,
           claimed_by = NULL, claimed_at = NULL, updated_at = @now
       WHERE id = @jobId`
    ).run({ jobId: job.id, runAt: now + delay, error: errorMessage, now });
    return { outcome: 'retry_scheduled', retryInMs: delay };
  }

  db.prepare(
    `UPDATE jobs
     SET status = 'dead', finished_at = @now, last_error = @error,
         claimed_by = NULL, updated_at = @now
     WHERE id = @jobId`
  ).run({ jobId: job.id, error: errorMessage, now });

  db.prepare(
    `INSERT INTO dead_letter_jobs (id, job_id, queue_id, handler, payload, error, attempts, moved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id('dlq'), job.id, job.queue_id, job.handler, job.payload, errorMessage, job.attempts, now);

  // Dependents can never run; cancel them rather than leaving them stuck.
  db.prepare(
    `UPDATE jobs SET status = 'canceled', last_error = 'Dependency failed', updated_at = @now
     WHERE depends_on = @jobId AND status = 'waiting'`
  ).run({ jobId: job.id, now });

  log.warn('job moved to dead letter queue', { jobId: job.id, attempts: job.attempts });
  return { outcome: 'dead_lettered' };
}

function closeExecution(db, jobId, { status, finishedAt, error = null, output = null }) {
  db.prepare(
    `UPDATE job_executions
     SET status = @status, finished_at = @finishedAt,
         duration_ms = @finishedAt - started_at, error = @error, output = @output
     WHERE job_id = @jobId AND status = 'running'`
  ).run({ jobId, status, finishedAt, error, output });
}

// Operator action: resurrect a dead-lettered job for a fresh round of attempts.
function retryDeadJob(dlqId) {
  const db = getDb();
  const now = Date.now();

  return db.transaction(() => {
    const entry = db
      .prepare('SELECT * FROM dead_letter_jobs WHERE id = ? AND requeued_at IS NULL')
      .get(dlqId);
    if (!entry) return false;

    const result = db
      .prepare(
        `UPDATE jobs
         SET status = 'queued', attempts = 0, last_error = NULL,
             finished_at = NULL, run_at = NULL, updated_at = @now
         WHERE id = @jobId AND status = 'dead'`
      )
      .run({ jobId: entry.job_id, now });
    if (result.changes !== 1) return false;

    db.prepare('UPDATE dead_letter_jobs SET requeued_at = ? WHERE id = ?').run(now, dlqId);
    return true;
  })();
}

module.exports = { startJob, completeJob, failJob, applyFailure, retryDeadJob };
