const express = require('express');
const { getDb } = require('../db');
const { id } = require('../ids');
const { validate } = require('../validate');
const { ApiError } = require('../errors');
const { getQueue } = require('../access');
const { nextCronRun } = require('../services/scheduler');

const router = express.Router();

function assertValidCron(expression) {
  try {
    return nextCronRun(expression);
  } catch {
    throw ApiError.badRequest('cron_expression is not a valid cron expression', [
      { field: 'cron_expression', message: 'expected standard 5/6-field cron syntax' },
    ]);
  }
}

router.get('/queues/:queueId/schedules', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId);
  const schedules = getDb()
    .prepare('SELECT * FROM scheduled_jobs WHERE queue_id = ? ORDER BY name')
    .all(queue.id);
  res.json({ data: schedules });
});

router.post('/queues/:queueId/schedules', (req, res) => {
  const queue = getQueue(req.user.id, req.params.queueId, 'member');
  const body = validate(req.body, {
    name: { required: true, type: 'string', minLen: 1, maxLen: 100 },
    cron_expression: { required: true, type: 'string', maxLen: 100 },
    handler: { required: true, type: 'string', minLen: 1, maxLen: 100 },
    payload: { type: 'object' },
  });
  const nextRun = assertValidCron(body.cron_expression);

  const db = getDb();
  if (db.prepare('SELECT 1 FROM scheduled_jobs WHERE queue_id = ? AND name = ?').get(queue.id, body.name)) {
    throw ApiError.conflict('A schedule with this name already exists on the queue');
  }

  const scheduleId = id('sch');
  db.prepare(
    `INSERT INTO scheduled_jobs (id, queue_id, name, cron_expression, handler, payload, is_active, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    scheduleId, queue.id, body.name, body.cron_expression, body.handler,
    JSON.stringify(body.payload || {}), nextRun, Date.now()
  );

  res.status(201).json(db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(scheduleId));
});

router.patch('/schedules/:scheduleId', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(req.params.scheduleId);
  if (!schedule) throw ApiError.notFound('Schedule');
  getQueue(req.user.id, schedule.queue_id, 'member');

  const body = validate(req.body, {
    cron_expression: { type: 'string', maxLen: 100 },
    handler: { type: 'string', minLen: 1, maxLen: 100 },
    payload: { type: 'object' },
    is_active: { type: 'boolean' },
  });

  const cron = body.cron_expression ?? schedule.cron_expression;
  const nextRun = body.cron_expression ? assertValidCron(cron) : schedule.next_run_at;

  db.prepare(
    `UPDATE scheduled_jobs
     SET cron_expression = ?, handler = ?, payload = ?, is_active = ?, next_run_at = ?
     WHERE id = ?`
  ).run(
    cron,
    body.handler ?? schedule.handler,
    body.payload !== undefined ? JSON.stringify(body.payload) : schedule.payload,
    body.is_active !== undefined ? (body.is_active ? 1 : 0) : schedule.is_active,
    nextRun,
    schedule.id
  );

  res.json(db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(schedule.id));
});

router.delete('/schedules/:scheduleId', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(req.params.scheduleId);
  if (!schedule) throw ApiError.notFound('Schedule');
  getQueue(req.user.id, schedule.queue_id, 'member');

  db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(schedule.id);
  res.status(204).end();
});

module.exports = router;
