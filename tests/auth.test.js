const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, stopServer, request, createUser, createWorkspace } = require('./helpers');

before(() => startServer());
after(() => stopServer());

test('register returns a token and a personal organization', async () => {
  const user = await createUser();
  assert.ok(user.token);
  assert.ok(user.orgId.startsWith('org_'));
});

test('duplicate email registration is rejected with 409', async () => {
  const user = await createUser();
  const res = await request('POST', '/api/auth/register', {
    body: { email: user.email, password: 'password123', name: 'Copycat' },
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error.code, 'conflict');
});

test('login succeeds with valid credentials, fails with wrong password', async () => {
  const user = await createUser();
  const good = await request('POST', '/api/auth/login', {
    body: { email: user.email, password: 'password123' },
  });
  assert.strictEqual(good.status, 200);
  assert.ok(good.body.token);

  const bad = await request('POST', '/api/auth/login', {
    body: { email: user.email, password: 'wrong-password' },
  });
  assert.strictEqual(bad.status, 401);
});

test('protected endpoints reject missing and garbage tokens', async () => {
  const missing = await request('GET', '/api/projects');
  assert.strictEqual(missing.status, 401);

  const garbage = await request('GET', '/api/projects', { token: 'not-a-jwt' });
  assert.strictEqual(garbage.status, 401);
});

test('validation errors are structured with per-field details', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'not-an-email', password: 'short', name: '' },
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, 'bad_request');
  const fields = res.body.error.details.map((d) => d.field).sort();
  assert.deepStrictEqual(fields, ['email', 'name', 'password']);
});

test('users cannot see or touch resources in foreign organizations', async () => {
  const workspaceA = await createWorkspace();
  const userB = await createUser();

  // Both reads and writes must 404 (not 403) to avoid leaking existence.
  const read = await request('GET', `/api/queues/${workspaceA.queueId}`, { token: userB.token });
  assert.strictEqual(read.status, 404);

  const write = await request('POST', `/api/queues/${workspaceA.queueId}/jobs`, {
    token: userB.token,
    body: { handler: 'echo' },
  });
  assert.strictEqual(write.status, 404);
});

test('RBAC: viewers can read but cannot create jobs or pause queues', async () => {
  const workspace = await createWorkspace();
  const viewer = await createUser();
  const invite = await request('POST', `/api/orgs/${workspace.orgId}/members`, {
    token: workspace.token,
    body: { email: viewer.email, role: 'viewer' },
  });
  assert.strictEqual(invite.status, 201);

  const read = await request('GET', `/api/queues/${workspace.queueId}`, { token: viewer.token });
  assert.strictEqual(read.status, 200);

  const createJob = await request('POST', `/api/queues/${workspace.queueId}/jobs`, {
    token: viewer.token,
    body: { handler: 'echo' },
  });
  assert.strictEqual(createJob.status, 403);

  const pause = await request('POST', `/api/queues/${workspace.queueId}/pause`, { token: viewer.token });
  assert.strictEqual(pause.status, 403);
});

test('projects can be updated by admins but not by viewers', async () => {
  const workspace = await createWorkspace();

  const renamed = await request('PATCH', `/api/projects/${workspace.projectId}`, {
    token: workspace.token,
    body: { name: 'renamed-project', description: 'updated' },
  });
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.body.name, 'renamed-project');
  assert.strictEqual(renamed.body.description, 'updated');

  const viewer = await createUser();
  await request('POST', `/api/orgs/${workspace.orgId}/members`, {
    token: workspace.token,
    body: { email: viewer.email, role: 'viewer' },
  });
  const denied = await request('PATCH', `/api/projects/${workspace.projectId}`, {
    token: viewer.token,
    body: { name: 'hijacked' },
  });
  assert.strictEqual(denied.status, 403);
});

test('worker API rejects requests without the shared token', async () => {
  const res = await request('POST', '/api/worker/register', {
    body: { name: 'rogue' },
  });
  assert.strictEqual(res.status, 401);
});
