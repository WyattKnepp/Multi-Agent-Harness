// Idea pipeline server. Runs on the droplet behind Caddy.
//   /api/*   — the web app's API. Caddy puts this behind the Google login.
//   /agent/* — for the laptop dispatcher. Caddy skips the Google login here,
//              so every route checks the AGENT_TOKEN bearer token instead.
// With INTERNAL_TOKEN set, a second listener on 127.0.0.1:INTERNAL_PORT serves
// the internal API for Lawn and the agent (internal.js). Caddy doesn't proxy it.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const grill = require('./grill');
const { createInternalApp } = require('./internal');
const jobsLib = require('./jobs');
const jobs = jobsLib.shared(store.DATA_DIR, store.now);

const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.HOST || '127.0.0.1';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
if (!AGENT_TOKEN) console.warn('AGENT_TOKEN is not set; /agent routes are disabled');
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 3007);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const app = express();
app.use(express.json({ limit: '20mb' })); // big enough for the project CLAUDE.md sync
app.use(express.static(path.join(__dirname, 'public')));

// One grilling call at a time per idea, so double-taps can't fork the session.
// Maps idea id → a token for the call holding the lock.
const busy = new Map();
// Bumped when a grill is cancelled (or the idea deleted). A call that started
// in an older epoch must not save anything, even if Claude already answered.
const epochs = new Map();
const epoch = (id) => epochs.get(id) || 0;

function mustGet(req, res) {
  const idea = store.get(req.params.id);
  if (!idea) res.status(404).json({ error: 'No such idea' });
  return idea;
}

async function withLock(idea, res, fn) {
  if (busy.has(idea.id)) return res.status(409).json({ error: 'Claude is still thinking about this one' });
  const token = {};
  busy.set(idea.id, token);
  const started = epoch(idea.id);
  // fn calls this after its await, before touching the store.
  const stillWanted = () => { if (epoch(idea.id) !== started) throw new grill.Cancelled(); };
  try {
    await fn(stillWanted);
  } catch (e) {
    if (e.cancelled) return res.status(409).json({ error: e.message, cancelled: true });
    console.error(`[${idea.id}]`, e.message);
    // 500, not 502: proxies like Cloudflare may swap a 502 for their own page.
    res.status(500).json({ error: e.message });
  } finally {
    // A cancel may already have released the lock and a new call taken it.
    if (busy.get(idea.id) === token) busy.delete(idea.id);
  }
}

// Stop whatever grilling call is running for an idea: anything it returns
// later is dropped, and its claude process is killed.
async function stopGrill(id) {
  epochs.set(id, epoch(id) + 1);
  busy.delete(id);
  await grill.cancel(id);
}

// A droplet send links the idea to its runner job; the page shows that job.
const view = (idea) => {
  const jobId = idea.dispatch?.jobId;
  const job = jobId ? jobs.get(jobId) : null;
  return { ...idea, busy: busy.has(idea.id), job: job ? jobsLib.toJob(job) : null };
};

// ============ WEB APP API ============

app.get('/api/ideas', (req, res) => res.json(store.list().map(view)));
app.get('/api/ideas/:id', (req, res) => {
  const idea = mustGet(req, res);
  if (idea) res.json(view(idea));
});

app.post('/api/ideas', (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Idea is empty' });
  res.json(store.create(text));
});

// Editable fields only; status changes go through the dedicated routes below,
// except archiving/unarchiving.
app.patch('/api/ideas/:id', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const patch = {};
  if (typeof req.body.text === 'string') patch.text = req.body.text;
  if (req.body.archived === true) patch.status = 'archived';
  if (req.body.archived === false) patch.status = idea.handoff ? 'review' : idea.messages.length ? 'grilling' : 'inbox';
  res.json(view(store.update(idea.id, patch)));
});

// Hard delete. Only for ideas that were never grilled (inbox) or were already
// put away (archived); anything in flight has to be cancelled or archived first.
app.delete('/api/ideas/:id', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (idea.status !== 'inbox' && idea.status !== 'archived') return res.status(409).json({ error: `Can't delete an idea that is ${idea.status}` });
  await stopGrill(idea.id);
  store.remove(idea.id);
  res.json({ ok: true });
});

// Context notes: plain text the user adds to an idea. They only change the
// stored idea and never call Claude, so they skip the grilling lock and work
// while a turn is running. Undelivered notes go out with the next grilling
// message or the handoff request (see grill.js).
const NOTE_MAX = 4000;
const NOTE_STATUSES = ['inbox', 'grilling', 'review'];

function noteText(req, res) {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return void res.status(400).json({ error: 'Note is empty' });
  if (text.length > NOTE_MAX) return void res.status(400).json({ error: `Note is too long (max ${NOTE_MAX} characters)` });
  return text.trim();
}

function noteIdea(req, res) {
  const idea = mustGet(req, res);
  if (idea && !NOTE_STATUSES.includes(idea.status)) {
    res.status(409).json({ error: `Can't change context on an idea that is ${idea.status}` });
    return null;
  }
  return idea;
}

app.post('/api/ideas/:id/context', (req, res) => {
  const idea = noteIdea(req, res);
  if (!idea) return;
  const text = noteText(req, res);
  if (text === undefined) return;
  res.json(view(store.addNote(idea.id, text)));
});

// An edit only updates the stored note; one already delivered isn't re-sent.
app.all('/api/ideas/:id/context/:noteId', (req, res, next) => {
  if (!['PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const idea = noteIdea(req, res);
  if (!idea) return;
  let updated;
  if (req.method === 'DELETE') updated = store.removeNote(idea.id, req.params.noteId);
  else {
    const text = noteText(req, res);
    if (text === undefined) return;
    updated = store.editNote(idea.id, req.params.noteId, text);
  }
  if (!updated) return res.status(404).json({ error: 'No such note' });
  res.json(view(updated));
});

// Abandon the grilling: kill any running turn, forget the session and the
// transcript, and put the idea back in the inbox with its text untouched.
// An inbox idea counts while its first turn is still running.
app.post('/api/ideas/:id/cancel-grill', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (idea.status !== 'grilling' && !(idea.status === 'inbox' && busy.has(idea.id))) {
    return res.status(409).json({ error: `Can't cancel grilling on an idea that is ${idea.status}` });
  }
  await stopGrill(idea.id);
  store.setDelivered(idea.id); // the session is gone: every note goes out again with the next one
  res.json(view(store.update(idea.id, { status: 'inbox', grillSession: null, messages: [], handoff: null })));
});

// Send a grilling message. With no message on a fresh idea, it starts the
// grilling by handing Claude the idea itself.
app.post('/api/ideas/:id/grill', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const typed = String(req.body.message || '').trim();
  const first = !idea.grillSession;
  if (!typed && !first) return res.status(400).json({ error: 'Message is empty' });
  // Notes not yet delivered ride along with this message (see grill.grillMessage).
  const message = grill.grillMessage(idea, typed);
  const sent = (idea.contextNotes || []).filter((n) => !n.delivered).map((n) => n.id);

  await withLock(idea, res, async (stillWanted) => {
    const { session, reply, questions, done } = await grill.turn({
      key: idea.id,
      session: idea.grillSession,
      message,
      projects: store.projects().projects,
      structured: true,
    });
    stillWanted();
    store.setDelivered(idea.id, sent);
    const messages = [...idea.messages];
    if (!first || typed) messages.push({ role: 'me', text: typed || message, at: store.now() });
    // Structured turns carry questions (and maybe done); a turn that couldn't
    // be parsed, like every turn from before this format, is just text.
    const msg = { role: 'claude', text: reply, at: store.now() };
    if (questions) Object.assign(msg, { questions, done });
    messages.push(msg);
    res.json(view(store.update(idea.id, { grillSession: session, messages, status: 'grilling' })));
  });
});

// Explain one of the latest turn's questions. A side call on a fork of the
// session: it doesn't take the idea's lock, isn't saved, and doesn't count as
// an answer. The client keeps the explanation until the turn is answered.
app.post('/api/ideas/:id/elaborate', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (!idea.grillSession) return res.status(400).json({ error: 'Grill it first' });
  if (busy.has(idea.id)) return res.status(409).json({ error: 'Claude is still thinking about this one' });
  const last = idea.messages[idea.messages.length - 1];
  const question = last?.role === 'claude' && last.questions?.find((q) => q.id === req.body.qid);
  if (!question) return res.status(404).json({ error: 'That question is no longer open' });
  const started = epoch(idea.id);
  try {
    const text = await grill.elaborate({ key: idea.id, session: idea.grillSession, question, projects: store.projects().projects });
    if (epoch(idea.id) !== started) throw new grill.Cancelled();
    res.json({ text: text || 'Claude had nothing to add.' });
  } catch (e) {
    if (e.cancelled) return res.status(409).json({ error: e.message, cancelled: true });
    console.error(`[${idea.id}] elaborate:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// End the grilling: Claude writes the brief and suggests a project.
app.post('/api/ideas/:id/handoff', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (!idea.grillSession) return res.status(400).json({ error: 'Grill it first' });
  await withLock(idea, res, async (stillWanted) => {
    const notes = idea.contextNotes || [];
    const sent = notes.filter((n) => !n.delivered).map((n) => n.id);
    const handoff = await grill.handoff({ key: idea.id, session: idea.grillSession, projects: store.projects().projects, notes });
    stillWanted();
    store.setDelivered(idea.id, sent);
    res.json(view(store.update(idea.id, { handoff, status: 'review' })));
  });
});

// Confirm the (possibly edited) handoff and queue it for the laptop.
app.post('/api/ideas/:id/send', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const { title, project, brief } = req.body;
  if (!PROJECT_NAME.test(String(project || ''))) return res.status(400).json({ error: 'Project must be a plain folder name' });
  if (!String(brief || '').trim()) return res.status(400).json({ error: 'Brief is empty' });
  const isNew = !store.projects().projects.some((p) => p.name === project);
  // GitHub repo visibility for a new project. Private unless asked otherwise.
  const visibility = (req.body.visibility || idea.handoff?.visibility) === 'public' ? 'public' : 'private';
  const handoff = { title: String(title || idea.handoff?.title || '').slice(0, 80), project, isNew, visibility, brief };
  // destination: laptop (herdr, the default) or droplet (runner/, preview or live).
  const destination = req.body.destination === 'droplet' ? 'droplet' : 'laptop';
  if (destination === 'droplet') {
    if (isNew) return res.status(400).json({ error: 'The droplet only builds existing projects; send new projects to the laptop' });
    const mode = req.body.mode === 'live' ? 'live' : 'preview';
    const job = jobs.create({ project, title: handoff.title || 'Change', brief, mode, source: 'ideas', idea_id: idea.id });
    const dispatch = { destination, jobId: job.id, mode, claimedAt: store.now(), at: store.now(), error: null };
    return res.json(view(store.update(idea.id, { handoff, status: 'dispatched', dispatch, projectId: project })));
  }
  // Sending confirms the project, so the internal API's project_id follows it.
  res.json(view(store.update(idea.id, { handoff, status: 'ready', dispatch: null, projectId: project })));
});

// Ship / discard / roll back the droplet job an idea was sent as.
app.post('/api/ideas/:id/job/actions', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const job = idea.dispatch?.jobId ? jobs.get(idea.dispatch.jobId) : null;
  if (!job) return res.status(404).json({ error: 'This idea has no droplet job' });
  const action = req.body?.action;
  if (!jobsLib.ACTIONS[action]) return res.status(400).json({ error: 'action must be ship, discard or rollback' });
  if (job.action) return res.status(409).json({ error: `A ${job.action.type} is already in progress` });
  if (!jobsLib.ACTIONS[action].includes(job.status)) return res.status(409).json({ error: `The job is ${job.status}; ${action} needs ${jobsLib.ACTIONS[action].join(' or ')}` });
  jobs.requestAction(job, action);
  res.json(view(store.get(idea.id)));
});

// Pull a queued idea back before the laptop picks it up.
app.post('/api/ideas/:id/unsend', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (idea.status !== 'ready' && idea.status !== 'failed') return res.status(409).json({ error: 'Already dispatched' });
  res.json(view(store.update(idea.id, { status: 'review' })));
});

app.get('/api/projects', (req, res) => res.json(store.projects()));

// ============ LAPTOP DISPATCHER API ============

function agentAuth(req, res, next) {
  const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer /, ''));
  const want = Buffer.from(AGENT_TOKEN);
  if (!AGENT_TOKEN || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
app.use('/agent', agentAuth);

app.get('/agent/queue', (req, res) => {
  res.json(store.list().filter((i) => i.status === 'ready').map((i) => ({ id: i.id, handoff: i.handoff })));
});

// Claim before launching, so two dispatchers (or a retry) can't launch twice.
app.post('/agent/ideas/:id/claim', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (idea.status !== 'ready') return res.status(409).json({ error: `Idea is ${idea.status}` });
  store.update(idea.id, { status: 'dispatching', dispatch: { claimedAt: store.now() } });
  res.json({ ok: true, handoff: idea.handoff });
});

app.post('/agent/ideas/:id/result', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const { ok, error, ...info } = req.body;
  store.update(idea.id, {
    status: ok ? 'dispatched' : 'failed',
    dispatch: { ...idea.dispatch, ...info, error: ok ? null : String(error || 'unknown error'), at: store.now() },
  });
  res.json({ ok: true });
});

// Result of the agent's `make deploy` for this idea. Kept apart from status:
// a failed deploy is not a failed dispatch, and the idea shouldn't be resent.
const LOG_MAX = 4 * 1024;
app.post('/agent/ideas/:id/deploy', (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const { status, commit, message, log } = req.body || {};
  if (status !== 'ok' && status !== 'failed') return res.status(400).json({ error: 'status must be ok or failed' });
  const tail = String(log || '');
  store.update(idea.id, {
    deploy: {
      status,
      commit: String(commit || '').slice(0, 64),
      message: String(message || '').slice(0, 1000),
      log: tail.length > LOG_MAX ? tail.slice(-LOG_MAX) : tail,
      at: store.now(),
    },
  });
  res.json({ ok: true });
});

// The laptop's project list, with each project's CLAUDE.md (or README.md).
app.put('/agent/projects', (req, res) => {
  const projects = (Array.isArray(req.body) ? req.body : [])
    .filter((p) => PROJECT_NAME.test(String(p.name || '')))
    .map((p) => ({
      name: p.name,
      description: String(p.description || '').slice(0, 200),
      context: p.context && typeof p.context.text === 'string'
        ? { file: String(p.context.file || 'CLAUDE.md'), text: p.context.text.slice(0, 100 * 1024) }
        : null,
    }));
  store.setProjects(projects);
  res.json({ ok: true, count: projects.length, withContext: projects.filter((p) => p.context).length });
});

app.get('/agent/ping', (req, res) => res.json({ ok: true }));

module.exports = { app };

if (require.main === module) {
  store.syncRegistry(); // one-time, additive data migration; see store.js
  app.listen(PORT, HOST, () => console.log(`idea-pipeline on http://${HOST}:${PORT}`));
  if (INTERNAL_TOKEN) {
    // Loopback only, whatever HOST is: this API must never face the internet.
    createInternalApp({ store, token: INTERNAL_TOKEN })
      .listen(INTERNAL_PORT, '127.0.0.1', () => console.log(`internal API on http://127.0.0.1:${INTERNAL_PORT}`))
      // A clash on this port must not take the web app down with it.
      .on('error', (e) => console.error(`internal API not started: ${e.message}`));
  } else {
    console.warn('INTERNAL_TOKEN is not set; the internal API (for Lawn) is disabled');
  }
}
