const express = require('express');
const { getDb } = require('../db');
const { pagination } = require('../validate');
const { ApiError } = require('../errors');
const { getQueue, visibleQueueIds } = require('../access');
const { retryDeadJob } = require('../services/lifecycle');
const config = require('../config');

const router = express.Router();

// Dead letter entries across every queue the caller can see.
router.get('/dlq', (req, res) => {
  const queueIds = visibleQueueIds(req.user.id);
  if (!queueIds.length) return res.json({ data: [], pagination: { page: 1, limit: 0, total: 0, pages: 0 } });

  const db = getDb();
  const { page, limit, offset } = pagination(req.query, config);
  const placeholders = queueIds.map(() => '?').join(',');
  const activeOnly = req.query.include_requeued === 'true' ? '' : 'AND d.requeued_at IS NULL';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM dead_letter_jobs d WHERE d.queue_id IN (${placeholders}) ${activeOnly}`)
    .get(...queueIds).n;
  const data = db
    .prepare(
      `SELECT d.*, q.name AS queue_name FROM dead_letter_jobs d
       JOIN queues q ON q.id = d.queue_id
       WHERE d.queue_id IN (${placeholders}) ${activeOnly}
       ORDER BY d.moved_at DESC LIMIT ? OFFSET ?`
    )
    .all(...queueIds, limit, offset);

  res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.post('/dlq/:dlqId/retry', (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM dead_letter_jobs WHERE id = ?').get(req.params.dlqId);
  if (!entry) throw ApiError.notFound('Dead letter entry');
  getQueue(req.user.id, entry.queue_id, 'member');

  if (!retryDeadJob(entry.id)) {
    throw ApiError.conflict('Entry was already requeued or the job is no longer dead');
  }
  res.json({ id: entry.id, job_id: entry.job_id, status: 'queued' });
});

module.exports = router;
