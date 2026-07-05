const express = require('express');
const { getDb } = require('../db');
const { id } = require('../ids');
const { validate, pagination } = require('../validate');
const { ApiError } = require('../errors');
const { getQueue, getJob } = require('../access');
const { DEFAULT_POLICY } = require('../services/retry');
const config = require('../config');

const router = express.Router();

const JOB_FIELDS = {
  handler: { required: true, type: 'string', minLen: 1, maxLen: 100 },
  payload: { type: 'object' },
  priority: { type: 'integer', min: 1, max: 10 },
  run_at: { type: 'integer', min: 0 },          // epoch ms for one-off scheduled jobs
  delay_ms: { type: 'integer', min: 0, max: 30 * 24 * 3600000 },
  max_attempts: { type: 'integer', min: 1, max: 50 },
  timeout_ms: { type: 'integer', min: 100, max: 3600000 },
  idempotency_key: { type: 'string', maxLen: 200 },
  depends_on: { type: 'string' },
};

// Resolves the effective max_attempts: explicit override > queue policy > default.
function defaultMaxAttempts(db, queue) {
  if (!queue.retry_policy_id) return DEFAULT_POLICY.max_attempts;
  const policy = db.prepare('SELECT max_attempts FROM retry_policies WHERE id = ?').get(queue.retry_policy_id);
  return policy ? policy.max_attempts : DEFAULT_POLICY.max_attempts;
}

// Builds the row for one job spec; shared by single and batch creation.
function buildJob(db, queue, spec, { batchId = null, userId } = {}) {
  const now = Date.now();

  let status = 'queued';
  let runAt = null;
  if (spec.depends_on) {
    const parent = db.prepare('SELECT id, queue_id, status FROM jobs WHERE id = ?').get(spec.depends_on);
    if (!parent) throw ApiError.badRequest('depends_on does not reference an existing job');
    getJob(userId, parent.id); // access check: dependency must be visible to caller
    // A dead or canceled parent will never complete, so the child would
    // wait forever — reject it up front instead.
    if (parent.status === 'dead' || parent.status === 'canceled') {
      throw ApiError.badRequest(`depends_on references a ${parent.status} job that will never complete`);
    }
    // Only wait for parents that have not finished successfully yet.
    if (parent.status !== 'completed') status = 'waiting';
  }
  if (spec.run_at !== undefined || spec.delay_ms !== undefined) {
    runAt = spec.run_at !== undefined ? spec.run_at : now + spec.delay_ms;
    if (runAt > now && status !== 'waiting') status = 'scheduled';
    if (runAt <= now && status !== 'waiting') { status = 'queued'; runAt = null; }
  }

  return {
    id: id('job'),
    queue_id: queue.id,
    handler: spec.handler,
    payload: JSON.stringify(spec.payload || {}),
    status,
    priority: spec.priority ?? 5,
    run_at: runAt,
    max_attempts: spec.max_attempts ?? defaultMaxAttempts(db, queue),
    timeout_ms: spec.timeout_ms ?? 60000,
    idempotency_key: spec.idempotency_key ?? null,
    batch_id: batchId,
    depends_on: spec.depends_on ?? null,
    created_at: now,
    updated_at: now,
  };
}

const INSERT_JOB = `
  INSERT INTO jobs (id, queue_id, handler, payload, status, priority, run_at,
                    max_attempts, timeout_ms, idempotency_key, batch_id, depends_on,
                    created_at, updated_at)
  VALUES (@id, @queue_id, @handler, @payload, @status, @priority, @run_at,
          @max_attempts, @timeout_ms, @idempotency_key, @batch_id, @depends_on,
          @created_at, @updated_at)`;

// --- Creation ----------------------------------------------------------------

router.post('/queues/:queueId/jobs', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'member');
  const spec = validate(req.body, JOB_FIELDS);
  const db = getDb();

  // Idempotent creation: same key in the same queue returns the original job.
  if (spec.idempotency_key) {
    const existing = db
      .prepare('SELECT * FROM jobs WHERE queue_id = ? AND idempotency_key = ?')
      .get(queue.id, spec.idempotency_key);
    if (existing) return res.status(200).json({ ...existing, deduplicated: true });
  }

  const job = buildJob(db, queue, spec, { userId: req.user.id });
  db.prepare(INSERT_JOB).run(job);
  res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id));
});

router.post('/queues/:queueId/jobs/batch', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'member');
  const body = validate(req.body, {
    jobs: { required: true, type: 'array', minLen: 1, maxLen: 500 },
  });

  const db = getDb();
  const batchId = id('bat');
  const specs = body.jobs.map((j) => validate(j, JOB_FIELDS));

  // All-or-nothing: one bad spec rejects the whole batch before any insert.
  const rows = specs.map((spec) => buildJob(db, queue, spec, { batchId, userId: req.user.id }));
  const insert = db.prepare(INSERT_JOB);
  db.transaction(() => rows.forEach((row) => insert.run(row)))();

  res.status(201).json({ batch_id: batchId, created: rows.length, job_ids: rows.map((r) => r.id) });
});

// --- Listing & inspection ------------------------------------------------------

router.get('/queues/:queueId/jobs', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId);
  const db = getDb();
  const { page, limit, offset } = pagination(req.query, config);

  const filters = ['queue_id = @queueId'];
  const params = { queueId: queue.id };
  if (req.query.status) {
    filters.push('status = @status');
    params.status = req.query.status;
  }
  if (req.query.handler) {
    filters.push('handler = @handler');
    params.handler = req.query.handler;
  }
  if (req.query.batch_id) {
    filters.push('batch_id = @batchId');
    params.batchId = req.query.batch_id;
  }
  const where = filters.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${where}`).get(params).n;
  const data = db
    .prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.user.id, req.params.jobId);
  const db = getDb();

  const executions = db
    .prepare('SELECT * FROM job_executions WHERE job_id = ? ORDER BY attempt')
    .all(job.id);
  const logs = db
    .prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY created_at LIMIT 500')
    .all(job.id);
  const dlq = db
    .prepare('SELECT * FROM dead_letter_jobs WHERE job_id = ? ORDER BY moved_at DESC LIMIT 1')
    .get(job.id);

  res.json({ ...job, executions, logs, dead_letter: dlq || null });
});

router.get('/batches/:batchId', (req, res) => {
  const db = getDb();
  const first = db.prepare('SELECT * FROM jobs WHERE batch_id = ? LIMIT 1').get(req.params.batchId);
  if (!first) throw ApiError.notFound('Batch');
  getQueue(req.user.id, first.queue_id); // access check via the owning queue

  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM jobs WHERE batch_id = ? GROUP BY status')
    .all(req.params.batchId)
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  res.json({ batch_id: req.params.batchId, queue_id: first.queue_id, by_status: byStatus });
});

// --- Operator actions ----------------------------------------------------------

router.post('/jobs/:jobId/cancel', (req, res) => {
  const job = getJob(req.user.id, req.params.jobId, 'member');
  const result = getDb()
    .prepare(
      `UPDATE jobs SET status = 'canceled', updated_at = ?
       WHERE id = ? AND status IN ('waiting', 'queued', 'scheduled')`
    )
    .run(Date.now(), job.id);
  if (result.changes !== 1) {
    throw ApiError.conflict(`Job cannot be canceled in status '${job.status}'`);
  }
  res.json({ id: job.id, status: 'canceled' });
});

// Requeue a finished job for a fresh run (dead or canceled).
router.post('/jobs/:jobId/retry', (req, res) => {
  const job = getJob(req.user.id, req.params.jobId, 'member');
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE jobs
       SET status = 'queued', attempts = 0, last_error = NULL, run_at = NULL,
           finished_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('dead', 'canceled')`
    )
    .run(now, job.id);
  if (result.changes !== 1) {
    throw ApiError.conflict(`Job cannot be retried in status '${job.status}'`);
  }
  res.json({ id: job.id, status: 'queued' });
});

module.exports = router;
