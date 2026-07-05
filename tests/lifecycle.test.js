const { test, before, after } = require('node:test');
const assert = require('node:assert');
const {
  startServer, stopServer, request, createWorkspace, registerWorker, getDb,
} = require('./helpers');
const { tick } = require('../src/services/scheduler');

before(() => startServer());
after(() => stopServer());

async function getJob(workspace, jobId) {
  const res = await request('GET', `/api/jobs/${jobId}`, { token: workspace.token });
  return res.body;
}

test('happy path: queued -> claimed -> running -> completed with an execution record', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace);

  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token,
    body: { handler: 'echo', payload: { hello: 'world' } },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.status, 'queued');

  const claimed = await request('POST', '/api/worker/claim', {
    worker: true, body: { worker_id: workerId },
  });
  assert.strictEqual(claimed.body.id, created.body.id);
  assert.strictEqual((await getJob(workspace, created.body.id)).status, 'claimed');

  const started = await request('POST', `/api/worker/jobs/${created.body.id}/start`, {
    worker: true, body: { worker_id: workerId },
  });
  assert.strictEqual(started.body.attempt, 1);
  assert.strictEqual((await getJob(workspace, created.body.id)).status, 'running');

  await request('POST', `/api/worker/jobs/${created.body.id}/complete`, {
    worker: true, body: { worker_id: workerId, output: { ok: true } },
  });

  const finalJob = await getJob(workspace, created.body.id);
  assert.strictEqual(finalJob.status, 'completed');
  assert.strictEqual(finalJob.executions.length, 1);
  assert.strictEqual(finalJob.executions[0].status, 'completed');
  assert.ok(finalJob.executions[0].duration_ms >= 0);
});

test('failure path: retries with backoff, then lands in the dead letter queue', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace, { name: 'failer' });

  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token,
    body: { handler: 'always_fail', max_attempts: 2 },
  });
  const jobId = created.body.id;

  // Attempt 1: fail -> retry scheduled in the future.
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${jobId}/start`, { worker: true, body: { worker_id: workerId } });
  const firstFail = await request('POST', `/api/worker/jobs/${jobId}/fail`, {
    worker: true, body: { worker_id: workerId, error: 'boom' },
  });
  assert.strictEqual(firstFail.body.outcome, 'retry_scheduled');

  let job = await getJob(workspace, jobId);
  assert.strictEqual(job.status, 'scheduled');
  assert.ok(job.run_at > Date.now(), 'retry is scheduled in the future');

  // Fast-forward: a scheduler tick past run_at promotes it back to queued.
  tick(job.run_at + 1);
  job = await getJob(workspace, jobId);
  assert.strictEqual(job.status, 'queued');

  // Attempt 2: final failure -> dead letter queue.
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${jobId}/start`, { worker: true, body: { worker_id: workerId } });
  const finalFail = await request('POST', `/api/worker/jobs/${jobId}/fail`, {
    worker: true, body: { worker_id: workerId, error: 'boom again' },
  });
  assert.strictEqual(finalFail.body.outcome, 'dead_lettered');

  job = await getJob(workspace, jobId);
  assert.strictEqual(job.status, 'dead');
  assert.strictEqual(job.executions.length, 2);
  assert.ok(job.dead_letter, 'DLQ entry exists');

  // Operator requeues from the DLQ and gets a fresh attempt budget.
  const requeued = await request('POST', `/api/dlq/${job.dead_letter.id}/retry`, {
    token: workspace.token,
  });
  assert.strictEqual(requeued.status, 200);
  job = await getJob(workspace, jobId);
  assert.strictEqual(job.status, 'queued');
  assert.strictEqual(job.attempts, 0);
});

test('completion reports are idempotent: a duplicate report is a no-op', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace, { name: 'dup' });

  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'echo' },
  });
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${created.body.id}/start`, { worker: true, body: { worker_id: workerId } });

  const first = await request('POST', `/api/worker/jobs/${created.body.id}/complete`, {
    worker: true, body: { worker_id: workerId },
  });
  const duplicate = await request('POST', `/api/worker/jobs/${created.body.id}/complete`, {
    worker: true, body: { worker_id: workerId },
  });
  assert.strictEqual(first.body.applied, true);
  assert.strictEqual(duplicate.body.applied, false, 'second report changes nothing');

  const job = await getJob(workspace, created.body.id);
  assert.strictEqual(job.executions.length, 1);
});

test('idempotency keys deduplicate job creation within a queue', async () => {
  const workspace = await createWorkspace();
  const body = { handler: 'echo', idempotency_key: 'order-42-confirmation' };

  const first = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body,
  });
  const second = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body,
  });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.id, first.body.id);
  assert.strictEqual(second.body.deduplicated, true);
});

test('batch creation is atomic and queryable by batch id', async () => {
  const workspace = await createWorkspace();
  const res = await request('POST', `/api/queues/${workspace.queueId}/jobs/batch`, {
    token: workspace.token,
    body: { jobs: [{ handler: 'echo' }, { handler: 'echo' }, { handler: 'sleep' }] },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.created, 3);

  const summary = await request('GET', `/api/batches/${res.body.batch_id}`, {
    token: workspace.token,
  });
  assert.strictEqual(summary.body.by_status.queued, 3);
});

test('workflow dependency: child waits until parent completes', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace, { name: 'dep' });

  const parent = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'echo' },
  });
  const child = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'echo', depends_on: parent.body.id },
  });
  assert.strictEqual(child.body.status, 'waiting');

  // Run the parent to completion; child becomes claimable.
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${parent.body.id}/start`, { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${parent.body.id}/complete`, { worker: true, body: { worker_id: workerId } });

  const readyChild = await getJob(workspace, child.body.id);
  assert.strictEqual(readyChild.status, 'queued');
});

test('a dependency on a dead or canceled job is rejected at creation', async () => {
  const workspace = await createWorkspace();
  const workerId = await registerWorker(workspace, { name: 'dead-parent' });

  // Drive a job to 'dead' (single attempt, no retry).
  const parent = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'always_fail', max_attempts: 1 },
  });
  await request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${parent.body.id}/start`, { worker: true, body: { worker_id: workerId } });
  await request('POST', `/api/worker/jobs/${parent.body.id}/fail`, {
    worker: true, body: { worker_id: workerId, error: 'nope' },
  });

  const child = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'echo', depends_on: parent.body.id },
  });
  assert.strictEqual(child.status, 400, 'child of a dead parent would wait forever');
  assert.match(child.body.error.message, /never complete/);
});

test('canceling a queued job prevents it from being claimed', async () => {
  const workspace = await createWorkspace();
  const created = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: workspace.token, body: { handler: 'echo' },
  });
  const canceled = await request('POST', `/api/jobs/${created.body.id}/cancel`, {
    token: workspace.token,
  });
  assert.strictEqual(canceled.status, 200);

  const workerId = await registerWorker(workspace, { name: 'cancel-check' });
  const claimAttempt = await request('POST', '/api/worker/claim', {
    worker: true, body: { worker_id: workerId },
  });
  assert.strictEqual(claimAttempt.status, 204);

  // A running job cannot be canceled through this endpoint.
  const db = getDb();
  db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(created.body.id);
  const badCancel = await request('POST', `/api/jobs/${created.body.id}/cancel`, {
    token: workspace.token,
  });
  assert.strictEqual(badCancel.status, 409);
});
