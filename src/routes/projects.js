const express = require('express');
const { getDb } = require('../db');
const { id } = require('../ids');
const { validate } = require('../validate');
const { ApiError } = require('../errors');
const { assertOrgRole, getProject, roleIn } = require('../access');

const router = express.Router();

// List projects across all orgs the caller belongs to.
router.get('/', (req, res) => {
  const projects = getDb()
    .prepare(
      `SELECT p.*, o.name AS org_name, m.role,
              (SELECT COUNT(*) FROM queues q WHERE q.project_id = p.id) AS queue_count
       FROM projects p
       JOIN organizations o ON o.id = p.org_id
       JOIN organization_members m ON m.org_id = p.org_id
       WHERE m.user_id = ?
       ORDER BY p.created_at DESC`
    )
    .all(req.user.id);
  res.json({ data: projects });
});

router.post('/', (req, res) => {
  const body = validate(req.body, {
    org_id: { required: true, type: 'string' },
    name: { required: true, type: 'string', minLen: 1, maxLen: 100 },
    description: { type: 'string', maxLen: 500 },
  });
  assertOrgRole(req.user.id, body.org_id, 'admin');

  const db = getDb();
  if (db.prepare('SELECT 1 FROM projects WHERE org_id = ? AND name = ?').get(body.org_id, body.name)) {
    throw ApiError.conflict('A project with this name already exists in the organization');
  }

  const now = Date.now();
  const projectId = id('prj');
  db.prepare(
    'INSERT INTO projects (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, body.org_id, body.name, body.description || null, now);

  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
});

router.get('/:projectId', (req, res) => {
  const project = getProject(req.user.id, req.params.projectId);
  const role = roleIn(req.user.id, project.org_id);
  res.json({ ...project, role });
});

router.patch('/:projectId', (req, res) => {
  const project = getProject(req.user.id, req.params.projectId, 'admin');
  const body = validate(req.body, {
    name: { type: 'string', minLen: 1, maxLen: 100 },
    description: { type: 'string', maxLen: 500 },
  });
  if (body.name === undefined && body.description === undefined) {
    throw ApiError.badRequest('No updatable fields provided');
  }

  const db = getDb();
  if (body.name && body.name !== project.name) {
    const clash = db
      .prepare('SELECT 1 FROM projects WHERE org_id = ? AND name = ? AND id != ?')
      .get(project.org_id, body.name, project.id);
    if (clash) throw ApiError.conflict('A project with this name already exists in the organization');
  }

  db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(
    body.name ?? project.name,
    body.description !== undefined ? body.description : project.description,
    project.id
  );
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
});

router.delete('/:projectId', (req, res) => {
  getProject(req.user.id, req.params.projectId, 'owner');
  // Queues, jobs, executions and logs all cascade from the project.
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.projectId);
  res.status(204).end();
});

module.exports = router;
