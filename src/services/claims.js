// Atomic job claiming. The SELECT + conditional UPDATE run inside a single
// better-sqlite3 transaction; SQLite serializes writers, so two workers can
// never claim the same job. The UPDATE still re-checks status='queued' as a
// belt-and-braces guard (and to keep the logic portable to databases where
// the read and write are not implicitly serialized).

const { getDb } = require('../db');

// Picks the best eligible job for a worker, honouring:
//  - queue pause state
//  - per-queue concurrency limit (claimed + running jobs)
//  - per-queue rate limit (executions started in the last 60s, plus jobs
//    already claimed but not yet started)
//  - queue priority first, then job priority, then FIFO age
// Returns the claimed job row or null when nothing is eligible.
function claimJob(workerId) {
  const db = getDb();
  const now = Date.now();

  const worker = db
    .prepare(`SELECT * FROM workers WHERE id = ? AND status = 'online'`)
    .get(workerId);
  if (!worker) return null;

  const queueNames = worker.queue_names ? JSON.parse(worker.queue_names) : null;
  const queueFilter = queueNames && queueNames.length
    ? `AND q.name IN (${queueNames.map(() => '?').join(',')})`
    : '';

  const selectCandidate = db.prepare(`
    SELECT j.id
    FROM jobs j
    JOIN queues q ON q.id = j.queue_id
    WHERE j.status = 'queued'
      AND q.is_paused = 0
      ${queueFilter}
      AND (
        SELECT COUNT(*) FROM jobs a
        WHERE a.queue_id = j.queue_id AND a.status IN ('claimed', 'running')
      ) < q.max_concurrency
      AND (
        q.rate_limit_per_minute IS NULL
        OR (
          (SELECT COUNT(*) FROM job_executions e
           WHERE e.queue_id = j.queue_id AND e.started_at > @windowStart)
          +
          (SELECT COUNT(*) FROM jobs c
           WHERE c.queue_id = j.queue_id AND c.status = 'claimed')
        ) < q.rate_limit_per_minute
      )
    ORDER BY q.priority DESC, j.priority DESC, j.created_at ASC
    LIMIT 1
  `);

  const claim = db.prepare(`
    UPDATE jobs
    SET status = 'claimed', claimed_by = @workerId, claimed_at = @now, updated_at = @now
    WHERE id = @jobId AND status = 'queued'
  `);

  const txn = db.transaction(() => {
    const params = { windowStart: now - 60000 };
    const candidate = queueNames && queueNames.length
      ? selectCandidate.get(...queueNames, params)
      : selectCandidate.get(params);
    if (!candidate) return null;

    const result = claim.run({ jobId: candidate.id, workerId, now });
    if (result.changes !== 1) return null;
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.id);
  });

  return txn();
}

module.exports = { claimJob };
