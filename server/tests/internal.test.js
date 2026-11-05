// The internal API over HTTP, against synthetic data in the pre-change format,
// plus checks that the web app and the laptop dispatcher API still behave.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-pipeline-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.AGENT_TOKEN = 'agent-secret';
const TOKEN = 'internal-secret';

// Legacy data: exactly the fields the old server.js wrote.
const legacyIdeas = [
  {
    id: 'aaa111', text: 'Inbox idea\nwith a body', status: 'inbox',
    createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z',
    grillSession: null, messages: [], handoff: null, dispatch: null, deploy: null,
  },
  {
    id: 'bbb222', text: 'Being grilled', status: 'review',
    createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z',
    grillSession: 's1', messages: [{ role: 'claude', text: 'q?', at: '2026-10-11T09:00:00.000Z' }],
    handoff: { title: 'Grilled title', project: 'Alpha', isNew: false, visibility: 'private', brief: 'b' },
    dispatch: null, deploy: null,
  },
  {
    id: 'ccc333', text: 'Shipped', status: 'dispatched',
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z',
    grillSession: 's2', messages: [],
    handoff: { title: 'Ship it', project: 'Alpha', isNew: false, visibility: 'private', brief: 'b' },
    dispatch: { claimedAt: '2026-09-02T10:00:00.000Z', at: '2026-09-02T10:05:00.000Z', error: null },
    deploy: { status: 'ok', commit: 'abc', message: 'm', log: '', at: '2026-09-03T10:00:00.000Z' },
  },
  {
    id: 'ddd444', text: 'Running', status: 'dispatched',
    createdAt: '2026-09-15T10:00:00.000Z', updatedAt: '2026-09-16T10:00:00.000Z',
    grillSession: 's3', messages: [],
    handoff: { title: 'Run it', project: 'Beta', isNew: true, visibility: 'private', brief: 'b' },
    dispatch: { claimedAt: '2026-09-16T10:00:00.000Z', at: '2026-09-16T10:01:00.000Z', error: null },
    deploy: null,
  },
  {
    id: 'eee555', text: 'Put away', status: 'archived',
    createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-02T10:00:00.000Z',
    grillSession: null, messages: [], handoff: null, dispatch: null, deploy: null,
  },
];
const legacyProjects = {
  syncedAt: '2026-10-25T00:00:00.000Z',
  projects: [
    { name: 'Alpha', description: 'First', contextFile: 'CLAUDE.md' },
    { name: 'Beta', description: 'Second', contextFile: null },
    { name: 'Gamma', description: 'Third', contextFile: null },
  ],
};
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
fs.writeFileSync(IDEAS_FILE, JSON.stringify(legacyIdeas, null, 2));
fs.writeFileSync(PROJECTS_FILE, JSON.stringify(legacyProjects, null, 2));
const ideasBefore = fs.readFileSync(IDEAS_FILE, 'utf8');
const projectsBefore = fs.readFileSync(PROJECTS_FILE, 'utf8');

const store = require('../store');
const { createInternalApp } = require('../internal');
const { app: webApp } = require('../server');

let internalUrl;
let webUrl;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  servers.push(s);
});

test.before(async () => {
  internalUrl = await listen(createInternalApp({ store, token: TOKEN }));
  webUrl = await listen(webApp);
});
test.after(() => {
  for (const s of servers) s.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function call(base, method, url, { body, token = TOKEN, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const api = (method, url, opts) => call(internalUrl, method, url, opts);
const web = (method, url, opts) => call(webUrl, method, url, { token: null, ...opts });
const byId = async () => Object.fromEntries((await api('GET', '/api/ideas')).body.map((i) => [i.id, i]));

test('every route needs the bearer token', async () => {
  for (const [m, u] of [['GET', '/api/projects'], ['GET', '/api/ideas'], ['PATCH', '/api/ideas/aaa111'], ['POST', '/api/projects'], ['GET', '/api/health']]) {
    assert.equal((await api(m, u, { token: null })).status, 401, `${m} ${u} without token`);
    assert.equal((await api(m, u, { token: 'internal-secreT' })).status, 401, `${m} ${u} wrong token`);
  }
  assert.deepEqual((await api('GET', '/api/health')).body, { ok: true });
});

test('reading legacy data maps it without rewriting ideas.json or projects.json', async () => {
  const ideas = await byId();
  assert.equal(Object.keys(ideas).length, 5);
  assert.deepEqual(ideas.aaa111, {
    id: 'aaa111', project_id: null, title: 'Inbox idea', body: 'Inbox idea\nwith a body', status: 'open',
    created_at: '2026-10-20T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z', last_acted_at: null, stage: 'inbox',
  });
  assert.equal(ideas.bbb222.status, 'in_progress');
  assert.equal(ideas.bbb222.project_id, null, 'unconfirmed handoff');
  assert.equal(ideas.bbb222.last_acted_at, '2026-10-11T09:00:00.000Z');
  assert.equal(ideas.ccc333.status, 'done');
  assert.equal(ideas.ccc333.project_id, 'Alpha');
  assert.equal(ideas.ddd444.status, 'in_progress');
  assert.equal(ideas.ddd444.project_id, 'Beta');
  assert.equal(ideas.eee555.status, 'dropped');

  const projects = (await api('GET', '/api/projects')).body;
  assert.deepEqual(projects.map((p) => p.id), ['Alpha', 'Beta', 'Gamma']);
  const alpha = projects[0];
  assert.deepEqual(alpha, { id: 'Alpha', name: 'Alpha', description: 'First', status: 'active', created_at: '2026-09-01T10:00:00.000Z' });
  assert.equal(projects[1].created_at, '2026-09-15T10:00:00.000Z', 'dated by the earliest idea naming it');
  assert.ok(Date.parse(projects[2].created_at) > Date.parse('2026-11-01T00:00:00Z') - 86400e3 * 365, 'unknown: first seen');

  assert.equal(fs.readFileSync(IDEAS_FILE, 'utf8'), ideasBefore);
  assert.equal(fs.readFileSync(PROJECTS_FILE, 'utf8'), projectsBefore);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'project-registry.json')));
});

test('the web app API is unchanged', async () => {
  const projects = (await web('GET', '/api/projects')).body;
  assert.deepEqual(Object.keys(projects).sort(), ['projects', 'syncedAt']);
  assert.equal(projects.projects.length, 3);
  const ideas = (await web('GET', '/api/ideas')).body;
  assert.equal(ideas.length, 5);
  assert.equal(ideas.find((i) => i.id === 'aaa111').text, 'Inbox idea\nwith a body');
  // The internal API is not mounted on the web app: its PATCH ignores contract fields.
  const r = await web('PATCH', '/api/ideas/aaa111', { body: { status: 'done' } });
  assert.equal(r.body.status, 'inbox');
  assert.equal((await web('GET', '/agent/queue')).status, 401);
});

test('GET /api/ideas filters by status and updated_since', async () => {
  const open = (await api('GET', '/api/ideas?status=open,in_progress')).body.map((i) => i.id).sort();
  assert.deepEqual(open, ['aaa111', 'bbb222', 'ddd444']);
  const recent = (await api('GET', '/api/ideas?updated_since=2026-09-16T10:00:00Z')).body.map((i) => i.id).sort();
  assert.ok(recent.includes('ddd444') && recent.includes('bbb222') && !recent.includes('ccc333'));
  assert.equal((await api('GET', '/api/ideas?status=closed')).status, 400);
  assert.equal((await api('GET', '/api/ideas?updated_since=soon')).status, 400);
  assert.equal((await api('GET', '/api/ideas/nope')).status, 404);
  assert.equal((await api('GET', '/api/ideas/aaa111')).body.id, 'aaa111');
});

test('POST /api/projects registers a project the laptop does not have yet', async () => {
  const r = await api('POST', '/api/projects', { body: { name: 'Lawn' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'Lawn');
  assert.equal(r.body.status, 'active');
  assert.equal((await api('POST', '/api/projects', { body: { name: 'Lawn' } })).status, 409);
  assert.equal((await api('POST', '/api/projects', { body: { name: 'Alpha' } })).status, 409, 'laptop project names are taken');
  assert.equal((await api('POST', '/api/projects', { body: { name: 'has space' } })).status, 400);
  assert.equal((await api('POST', '/api/projects', { body: { name: 'Delta', status: 'paused' } })).status, 400);
  assert.equal((await api('POST', '/api/projects', { body: { name: 'Delta', colour: 'red' } })).status, 400);
  assert.equal((await api('POST', '/api/projects', { raw: '{bad json' })).status, 400);
  const done = await api('POST', '/api/projects', { body: { name: 'Old-Thing', status: 'finished' } });
  assert.equal(done.body.status, 'finished');

  const ids = (await api('GET', '/api/projects')).body.map((p) => p.id);
  assert.deepEqual(ids, ['Alpha', 'Beta', 'Gamma', 'Lawn', 'Old-Thing']);
  // Not shown to the web app or the griller, so `send` still treats it as new.
  assert.equal((await web('GET', '/api/projects')).body.projects.length, 3);
});

test('a laptop sync keeps API projects and their dates', async () => {
  const before = (await api('GET', '/api/projects')).body.find((p) => p.id === 'Lawn');
  const sync = await call(webUrl, 'PUT', '/agent/projects', {
    token: 'agent-secret',
    body: [{ name: 'Alpha', description: 'First' }, { name: 'Lawn', description: 'Now on the laptop' }],
  });
  assert.equal(sync.status, 200);
  const after = (await api('GET', '/api/projects')).body;
  assert.deepEqual(after.map((p) => p.id), ['Alpha', 'Lawn', 'Old-Thing']);
  const lawn = after.find((p) => p.id === 'Lawn');
  assert.equal(lawn.created_at, before.created_at);
  assert.equal(lawn.description, 'Now on the laptop');
  assert.equal(after[0].created_at, '2026-09-01T10:00:00.000Z');
});

test('PATCH status moves the idea through the web app the right way', async () => {
  // done on an inbox idea: archived in the web app, done in the contract.
  let r = await api('PATCH', '/api/ideas/aaa111', { body: { status: 'done' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'done');
  assert.equal(r.body.stage, 'archived');
  assert.ok(r.body.last_acted_at);
  assert.ok(r.body.updated_at > '2026-10-20T10:00:00.000Z');
  assert.equal(store.get('aaa111').status, 'archived');

  // Reopen it.
  r = await api('PATCH', '/api/ideas/aaa111', { body: { status: 'open' } });
  assert.equal(r.body.status, 'open');
  assert.equal(r.body.stage, 'inbox');
  assert.equal(store.get('aaa111').statusOverride, undefined, 'no leftover override');

  // done on a running dispatch keeps it in the Sent tab.
  r = await api('PATCH', '/api/ideas/ddd444', { body: { status: 'done' } });
  assert.equal(r.body.status, 'done');
  assert.equal(r.body.stage, 'dispatched');

  // The web app moving an idea on overrides an explicit status.
  r = await api('PATCH', '/api/ideas/bbb222', { body: { status: 'open' } });
  assert.equal(r.body.status, 'open');
  assert.equal(r.body.stage, 'review');
  await web('PATCH', '/api/ideas/bbb222', { body: { archived: true } });
  assert.equal((await byId()).bbb222.status, 'dropped');
  await web('PATCH', '/api/ideas/bbb222', { body: { archived: false } });
  assert.equal((await byId()).bbb222.status, 'in_progress');

  assert.equal((await api('PATCH', '/api/ideas/bbb222', { body: { status: 'closed' } })).status, 400);
  assert.equal((await api('PATCH', '/api/ideas/bbb222', { body: { text: 'hi' } })).status, 400);
  assert.equal((await api('PATCH', '/api/ideas/bbb222', { body: {} })).status, 400);
  assert.equal((await api('PATCH', '/api/ideas/zzz', { body: { status: 'done' } })).status, 404);
});

test('PATCH project_id links, unlinks and validates', async () => {
  let r = await api('PATCH', '/api/ideas/aaa111', { body: { project_id: 'Old-Thing' } });
  assert.equal(r.body.project_id, 'Old-Thing');
  r = await api('PATCH', '/api/ideas/ccc333', { body: { project_id: null } });
  assert.equal(r.body.project_id, null, 'explicit null beats the handoff');
  assert.equal((await api('PATCH', '/api/ideas/aaa111', { body: { project_id: 'Nope' } })).status, 400);
  assert.equal((await api('PATCH', '/api/ideas/aaa111', { body: { project_id: 7 } })).status, 400);
  r = await api('PATCH', '/api/ideas/aaa111', { body: { project_id: 'Lawn', status: 'in_progress' } });
  assert.deepEqual([r.body.project_id, r.body.status], ['Lawn', 'in_progress']);
});

test('sending an idea from the web app sets its project_id', async () => {
  const r = await web('POST', '/api/ideas/bbb222/send', { body: { title: 'T', project: 'Alpha', brief: 'Do it' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ready');
  const idea = (await byId()).bbb222;
  assert.equal(idea.project_id, 'Alpha');
  assert.equal(idea.status, 'in_progress');
});

test('updates written by the new code still load in the old data format', () => {
  const saved = JSON.parse(fs.readFileSync(IDEAS_FILE, 'utf8'));
  for (const i of saved) {
    for (const k of ['id', 'text', 'status', 'createdAt', 'updatedAt', 'messages']) assert.ok(k in i, `${i.id} keeps ${k}`);
  }
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects));
});
