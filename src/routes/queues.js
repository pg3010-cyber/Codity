const express = require('express');
const { getDb } = require('../db');
const { id } = require('../ids');
const { validate } = require('../validate');
const { ApiError } = require('../errors');
const { getProject, getQueue } = require('../access');

const router = express.Router();

const QUEUE_FIELDS = {
  name: { type: 'string', minLen: 1, maxLen: 100, pattern: /^[a-z0-9][a-z0-9-_]*$/, patternMessage: 'must be lowercase alphanumeric with dashes/underscores' },
  priority: { type: 'integer', min: 1, max: 10 },
  max_concurrency: { type: 'integer', min: 1, max: 1000 },
  rate_limit_per_minute: { type: 'integer', min: 1, max: 100000 },
  retry_policy_id: { type: 'string' },
};

function queueWithStats(db, queue) {
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE queue_id = ? GROUP BY status`
    )
    .all(queue.id)
    .reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {});

  const hour = Date.now() - 3600000;
  const recent = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status IN ('failed','timed_out','lost') THEN 1 ELSE 0 END) AS failed,
         AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avg_duration_ms
       FROM job_executions WHERE queue_id = ? AND started_at > ?`
    )
    .get(queue.id, hour);

  return {
    ...queue,
    stats: {
      by_status: counts,
      depth: (counts.queued || 0) + (counts.scheduled || 0),
      last_hour: {
        completed: recent.completed || 0,
        failed: recent.failed || 0,
        avg_duration_ms: recent.avg_duration_ms ? Math.round(recent.avg_duration_ms) : null,
      },
    },
  };
}

// --- Queues under a project ------------------------------------------------

router.get('/projects/:projectId/queues', (req, res) => {
  const project = getProject(req.user.id, req.params.projectId);
  const db = getDb();
  const queues = db
    .prepare('SELECT * FROM queues WHERE project_id = ? ORDER BY priority DESC, name')
    .all(project.id);
  res.json({ data: queues.map((q) => queueWithStats(db, q)) });
});

router.post('/projects/:projectId/queues', (req, res) => {
  const project = getProject(req.user.id, req.params.projectId, 'admin');
  const body = validate(req.body, {
    ...QUEUE_FIELDS,
    name: { ...QUEUE_FIELDS.name, required: true },
  });

  const db = getDb();
  if (db.prepare('SELECT 1 FROM queues WHERE project_id = ? AND name = ?').get(project.id, body.name)) {
    throw ApiError.conflict('A queue with this name already exists in the project');
  }
  if (body.retry_policy_id) {
    const policy = db
      .prepare('SELECT 1 FROM retry_policies WHERE id = ? AND project_id = ?')
      .get(body.retry_policy_id, project.id);
    if (!policy) throw ApiError.badRequest('retry_policy_id does not reference a policy in this project');
  }

  const now = Date.now();
  const queueId = id('que');
  db.prepare(
    `INSERT INTO queues (id, project_id, name, priority, max_concurrency, rate_limit_per_minute, retry_policy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    queueId, project.id, body.name,
    body.priority ?? 5, body.max_concurrency ?? 5,
    body.rate_limit_per_minute ?? null, body.retry_policy_id ?? null,
    now, now
  );

  res.status(201).json(db.prepare('SELECT * FROM queues WHERE id = ?').get(queueId));
});

// --- Individual queue operations --------------------------------------------

router.get('/queues/:queueId', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId);
  res.json(queueWithStats(getDb(), queue));
});

router.patch('/queues/:queueId', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'admin');
  const body = validate(req.body, QUEUE_FIELDS);

  const db = getDb();
  if (body.retry_policy_id) {
    const policy = db
      .prepare('SELECT 1 FROM retry_policies WHERE id = ? AND project_id = ?')
      .get(body.retry_policy_id, queue.project_id);
    if (!policy) throw ApiError.badRequest('retry_policy_id does not reference a policy in this project');
  }

  const fields = ['name', 'priority', 'max_concurrency', 'rate_limit_per_minute', 'retry_policy_id'];
  const updates = fields.filter((f) => body[f] !== undefined);
  if (!updates.length) throw ApiError.badRequest('No updatable fields provided');

  db.prepare(
    `UPDATE queues SET ${updates.map((f) => `${f} = @${f}`).join(', ')}, updated_at = @now WHERE id = @id`
  ).run({ ...body, now: Date.now(), id: queue.id });

  res.json(db.prepare('SELECT * FROM queues WHERE id = ?').get(queue.id));
});

router.post('/queues/:queueId/pause', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'admin');
  getDb().prepare('UPDATE queues SET is_paused = 1, updated_at = ? WHERE id = ?').run(Date.now(), queue.id);
  res.json({ id: queue.id, is_paused: true });
});

router.post('/queues/:queueId/resume', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'admin');
  getDb().prepare('UPDATE queues SET is_paused = 0, updated_at = ? WHERE id = ?').run(Date.now(), queue.id);
  res.json({ id: queue.id, is_paused: false });
});

router.delete('/queues/:queueId', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'admin');
  getDb().prepare('DELETE FROM queues WHERE id = ?').run(queue.id);
  res.status(204).end();
});

// --- Retry policies (project scoped) ----------------------------------------

router.get('/projects/:projectId/retry-policies', (req, res) => {
  const project = getProject(req.user.id, req.params.projectId);
  const policies = getDb()
    .prepare('SELECT * FROM retry_policies WHERE project_id = ? ORDER BY name')
    .all(project.id);
  res.json({ data: policies });
});

router.post('/projects/:projectId/retry-policies', (req, res) => {
  const project = getProject(req.user.id, req.params.projectId, 'admin');
  const body = validate(req.body, {
    name: { required: true, type: 'string', minLen: 1, maxLen: 100 },
    strategy: { required: true, type: 'string', enum: ['none', 'fixed', 'linear', 'exponential'] },
    max_attempts: { type: 'integer', min: 1, max: 50, default: 3 },
    base_delay_ms: { type: 'integer', min: 0, max: 3600000, default: 1000 },
    max_delay_ms: { type: 'integer', min: 0, max: 86400000, default: 60000 },
    jitter: { type: 'boolean', default: false },
  });

  const db = getDb();
  if (db.prepare('SELECT 1 FROM retry_policies WHERE project_id = ? AND name = ?').get(project.id, body.name)) {
    throw ApiError.conflict('A retry policy with this name already exists in the project');
  }

  const policyId = id('rtp');
  db.prepare(
    `INSERT INTO retry_policies (id, project_id, name, strategy, max_attempts, base_delay_ms, max_delay_ms, jitter, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    policyId, project.id, body.name, body.strategy,
    body.max_attempts, body.base_delay_ms, body.max_delay_ms,
    body.jitter ? 1 : 0, Date.now()
  );

  res.status(201).json(db.prepare('SELECT * FROM retry_policies WHERE id = ?').get(policyId));
});

module.exports = router;
