const { test, before, after } = require('node:test');
const assert = require('node:assert');
const {
  startServer, stopServer, request, createWorkspace, registerWorker, getDb,
} = require('./helpers');
const { tick, nextCronRun } = require('../src/services/scheduler');

before(() => startServer());
after(() => stopServer());

test('delayed jobs stay scheduled until their run_at passes', async () => {
  const workspace = await createWorkspace();
  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token,
    body: { handler: 'echo', delay_ms: 60000 },
  });
  assert.strictEqual(created.body.status, 'scheduled');

  tick(Date.now()); // before run_at: nothing changes
  let res = await request('GET', `/api/jobs/${created.body.id}`, { token: workspace.token });
  assert.strictEqual(res.body.status, 'scheduled');

  tick(created.body.run_at + 1); // after run_at: promoted
  res = await request('GET', `/api/jobs/${created.body.id}`, { token: workspace.token });
  assert.strictEqual(res.body.status, 'queued');
});

test('nextCronRun computes a strictly future timestamp', () => {
  const from = new Date('2026-01-01T00:00:30Z');
  const next = nextCronRun('*/5 * * * *', from);
  assert.strictEqual(new Date(next).toISOString(), '2026-01-01T00:05:00.000Z');
});

test('invalid cron expressions are rejected at schedule creation', async () => {
  const workspace = await createWorkspace();
  const res = await request('POST', `/api/queues/${workspace.queueId}/schedules`, {
    token: workspace.token,
    body: { name: 'broken', cron_expression: 'not a cron', handler: 'echo' },
  });
  assert.strictEqual(res.status, 400);
});

test('due recurring schedules materialize exactly one job per tick window', async () => {
  const workspace = await createWorkspace();
  const schedule = await request('POST', `/api/queues/${workspace.queueId}/schedules`, {
    token: workspace.token,
    body: { name: 'every-minute', cron_expression: '* * * * *', handler: 'echo', payload: { from: 'cron' } },
  });

  // Force the schedule due, then tick.
  const db = getDb();
  db.prepare('UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?')
    .run(Date.now() - 1000, schedule.body.id);
  tick();

  const jobs = await request('GET', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token,
  });
  const cronJobs = jobs.body.data.filter((j) => j.schedule_id === schedule.body.id);
  assert.strictEqual(cronJobs.length, 1);
  assert.strictEqual(cronJobs[0].status, 'queued');

  // next_run_at advanced into the future; a second tick creates nothing new.
  tick();
  const again = await request('GET', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token,
  });
  assert.strictEqual(again.body.data.filter((j) => j.schedule_id === schedule.body.id).length, 1);
});

test('claimed jobs that never start are released back to the queue', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace, { name: 'fumbler' });

  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'echo' },
  });
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });

  // Simulate a worker that claimed but never called start: backdate the
  // claim past the timeout while keeping the worker's heartbeat fresh
  // (so the dead-worker reaper stays out of the picture).
  const db = getDb();
  db.prepare('UPDATE jobs SET claimed_at = ? WHERE id = ?')
    .run(Date.now() - 2 * 60 * 1000, created.body.id);
  tick();

  const job = await request('GET', `/api/jobs/${created.body.id}`, { token: workspace.token });
  assert.strictEqual(job.body.status, 'queued', 'stuck claim released');
  assert.strictEqual(job.body.claimed_by, null);
  assert.strictEqual(job.body.attempts, 0, 'a never-started claim consumes no retry budget');

  // The job is claimable again.
  const reclaim = await request('POST', '/api/worker/claim', {
    worker: true, body: { worker_id: workerId },
  });
  assert.strictEqual(reclaim.status, 200);
  assert.strictEqual(reclaim.body.id, created.body.id);
});

test('jobs from dead workers are recovered through the retry path', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace, { name: 'doomed' });

  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'sleep', max_attempts: 3 },
  });
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${created.body.id}/start`, {
    worker: true, body: { worker_id: workerId },
  });

  // Simulate a crash: backdate the heartbeat past the timeout, then tick.
  const db = getDb();
  db.prepare('UPDATE workers SET last_heartbeat_at = ? WHERE id = ?')
    .run(Date.now() - 10 * 60 * 1000, workerId);
  tick();

  const worker = db.prepare('SELECT status FROM workers WHERE id = ?').get(workerId);
  assert.strictEqual(worker.status, 'offline');

  const job = await request('GET', `/api/jobs/${created.body.id}`, { token: workspace.token });
  assert.strictEqual(job.body.status, 'scheduled', 'orphaned job is rescheduled for retry');
  assert.strictEqual(job.body.executions[0].status, 'lost');
  assert.match(job.body.last_error, /heartbeat/i);
});
