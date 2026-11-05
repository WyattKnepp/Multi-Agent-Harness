// Droplet jobs: changes approved in Lawn's chat, built by runner/ on the droplet.
// Stored in data/jobs.json, separate from ideas (a job is not an idea and must
// not show up in the garden's idea counts).
//
// Job: {
//   id, source: lawn|ideas|api, thread_id (Lawn chat thread to report to),
//   idea_id (ideas-app idea it came from), project, title, brief, mode: preview|live,
//   status, note, branch, base, commit, preview_url, preview_port, release,
//   tests: {ok, summary} | null, action: {type, requested_at} | null,
//   events: [{at, status, message}], log (tail, 8 KB), created_at, updated_at,
//   claimed_at, finished_at
// }
//
// Status:
//   queued -> running -> testing -> preview  (mode preview: waits for ship/discard)
//                                 -> deploying -> live  (mode live, or ship)
//   preview + ship    -> deploying -> live | failed
//   preview + discard -> discarded
//   live + rollback   -> rolling_back -> rolled_back | live (rollback refused)
//   any step can end in failed; a target the runner won't touch ends in rejected.
// Actions (ship/discard/rollback) are requests: the runner carries them out
// one at a time and moves the status.
const fs = require('fs');
const path = require('path');

const MODES = ['preview', 'live'];
const SOURCES = ['lawn', 'ideas', 'api'];
const STATUSES = ['queued', 'running', 'testing', 'preview', 'deploying', 'live',
  'rolling_back', 'rolled_back', 'discarded', 'failed', 'rejected'];
// Statuses the runner may set through PATCH.
const RUNNER_STATUSES = STATUSES.filter((s) => s !== 'queued');
// Which action is allowed from which status.
const ACTIONS = { ship: ['preview'], discard: ['preview', 'failed'], rollback: ['live'] };
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TITLE_MAX = 120;
const BRIEF_MAX = 20000;
const LOG_MAX = 8192;
const EVENTS_MAX = 50;

function createJobStore(dataDir, now = () => new Date().toISOString()) {
  const file = path.join(dataDir, 'jobs.json');
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { jobs = []; }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmp, file);
  };
  const nextId = () => jobs.reduce((m, j) => Math.max(m, j.id), 0) + 1;

  return {
    list: () => jobs,
    get: (id) => jobs.find((j) => j.id === Number(id)) || null,

    create({ project, title, brief, mode, thread_id = null, idea_id = null, source = 'api' }) {
      const t = now();
      const job = {
        id: nextId(), source, thread_id, idea_id, project, title, brief, mode,
        status: 'queued', note: 'Waiting for the runner', branch: null, base: null, commit: null,
        preview_url: null, preview_port: null, release: null, tests: null, action: null,
        events: [{ at: t, status: 'queued', message: source === 'lawn' ? 'Approved in Lawn chat' : source === 'ideas' ? 'Sent from the ideas app' : 'Filed' }],
        log: '', created_at: t, updated_at: t, claimed_at: null, finished_at: null,
      };
      jobs.push(job);
      save();
      return job;
    },

    requestAction(job, type) {
      job.action = { type, requested_at: now() };
      job.updated_at = now();
      save();
      return job;
    },

    // The runner takes one thing at a time: a pending action first (the user
    // is waiting on it), else the oldest queued job. Returns {job, kind} or null.
    claim() {
      const busy = jobs.find((j) => j.claimed_at && !j.finished_at);
      if (busy) return null;
      const acting = jobs.filter((j) => j.action && !j.action.claimed_at)
        .sort((a, b) => a.action.requested_at.localeCompare(b.action.requested_at))[0];
      const t = now();
      if (acting) {
        acting.action.claimed_at = t;
        acting.claimed_at = t;
        acting.finished_at = null;
        acting.updated_at = t;
        save();
        return { job: acting, kind: acting.action.type };
      }
      const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.id - b.id)[0];
      if (!queued) return null;
      queued.claimed_at = t;
      queued.finished_at = null;
      queued.updated_at = t;
      save();
      return { job: queued, kind: 'build' };
    },

    // Runner progress. `done: true` releases the claim (and clears a finished action).
    update(job, patch) {
      const t = now();
      for (const k of ['status', 'note', 'branch', 'base', 'commit', 'preview_url', 'preview_port', 'release', 'tests']) {
        if (k in patch) job[k] = patch[k];
      }
      if (patch.log) job.log = (job.log + patch.log).slice(-LOG_MAX);
      if ('status' in patch || patch.note) {
        job.events.push({ at: t, status: job.status, message: patch.note || '' });
        job.events = job.events.slice(-EVENTS_MAX);
      }
      if (patch.done) {
        job.finished_at = t;
        job.action = null;
      }
      job.updated_at = t;
      save();
      return job;
    },

    // A runner restart leaves a claim open; hand it back so the next claim works.
    releaseStale() {
      let n = 0;
      for (const j of jobs) {
        if (j.claimed_at && !j.finished_at) {
          j.finished_at = now();
          j.action = null;
          if (['queued', 'running', 'testing', 'deploying', 'rolling_back'].includes(j.status)) {
            j.status = 'failed';
            j.note = 'The runner restarted in the middle of this job; check the live app, then ask again';
            j.events.push({ at: j.finished_at, status: 'failed', message: j.note });
          }
          n++;
        }
      }
      if (n) save();
      return n;
    },
  };
}

// Public shape: everything except the full brief and log unless asked.
function toJob(job, { full = false } = {}) {
  const out = { ...job };
  if (!full) {
    delete out.log;
    out.events = job.events.slice(-5);
    out.brief = job.brief.length > 300 ? job.brief.slice(0, 299) + '…' : job.brief;
  }
  return out;
}

// Validates POST /api/jobs. Returns {error} or the clean fields.
function parseNewJob(body) {
  const b = body || {};
  const extra = Object.keys(b).filter((k) => !['project', 'title', 'brief', 'mode', 'thread_id', 'source'].includes(k));
  if (extra.length) return { error: `Unknown field ${extra.join(', ')}` };
  const project = String(b.project ?? '').trim();
  if (!PROJECT_NAME.test(project)) return { error: 'project must be a project folder name' };
  const title = String(b.title ?? '').trim();
  if (!title || title.length > TITLE_MAX) return { error: `title is required, at most ${TITLE_MAX} characters` };
  const brief = String(b.brief ?? '').trim();
  if (brief.length < 20 || brief.length > BRIEF_MAX) return { error: `brief must be 20 to ${BRIEF_MAX} characters` };
  const mode = b.mode ?? 'preview';
  if (!MODES.includes(mode)) return { error: 'mode must be preview or live' };
  const thread = b.thread_id;
  if (thread !== undefined && thread !== null && !(Number.isInteger(thread) && thread > 0)) {
    return { error: 'thread_id must be a positive integer or null' };
  }
  const source = b.source ?? (thread ? 'lawn' : 'api');
  // `ideas` jobs are made by the web app's Send, never through this endpoint.
  if (!['lawn', 'api'].includes(source)) return { error: 'source must be lawn or api' };
  if (source === 'lawn' && !thread) return { error: 'a lawn job needs the thread_id to report to' };
  return { project, title, brief, mode, thread_id: thread ?? null, source };
}

// One store per data dir, shared by the web app and the internal API (both run
// in the same process and must see the same jobs).
const stores = new Map();
function shared(dataDir, now) {
  if (!stores.has(dataDir)) stores.set(dataDir, createJobStore(dataDir, now));
  return stores.get(dataDir);
}

module.exports = { createJobStore, shared, SOURCES, toJob, parseNewJob, MODES, STATUSES, RUNNER_STATUSES, ACTIONS };
