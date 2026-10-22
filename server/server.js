// Idea pipeline server. Runs on the droplet behind Caddy.
//   /api/*   — the web app's API. Caddy puts this behind the Google login.
//   /agent/* — for the laptop dispatcher. Caddy skips the Google login here,
//              so every route checks the AGENT_TOKEN bearer token instead.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const grill = require('./grill');

const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.HOST || '127.0.0.1';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
if (!AGENT_TOKEN) console.warn('AGENT_TOKEN is not set; /agent routes are disabled');

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const app = express();
app.use(express.json({ limit: '20mb' })); // big enough for the project CLAUDE.md sync
app.use(express.static(path.join(__dirname, 'public')));

// One grilling call at a time per idea, so double-taps can't fork the session.
const busy = new Set();

function mustGet(req, res) {
  const idea = store.get(req.params.id);
  if (!idea) res.status(404).json({ error: 'No such idea' });
  return idea;
}

async function withLock(idea, res, fn) {
  if (busy.has(idea.id)) return res.status(409).json({ error: 'Claude is still thinking about this one' });
  busy.add(idea.id);
  try {
    await fn();
  } catch (e) {
    console.error(`[${idea.id}]`, e.message);
    res.status(502).json({ error: e.message });
  } finally {
    busy.delete(idea.id);
  }
}

const view = (idea) => ({ ...idea, busy: busy.has(idea.id) });

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

app.delete('/api/ideas/:id', (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
});

// Send a grilling message. With no message on a fresh idea, it starts the
// grilling by handing Claude the idea itself.
app.post('/api/ideas/:id/grill', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  const typed = String(req.body.message || '').trim();
  const first = !idea.grillSession;
  if (!typed && !first) return res.status(400).json({ error: 'Message is empty' });
  const message = first
    ? `Here's my idea:\n\n${idea.text}${typed ? `\n\n${typed}` : ''}`
    : typed;

  await withLock(idea, res, async () => {
    const { session, reply } = await grill.turn({
      session: idea.grillSession,
      message,
      projects: store.projects().projects,
    });
    const messages = [...idea.messages];
    if (!first || typed) messages.push({ role: 'me', text: typed || message, at: store.now() });
    messages.push({ role: 'claude', text: reply, at: store.now() });
    res.json(view(store.update(idea.id, { grillSession: session, messages, status: 'grilling' })));
  });
});

// End the grilling: Claude writes the brief and suggests a project.
app.post('/api/ideas/:id/handoff', async (req, res) => {
  const idea = mustGet(req, res);
  if (!idea) return;
  if (!idea.grillSession) return res.status(400).json({ error: 'Grill it first' });
  await withLock(idea, res, async () => {
    const handoff = await grill.handoff({ session: idea.grillSession, projects: store.projects().projects });
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
  const handoff = { title: String(title || idea.handoff?.title || '').slice(0, 80), project, isNew, brief };
  res.json(view(store.update(idea.id, { handoff, status: 'ready', dispatch: null })));
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

app.listen(PORT, HOST, () => console.log(`idea-pipeline on http://${HOST}:${PORT}`));
