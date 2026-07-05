/* Conveyor dashboard — a small hand-rolled SPA.
 * Hash routing + fetch + 3s polling on live views. No build step. */

(() => {
  'use strict';

  // ------------------------------------------------------------------ state
  const state = {
    token: localStorage.getItem('conveyor_token'),
    user: JSON.parse(localStorage.getItem('conveyor_user') || 'null'),
    orgs: [],
    pollTimer: null,
  };

  const view = document.getElementById('view');
  const sidebar = document.getElementById('sidebar');

  // ------------------------------------------------------------------ utils
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  const fmtAgo = (ms) => {
    if (!ms) return '—';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

  function toast(message, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `show${isError ? ' error' : ''}`;
    setTimeout(() => (el.className = ''), 2600);
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && state.token) return logout();
    if (!response.ok) {
      const details = (data.error?.details || []).map((d) => `${d.field} ${d.message}`).join('; ');
      throw new Error(details || data.error?.message || `HTTP ${response.status}`);
    }
    return data;
  }

  function setPoll(fn, ms = 3000) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      // Don't re-render underneath an open dialog.
      if (document.querySelector('.modal-backdrop')) return;
      fn().catch(() => {});
    }, ms);
  }

  // ------------------------------------------------------------------ auth
  function logout() {
    localStorage.removeItem('conveyor_token');
    localStorage.removeItem('conveyor_user');
    state.token = null;
    state.user = null;
    location.hash = '#/login';
  }

  document.getElementById('logout-btn').addEventListener('click', logout);

  function renderAuth(mode) {
    sidebar.classList.add('hidden');
    const isLogin = mode === 'login';
    view.innerHTML = `
      <div class="auth-wrap"><div class="auth-card">
        <h1>◆ Conveyor</h1>
        <p class="sub">${isLogin ? 'Sign in to your workspace' : 'Create your account'}</p>
        <form id="auth-form">
          ${isLogin ? '' : `
            <label>Name</label><input name="name" required maxlength="100">
            <label>Organization name <span class="dim">(optional)</span></label>
            <input name="organization_name" maxlength="100">`}
          <label>Email</label><input name="email" type="email" required>
          <label>Password</label><input name="password" type="password" required minlength="${isLogin ? 1 : 8}">
          <div class="form-error" id="auth-error"></div>
          <button class="btn" type="submit">${isLogin ? 'Sign in' : 'Create account'}</button>
        </form>
        <div class="auth-switch">
          ${isLogin ? `No account? <a href="#/register">Register</a>` : `Have an account? <a href="#/login">Sign in</a>`}
        </div>
      </div></div>`;

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try {
        const data = await api(`/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('conveyor_token', data.token);
        localStorage.setItem('conveyor_user', JSON.stringify(data.user));
        location.hash = '#/overview';
      } catch (err) {
        document.getElementById('auth-error').textContent = err.message;
      }
    });
  }

  // ------------------------------------------------------------------ modal
  function modal(title, bodyHtml, onSubmit) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h2>${esc(title)}</h2>
        <form id="modal-form">${bodyHtml}
          <div class="form-error" id="modal-error"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" id="modal-cancel">Cancel</button>
            <button type="submit" class="btn">Save</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    const closeModal = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => e.target === backdrop && closeModal());
    backdrop.querySelector('#modal-cancel').addEventListener('click', closeModal);
    backdrop.querySelector('#modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await onSubmit(Object.fromEntries(new FormData(e.target).entries()));
        closeModal();
      } catch (err) {
        backdrop.querySelector('#modal-error').textContent = err.message;
      }
    });
  }

  // ------------------------------------------------------------------ overview
  async function renderOverview() {
    const [overview, throughput] = await Promise.all([
      api('/metrics/overview'),
      api('/metrics/throughput?minutes=30'),
    ]);

    view.innerHTML = `
      <div class="page-title">Overview</div>
      <div class="page-sub">System health across everything you can see · auto-refreshing</div>
      <div class="cards">
        <div class="card"><div class="label">Backlog</div><div class="metric">${overview.jobs.backlog}</div></div>
        <div class="card"><div class="label">In flight</div><div class="metric warn">${overview.jobs.in_flight}</div></div>
        <div class="card"><div class="label">Completed (1h)</div><div class="metric good">${overview.last_hour.completed}</div></div>
        <div class="card"><div class="label">Failed (1h)</div><div class="metric ${overview.last_hour.failed ? 'bad' : ''}">${overview.last_hour.failed}</div></div>
        <div class="card"><div class="label">Failure rate (1h)</div><div class="metric ${overview.last_hour.failure_rate > 0.1 ? 'bad' : ''}">${(overview.last_hour.failure_rate * 100).toFixed(1)}%</div></div>
        <div class="card"><div class="label">Avg duration (1h)</div><div class="metric">${fmtMs(overview.last_hour.avg_duration_ms)}</div></div>
        <div class="card"><div class="label">Workers online</div><div class="metric ${overview.workers.online ? 'good' : 'bad'}">${overview.workers.online}</div></div>
        <div class="card"><div class="label">Dead letters</div><div class="metric ${overview.dead_letter_depth ? 'bad' : ''}">${overview.dead_letter_depth}</div></div>
      </div>
      <div class="panel">
        <h3>Throughput — last 30 minutes (per minute)</h3>
        <canvas id="throughput-chart" class="chart-canvas"></canvas>
      </div>
      <div class="panel">
        <h3>Jobs by status</h3>
        <div>${Object.entries(overview.jobs.by_status).map(([s, n]) => `${badge(s)} <b style="margin-right:16px">${n}</b>`).join('') || '<span class="dim">No jobs yet</span>'}</div>
      </div>`;

    drawThroughput(document.getElementById('throughput-chart'), throughput.data, 30);
  }

  function drawThroughput(canvas, rows, minutes) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const now = Math.floor(Date.now() / 60000) * 60000;
    const buckets = [];
    for (let i = minutes - 1; i >= 0; i--) {
      const minute = now - i * 60000;
      const row = rows.find((r) => r.minute === minute);
      buckets.push({ completed: row?.completed || 0, failed: row?.failed || 0 });
    }
    const max = Math.max(4, ...buckets.map((b) => b.completed + b.failed));
    const barWidth = width / buckets.length;

    ctx.clearRect(0, 0, width, height);
    // gridlines
    ctx.strokeStyle = 'rgba(42,49,64,.6)';
    ctx.fillStyle = '#8b94a5';
    ctx.font = '10px Segoe UI';
    for (let g = 0; g <= 2; g++) {
      const y = height - 14 - ((height - 24) * g) / 2;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.fillText(String(Math.round((max * g) / 2)), 2, y - 3);
    }
    buckets.forEach((b, i) => {
      const x = i * barWidth + 1;
      const completedHeight = ((height - 24) * b.completed) / max;
      const failedHeight = ((height - 24) * b.failed) / max;
      ctx.fillStyle = '#35c98a';
      ctx.fillRect(x, height - 14 - completedHeight, Math.max(1, barWidth - 2), completedHeight);
      ctx.fillStyle = '#f0596b';
      ctx.fillRect(x, height - 14 - completedHeight - failedHeight, Math.max(1, barWidth - 2), failedHeight);
    });
  }

  // ------------------------------------------------------------------ projects
  async function renderProjects() {
    const [{ data: projects }, me] = await Promise.all([api('/projects'), api('/auth/me')]);
    state.orgs = me.organizations;

    view.innerHTML = `
      <div class="page-head">
        <div><div class="page-title">Projects</div>
        <div class="page-sub">Each project owns its queues and retry policies</div></div>
        <button class="btn" id="new-project">＋ New project</button>
      </div>
      <div class="panel"><table>
        <thead><tr><th>Name</th><th>Organization</th><th>Your role</th><th>Queues</th><th>Created</th></tr></thead>
        <tbody>
          ${projects.map((p) => `
            <tr class="clickable" data-href="#/projects/${p.id}">
              <td><b>${esc(p.name)}</b><div class="dim" style="font-size:.8rem">${esc(p.description || '')}</div></td>
              <td>${esc(p.org_name)}</td><td>${badge(p.role)}</td>
              <td>${p.queue_count}</td><td class="dim">${fmtAgo(p.created_at)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">No projects yet — create one to get started.</td></tr>'}
        </tbody>
      </table></div>`;

    document.getElementById('new-project').addEventListener('click', () => {
      modal('New project', `
        <label>Organization</label>
        <select name="org_id">${state.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
        <label>Name</label><input name="name" required maxlength="100">
        <label>Description</label><input name="description" maxlength="500">`,
        async (data) => {
          await api('/projects', { method: 'POST', body: data });
          toast('Project created');
          renderProjects();
        });
    });
  }

  // ------------------------------------------------------------------ project detail (queues)
  async function renderProject(projectId) {
    const [project, { data: queues }, { data: policies }] = await Promise.all([
      api(`/projects/${projectId}`),
      api(`/projects/${projectId}/queues`),
      api(`/projects/${projectId}/retry-policies`),
    ]);

    view.innerHTML = `
      <div class="breadcrumb"><a href="#/projects">Projects</a> / ${esc(project.name)}</div>
      <div class="page-head">
        <div><div class="page-title">${esc(project.name)}</div>
        <div class="page-sub">${esc(project.description || 'Queues and retry policies')}</div></div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" id="new-policy">＋ Retry policy</button>
          <button class="btn" id="new-queue">＋ New queue</button>
        </div>
      </div>
      <div class="panel"><h3>Queues</h3><table>
        <thead><tr><th>Queue</th><th>State</th><th>Priority</th><th>Concurrency</th><th>Depth</th><th>Running</th><th>1h ✓/✗</th><th>Avg</th></tr></thead>
        <tbody>
          ${queues.map((q) => `
            <tr class="clickable" data-href="#/queues/${q.id}">
              <td><b>${esc(q.name)}</b></td>
              <td>${q.is_paused ? badge('paused') : badge('online')}</td>
              <td>${q.priority}</td><td>${q.max_concurrency}</td>
              <td>${q.stats.depth}</td>
              <td>${(q.stats.by_status.running || 0) + (q.stats.by_status.claimed || 0)}</td>
              <td><span style="color:var(--green)">${q.stats.last_hour.completed}</span> / <span style="color:var(--red)">${q.stats.last_hour.failed}</span></td>
              <td>${fmtMs(q.stats.last_hour.avg_duration_ms)}</td>
            </tr>`).join('') || '<tr><td colspan="8" class="empty">No queues yet.</td></tr>'}
        </tbody>
      </table></div>
      <div class="panel"><h3>Retry policies</h3><table>
        <thead><tr><th>Name</th><th>Strategy</th><th>Max attempts</th><th>Base delay</th><th>Max delay</th><th>Jitter</th></tr></thead>
        <tbody>
          ${policies.map((p) => `
            <tr><td><b>${esc(p.name)}</b></td><td>${esc(p.strategy)}</td><td>${p.max_attempts}</td>
            <td>${fmtMs(p.base_delay_ms)}</td><td>${fmtMs(p.max_delay_ms)}</td><td>${p.jitter ? 'yes' : 'no'}</td></tr>`).join('')
            || '<tr><td colspan="6" class="empty">No custom policies — queues fall back to exponential ×3.</td></tr>'}
        </tbody>
      </table></div>`;

    document.getElementById('new-queue').addEventListener('click', () => {
      modal('New queue', `
        <label>Name</label><input name="name" required pattern="[a-z0-9][a-z0-9-_]*" title="lowercase, digits, - and _">
        <div class="form-row">
          <div><label>Priority (1–10)</label><input name="priority" type="number" value="5" min="1" max="10"></div>
          <div><label>Max concurrency</label><input name="max_concurrency" type="number" value="5" min="1"></div>
        </div>
        <label>Rate limit / minute <span class="dim">(blank = unlimited)</span></label>
        <input name="rate_limit_per_minute" type="number" min="1">
        <label>Retry policy</label>
        <select name="retry_policy_id"><option value="">Default (exponential ×3)</option>
          ${policies.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select>`,
        async (data) => {
          const body = {
            name: data.name,
            priority: Number(data.priority),
            max_concurrency: Number(data.max_concurrency),
          };
          if (data.rate_limit_per_minute) body.rate_limit_per_minute = Number(data.rate_limit_per_minute);
          if (data.retry_policy_id) body.retry_policy_id = data.retry_policy_id;
          await api(`/projects/${projectId}/queues`, { method: 'POST', body });
          toast('Queue created');
          renderProject(projectId);
        });
    });

    document.getElementById('new-policy').addEventListener('click', () => {
      modal('New retry policy', `
        <label>Name</label><input name="name" required>
        <label>Strategy</label>
        <select name="strategy">
          <option value="exponential">exponential</option><option value="linear">linear</option>
          <option value="fixed">fixed</option><option value="none">none</option>
        </select>
        <div class="form-row">
          <div><label>Max attempts</label><input name="max_attempts" type="number" value="3" min="1" max="50"></div>
          <div><label>Base delay (ms)</label><input name="base_delay_ms" type="number" value="1000" min="0"></div>
        </div>
        <div class="form-row">
          <div><label>Max delay (ms)</label><input name="max_delay_ms" type="number" value="60000" min="0"></div>
          <div><label>Jitter</label><select name="jitter"><option value="false">no</option><option value="true">yes</option></select></div>
        </div>`,
        async (data) => {
          await api(`/projects/${projectId}/retry-policies`, {
            method: 'POST',
            body: {
              name: data.name, strategy: data.strategy,
              max_attempts: Number(data.max_attempts),
              base_delay_ms: Number(data.base_delay_ms),
              max_delay_ms: Number(data.max_delay_ms),
              jitter: data.jitter === 'true',
            },
          });
          toast('Retry policy created');
          renderProject(projectId);
        });
    });
  }

  // ------------------------------------------------------------------ queue detail
  async function renderQueue(queueId, page = 1, statusFilter = '') {
    const query = new URLSearchParams({ page, limit: 20 });
    if (statusFilter) query.set('status', statusFilter);
    const [queue, jobsPage, { data: schedules }] = await Promise.all([
      api(`/queues/${queueId}`),
      api(`/queues/${queueId}/jobs?${query}`),
      api(`/queues/${queueId}/schedules`),
    ]);
    const s = queue.stats;

    view.innerHTML = `
      <div class="breadcrumb"><a href="#/projects">Projects</a> / <a href="#/projects/${queue.project_id}">project</a> / ${esc(queue.name)}</div>
      <div class="page-head">
        <div><div class="page-title">${esc(queue.name)} ${queue.is_paused ? badge('paused') : ''}</div>
        <div class="page-sub">priority ${queue.priority} · concurrency ${queue.max_concurrency}${queue.rate_limit_per_minute ? ` · ${queue.rate_limit_per_minute}/min` : ''}</div></div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" id="edit-queue">Edit</button>
          <button class="btn btn-ghost" id="toggle-pause">${queue.is_paused ? 'Resume' : 'Pause'}</button>
          <button class="btn btn-ghost" id="new-schedule">＋ Schedule</button>
          <button class="btn" id="new-job">＋ New job</button>
        </div>
      </div>
      <div class="cards">
        <div class="card"><div class="label">Depth</div><div class="metric">${s.depth}</div></div>
        <div class="card"><div class="label">Running</div><div class="metric warn">${(s.by_status.running || 0) + (s.by_status.claimed || 0)}</div></div>
        <div class="card"><div class="label">Completed (1h)</div><div class="metric good">${s.last_hour.completed}</div></div>
        <div class="card"><div class="label">Failed (1h)</div><div class="metric ${s.last_hour.failed ? 'bad' : ''}">${s.last_hour.failed}</div></div>
        <div class="card"><div class="label">Dead</div><div class="metric ${s.by_status.dead ? 'bad' : ''}">${s.by_status.dead || 0}</div></div>
      </div>

      ${schedules.length ? `<div class="panel"><h3>Recurring schedules</h3><table>
        <thead><tr><th>Name</th><th>Cron</th><th>Handler</th><th>Active</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
        <tbody>${schedules.map((sch) => `
          <tr><td><b>${esc(sch.name)}</b></td><td class="mono">${esc(sch.cron_expression)}</td>
          <td class="mono">${esc(sch.handler)}</td><td>${sch.is_active ? badge('online') : badge('paused')}</td>
          <td class="dim">${fmtTime(sch.next_run_at)}</td><td class="dim">${fmtAgo(sch.last_run_at)}</td>
          <td><button class="btn btn-ghost btn-sm" data-toggle-schedule="${sch.id}" data-active="${sch.is_active}">${sch.is_active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}
        </tbody></table></div>` : ''}

      <div class="panel">
        <div class="toolbar">
          <h3 style="margin:0">Jobs</h3>
          <select id="status-filter">
            <option value="">All statuses</option>
            ${['waiting','queued','scheduled','claimed','running','completed','dead','canceled']
              .map((st) => `<option value="${st}" ${st === statusFilter ? 'selected' : ''}>${st}</option>`).join('')}
          </select>
        </div>
        <table>
          <thead><tr><th>Job</th><th>Handler</th><th>Status</th><th>Priority</th><th>Attempts</th><th>Created</th><th>Run at</th></tr></thead>
          <tbody>
            ${jobsPage.data.map((j) => `
              <tr class="clickable" data-href="#/jobs/${j.id}">
                <td class="mono">${esc(j.id.slice(0, 12))}…</td>
                <td class="mono">${esc(j.handler)}</td>
                <td>${badge(j.status)}</td><td>${j.priority}</td>
                <td>${j.attempts}/${j.max_attempts}</td>
                <td class="dim">${fmtAgo(j.created_at)}</td>
                <td class="dim">${j.run_at ? fmtTime(j.run_at) : '—'}</td>
              </tr>`).join('') || '<tr><td colspan="7" class="empty">No jobs match.</td></tr>'}
          </tbody>
        </table>
        <div class="pager">
          <span>Page ${jobsPage.pagination.page} of ${Math.max(1, jobsPage.pagination.pages)} (${jobsPage.pagination.total} jobs)</span>
          <button class="btn btn-ghost btn-sm" id="prev-page" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
          <button class="btn btn-ghost btn-sm" id="next-page" ${page >= jobsPage.pagination.pages ? 'disabled' : ''}>Next ›</button>
        </div>
      </div>`;

    document.getElementById('status-filter').addEventListener('change', (e) => {
      clearInterval(state.pollTimer);
      renderQueue(queueId, 1, e.target.value);
    });
    document.getElementById('prev-page').addEventListener('click', () => renderQueue(queueId, page - 1, statusFilter));
    document.getElementById('next-page').addEventListener('click', () => renderQueue(queueId, page + 1, statusFilter));

    document.getElementById('edit-queue').addEventListener('click', () => {
      modal('Edit queue', `
        <div class="form-row">
          <div><label>Priority (1–10)</label><input name="priority" type="number" value="${queue.priority}" min="1" max="10"></div>
          <div><label>Max concurrency</label><input name="max_concurrency" type="number" value="${queue.max_concurrency}" min="1"></div>
        </div>
        <label>Rate limit / minute <span class="dim">(blank = unlimited)</span></label>
        <input name="rate_limit_per_minute" type="number" min="1" value="${queue.rate_limit_per_minute ?? ''}">`,
        async (data) => {
          const body = {
            priority: Number(data.priority),
            max_concurrency: Number(data.max_concurrency),
          };
          if (data.rate_limit_per_minute) body.rate_limit_per_minute = Number(data.rate_limit_per_minute);
          await api(`/queues/${queueId}`, { method: 'PATCH', body });
          toast('Queue updated');
          renderQueue(queueId, page, statusFilter);
        });
    });

    document.getElementById('toggle-pause').addEventListener('click', async () => {
      await api(`/queues/${queueId}/${queue.is_paused ? 'resume' : 'pause'}`, { method: 'POST' });
      toast(queue.is_paused ? 'Queue resumed' : 'Queue paused');
      renderQueue(queueId, page, statusFilter);
    });

    view.querySelectorAll('[data-toggle-schedule]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/schedules/${btn.dataset.toggleSchedule}`, {
          method: 'PATCH',
          body: { is_active: btn.dataset.active !== '1' },
        });
        renderQueue(queueId, page, statusFilter);
      });
    });

    document.getElementById('new-job').addEventListener('click', () => {
      modal('New job', `
        <label>Handler</label>
        <select name="handler">
          ${['echo','sleep','send_email','http_request','generate_report','flaky','always_fail']
            .map((h) => `<option>${h}</option>`).join('')}
        </select>
        <label>Payload (JSON)</label><textarea name="payload" rows="3">{}</textarea>
        <div class="form-row">
          <div><label>Priority</label><input name="priority" type="number" value="5" min="1" max="10"></div>
          <div><label>Delay (ms, optional)</label><input name="delay_ms" type="number" min="0" placeholder="run immediately"></div>
        </div>
        <div class="form-row">
          <div><label>Max attempts <span class="dim">(blank = policy)</span></label><input name="max_attempts" type="number" min="1" max="50"></div>
          <div><label>Timeout (ms)</label><input name="timeout_ms" type="number" value="60000" min="100"></div>
        </div>
        <label>Idempotency key <span class="dim">(optional)</span></label><input name="idempotency_key">`,
        async (data) => {
          let payload;
          try { payload = JSON.parse(data.payload || '{}'); }
          catch { throw new Error('Payload must be valid JSON'); }
          const body = { handler: data.handler, payload, priority: Number(data.priority), timeout_ms: Number(data.timeout_ms) };
          if (data.delay_ms) body.delay_ms = Number(data.delay_ms);
          if (data.max_attempts) body.max_attempts = Number(data.max_attempts);
          if (data.idempotency_key) body.idempotency_key = data.idempotency_key;
          const created = await api(`/queues/${queueId}/jobs`, { method: 'POST', body });
          toast(created.deduplicated ? 'Duplicate — returned existing job' : 'Job created');
          renderQueue(queueId, page, statusFilter);
        });
    });

    document.getElementById('new-schedule').addEventListener('click', () => {
      modal('New recurring schedule', `
        <label>Name</label><input name="name" required>
        <label>Cron expression</label><input name="cron_expression" required placeholder="*/5 * * * *">
        <label>Handler</label>
        <select name="handler">
          ${['echo','sleep','send_email','http_request','generate_report','flaky']
            .map((h) => `<option>${h}</option>`).join('')}
        </select>
        <label>Payload (JSON)</label><textarea name="payload" rows="3">{}</textarea>`,
        async (data) => {
          let payload;
          try { payload = JSON.parse(data.payload || '{}'); }
          catch { throw new Error('Payload must be valid JSON'); }
          await api(`/queues/${queueId}/schedules`, {
            method: 'POST',
            body: { name: data.name, cron_expression: data.cron_expression, handler: data.handler, payload },
          });
          toast('Schedule created');
          renderQueue(queueId, page, statusFilter);
        });
    });

    // Live refresh that keeps the current page and status filter.
    setPoll(() => renderQueue(queueId, page, statusFilter));
  }

  // ------------------------------------------------------------------ job detail
  async function renderJob(jobId) {
    const job = await api(`/jobs/${jobId}`);

    const actions = [];
    if (['waiting', 'queued', 'scheduled'].includes(job.status)) {
      actions.push('<button class="btn btn-danger" id="cancel-job">Cancel</button>');
    }
    if (['dead', 'canceled'].includes(job.status)) {
      actions.push('<button class="btn" id="retry-job">Retry job</button>');
    }

    view.innerHTML = `
      <div class="breadcrumb"><a href="#/queues/${job.queue_id}">← Back to queue</a></div>
      <div class="page-head">
        <div><div class="page-title mono">${esc(job.id)}</div>
        <div class="page-sub">${badge(job.status)} · handler <span class="mono">${esc(job.handler)}</span> · attempt ${job.attempts}/${job.max_attempts}</div></div>
        <div style="display:flex;gap:10px">${actions.join('')}</div>
      </div>

      <div class="cards">
        <div class="card"><div class="label">Created</div><div style="margin-top:6px">${fmtTime(job.created_at)}</div></div>
        <div class="card"><div class="label">Run at</div><div style="margin-top:6px">${job.run_at ? fmtTime(job.run_at) : 'immediate'}</div></div>
        <div class="card"><div class="label">Started</div><div style="margin-top:6px">${fmtTime(job.started_at)}</div></div>
        <div class="card"><div class="label">Finished</div><div style="margin-top:6px">${fmtTime(job.finished_at)}</div></div>
      </div>

      ${job.last_error ? `<div class="panel" style="border-color:var(--red)"><h3 style="color:var(--red)">Last error</h3><div class="mono">${esc(job.last_error)}</div></div>` : ''}
      ${job.depends_on ? `<div class="panel"><h3>Depends on</h3><a class="mono" style="color:var(--accent)" href="#/jobs/${esc(job.depends_on)}">${esc(job.depends_on)}</a></div>` : ''}

      <div class="panel"><h3>Payload</h3><div class="log-box">${esc(JSON.stringify(JSON.parse(job.payload), null, 2))}</div></div>

      <div class="panel"><h3>Executions (${job.executions.length})</h3><table>
        <thead><tr><th>#</th><th>Status</th><th>Worker</th><th>Started</th><th>Duration</th><th>Error / output</th></tr></thead>
        <tbody>
          ${job.executions.map((e) => `
            <tr><td>${e.attempt}</td><td>${badge(e.status)}</td>
            <td class="mono">${esc((e.worker_id || '—').slice(0, 12))}</td>
            <td class="dim">${fmtTime(e.started_at)}</td><td>${fmtMs(e.duration_ms)}</td>
            <td class="mono" style="max-width:340px;word-break:break-all">${esc(e.error || e.output || '—')}</td></tr>`).join('')
            || '<tr><td colspan="6" class="empty">Not executed yet.</td></tr>'}
        </tbody>
      </table></div>

      <div class="panel"><h3>Logs (${job.logs.length})</h3>
        <div class="log-box">${job.logs.map((l) =>
          `<div class="log-line ${esc(l.level)}"><span class="ts">${new Date(l.created_at).toLocaleTimeString()}</span>[${esc(l.level)}] ${esc(l.message)}</div>`).join('')
          || '<span class="dim">No logs.</span>'}</div>
      </div>`;

    document.getElementById('cancel-job')?.addEventListener('click', async () => {
      await api(`/jobs/${jobId}/cancel`, { method: 'POST' });
      toast('Job canceled');
      renderJob(jobId);
    });
    document.getElementById('retry-job')?.addEventListener('click', async () => {
      await api(`/jobs/${jobId}/retry`, { method: 'POST' });
      toast('Job requeued');
      renderJob(jobId);
    });
  }

  // ------------------------------------------------------------------ workers
  async function renderWorkers() {
    const { data: workers } = await api('/workers');
    view.innerHTML = `
      <div class="page-title">Workers</div>
      <div class="page-sub">Heartbeat timeout marks workers offline and recovers their jobs</div>
      <div class="panel"><table>
        <thead><tr><th>Worker</th><th>Status</th><th>Host</th><th>Slots</th><th>Active</th><th>Queues</th><th>Last heartbeat</th></tr></thead>
        <tbody>
          ${workers.map((w) => `
            <tr>
              <td><b>${esc(w.name)}</b><div class="mono dim" style="font-size:.75rem">${esc(w.id.slice(0, 16))}…</div></td>
              <td>${badge(w.status)}</td>
              <td class="dim">${esc(w.hostname || '—')}${w.pid ? ` · pid ${w.pid}` : ''}</td>
              <td>${w.max_concurrency}</td><td>${w.active_jobs}</td>
              <td class="mono dim">${w.queue_names ? esc(JSON.parse(w.queue_names).join(', ')) : 'all'}</td>
              <td class="dim">${fmtAgo(w.last_heartbeat_at)}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="empty">No workers have registered yet. Start one with <span class="mono">npm run worker</span>.</td></tr>'}
        </tbody>
      </table></div>`;
  }

  // ------------------------------------------------------------------ DLQ
  async function renderDlq() {
    const { data: entries } = await api('/dlq');
    view.innerHTML = `
      <div class="page-title">Dead Letter Queue</div>
      <div class="page-sub">Jobs that exhausted every retry — inspect and requeue</div>
      <div class="panel"><table>
        <thead><tr><th>Job</th><th>Queue</th><th>Handler</th><th>Attempts</th><th>Error</th><th>Moved</th><th></th></tr></thead>
        <tbody>
          ${entries.map((d) => `
            <tr>
              <td><a class="mono" style="color:var(--accent);text-decoration:none" href="#/jobs/${d.job_id}">${esc(d.job_id.slice(0, 12))}…</a></td>
              <td>${esc(d.queue_name)}</td><td class="mono">${esc(d.handler)}</td>
              <td>${d.attempts}</td>
              <td class="mono" style="max-width:300px;word-break:break-all">${esc(d.error || '—')}</td>
              <td class="dim">${fmtAgo(d.moved_at)}</td>
              <td><button class="btn btn-sm" data-retry-dlq="${d.id}">Requeue</button></td>
            </tr>`).join('') || '<tr><td colspan="7" class="empty">Dead letter queue is empty. 🎉</td></tr>'}
        </tbody>
      </table></div>`;

    view.querySelectorAll('[data-retry-dlq]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/dlq/${btn.dataset.retryDlq}/retry`, { method: 'POST' });
          toast('Job requeued');
          renderDlq();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  // ------------------------------------------------------------------ router
  const routes = [
    { pattern: /^#\/login$/, render: () => renderAuth('login'), public: true },
    { pattern: /^#\/register$/, render: () => renderAuth('register'), public: true },
    { pattern: /^#\/overview$/, render: renderOverview, poll: renderOverview, nav: 'overview' },
    { pattern: /^#\/projects$/, render: renderProjects, nav: 'projects' },
    { pattern: /^#\/projects\/([\w]+)$/, render: (id) => renderProject(id), poll: true, nav: 'projects' },
    { pattern: /^#\/queues\/([\w]+)$/, render: (id) => renderQueue(id), nav: 'projects' },
    { pattern: /^#\/jobs\/([\w]+)$/, render: (id) => renderJob(id), poll: true, nav: 'projects' },
    { pattern: /^#\/workers$/, render: renderWorkers, poll: renderWorkers, nav: 'workers' },
    { pattern: /^#\/dlq$/, render: renderDlq, nav: 'dlq' },
  ];

  async function route() {
    clearInterval(state.pollTimer);
    const hash = location.hash || '#/overview';
    const match = routes.find((r) => r.pattern.test(hash));

    if (!match || (!match.public && !state.token)) {
      location.hash = state.token ? '#/overview' : '#/login';
      return;
    }
    if (match.public && state.token) {
      location.hash = '#/overview';
      return;
    }

    if (!match.public) {
      sidebar.classList.remove('hidden');
      document.getElementById('user-email').textContent = state.user?.email || '';
      document.querySelectorAll('#sidebar nav a').forEach((a) => {
        a.classList.toggle('active', a.dataset.nav === match.nav);
      });
    }

    const params = hash.match(match.pattern).slice(1);
    try {
      await match.render(...params);
      if (match.poll) {
        const refresh = typeof match.poll === 'function' ? match.poll : () => match.render(...params);
        setPoll(() => refresh(...params));
      }
    } catch (err) {
      view.innerHTML = `<div class="empty">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  // Click-through rows
  document.addEventListener('click', (e) => {
    const row = e.target.closest('tr.clickable');
    if (row?.dataset.href) location.hash = row.dataset.href;
  });

  window.addEventListener('hashchange', route);
  route();
})();
