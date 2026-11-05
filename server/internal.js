// Internal API for Lawn and the OpenClaw agent (Lawn spec, "Ideas app API
// contract"). It is a separate Express app that server.js listens on with
// 127.0.0.1:INTERNAL_PORT. Caddy never proxies that port, so it can't be
// reached from outside the droplet. Every request also needs
// `Authorization: Bearer <INTERNAL_TOKEN>`. The web app's /api/* on PORT
// (behind the Google login) is untouched.
//
//   GET   /api/projects                               -> [Project]
//   POST  /api/projects        {name, status?}        -> 201 Project
//   GET   /api/ideas?status=open,in_progress&updated_since=<iso>  -> [Idea]
//   GET   /api/ideas/:id                              -> Idea
//   PATCH /api/ideas/:id       {status?, project_id?} -> Idea
//   GET   /api                                        -> self-describing index (api-index.js)
//   GET   /api/health                                 -> {ok: true}
//
// Droplet jobs (changes approved in Lawn's chat, built by runner/; jobs.js):
//   POST  /api/jobs   {project, title, brief, mode?, thread_id?, source?} -> 201 Job (approved, queued)
//   GET   /api/jobs?thread_id=&project=&status=a,b&limit=        -> [Job], newest first
//   GET   /api/jobs/:id?full=1                                   -> Job (full: brief + log)
//   POST  /api/jobs/:id/actions {action: ship|discard|rollback}  -> 202 Job
// For the runner only (same token; it runs as the same user on the same box):
//   POST  /api/runner/hello                                      -> {released}
//   POST  /api/runner/claim                                      -> {job, kind} | 204
//   PATCH /api/jobs/:id  {status?, note?, branch?, base?, commit?, preview_url?,
//                         preview_port?, release?, tests?, log?, done?} -> Job
//
// Errors are {error: "<message>"}, as in the rest of the app.
const express = require('express');
const crypto = require('crypto');
const contract = require('./contract');
const jobsLib = require('./jobs');
const apiIndex = require('./api-index');

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function bearer(token) {
  const want = Buffer.from(token);
  return (req, res, next) => {
    const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer /, ''));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

const toProject = (p) => ({
  id: p.name,
  name: p.name,
  description: p.description || '',
  status: contract.PROJECT_STATUSES.includes(p.status) ? p.status : 'active',
  created_at: p.createdAt,
});

// `store` is store.js (shared with the web app, so both see the same data).
function createInternalApp({ store, token, jobs = jobsLib.shared(store.DATA_DIR, store.now) }) {
  if (!token) throw new Error('internal API needs a token');
  const app = express();
  app.disable('x-powered-by');
  app.use(bearer(token));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api', (req, res) => res.json(apiIndex.index()));
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/projects', (req, res) => res.json(store.allProjects().map(toProject)));

  app.post('/api/projects', (req, res) => {
    const body = req.body || {};
    const extra = Object.keys(body).filter((k) => k !== 'name' && k !== 'status');
    if (extra.length) return res.status(400).json({ error: `Unknown field ${extra.join(', ')}` });
    const name = String(body.name ?? '').trim();
    if (!PROJECT_NAME.test(name)) {
      return res.status(400).json({ error: 'name must be a plain folder name: letters, digits, . _ -, up to 64 characters' });
    }
    const status = body.status ?? 'active';
    if (!contract.PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be ${contract.PROJECT_STATUSES.join(' or ')}` });
    }
    const created = store.createProject(name, status);
    if (!created) return res.status(409).json({ error: `Project ${name} already exists` });
    res.status(201).json(toProject(created));
  });

  app.get('/api/ideas', (req, res) => {
    const q = contract.parseIdeaQuery(req.query);
    if (q.error) return res.status(400).json({ error: q.error });
    res.json(contract.filterIdeas(store.list().map(contract.toIdea), q));
  });

  app.get('/api/ideas/:id', (req, res) => {
    const idea = store.get(req.params.id);
    if (!idea) return res.status(404).json({ error: 'No such idea' });
    res.json(contract.toIdea(idea));
  });

  app.patch('/api/ideas/:id', (req, res) => {
    const idea = store.get(req.params.id);
    if (!idea) return res.status(404).json({ error: 'No such idea' });
    const body = req.body || {};
    const extra = Object.keys(body).filter((k) => k !== 'status' && k !== 'project_id');
    if (extra.length) return res.status(400).json({ error: `Unknown field ${extra.join(', ')}; only status and project_id can change` });
    if (!('status' in body) && !('project_id' in body)) return res.status(400).json({ error: 'Nothing to change: send status and/or project_id' });

    const patch = { actedAt: store.now() };
    if ('status' in body) {
      if (!contract.STATUSES.includes(body.status)) {
        return res.status(400).json({ error: `status must be one of ${contract.STATUSES.join(', ')}` });
      }
      Object.assign(patch, contract.statusPatch(idea, body.status));
    }
    if ('project_id' in body) {
      const pid = body.project_id;
      if (pid !== null && typeof pid !== 'string') return res.status(400).json({ error: 'project_id must be a project id or null' });
      if (pid !== null && !store.allProjects().some((p) => p.name === pid)) {
        return res.status(400).json({ error: `No such project ${pid}; create it with POST /api/projects first` });
      }
      patch.projectId = pid;
    }
    res.json(contract.toIdea(store.update(idea.id, patch)));
  });

  mountJobs(app, jobs, store);

  app.use((req, res) => res.status(404).json({ error: 'No such endpoint' }));
  // Malformed JSON and the like: answer in the app's error shape.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[internal]', err.message);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });
  return app;
}

function mountJobs(app, jobs, store) {
  const { toJob, parseNewJob, ACTIONS, STATUSES, RUNNER_STATUSES } = jobsLib;
  const find = (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) res.status(404).json({ error: 'No such job' });
    return job;
  };

  app.post('/api/jobs', (req, res) => {
    const f = parseNewJob(req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    res.status(201).json(toJob(jobs.create(f), { full: true }));
  });

  app.get('/api/jobs', (req, res) => {
    let list = jobs.list().slice().sort((a, b) => b.id - a.id);
    const { thread_id: thread, idea_id: ideaId, source, project, status } = req.query;
    if (thread !== undefined && thread !== '') list = list.filter((j) => String(j.thread_id) === String(thread));
    if (ideaId) list = list.filter((j) => j.idea_id === ideaId);
    if (source) list = list.filter((j) => j.source === source);
    if (project) list = list.filter((j) => j.project === project);
    if (status) {
      const want = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      const bad = want.filter((s) => !STATUSES.includes(s));
      if (bad.length) return res.status(400).json({ error: `Unknown status ${bad.join(', ')}` });
      list = list.filter((j) => want.includes(j.status));
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    res.json(list.slice(0, limit).map((j) => toJob(j)));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = find(req, res);
    if (job) res.json(toJob(job, { full: req.query.full === '1' || req.query.full === 'true' }));
  });

  app.post('/api/jobs/:id/actions', (req, res) => {
    const job = find(req, res);
    if (!job) return;
    const action = req.body?.action;
    if (!ACTIONS[action]) return res.status(400).json({ error: 'action must be ship, discard or rollback' });
    if (job.action) return res.status(409).json({ error: `A ${job.action.type} is already in progress for change ${job.id}` });
    if (!ACTIONS[action].includes(job.status)) {
      return res.status(409).json({ error: `Change ${job.id} is ${job.status}; ${action} needs ${ACTIONS[action].join(' or ')}` });
    }
    res.status(202).json(toJob(jobs.requestAction(job, action)));
  });

  app.post('/api/runner/hello', (req, res) => res.json({ released: jobs.releaseStale() }));

  app.post('/api/runner/claim', (req, res) => {
    const c = jobs.claim();
    if (!c) return res.status(204).end();
    res.json({ job: toJob(c.job, { full: true }), kind: c.kind });
  });

  app.patch('/api/jobs/:id', (req, res) => {
    const job = find(req, res);
    if (!job) return;
    const b = req.body || {};
    const allowed = ['status', 'note', 'branch', 'base', 'commit', 'preview_url', 'preview_port', 'release', 'tests', 'log', 'done'];
    const extra = Object.keys(b).filter((k) => !allowed.includes(k));
    if (extra.length) return res.status(400).json({ error: `Unknown field ${extra.join(', ')}` });
    if ('status' in b && !RUNNER_STATUSES.includes(b.status)) return res.status(400).json({ error: `status must be one of ${RUNNER_STATUSES.join(', ')}` });
    if ('log' in b && typeof b.log !== 'string') return res.status(400).json({ error: 'log must be a string' });
    const updated = jobs.update(job, b);
    // A job sent from an idea records its outcome as the idea's deploy, the
    // same field `make deploy` fills, so the idea counts as shipped (or not).
    if (updated.idea_id && ['live', 'rolled_back'].includes(b.status) && store.get(updated.idea_id)) {
      const live = b.status === 'live';
      store.update(updated.idea_id, {
        deploy: {
          status: live ? 'ok' : 'failed',
          commit: updated.commit || '',
          message: live ? `Live from the droplet runner (change ${updated.id})` : `Rolled back (change ${updated.id})`,
          log: '', at: store.now(),
        },
      });
    }
    res.json(toJob(updated, { full: true }));
  });
}

module.exports = { createInternalApp };
