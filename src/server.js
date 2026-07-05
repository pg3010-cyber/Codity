const config = require('./config');
const { connect, close } = require('./db');
const { createApp } = require('./app');
const scheduler = require('./services/scheduler');
const log = require('./logger');

connect();
scheduler.start();

const server = createApp().listen(config.port, () => {
  log.info('server listening', { port: config.port, dashboard: `http://localhost:${config.port}` });
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  scheduler.stop();
  server.close(() => {
    close();
    process.exit(0);
  });
  // Do not hang forever on open keep-alive connections.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
