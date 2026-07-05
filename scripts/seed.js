// Seeds a demo workspace so the dashboard has something to show:
//   user  demo@conveyor.dev / password123
//   project "Acme App" with three queues, a retry policy, a cron schedule
//   and a spread of jobs (immediate, delayed, batch, flaky, dead-letter bait).

const bcrypt = require('bcryptjs');
const { connect } = require('../src/db');
const { id } = require('../src/ids');
const { nextCronRun } = require('../src/services/scheduler');

const db = connect();
const now = Date.now();

const existing = db.prepare('SELECT 1 FROM users WHERE email = ?').get('demo@conveyor.dev');
if (existing) {
  console.log('Seed data already present (demo@conveyor.dev exists) — nothing to do.');
  process.exit(0);
}

const userId = id('usr');
const orgId = id('org');
const projectId = id('prj');
const policyId = id('rtp');
const emailQueueId = id('que');
const reportQueueId = id('que');
const webhookQueueId = id('que');

db.transaction(() => {
  db.prepare('INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, 'demo@conveyor.dev', bcrypt.hashSync('password123', 10), 'Demo User', now);
  db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
    .run(orgId, 'Acme Inc', now);
  db.prepare('INSERT INTO organization_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(orgId, userId, 'owner', now);
  db.prepare('INSERT INTO projects (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, orgId, 'Acme App', 'Background jobs for the Acme web application', now);

  db.prepare(
    `INSERT INTO retry_policies (id, project_id, name, strategy, max_attempts, base_delay_ms, max_delay_ms, jitter, created_at)
     VALUES (?, ?, 'aggressive-exponential', 'exponential', 5, 500, 30000, 1, ?)`
  ).run(policyId, projectId, now);

  const insertQueue = db.prepare(
    `INSERT INTO queues (id, project_id, name, priority, max_concurrency, rate_limit_per_minute, retry_policy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertQueue.run(emailQueueId, projectId, 'emails', 8, 10, null, policyId, now, now);
  insertQueue.run(reportQueueId, projectId, 'reports', 3, 2, null, null, now, now);
  insertQueue.run(webhookQueueId, projectId, 'webhooks', 5, 5, 120, null, now, now);

  db.prepare(
    `INSERT INTO scheduled_jobs (id, queue_id, name, cron_expression, handler, payload, is_active, next_run_at, created_at)
     VALUES (?, ?, 'nightly-digest', '*/2 * * * *', 'generate_report', '{"rows":1200}', 1, ?, ?)`
  ).run(id('sch'), reportQueueId, nextCronRun('*/2 * * * *'), now);

  const insertJob = db.prepare(
    `INSERT INTO jobs (id, queue_id, handler, payload, status, priority, run_at, max_attempts, timeout_ms, batch_id, created_at, updated_at)
     VALUES (@id, @queue_id, @handler, @payload, @status, @priority, @run_at, @max_attempts, @timeout_ms, @batch_id, @now, @now)`
  );
  const base = {
    status: 'queued', priority: 5, run_at: null,
    max_attempts: 3, timeout_ms: 60000, batch_id: null, now,
  };

  // Immediate email jobs
  for (let i = 1; i <= 6; i++) {
    insertJob.run({
      ...base, id: id('job'), queue_id: emailQueueId, handler: 'send_email',
      payload: JSON.stringify({ to: `user${i}@example.com`, template: 'welcome' }),
      priority: i <= 2 ? 9 : 5,
    });
  }

  // Delayed job (runs in 2 minutes)
  insertJob.run({
    ...base, id: id('job'), queue_id: emailQueueId, handler: 'send_email',
    payload: JSON.stringify({ to: 'later@example.com', template: 'reminder' }),
    status: 'scheduled', run_at: now + 120000,
  });

  // Batch of webhook deliveries
  const batchId = id('bat');
  for (let i = 1; i <= 8; i++) {
    insertJob.run({
      ...base, id: id('job'), queue_id: webhookQueueId, handler: 'echo',
      payload: JSON.stringify({ event: 'order.created', order: 1000 + i }),
      batch_id: batchId,
    });
  }

  // Retry/DLQ exercisers
  insertJob.run({
    ...base, id: id('job'), queue_id: webhookQueueId, handler: 'flaky',
    payload: JSON.stringify({ failure_rate: 0.6 }),
  });
  insertJob.run({
    ...base, id: id('job'), queue_id: webhookQueueId, handler: 'always_fail',
    payload: '{}', max_attempts: 2,
  });

  // Slow report job to show concurrency limits
  insertJob.run({
    ...base, id: id('job'), queue_id: reportQueueId, handler: 'generate_report',
    payload: JSON.stringify({ rows: 5000 }),
  });
})();

console.log('Seeded demo workspace:');
console.log('  login:    demo@conveyor.dev / password123');
console.log('  project:  Acme App (queues: emails, reports, webhooks)');
console.log('Start the server (npm start) and a worker (npm run worker) to see it move.');
