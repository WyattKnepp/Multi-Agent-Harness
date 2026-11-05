// Ideas sent from the web app to the droplet: one job model with Lawn's jobs
// (source: ideas), the idea page's actions, and the internal API's index.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-pipeline-droplet-'));
const TOKEN = 'internal-secret';
const store = require('../store');
const { createInternalApp } = require('../internal');
const { app } = require('../server');

const BRIEF = 'Make the lawn greener in the evening, and test it.';
let internal;
let web;
const servers = [];
const listen = (a) => new Promise((resolve) => {
  const s = a.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  servers.push(s);
});
test.before(async () => {
  internal = await listen(createInternalApp({ store, token: TOKEN }));
  web = await listen(app);
});
test.after(() => servers.forEach((s) => s.close()));

async function call(base, method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const api = (m, u, b, t = TOKEN) => call(internal, m, u, b, t);
const webApi = (m, u, b) => call(web, m, u, b);

test.describe('api: ideas sent to the droplet', () => {
  test('sending to the droplet files an ideas job linked to the idea', async () => {
    store.setProjects([{ name: 'Lawn', description: '', context: null }]);
    const idea = (await webApi('POST', '/api/ideas', { text: 'Make the lawn greener' })).body;
    const r = await webApi('POST', `/api/ideas/${idea.id}/send`, { title: 'Greener', project: 'Lawn', brief: BRIEF, destination: 'droplet', mode: 'live' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'dispatched');
    assert.equal(r.body.job.source, 'ideas');
    assert.equal(r.body.job.mode, 'live');
    assert.equal(r.body.job.idea_id, idea.id);
    assert.equal((await api('GET', `/api/jobs?idea_id=${idea.id}`)).body.length, 1);
    // The laptop dispatcher never sees it.
    assert.equal(store.get(idea.id).status, 'dispatched');

    const c = await api('POST', '/api/runner/claim');
    assert.equal(c.body.job.idea_id, idea.id);
    await api('PATCH', `/api/jobs/${c.body.job.id}`, { status: 'live', commit: 'abc1234', done: true });
    const after = (await webApi('GET', `/api/ideas/${idea.id}`)).body;
    assert.equal(after.deploy.status, 'ok');
    assert.equal(after.job.status, 'live');
    assert.equal((await api('GET', `/api/ideas/${idea.id}`)).body.status, 'done');

    const a = await webApi('POST', `/api/ideas/${idea.id}/job/actions`, { action: 'rollback' });
    assert.equal(a.status, 200);
    assert.equal(a.body.job.action.type, 'rollback');
    assert.equal((await webApi('POST', `/api/ideas/${idea.id}/job/actions`, { action: 'ship' })).status, 409);
  });

  test('the laptop stays the default destination', async () => {
    const idea = (await webApi('POST', '/api/ideas', { text: 'Laptop one' })).body;
    const r = await webApi('POST', `/api/ideas/${idea.id}/send`, { title: 'L', project: 'Lawn', brief: BRIEF });
    assert.equal(r.body.status, 'ready');
    assert.equal(r.body.job, null);
  });

  test('new projects cannot go to the droplet', async () => {
    const idea = (await webApi('POST', '/api/ideas', { text: 'Brand new thing' })).body;
    const r = await webApi('POST', `/api/ideas/${idea.id}/send`, { title: 'New', project: 'Nope', brief: BRIEF, destination: 'droplet' });
    assert.equal(r.status, 400);
  });

  test('a lawn job must name its thread', async () => {
    assert.equal((await api('POST', '/api/jobs', { project: 'Lawn', title: 't', brief: BRIEF, source: 'lawn' })).status, 400);
    assert.equal((await api('POST', '/api/jobs', { project: 'Lawn', title: 't', brief: BRIEF, source: 'ideas' })).status, 400);
  });

  test('the internal API describes itself, behind the token', async () => {
    assert.equal((await api('GET', '/api', null, 'wrong')).status, 401);
    const idx = (await api('GET', '/api')).body;
    const tools = idx.endpoints.filter((e) => e.agent !== false).map((e) => e.tool);
    assert.ok(tools.includes('create_change_job'));
    assert.ok(tools.includes('change_job_action'));
    assert.ok(idx.endpoints.every((e) => e.method && e.path && e.summary));
  });
});
