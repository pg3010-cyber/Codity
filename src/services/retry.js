// Retry delay computation. `attempt` is the attempt number that just failed
// (1-based), so the first retry after attempt 1 uses the base delay.

const DEFAULT_POLICY = {
  strategy: 'exponential',
  max_attempts: 3,
  base_delay_ms: 1000,
  max_delay_ms: 60000,
  jitter: 0,
};

function computeRetryDelay(policy, attempt) {
  const p = { ...DEFAULT_POLICY, ...policy };
  let delay;
  switch (p.strategy) {
    case 'none':
      return null;
    case 'fixed':
      delay = p.base_delay_ms;
      break;
    case 'linear':
      delay = p.base_delay_ms * attempt;
      break;
    case 'exponential':
      delay = p.base_delay_ms * 2 ** (attempt - 1);
      break;
    default:
      delay = p.base_delay_ms;
  }
  delay = Math.min(delay, p.max_delay_ms);
  if (p.jitter) {
    // Up to +25% random jitter to spread thundering herds of retries.
    delay += Math.floor(delay * 0.25 * Math.random());
  }
  return delay;
}

module.exports = { computeRetryDelay, DEFAULT_POLICY };
