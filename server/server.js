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
  const message = first
    ? `Here's my idea:\n\n${idea.text}${typed ? `\n\n${typed}` : ''}`
    : typed;

  await withLock(idea, res, async (stillWanted) => {
    const { session, reply, questions, done } = await grill.turn({
      key: idea.id,
      session: idea.grillSession,
      message,
      projects: store.projects().projects,
      structured: true,
    });
    stillWanted();
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
    const handoff = await grill.handoff({ key: idea.id, session: idea.grillSession, projects: store.projects().projects });
    stillWanted();
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
