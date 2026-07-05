const { test } = require('node:test');
const assert = require('node:assert');
const { computeRetryDelay } = require('../src/services/retry');

test('fixed strategy returns the base delay for every attempt', () => {
  const policy = { strategy: 'fixed', base_delay_ms: 2000, max_delay_ms: 60000 };
  assert.strictEqual(computeRetryDelay(policy, 1), 2000);
  assert.strictEqual(computeRetryDelay(policy, 5), 2000);
});

test('linear strategy scales with the attempt number', () => {
  const policy = { strategy: 'linear', base_delay_ms: 1000, max_delay_ms: 60000 };
  assert.strictEqual(computeRetryDelay(policy, 1), 1000);
  assert.strictEqual(computeRetryDelay(policy, 3), 3000);
});

test('exponential strategy doubles per attempt', () => {
  const policy = { strategy: 'exponential', base_delay_ms: 1000, max_delay_ms: 600000 };
  assert.strictEqual(computeRetryDelay(policy, 1), 1000);
  assert.strictEqual(computeRetryDelay(policy, 2), 2000);
  assert.strictEqual(computeRetryDelay(policy, 4), 8000);
});

test('delays are capped at max_delay_ms', () => {
  const policy = { strategy: 'exponential', base_delay_ms: 1000, max_delay_ms: 5000 };
  assert.strictEqual(computeRetryDelay(policy, 10), 5000);
});

test('none strategy disables retries entirely', () => {
  assert.strictEqual(computeRetryDelay({ strategy: 'none' }, 1), null);
});

test('jitter adds at most 25% on top of the computed delay', () => {
  const policy = { strategy: 'fixed', base_delay_ms: 1000, max_delay_ms: 60000, jitter: 1 };
  for (let i = 0; i < 50; i++) {
    const delay = computeRetryDelay(policy, 1);
    assert.ok(delay >= 1000 && delay <= 1250, `delay ${delay} outside jitter window`);
  }
});
