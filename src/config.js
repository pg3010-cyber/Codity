const path = require('path');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

module.exports = {
  port: Number(env('PORT', 4000)),
  dbPath: env('DB_PATH', path.join(__dirname, '..', 'data', 'conveyor.db')),
  jwtSecret: env('JWT_SECRET', 'dev-only-secret'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '24h'),
  workerToken: env('WORKER_TOKEN', 'local-worker-token'),

  // Scheduler cadence and liveness thresholds
  schedulerIntervalMs: Number(env('SCHEDULER_INTERVAL_MS', 1000)),
  workerHeartbeatTimeoutMs: Number(env('WORKER_HEARTBEAT_TIMEOUT_MS', 30000)),
  heartbeatRetentionMs: Number(env('HEARTBEAT_RETENTION_MS', 60 * 60 * 1000)),
  // A claimed job must start within this window or it is released back to
  // the queue (covers workers that claim and then fail to report start).
  claimTimeoutMs: Number(env('CLAIM_TIMEOUT_MS', 60000)),

  // Hard caps to keep list endpoints predictable
  maxPageSize: 100,
  defaultPageSize: 25,
};
