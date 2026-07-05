// Handler registry. A handler receives (payload, ctx) and may return a JSON
// result. ctx.log(level, message) streams structured logs back to the server.
// Handlers should be idempotent where possible: the platform guarantees
// at-least-once execution, so a retried job may run twice.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  // Trivial echo — useful for smoke tests.
  echo: async (payload, ctx) => {
    ctx.log('info', `echo: ${JSON.stringify(payload)}`);
    return { echoed: payload };
  },

  // Sleeps payload.ms milliseconds (default 1000). Good for load testing
  // concurrency limits and graceful shutdown behaviour.
  sleep: async (payload, ctx) => {
    const ms = Math.min(Number(payload.ms) || 1000, 300000);
    ctx.log('info', `sleeping ${ms}ms`);
    await sleep(ms);
    return { slept_ms: ms };
  },

  // Simulated email delivery with a small random latency.
  send_email: async (payload, ctx) => {
    if (!payload.to) throw new Error('send_email requires payload.to');
    ctx.log('info', `rendering template '${payload.template || 'default'}' for ${payload.to}`);
    await sleep(200 + Math.random() * 600);
    ctx.log('info', `delivered to ${payload.to}`);
    return { delivered: true, to: payload.to };
  },

  // Real outbound HTTP call. payload: { url, method?, body?, headers? }
  http_request: async (payload, ctx) => {
    if (!payload.url) throw new Error('http_request requires payload.url');
    ctx.log('info', `${payload.method || 'GET'} ${payload.url}`);
    const response = await fetch(payload.url, {
      method: payload.method || 'GET',
      headers: payload.headers,
      body: payload.body ? JSON.stringify(payload.body) : undefined,
    });
    ctx.log(response.ok ? 'info' : 'warn', `upstream responded ${response.status}`);
    if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
    return { status: response.status };
  },

  // Simulated multi-step pipeline that reports progress through logs.
  generate_report: async (payload, ctx) => {
    for (const step of ['collecting rows', 'aggregating', 'rendering PDF', 'uploading']) {
      ctx.log('info', step);
      await sleep(150 + Math.random() * 350);
    }
    return { report: `report-${Date.now()}.pdf`, rows: payload.rows || 0 };
  },

  // Fails with probability payload.failure_rate (default 0.5) — exercises
  // the retry and dead-letter machinery.
  flaky: async (payload, ctx) => {
    const failureRate = payload.failure_rate ?? 0.5;
    await sleep(100 + Math.random() * 200);
    if (Math.random() < failureRate) {
      ctx.log('error', 'simulated transient failure');
      throw new Error('Simulated transient failure');
    }
    return { lucky: true };
  },

  // Always fails — guaranteed to end in the dead letter queue.
  always_fail: async (_payload, ctx) => {
    ctx.log('error', 'this handler always fails');
    throw new Error('This handler always fails');
  },
};
