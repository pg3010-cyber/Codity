// Role-based access control. Roles live on the organization membership and
// flow down: org -> project -> queue -> job. Every resource lookup resolves
// its owning org and checks the caller's role there, so a valid token for
// one org can never touch another org's data.

const { getDb } = require('./db');
const { ApiError } = require('./errors');

const ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };

function roleIn(userId, orgId) {
  const row = getDb()
    .prepare('SELECT role FROM organization_members WHERE user_id = ? AND org_id = ?')
    .get(userId, orgId);
  return row ? row.role : null;
}

function assertOrgRole(userId, orgId, minRole) {
  const role = roleIn(userId, orgId);
  if (!role) throw ApiError.notFound('Organization');
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw ApiError.forbidden();
  return role;
}

// Each of these loads the resource, walks up to the org, and enforces the
// minimum role in one step. They throw 404 (not 403) for resources in orgs
// the caller doesn't belong to, to avoid leaking existence.

function getProject(userId, projectId, minRole = 'viewer') {
  const project = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw ApiError.notFound('Project');
  assertOrgRole(userId, project.org_id, minRole);
  return project;
}

function getQueue(userId, queueId, minRole = 'viewer') {
  const queue = getDb().prepare('SELECT * FROM queues WHERE id = ?').get(queueId);
  if (!queue) throw ApiError.notFound('Queue');
  getProject(userId, queue.project_id, minRole);
  return queue;
}

function getJob(userId, jobId, minRole = 'viewer') {
  const job = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw ApiError.notFound('Job');
  getQueue(userId, job.queue_id, minRole);
  return job;
}

// All queue ids across every org the user belongs to — used by dashboards
// that aggregate over everything the user can see.
function visibleQueueIds(userId) {
  return getDb()
    .prepare(
      `SELECT q.id FROM queues q
       JOIN projects p ON p.id = q.project_id
       JOIN organization_members m ON m.org_id = p.org_id
       WHERE m.user_id = ?`
    )
    .all(userId)
    .map((r) => r.id);
}

module.exports = { ROLE_RANK, roleIn, assertOrgRole, getProject, getQueue, getJob, visibleQueueIds };
