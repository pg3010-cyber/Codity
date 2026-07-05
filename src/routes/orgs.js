const express = require('express');
const { getDb } = require('../db');
const { validate } = require('../validate');
const { ApiError } = require('../errors');
const { assertOrgRole, roleIn } = require('../access');

const router = express.Router();

router.get('/:orgId/members', (req, res) => {
  assertOrgRole(req.user.id, req.params.orgId, 'viewer');
  const members = getDb()
    .prepare(
      `SELECT u.id, u.email, u.name, m.role, m.created_at
       FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? ORDER BY m.created_at`
    )
    .all(req.params.orgId);
  res.json({ data: members });
});

// Add an existing user to the org by email with a role.
router.post('/:orgId/members', (req, res) => {
  assertOrgRole(req.user.id, req.params.orgId, 'admin');
  const body = validate(req.body, {
    email: { required: true, type: 'string' },
    role: { required: true, type: 'string', enum: ['admin', 'member', 'viewer'] },
  });

  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email.toLowerCase());
  if (!user) throw ApiError.notFound('User');
  if (roleIn(user.id, req.params.orgId)) {
    throw ApiError.conflict('User is already a member of this organization');
  }

  db.prepare(
    'INSERT INTO organization_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)'
  ).run(req.params.orgId, user.id, body.role, Date.now());

  res.status(201).json({ user_id: user.id, role: body.role });
});

router.delete('/:orgId/members/:userId', (req, res) => {
  assertOrgRole(req.user.id, req.params.orgId, 'admin');
  const target = roleIn(req.params.userId, req.params.orgId);
  if (!target) throw ApiError.notFound('Membership');
  if (target === 'owner') throw ApiError.forbidden('The owner cannot be removed');

  getDb()
    .prepare('DELETE FROM organization_members WHERE org_id = ? AND user_id = ?')
    .run(req.params.orgId, req.params.userId);
  res.status(204).end();
});

module.exports = router;
