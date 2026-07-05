const { test, before, after } = require('node:test');
const assert = require('node:assert');
const {
  startServer, stopServer, request, createWorkspace, registerWorker,
} = require('./helpers');

before(() => startServer());
after(() => stopServer());

async function createJobs(workspace, count, extra = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const res = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
      token: workspace.token,
      body: { handler: 'echo', payload: { i }, ...extra },
    });
    ids.push(res.body.id);
  }
  return ids;
}

function claim(workerId) {
  return request('POST', '/api/worker/claim', { worker: true, body: { worker_id: workerId } });
}

test('concurrent claims never hand the same job to two workers', async () => {
  const workspace = await createWorkspace({ max_concurrency: 100 });
  await createJobs(workspace, 10);
  const workerA = await registerWorker(workspace, { name: 'wA' });
  const workerB = await registerWorker(workspace, { name: 'wB' });

  // 20 simultaneous claims racing for 10 jobs.
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => claim(i % 2 ? workerA : workerB))
  );
  const claimed = results.filter((r) => r.status === 200).map((r) => r.body.id);
  const empty = results.filter((r) => r.status === 204);

  assert.strictEqual(claimed.length, 10, 'every job claimed exactly once');
  assert.strictEqual(new Set(claimed).size, 10, 'no duplicate claims');
  assert.strictEqual(empty.length, 10, 'surplus claims come back empty');
});

test('claims respect the queue concurrency limit', async () => {
  const workspace = await createWorkspace({ max_concurrency: 2 });
  await createJobs(workspace, 5);
  const workerId = await registerWorker(workspace, { name: 'limited' });

  const first = await claim(workerId);
  const second = await claim(workerId);
  const third = await claim(workerId);

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(third.status, 204, 'third claim blocked by max_concurrency=2');

  // Completing one job frees a slot.
  await request('POST', `/api/worker/jobs/${first.body.id}/start`, {
    worker: true, body: { worker_id: workerId },
  });
  await request('POST', `/api/worker/jobs/${first.body.id}/complete`, {
    worker: true, body: { worker_id: workerId },
  });
  const fourth = await claim(workerId);
  assert.strictEqual(fourth.status, 200);
});

test('paused queues never hand out jobs', async () => {
  const workspace = await createWorkspace();
  await createJobs(workspace, 2);
  await request('POST', `/api/queues/${workspace.queueId}/pause`, { token: workspace.token });

  const workerId = await registerWorker(workspace, { name: 'pausable' });
  const blocked = await claim(workerId);
  assert.strictEqual(blocked.status, 204);

  await request('POST', `/api/queues/${workspace.queueId}/resume`, { token: workspace.token });
  const allowed = await claim(workerId);
  assert.strictEqual(allowed.status, 200);
});

test('higher priority jobs are claimed first within a queue', async () => {
  const workspace = await createWorkspace();
  await createJobs(workspace, 1, { priority: 2 });
  const [urgent] = await createJobs(workspace, 1, { priority: 9 });

  const workerId = await registerWorker(workspace, { name: 'priority' });
  const first = await claim(workerId);
  assert.strictEqual(first.body.id, urgent, 'priority 9 beats priority 2 despite FIFO age');
});

test('workers subscribed to specific queues ignore other queues', async () => {
  const workspace = await createWorkspace();
  await createJobs(workspace, 1);
  const stranger = await registerWorker(workspace, { name: 'stranger', queue_names: ['some-other-queue'] });
  const subscriber = await registerWorker(workspace, { name: 'subscriber' });

  const nothing = await claim(stranger);
  assert.strictEqual(nothing.status, 204);

  const something = await claim(subscriber);
  assert.strictEqual(something.status, 200);
});

test('per-queue rate limit caps claims in a rolling minute', async () => {
  const workspace = await createWorkspace({ name: 'ratelimited', rate_limit_per_minute: 2 });
  await createJobs(workspace, 4);
  const workerId = await registerWorker(workspace, { name: 'ratelimit-worker' });

  const first = await claim(workerId);
  const second = await claim(workerId);
  const third = await claim(workerId);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(third.status, 204, 'rate limit of 2/min blocks the third claim');
});
