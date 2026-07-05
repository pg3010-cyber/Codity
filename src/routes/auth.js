const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { id } = require('../ids');
const { validate } = require('../validate');
const { ApiError } = require('../errors');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

function issueToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// Registration creates the user plus a personal organization they own, so
// a fresh account is immediately usable without an invite flow.
router.post('/register', (req, res) => {
  const body = validate(req.body, {
    email: { required: true, type: 'string', maxLen: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMessage: 'must be a valid email address' },
    password: { required: true, type: 'string', minLen: 8, maxLen: 100 },
    name: { required: true, type: 'string', minLen: 1, maxLen: 100 },
    organization_name: { type: 'string', maxLen: 100 },
  });

  const db = getDb();
  const email = body.email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const now = Date.now();
  const userId = id('usr');
  const orgId = id('org');

  db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, email, bcrypt.hashSync(body.password, 10), body.name, now);
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
      .run(orgId, body.organization_name || `${body.name}'s organization`, now);
    db.prepare('INSERT INTO organization_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(orgId, userId, 'owner', now);
  })();

  res.status(201).json({
    token: issueToken(userId),
    user: { id: userId, email, name: body.name },
    organization: { id: orgId },
  });
});

router.post('/login', (req, res) => {
  const body = validate(req.body, {
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
  });

  const user = getDb()
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(body.email.toLowerCase());
  if (!user || !bcrypt.compareSync(body.password, user.password_hash)) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  res.json({
    token: issueToken(user.id),
    user: { id: user.id, email: user.email, name: user.name },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const orgs = getDb()
    .prepare(
      `SELECT o.id, o.name, m.role FROM organizations o
       JOIN organization_members m ON m.org_id = o.id
       WHERE m.user_id = ?`
    )
    .all(req.user.id);
  res.json({ user: req.user, organizations: orgs });
});

module.exports = router;
