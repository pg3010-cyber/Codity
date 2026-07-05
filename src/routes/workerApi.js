// Internal API used by worker processes. Authenticated with a shared token
// (X-Worker-Token) rather than user JWTs — workers are infrastructure.
//
// Contract: register -> loop { claim -> start -> (logs) -> complete|fail }
// with heartbeats in parallel; deregister on graceful shutdown.

const express = require('express');
const os = require('os');
const { getDb } = require('../db');
const { id } = require('../ids');
const { validate } = require('../validate');
const { ApiError } = require('../errors');
const { claimJob } = require('../services/claims');
const { startJob, completeJob, failJob } = require('../services/lifecycle');
const log = require('../logger');

const router = express.Router();

router.post('/register', (req, res) => {
  const body = validate(req.body, {
    name: { required: true, type: 'string', minLen: 1, maxLen: 100 },
    hostname: { type: 'string', maxLen: 200 },
    pid: { type: 'integer', min: 0 },
    max_concurrency: { type: 'integer', min: 1, max: 100, default: 4 },
    queue_names: { type: 'array', maxLen: 50 },
  });

  const now = Date.now();
  const workerId = id('wrk');
  getDb()
    .prepare(
      `INSERT INTO workers (id, name, hostname, pid, status, max_concurrency, queue_names, registered_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)`
    )
    .run(
      workerId, body.name, body.hostname || os.hostname(), body.pid ?? null,
      body.max_concurrency,
      body.queue_names && body.queue_names.length ? JSON.stringify(body.queue_names) : null,
      now, now
    );

  log.info('worker registered', { workerId, name: body.name });
  res.status(201).json({ worker_id: workerId });
});

router.post('/heartbeat', (req, res) => {
  const body = validate(req.body, {
    worker_id: { required: true, type: 'string' },
    active_jobs: { type: 'integer', min: 0, default: 0 },
    rss_bytes: { type: 'integer', min: 0 },
  });

  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE workers SET last_heartbeat_at = ?, status = CASE WHEN status = 'offline' THEN 'online' ELSE status END
       WHERE id = ?`
    )
    .run(now, body.worker_id);
  if (result.changes !== 1) throw ApiError.notFound('Worker');

  db.prepare(
    'INSERT INTO worker_heartbeats (id, worker_id, active_jobs, rss_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id('hbt'), body.worker_id, body.active_jobs, body.rss_bytes ?? null, now);

  res.json({ ok: true });
});

// Atomically claim the next eligible job. 204 = nothing to do right now.
router.post('/claim', (req, res) => {
  const body = validate(req.body, { worker_id: { required: true, type: 'string' } });
  const job = claimJob(body.worker_id);
  if (!job) return res.status(204).end();
  res.json({ ...job, payload: JSON.parse(job.payload) });
});

router.post('/jobs/:jobId/start', (req, res) => {
  const body = validate(req.body, { worker_id: { required: true, type: 'string' } });
  const started = startJob(req.params.jobId, body.worker_id);
  if (!started) {
    throw ApiError.conflict('Job is not claimed by this worker (it may have been reassigned)');
  }
  res.json({ execution_id: started.executionId, attempt: started.job.attempts });
});

router.post('/jobs/:jobId/complete', (req, res) => {
  const body = validate(req.body, {
    worker_id: { required: true, type: 'string' },
    output: { type: 'object' },
  });
  if (!completeJob(req.params.jobId, body.worker_id, body.output)) {
    // Duplicate/stale report — job already finished or was reassigned.
    // Returning 200 keeps the endpoint idempotent for worker retries.
    return res.json({ ok: true, applied: false });
  }
  res.json({ ok: true, applied: true });
});

router.post('/jobs/:jobId/fail', (req, res) => {
  const body = validate(req.body, {
    worker_id: { required: true, type: 'string' },
    error: { required: true, type: 'string', maxLen: 5000 },
    timed_out: { type: 'boolean', default: false },
  });
  const result = failJob(req.params.jobId, body.worker_id, body.error, {
    timedOut: body.timed_out,
  });
  if (!result) return res.json({ ok: true, applied: false });
  res.json({ ok: true, applied: true, ...result });
});

// Structured per-job logs streamed from handlers during execution.
router.post('/jobs/:jobId/logs', (req, res) => {
  const body = validate(req.body, {
    execution_id: { type: 'string' },
    entries: { required: true, type: 'array', minLen: 1, maxLen: 100 },
  });

  const db = getDb();
  if (!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(req.params.jobId)) {
    throw ApiError.notFound('Job');
  }

  const insert = db.prepare(
    'INSERT INTO job_logs (id, job_id, execution_id, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  db.transaction(() => {
    for (const entry of body.entries) {
      const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
      insert.run(id('log'), req.params.jobId, body.execution_id || null, level, String(entry.message).slice(0, 5000), entry.ts || now);
    }
  })();

  res.json({ ok: true, written: body.entries.length });
});

// Graceful shutdown: worker announces it is leaving after finishing its work.
router.post('/deregister', (req, res) => {
  const body = validate(req.body, { worker_id: { required: true, type: 'string' } });
  getDb().prepare(`UPDATE workers SET status = 'offline' WHERE id = ?`).run(body.worker_id);
  log.info('worker deregistered', { workerId: body.worker_id });
  res.json({ ok: true });
});

module.exports = router;
