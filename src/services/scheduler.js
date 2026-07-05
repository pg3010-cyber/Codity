// The scheduler is a single in-process loop owned by the API server. Each
// tick it: promotes due delayed/retry jobs, materializes recurring cron
// schedules into concrete jobs, reaps dead workers (recovering their
// in-flight jobs through the normal retry path), and prunes old heartbeats.

const cronParser = require('cron-parser');
const { getDb } = require('../db');
const { id } = require('../ids');
const { applyFailure } = require('./lifecycle');
const config = require('../config');
const log = require('../logger');

let timer = null;

function nextCronRun(expression, from = new Date()) {
  return cronParser.parseExpression(expression, { currentDate: from }).next().toDate().getTime();
}

function promoteDueJobs(db, now) {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'queued', updated_at = @now
       WHERE status = 'scheduled' AND run_at <= @now`
    )
    .run({ now });
  if (result.changes > 0) {
    log.debug('promoted scheduled jobs', { count: result.changes });
  }
}

function materializeSchedules(db, now) {
  const due = db
    .prepare(
      `SELECT s.*, q.id AS q_id FROM scheduled_jobs s
       JOIN queues q ON q.id = s.queue_id
       WHERE s.is_active = 1 AND s.next_run_at <= @now`
    )
    .all({ now });

  for (const schedule of due) {
    const jobId = id('job');
    db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs (id, queue_id, handler, payload, status, schedule_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
      ).run(jobId, schedule.queue_id, schedule.handler, schedule.payload, schedule.id, now, now);

      // Always advance from `now` so a stalled server does not fire a
      // burst of catch-up runs for every missed interval.
      db.prepare(
        `UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?`
      ).run(now, nextCronRun(schedule.cron_expression, new Date(now)), schedule.id);
    })();
    log.info('materialized recurring job', { scheduleId: schedule.id, jobId });
  }
}

function reapDeadWorkers(db, now) {
  const cutoff = now - config.workerHeartbeatTimeoutMs;
  const dead = db
    .prepare(
      `SELECT id FROM workers
       WHERE status IN ('online', 'draining') AND last_heartbeat_at < ?`
    )
    .all(cutoff);

  for (const worker of dead) {
    db.transaction(() => {
      db.prepare(`UPDATE workers SET status = 'offline' WHERE id = ?`).run(worker.id);

      const orphans = db
        .prepare(
          `SELECT * FROM jobs WHERE claimed_by = ? AND status IN ('claimed', 'running')`
        )
        .all(worker.id);

      for (const job of orphans) {
        // Close any open execution as 'lost', then route through the
        // standard retry/DLQ decision.
        db.prepare(
          `UPDATE job_executions
           SET status = 'lost', finished_at = @now, duration_ms = @now - started_at,
               error = 'Worker stopped heartbeating'
           WHERE job_id = @jobId AND status = 'running'`
        ).run({ jobId: job.id, now });

        applyFailure(db, job, 'Worker lost (heartbeat timeout)', now);
      }

      if (orphans.length) {
        log.warn('recovered jobs from dead worker', {
          workerId: worker.id,
          jobs: orphans.length,
        });
      }
    })();
  }
}

// Releases jobs stuck in 'claimed': a worker took the job but never reported
// start within the claim timeout (crashed mid-handoff, or its start call
// failed). The attempt never began, so this does not consume retry budget;
// the job simply becomes claimable again. If the original worker later tries
// to start it anyway, the status guard on the start transition rejects it.
function releaseStuckClaims(db, now) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = @now
       WHERE status = 'claimed' AND claimed_at < @cutoff`
    )
    .run({ now, cutoff: now - config.claimTimeoutMs });
  if (result.changes > 0) {
    log.warn('released stuck claims back to queue', { count: result.changes });
  }
}

function pruneHeartbeats(db, now) {
  db.prepare('DELETE FROM worker_heartbeats WHERE created_at < ?').run(
    now - config.heartbeatRetentionMs
  );
}

// One pass over all scheduler duties. Exported separately so tests can
// drive ticks deterministically without timers.
function tick(now = Date.now()) {
  const db = getDb();
  promoteDueJobs(db, now);
  materializeSchedules(db, now);
  reapDeadWorkers(db, now);
  releaseStuckClaims(db, now);
  pruneHeartbeats(db, now);
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      log.error('scheduler tick failed', { error: err.message });
    }
  }, config.schedulerIntervalMs);
  timer.unref();
  log.info('scheduler started', { intervalMs: config.schedulerIntervalMs });
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick, nextCronRun };
