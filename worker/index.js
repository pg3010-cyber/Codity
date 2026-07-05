#!/usr/bin/env node
// Conveyor worker: registers with the API server, polls for jobs across N
// concurrent slots, executes handlers with a per-job timeout, streams logs,
// heartbeats every few seconds and drains gracefully on SIGINT/SIGTERM.
//
// Usage:
//   node worker/index.js [--name w1] [--concurrency 4] [--queues emails,default]
// Environment: API_URL, WORKER_TOKEN, WORKER_NAME, WORKER_CONCURRENCY, WORKER_QUEUES

const os = require('os');
const handlers = require('./handlers');

const args = parseArgs(process.argv.slice(2));
const API_URL = process.env.API_URL || 'http://localhost:4000';
const WORKER_TOKEN = process.env.WORKER_TOKEN || 'local-worker-token';
const NAME = args.name || process.env.WORKER_NAME || `worker-${os.hostname()}-${process.pid}`;
const CONCURRENCY = Number(args.concurrency || process.env.WORKER_CONCURRENCY || 4);
const QUEUES = (args.queues || process.env.WORKER_QUEUES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const HEARTBEAT_MS = 5000;
const IDLE_POLL_MIN_MS = 250;
const IDLE_POLL_MAX_MS = 2000;

let workerId = null;
let draining = false;
let activeJobs = 0;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function logLine(level, msg, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, worker: NAME, msg, ...extra }) + '\n'
  );
}

async function api(path, body) {
  const response = await fetch(`${API_URL}/api/worker${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-token': WORKER_TOKEN },
    body: JSON.stringify(body || {}),
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`API ${path} returned ${response.status}: ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function register() {
  const registration = await api('/register', {
    name: NAME,
    hostname: os.hostname(),
    pid: process.pid,
    max_concurrency: CONCURRENCY,
    queue_names: QUEUES.length ? QUEUES : undefined,
  });
  workerId = registration.worker_id;
  logLine('info', 'worker registered', {
    workerId,
    concurrency: CONCURRENCY,
    queues: QUEUES.length ? QUEUES : 'all',
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the handler with a hard timeout. The timer loses the race only if the
// handler genuinely overruns, in which case we report timed_out to the server.
async function executeWithTimeout(handler, payload, ctx, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([handler(payload, ctx), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class TimeoutError extends Error {}

async function runJob(job) {
  const started = await api(`/jobs/${job.id}/start`, { worker_id: workerId });
  const executionId = started.execution_id;

  // Buffer handler logs and flush in batches to keep chatty handlers cheap.
  const buffer = [];
  const ctx = {
    attempt: started.attempt,
    log: (level, message) => buffer.push({ level, message, ts: Date.now() }),
  };
  const flushLogs = async () => {
    if (!buffer.length) return;
    const entries = buffer.splice(0, buffer.length);
    await api(`/jobs/${job.id}/logs`, { execution_id: executionId, entries }).catch(() => {});
  };

  const handler = handlers[job.handler];
  try {
    if (!handler) throw new Error(`Unknown handler '${job.handler}'`);
    const output = await executeWithTimeout(handler, job.payload, ctx, job.timeout_ms);
    await flushLogs();
    await api(`/jobs/${job.id}/complete`, { worker_id: workerId, output: output ?? {} });
    logLine('info', 'job completed', { job: job.id, handler: job.handler, attempt: started.attempt });
  } catch (err) {
    await flushLogs();
    await api(`/jobs/${job.id}/fail`, {
      worker_id: workerId,
      error: String(err.message || err).slice(0, 5000),
      timed_out: err instanceof TimeoutError,
    });
    logLine('warn', 'job failed', { job: job.id, handler: job.handler, error: err.message });
  }
}

// One polling slot: claim -> execute -> repeat, with exponential idle backoff.
async function slotLoop(slot) {
  let idleDelay = IDLE_POLL_MIN_MS;
  while (!draining) {
    let job = null;
    try {
      job = await api('/claim', { worker_id: workerId });
    } catch (err) {
      logLine('warn', 'claim failed, backing off', { slot, error: err.message });
      await sleep(IDLE_POLL_MAX_MS);
      continue;
    }

    if (!job) {
      await sleep(idleDelay);
      idleDelay = Math.min(idleDelay * 2, IDLE_POLL_MAX_MS);
      continue;
    }

    idleDelay = IDLE_POLL_MIN_MS;
    activeJobs++;
    try {
      await runJob(job);
    } catch (err) {
      logLine('error', 'job reporting failed', { job: job.id, error: err.message });
    } finally {
      activeJobs--;
    }
  }
}

async function heartbeatLoop() {
  while (!draining) {
    try {
      await api('/heartbeat', {
        worker_id: workerId,
        active_jobs: activeJobs,
        rss_bytes: process.memoryUsage().rss,
      });
    } catch (err) {
      logLine('warn', 'heartbeat failed', { error: err.message });
      // The server no longer knows this worker (restarted with a fresh
      // database, or the record was removed) — re-register rather than
      // polling as a zombie forever.
      if (err.status === 404 && !draining) {
        try {
          await register();
        } catch (registerErr) {
          logLine('warn', 're-registration failed', { error: registerErr.message });
        }
      }
    }
    await sleep(HEARTBEAT_MS);
  }
}

async function shutdown(signal) {
  if (draining) return;
  draining = true;
  logLine('info', `received ${signal}, draining`, { active: activeJobs });

  // Wait (up to 30s) for in-flight jobs; new claims already stopped.
  const deadline = Date.now() + 30000;
  while (activeJobs > 0 && Date.now() < deadline) await sleep(200);

  try {
    await api('/deregister', { worker_id: workerId });
  } catch { /* server may already be gone */ }
  logLine('info', 'worker stopped');
  process.exit(0);
}

async function main() {
  await register();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  heartbeatLoop();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => slotLoop(i)));
  await shutdown('drain');
}

main().catch((err) => {
  logLine('error', 'worker crashed', { error: err.message });
  process.exit(1);
});
