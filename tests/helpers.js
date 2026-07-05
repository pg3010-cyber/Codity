// Shared test harness: boots the full HTTP app against an in-memory SQLite
// database on an ephemeral port. node --test runs each file in its own
// process, so every test file gets a pristine database.

const { connect, getDb } = require('../src/db');
const { createApp } = require('../src/app');
const config = require('../src/config');

let server = null;
let baseUrl = null;

function startServer() {
  if (server) return baseUrl;
  connect(':memory:');
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

function stopServer() {
  if (server) server.close();
  server = null;
}

async function request(method, path, { token, worker, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (worker) headers['x-worker-token'] = config.workerToken;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let userCounter = 0;

// Registers a fresh user (with their own org) and returns credentials.
async function createUser(overrides = {}) {
  userCounter += 1;
  const res = await request('POST', '/api/auth/register', {
    body: {
      email: `user${userCounter}-${Date.now()}@test.dev`,
      password: 'password123',
      name: `Test User ${userCounter}`,
      ...overrides,
    },
  });
  if (res.status !== 201) throw new Error(`registration failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id, orgId: res.body.organization.id, email: res.body.user.email };
}

let queueCounter = 0;

// Standard fixture: user + project + queue, returning everything needed to
// create and claim jobs. Queue names are unique per workspace so tests in
// the same file (sharing one database) never claim each other's jobs.
async function createWorkspace(queueOverrides = {}) {
  const user = await createUser();
  queueCounter += 1;
  const project = await request('POST', '/api/projects', {
    token: user.token,
    body: { org_id: user.orgId, name: `proj-${Date.now()}-${userCounter}` },
  });
  const queue = await request('POST', `/api/projects/${project.body.id}/queues`, {
    token: user.token,
    body: { name: `queue-${queueCounter}`, ...queueOverrides },
  });
  return { ...user, projectId: project.body.id, queueId: queue.body.id, queueName: queue.body.name };
}

// Registers a worker subscribed to the workspace's queue (unless the test
// overrides queue_names explicitly).
async function registerWorker(workspace, options = {}) {
  const body = { name: options.name || 'test-worker', max_concurrency: 4, ...options };
  if (!body.queue_names && workspace?.queueName) body.queue_names = [workspace.queueName];
  const res = await request('POST', '/api/worker/register', { worker: true, body });
  return res.body.worker_id;
}

module.exports = { startServer, stopServer, request, createUser, createWorkspace, registerWorker, getDb };
