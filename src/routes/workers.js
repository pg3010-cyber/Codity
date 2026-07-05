const express = require('express');
const { getDb } = require('../db');
const { ApiError } = require('../errors');

const router = express.Router();

// Workers are cluster-level infrastructure shared by all projects, so any
// authenticated user may view them (read-only).

router.get('/', (req, res) => {
  const db = getDb();
  const workers = db
    .prepare(
      `SELECT w.*,
              (SELECT COUNT(*) FROM jobs j
               WHERE j.claimed_by = w.id AND j.status IN ('claimed','running')) AS active_jobs
       FROM workers w
       ORDER BY w.status = 'online' DESC, w.last_heartbeat_at DESC`
    )
    .all();
  res.json({ data: workers });
});

router.get('/:workerId', (req, res) => {
  const db = getDb();
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.workerId);
  if (!worker) throw ApiError.notFound('Worker');

  const heartbeats = db
    .prepare(
      'SELECT active_jobs, rss_bytes, created_at FROM worker_heartbeats WHERE worker_id = ? ORDER BY created_at DESC LIMIT 60'
    )
    .all(worker.id);
  const recentJobs = db
    .prepare(
      `SELECT e.job_id, e.attempt, e.status, e.started_at, e.duration_ms, j.handler
       FROM job_executions e JOIN jobs j ON j.id = e.job_id
       WHERE e.worker_id = ? ORDER BY e.started_at DESC LIMIT 20`
    )
    .all(worker.id);

  res.json({ ...worker, heartbeats, recent_executions: recentJobs });
});

module.exports = router;
