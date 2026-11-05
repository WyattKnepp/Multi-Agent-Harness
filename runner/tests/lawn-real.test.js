// The real Lawn binary against the real internal API and the real runner (fake
// `claude`, fixture repo): the agent's tools file and steer the change, and the
// runner's reports land in the Lawn chat thread. Skipped unless LAWN_BIN points
// at a Lawn binary (Lawn's backend/target/debug/lawn).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { LAWN_BIN } = process.env;
const HERE = __dirname;
const T = fs.mkdtempSync(path.join(HERE, '.tmp-lawn-'));
process.env.DATA_DIR = path.join(T, 'pipeline-data');
const TOKEN = 'internal-test-token';
const AGENT_TOKEN = 'lawn-agent-token-for-tests-0123456789';

const store = require('../../server/store');
const { createInternalApp } = require('../../server/internal');
const config = require('../lib/config');
const jail = require('../lib/jail');
const { createRunner } = require('../runner');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

let pipelineServer; let runner; let lawn; let browser; let agent; let releases; let threadId; let changeId;

async function call(base, method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const tool = (method, p, body) => call(agent, method, `/api/change-requests${p}`, body, AGENT_TOKEN);
const chat = async () => (await call(browser, 'GET', `/api/chat/threads/${threadId}/messages`)).data
  .map((m) => m.content);
const live = () => fs.readFileSync(path.join(releases, 'current', 'message.txt'), 'utf8').trim();

test.describe('runner with the real Lawn', { skip: LAWN_BIN ? false : 'set LAWN_BIN to run this' }, () => {
  test.before(async () => {
    const seed = path.join(T, 'seed');
    fs.cpSync(path.join(HERE, 'fixture/project'), seed, { recursive: true });
    git(seed, 'init', '--quiet', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'fixture');
    const origin = path.join(T, 'origin.git');
    git(T, 'clone', '--quiet', '--bare', seed, origin);
    const repo = path.join(T, 'runner-clone.git');
    git(T, 'clone', '--quiet', '--bare', origin, repo);
    releases = path.join(T, 'releases');
    const projectsFile = path.join(T, 'projects.deploy.json');
    fs.writeFileSync(projectsFile, JSON.stringify({
      Fixture: {
        enabled: false,
        test: 'bash test.sh',
        runner: {
          repo, base: 'main', preview: 'exec node server.js', previewHealthPath: '/health',
          deploy: `bash deploy.sh ${releases}`,
          rollback: `bash ${path.join(HERE, 'fixture/project/rollback.sh')} ${releases}`,
        },
      },
    }));
    const tokenFile = path.join(T, 'agent-token');
    fs.writeFileSync(tokenFile, `${AGENT_TOKEN}\n`, { mode: 0o600 });

    pipelineServer = await new Promise((resolve) => {
      const s = createInternalApp({ store, token: TOKEN }).listen(0, '127.0.0.1', () => resolve(s));
    });
    const pipelineUrl = `http://127.0.0.1:${pipelineServer.address().port}`;

    const [pb, pa, p0] = [await freePort(), await freePort(), await freePort()];
    browser = `http://127.0.0.1:${pb}`;
    agent = `http://127.0.0.1:${pa}`;
    fs.mkdirSync(path.join(T, 'static'));
    lawn = spawn(LAWN_BIN, [], {
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        LAWN_ENV_FILE: '/dev/null',
        LAWN_BIND: `127.0.0.1:${pb}`,
        LAWN_AGENT_BIND: `127.0.0.1:${pa}`,
        LAWN_AGENT_TOKEN_FILE: tokenFile,
        LAWN_DATABASE_URL: `sqlite://${path.join(T, 'lawn.db')}`,
        LAWN_STATIC_DIR: path.join(T, 'static'),
        IDEAS_URL: pipelineUrl,
        IDEAS_TOKEN: TOKEN,
      },
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${agent}/api/health`, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } })).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const cfg = config.fromEnv({
      RUNNER_HOME: path.join(T, 'runner'),
      PROJECTS_FILE: projectsFile,
      PIPELINE_URL: pipelineUrl,
      PIPELINE_TOKEN: TOKEN,
      RUNNER_LAWN_URL: agent,
      RUNNER_LAWN_TOKEN_FILE: tokenFile,
      CLAUDE_BIN: path.join(HERE, 'fixture/fake-claude.js'),
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
      RUNNER_SANDBOX: jail.available() ? 'bwrap' : 'none',
      PREVIEW_PORTS: `${p0 + 1}-${p0 + 3}`,
      PREVIEW_GATEWAY: `127.0.0.1:${p0}`,
      PREVIEW_BASE_URL: 'https://preview.example.test',
    });
    runner = await createRunner(cfg);
    const t = await call(browser, 'POST', '/api/chat/threads', {});
    assert.equal(t.status, 201, JSON.stringify(t.data));
    threadId = t.data.id;
  });

  test.after(() => {
    runner?.stop();
    lawn?.kill();
    pipelineServer?.close();
    fs.rmSync(T, { recursive: true, force: true });
  });

  test('request_change files an approved job; a thread that does not exist is refused', async () => {
    const bad = await tool('POST', '', { title: 'x', brief: 'A brief that is long enough to pass.', thread_id: 99999, project: 'Fixture' });
    assert.equal(bad.status, 422);
    const made = await tool('POST', '', { title: 'New greeting', brief: 'Greeting: Hello from Lawn chat\nNothing else.', thread_id: threadId, project: 'Fixture' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.data.source, 'lawn');
    assert.equal(made.data.mode, 'preview');
    changeId = made.data.id;
  });

  test('the runner builds it and the preview reaches the chat thread', async () => {
    await runner.tick();
    const s = await tool('GET', `/${changeId}`);
    assert.equal(s.data.status, 'preview', s.data.note);
    const msgs = await chat();
    assert.match(msgs[0], /^Started change/);
    assert.match(msgs[1], /ready to preview/);
    assert.match(msgs[1], new RegExp(`"id": "chg-${changeId}-preview"`));
    const list = await tool('GET', `?thread_id=${threadId}`);
    assert.deepEqual(list.data.map((j) => j.id), [changeId]);
  });

  test('a person on the browser cannot post as the runner', async () => {
    const r = await call(browser, 'POST', `/api/change-requests/${changeId}/report`, { text: 'forged' });
    assert.equal(r.status, 403);
  });

  test('ship_change goes live and the chat gets a roll-back card', async () => {
    assert.equal((await tool('POST', `/${changeId}/ship`, {})).status, 200);
    await runner.tick();
    assert.equal((await tool('GET', `/${changeId}`)).data.status, 'live');
    assert.equal(live(), 'Hello from Lawn chat');
    const msgs = await chat();
    assert.match(msgs.at(-1), new RegExp(`"id": "chg-${changeId}-rollback"`));
  });

  test('mode live deploys at once; rollback_change restores the release before it', async () => {
    const made = await tool('POST', '', { title: 'Newer greeting', brief: 'Greeting: Hello again\nNothing else.', thread_id: threadId, project: 'Fixture', mode: 'live' });
    assert.equal(made.data.mode, 'live');
    await runner.tick();
    assert.equal(live(), 'Hello again');
    assert.equal((await tool('POST', `/${made.data.id}/rollback`, {})).status, 200);
    await runner.tick();
    const after = (await tool('GET', `/${made.data.id}`)).data;
    assert.equal(after.status, 'rolled_back', after.note);
    assert.equal(live(), 'Hello from Lawn chat');
    assert.match((await chat()).at(-1), /Rolled back change/);
  });
});
