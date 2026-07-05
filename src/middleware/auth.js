const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db');
const { ApiError } = require('../errors');

// User authentication: Bearer JWT issued by /api/auth/login.
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(ApiError.unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(ApiError.unauthorized('Invalid or expired token'));
  }

  const user = getDb()
    .prepare('SELECT id, email, name, created_at FROM users WHERE id = ?')
    .get(payload.sub);
  if (!user) return next(ApiError.unauthorized('User no longer exists'));

  req.user = user;
  next();
}

// Worker authentication: shared secret. Workers are infrastructure, not
// users, so they use a separate credential and a separate API surface.
function requireWorker(req, _res, next) {
  if (req.headers['x-worker-token'] !== config.workerToken) {
    return next(ApiError.unauthorized('Invalid worker token'));
  }
  next();
}

module.exports = { requireAuth, requireWorker };
