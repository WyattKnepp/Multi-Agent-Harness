// Context notes on ideas: the API, and what gets sent to the claude session.
// The server runs as a child process on a free port with a temp data dir and a
// fake `claude` that logs every message it is sent.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-pipeline-ctx-'));
const logFile = path.join(dataDir, 'claude.log');
fs.writeFileSync(logFile, '');

let child;
let base;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start() {
  const port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AGENT_TOKEN: 'x', INTERNAL_TOKEN: '',
      CLAUDE_BIN: path.join(__dirname, 'helpers', 'fake-claude.js'), FAKE_CLAUDE_LOG: logFile,
    },
    stdio: 'ignore',
  });
  base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 100; n++) {
    try { await fetch(base + '/api/projects'); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error('server did not start');
}

const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const claudeCalls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const newIdea = async (text = 'An idea') => (await call('POST', '/api/ideas', { text })).body;
const addNote = (id, text) => call('POST', `/api/ideas/${id}/context`, { text });

before(start);
after(async () => {
  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('logic: context in the grill prompt', () => {
  const grill = require('../server/grill');
  const notes = [
    { id: 'a', text: 'first note', delivered: false },
    { id: 'b', text: 'already sent', delivered: true },
    { id: 'c', text: 'two\nlines', delivered: false },
  ];

  test('the first prompt holds the idea and every undelivered note, labelled as extra context', () => {
    const m = grill.grillMessage({ text: 'My idea', grillSession: null, contextNotes: notes }, 'typed bit');
    assert.match(m, /^Here's my idea:\n\nMy idea\n\ntyped bit\n\nExtra context from the user/);
    assert.match(m, /- first note/);
    assert.match(m, /- two\n {2}lines/);
    assert.doesNotMatch(m, /already sent/);
  });

  test('a later message labels notes as new extra context after the answer', () => {
    const m = grill.grillMessage({ text: 'My idea', grillSession: 's', contextNotes: notes }, 'my answer');
    assert.match(m, /^my answer\n\nNew extra context from the user/);
    assert.match(m, /- first note/);
  });

  test('a message with no undelivered notes is left as it was', () => {
    assert.equal(grill.grillMessage({ text: 'x', grillSession: 's', contextNotes: [notes[1]] }, 'hi'), 'hi');
    assert.equal(grill.grillMessage({ text: 'x', grillSession: 's' }, 'hi'), 'hi');
  });
});

describe('api: context notes', () => {
  test('adding a note keeps the idea in the inbox and does not call claude', async () => {
    const idea = await newIdea();
    const before = claudeCalls().length;
    const res = await addNote(idea.id, '  some context  ');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'inbox');
    assert.equal(res.body.grillSession, null);
    assert.equal(res.body.contextNotes.length, 1);
    assert.deepEqual(
      { text: res.body.contextNotes[0].text, delivered: res.body.contextNotes[0].delivered },
      { text: 'some context', delivered: false },
    );
    assert.ok(res.body.contextNotes[0].id && res.body.contextNotes[0].at);
    assert.equal(claudeCalls().length, before);
  });

  test('rejects an empty, non-string or over-long note', async () => {
    const idea = await newIdea();
    for (const text of ['', '   ', 5, undefined, 'x'.repeat(4001)]) {
      assert.equal((await addNote(idea.id, text)).status, 400, `text ${String(text).slice(0, 10)}`);
    }
    assert.equal((await call('GET', `/api/ideas/${idea.id}`)).body.contextNotes.length, 0);
  });

  test('edits and deletes notes, and 404s for an unknown idea or note', async () => {
    const idea = await newIdea();
    const { contextNotes: [note] } = (await addNote(idea.id, 'one')).body;
    const put = await call('PUT', `/api/ideas/${idea.id}/context/${note.id}`, { text: 'one, revised' });
    assert.equal(put.body.contextNotes[0].text, 'one, revised');
    assert.equal((await call('PATCH', `/api/ideas/${idea.id}/context/${note.id}`, { text: '' })).status, 400);
    assert.equal((await call('PATCH', `/api/ideas/${idea.id}/context/nope`, { text: 'x' })).status, 404);
    assert.equal((await call('POST', '/api/ideas/nope/context', { text: 'x' })).status, 404);
    const del = await call('DELETE', `/api/ideas/${idea.id}/context/${note.id}`);
    assert.deepEqual(del.body.contextNotes, []);
    assert.equal((await call('DELETE', `/api/ideas/${idea.id}/context/${note.id}`)).status, 404);
  });

  test('refuses notes on an archived idea', async () => {
    const idea = await newIdea();
    await call('PATCH', `/api/ideas/${idea.id}`, { archived: true });
    assert.equal((await addNote(idea.id, 'late')).status, 409);
  });

  test('notes survive a server restart', async () => {
    const idea = await newIdea();
    const { contextNotes: [note] } = (await addNote(idea.id, 'keep me')).body;
    await call('PATCH', `/api/ideas/${idea.id}/context/${note.id}`, { text: 'keep me, edited' });
    await stop();
    await start();
    const again = (await call('GET', `/api/ideas/${idea.id}`)).body;
    assert.deepEqual(again.contextNotes.map((n) => n.text), ['keep me, edited']);
  });
});

describe('api: context notes and grilling', () => {
  test('Grill me sends all notes in the first prompt, labelled as extra context', async () => {
    const idea = await newIdea('Build a thing');
    await addNote(idea.id, 'note one');
    await addNote(idea.id, 'note two');
    const before = claudeCalls().length;
    const res = await call('POST', `/api/ideas/${idea.id}/grill`, { message: '' });
    assert.equal(res.status, 200);
    const sent = claudeCalls().slice(before);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Here's my idea:\n\nBuild a thing/);
    assert.match(sent[0], /Extra context from the user[^\n]*:\n\n- note one\n- note two/);
    assert.ok(res.body.contextNotes.every((n) => n.delivered));
    assert.equal(res.body.messages.length, 1, 'the notes are not part of the transcript');
  });

  test('a note added mid-grill starts no turn and goes out once with the next answer', async () => {
    const idea = await newIdea();
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: '' });
    const before = claudeCalls().length;
    const added = await addNote(idea.id, 'learned something');
    assert.equal(added.body.status, 'grilling');
    assert.equal(claudeCalls().length, before, 'no new claude turn');

    await call('POST', `/api/ideas/${idea.id}/grill`, { message: 'free text answer' });
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: 'another answer' });
    const [second, third] = claudeCalls().slice(before);
    assert.match(second, /^free text answer\n\nNew extra context from the user[^\n]*:\n\n- learned something$/);
    assert.equal(third, 'another answer');
  });

  test('editing or deleting a delivered note re-sends nothing', async () => {
    const idea = await newIdea();
    const { contextNotes: [note] } = (await addNote(idea.id, 'sent already')).body;
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: '' });
    const edited = await call('PATCH', `/api/ideas/${idea.id}/context/${note.id}`, { text: 'revised' });
    assert.equal(edited.body.contextNotes[0].delivered, true);
    const before = claudeCalls().length;
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: 'answer' });
    assert.equal(claudeCalls()[before], 'answer');
  });

  test('a note added in review is included when the handoff is requested', async () => {
    const idea = await newIdea();
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: '' });
    await call('POST', `/api/ideas/${idea.id}/handoff`);
    const late = await addNote(idea.id, 'added in review');
    assert.equal(late.body.status, 'review');
    const before = claudeCalls().length;
    const res = await call('POST', `/api/ideas/${idea.id}/handoff`);
    assert.equal(res.body.status, 'review');
    const sent = claudeCalls().slice(before);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /New extra context from the user[^\n]*:\n\n- added in review[\s\S]*Grilling is over/);
    assert.ok(res.body.contextNotes.every((n) => n.delivered));
  });

  test('cancelling the grill keeps the notes and makes them undelivered again', async () => {
    const idea = await newIdea();
    await addNote(idea.id, 'stay');
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: '' });
    const res = await call('POST', `/api/ideas/${idea.id}/cancel-grill`);
    assert.equal(res.body.status, 'inbox');
    assert.deepEqual(res.body.contextNotes.map((n) => [n.text, n.delivered]), [['stay', false]]);
    const before = claudeCalls().length;
    await call('POST', `/api/ideas/${idea.id}/grill`, { message: '' });
    assert.match(claudeCalls()[before], /- stay/);
  });
});
