const express = require('express');
const { getDb } = require('../db');
const { visibleQueueIds } = require('../access');
const config = require('../config');

const router = express.Router();

// System overview scoped to the caller's queues: job counts, workers,
// failure rate and average duration over the last hour.
router.get('/overview', (req, res) => {
  const db = getDb();
  const queueIds = visibleQueueIds(req.user.id);
  const placeholders = queueIds.map(() => '?').join(',') || "''";

  const byStatus = queueIds.length
    ? db
        .prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE queue_id IN (${placeholders}) GROUP BY status`)
        .all(...queueIds)
        .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {})
    : {};

  const hourAgo = Date.now() - 3600000;
  const lastHour = queueIds.length
    ? db
        .prepare(
          `SELECT
             COUNT(*) AS executions,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status IN ('failed','timed_out','lost') THEN 1 ELSE 0 END) AS failed,
             AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avg_duration_ms
           FROM job_executions WHERE queue_id IN (${placeholders}) AND started_at > ?`
        )
        .get(...queueIds, hourAgo)
    : { executions: 0, completed: 0, failed: 0, avg_duration_ms: null };

  const workers = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
         SUM(CASE WHEN status = 'draining' THEN 1 ELSE 0 END) AS draining,
         SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline
       FROM workers`
    )
    .get();

  const dlqDepth = queueIds.length
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM dead_letter_jobs WHERE queue_id IN (${placeholders}) AND requeued_at IS NULL`
        )
        .get(...queueIds).n
    : 0;

  res.json({
    jobs: {
      by_status: byStatus,
      backlog: (byStatus.queued || 0) + (byStatus.scheduled || 0) + (byStatus.waiting || 0),
      in_flight: (byStatus.claimed || 0) + (byStatus.running || 0),
    },
    last_hour: {
      executions: lastHour.executions || 0,
      completed: lastHour.completed || 0,
      failed: lastHour.failed || 0,
      failure_rate: lastHour.executions
        ? Number(((lastHour.failed || 0) / lastHour.executions).toFixed(3))
        : 0,
      avg_duration_ms: lastHour.avg_duration_ms ? Math.round(lastHour.avg_duration_ms) : null,
    },
    workers: {
      online: workers.online || 0,
      draining: workers.draining || 0,
      offline: workers.offline || 0,
    },
    dead_letter_depth: dlqDepth,
  });
});

// Per-minute completed/failed counts for the throughput chart.
router.get('/throughput', (req, res) => {
  const db = getDb();
  const queueIds = visibleQueueIds(req.user.id);
  const minutes = Math.min(180, Math.max(5, parseInt(req.query.minutes, 10) || 30));
  const since = Date.now() - minutes * 60000;

  if (!queueIds.length) return res.json({ data: [], minutes });

  const placeholders = queueIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT (started_at / 60000) * 60000 AS minute,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status IN ('failed','timed_out','lost') THEN 1 ELSE 0 END) AS failed
       FROM job_executions
       WHERE queue_id IN (${placeholders}) AND started_at > ? AND finished_at IS NOT NULL
       GROUP BY minute ORDER BY minute`
    )
    .all(...queueIds, since);

  res.json({ data: rows, minutes });
});

module.exports = router;
