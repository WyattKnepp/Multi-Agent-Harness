// Droplet jobs on the internal API: create, list, actions, runner claim/patch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-pipeline-jobs-'));
process.env.DATA_DIR = DATA_DIR;
const TOKEN = 'internal-secret';
const store = require('../store');
const { createInternalApp } = require('../internal');

let base;
let server;
test.before(async () => {
  await new Promise((resolve) => {
    server = createInternalApp({ store, token: TOKEN }).listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, body, token = TOKEN) {
  const res = await fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const BRIEF = 'Add a dark mode toggle to the settings page, with tests.';

test.describe('api: jobs', () => {
  test('creating a job needs the token', async () => {
    const r = await call('POST', '/api/jobs', { project: 'Lawn', title: 't', brief: BRIEF }, 'wrong');
    assert.equal(r.status, 401);
  });

  test('a new job is queued with its mode and thread', async () => {
    const r = await call('POST', '/api/jobs', { project: 'Lawn', title: 'Dark mode', brief: BRIEF, mode: 'preview', thread_id: 7 });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'queued');
    assert.equal(r.body.mode, 'preview');
    assert.equal(r.body.thread_id, 7);
    assert.equal(r.body.brief, BRIEF);
  });

  test('bad fields are refused with a message', async () => {
    assert.equal((await call('POST', '/api/jobs', { project: 'Lawn', title: 'x', brief: BRIEF, mode: 'yolo' })).status, 400);
    assert.equal((await call('POST', '/api/jobs', { project: '../etc', title: 'x', brief: BRIEF })).status, 400);
    assert.equal((await call('POST', '/api/jobs', { project: 'Lawn', title: 'x', brief: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/jobs', { project: 'Lawn', title: 'x', brief: BRIEF, extra: 1 })).status, 400);
    assert.equal((await call('POST', '/api/jobs', { project: 'Lawn', title: 'x', brief: BRIEF, thread_id: 'a' })).status, 400);
  });

  test('the list filters by thread and status', async () => {
    await call('POST', '/api/jobs', { project: 'Lawn', title: 'Other thread', brief: BRIEF, thread_id: 8 });
    const r = await call('GET', '/api/jobs?thread_id=7');
    assert.deepEqual(r.body.map((j) => j.title), ['Dark mode']);
    assert.equal((await call('GET', '/api/jobs?status=live')).body.length, 0);
    assert.equal((await call('GET', '/api/jobs?status=nope')).status, 400);
  });

  test('the runner claims one job at a time, oldest first', async () => {
    assert.equal((await call('POST', '/api/runner/hello')).status, 200);
    const c = await call('POST', '/api/runner/claim');
    assert.equal(c.body.kind, 'build');
    assert.equal(c.body.job.title, 'Dark mode');
    assert.equal((await call('POST', '/api/runner/claim')).status, 204);
    const p = await call('PATCH', `/api/jobs/${c.body.job.id}`, { status: 'preview', note: 'Preview ready', preview_url: 'https://p', log: 'abc', done: true });
    assert.equal(p.body.status, 'preview');
    assert.equal(p.body.log, 'abc');
    assert.equal(p.body.events.at(-1).message, 'Preview ready');
    const c2 = await call('POST', '/api/runner/claim');
    assert.equal(c2.body.job.title, 'Other thread');
    await call('PATCH', `/api/jobs/${c2.body.job.id}`, { status: 'failed', done: true });
  });

  test('actions follow the status and go before queued jobs', async () => {
    const id = (await call('GET', '/api/jobs?thread_id=7')).body[0].id;
    assert.equal((await call('POST', `/api/jobs/${id}/actions`, { action: 'rollback' })).status, 409);
    assert.equal((await call('POST', `/api/jobs/${id}/actions`, { action: 'explode' })).status, 400);
    await call('POST', '/api/jobs', { project: 'Lawn', title: 'Queued later', brief: BRIEF });
    const a = await call('POST', `/api/jobs/${id}/actions`, { action: 'ship' });
    assert.equal(a.status, 202);
    assert.equal((await call('POST', `/api/jobs/${id}/actions`, { action: 'discard' })).status, 409);
    const c = await call('POST', '/api/runner/claim');
    assert.equal(c.body.kind, 'ship');
    assert.equal(c.body.job.id, id);
    const done = await call('PATCH', `/api/jobs/${id}`, { status: 'live', done: true });
    assert.equal(done.body.action, null);
    assert.equal((await call('POST', `/api/jobs/${id}/actions`, { action: 'rollback' })).status, 202);
  });

  test('a runner restart fails a job that was mid-build', async () => {
    const c = await call('POST', '/api/runner/claim');
    assert.equal(c.body.kind, 'rollback');
    await call('PATCH', `/api/jobs/${c.body.job.id}`, { status: 'rolled_back', done: true });
    const b = await call('POST', '/api/runner/claim');
    await call('PATCH', `/api/jobs/${b.body.job.id}`, { status: 'running' });
    assert.equal((await call('POST', '/api/runner/hello')).body.released, 1);
    const j = await call('GET', `/api/jobs/${b.body.job.id}?full=1`);
    assert.equal(j.body.status, 'failed');
    assert.match(j.body.note, /restarted/);
  });

  test('the runner can only set known statuses', async () => {
    const r = await call('PATCH', '/api/jobs/1', { status: 'queued' });
    assert.equal(r.status, 400);
    assert.equal((await call('PATCH', '/api/jobs/1', { secret: 1 })).status, 400);
    assert.equal((await call('GET', '/api/jobs/999')).status, 404);
  });
});
