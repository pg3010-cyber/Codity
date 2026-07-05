const express = require('express');
const path = require('path');
const { ApiError } = require('./errors');
const { requireAuth, requireWorker } = require('./middleware/auth');
const log = require('./logger');

const authRoutes = require('./routes/auth');
const orgRoutes = require('./routes/orgs');
const projectRoutes = require('./routes/projects');
const queueRoutes = require('./routes/queues');
const jobRoutes = require('./routes/jobs');
const scheduleRoutes = require('./routes/schedules');
const workerRoutes = require('./routes/workers');
const dlqRoutes = require('./routes/dlq');
const metricsRoutes = require('./routes/metrics');
const workerApiRoutes = require('./routes/workerApi');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Request logging with duration; skipped for the static dashboard.
  app.use('/api', (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log.info('request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // Public
  app.use('/api/auth', authRoutes);

  // Worker API (shared-token auth)
  app.use('/api/worker', requireWorker, workerApiRoutes);

  // User API (JWT auth)
  app.use('/api/orgs', requireAuth, orgRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api', requireAuth, queueRoutes);   // /projects/:id/queues, /queues/:id, retry policies
  app.use('/api', requireAuth, jobRoutes);     // /queues/:id/jobs, /jobs/:id, /batches/:id
  app.use('/api', requireAuth, scheduleRoutes);
  app.use('/api/workers', requireAuth, workerRoutes);
  app.use('/api', requireAuth, dlqRoutes);
  app.use('/api/metrics', requireAuth, metricsRoutes);

  // Dashboard (static single-page app)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (_req, _res, next) => next(ApiError.notFound('Endpoint')));

  // Central error handler: ApiErrors map to their status; anything else is a
  // logged 500 with no internals leaked to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      err = ApiError.badRequest('Request body is not valid JSON');
    }
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    log.error('unhandled error', { path: req.originalUrl, error: err.message, stack: err.stack });
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}

module.exports = { createApp };
