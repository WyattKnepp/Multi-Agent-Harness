// End to end: the real internal API (jobs) and the real runner, with a fake
// `claude` (fixture/fake-claude.js), a fixture repo with an "origin", a fake
// release dir for live deploys and a fake Lawn that records chat reports.
// Uses bubblewrap when it works here, as on the droplet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const HERE = __dirname;
// Not under /tmp: the jail mounts a fresh /tmp, as it does on the droplet.
const T = fs.mkdtempSync(path.join(HERE, '.tmp-e2e-'));
process.env.DATA_DIR = path.join(T, 'pipeline-data');
const TOKEN = 'internal-test-token';
const LAWN_TOKEN = 'lawn-agent-token-for-tests-0123456789';

const store = require('../../server/store');
const { createInternalApp } = require('../../server/internal');
const { app: webApp } = require('../../server/server');
const config = require('../lib/config');
const jail = require('../lib/jail');
const { createRunner } = require('../runner');
const { secretFiles } = require('../lib/steps');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sandbox = jail.available() ? 'bwrap' : 'none';
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const listen = (handler) => new Promise((resolve) => {
  const s = (typeof handler === 'function' && !handler.listen ? http.createServer(handler) : handler).listen(0, '127.0.0.1', () => resolve(s));
});
const url = (s) => `http://127.0.0.1:${s.address().port}`;

let pipelineServer;
let webServer;
let lawnServer;
let runner;
let releases;
let origin;
let repo;
const reports = []; // {id, text, auth}

async function api(method, p, body) {
  const res = await fetch(url(pipelineServer) + p, {
    method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status === 204 ? null : res.json();
}
const job = (id) => api('GET', `/api/jobs/${id}?full=1`);
const newJob = (body) => api('POST', '/api/jobs', { project: 'Fixture', mode: 'preview', thread_id: 5, ...body });
const live = () => fs.readFileSync(path.join(releases, 'current', 'message.txt'), 'utf8').trim();
const originMessage = () => git(origin, 'show', 'main:message.txt');
const reportsFor = (id) => reports.filter((r) => r.id === String(id)).map((r) => r.text);

test.before(async () => {
  // Fixture repo: a bare "origin" seeded from fixture/project, and the runner's
  // own bare clone of it (as on the droplet).
  const seed = path.join(T, 'seed');
  fs.cpSync(path.join(HERE, 'fixture/project'), seed, { recursive: true });
  git(seed, 'init', '--quiet', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'fixture');
  origin = path.join(T, 'origin.git');
  git(T, 'clone', '--quiet', '--bare', seed, origin);
  repo = path.join(T, 'runner-clone.git');
  git(T, 'clone', '--quiet', '--bare', origin, repo);
  releases = path.join(T, 'releases');

  // A production database the preview gets a scrubbed copy of.
  const prodDb = path.join(T, 'prod.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(prodDb);
  db.exec("CREATE TABLE account (token TEXT); INSERT INTO account VALUES ('refresh-secret')");
  db.close();
  const secret = path.join(T, 'secret.txt');
  fs.writeFileSync(secret, 'do not read me\n');

  const projectsFile = path.join(T, 'projects.deploy.json');
  fs.writeFileSync(projectsFile, JSON.stringify({
    _comment: 'test',
    Fixture: {
      port: 1, enabled: false,
      test: sandbox === 'bwrap' ? `SECRET_PROBE=${secret} bash test.sh` : 'bash test.sh',
      runner: {
        repo, base: 'main',
        preview: 'exec node server.js',
        previewHealthPath: '/health',
        previewCopy: [{ sqlite: prodDb, to: 'app.db', scrub: ['UPDATE account SET token = NULL', 'DELETE FROM no_such_table'] }],
        deploy: `bash deploy.sh ${releases}`,
        rollback: `bash ${path.join(HERE, 'fixture/project/rollback.sh')} ${releases}`,
      },
    },
    Other: { port: 2, notes: 'deployable from the laptop, but no runner block' },
  }, null, 2));

  // Fake Lawn: POST /api/change-requests/:id/report with the agent token.
  lawnServer = await listen((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const m = /^\/api\/change-requests\/(\d+)\/report$/.exec(req.url);
      if (req.method !== 'POST' || !m) { res.writeHead(404); return res.end('{}'); }
      reports.push({ id: m[1], text: JSON.parse(b).text, auth: req.headers.authorization });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const tokenFile = path.join(T, 'lawn-token');
  fs.writeFileSync(tokenFile, LAWN_TOKEN + '\n');

  pipelineServer = await listen(createInternalApp({ store, token: TOKEN }));
  webServer = await listen(webApp);
  const p0 = await freePort();
  const cfg = config.fromEnv({
    RUNNER_HOME: path.join(T, 'runner'),
    PROJECTS_FILE: projectsFile,
    PIPELINE_URL: url(pipelineServer),
    PIPELINE_TOKEN: TOKEN,
    RUNNER_LAWN_URL: url(lawnServer),
    RUNNER_LAWN_TOKEN_FILE: tokenFile,
    CLAUDE_BIN: path.join(HERE, 'fixture/fake-claude.js'),
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
    RUNNER_SANDBOX: sandbox,
    PREVIEW_PORTS: `${p0 + 1}-${p0 + 3}`,
    PREVIEW_GATEWAY: `127.0.0.1:${p0}`,
    PREVIEW_BASE_URL: 'https://preview.example.test',
    SECRET_PATHS: `${secret},~/.ssh,~/.config`,
  });
  cfg.gatewayPort = p0;
  runner = await createRunner(cfg);
  runner.cfg = cfg;
});

test.after(() => {
  runner?.stop();
  for (const s of [pipelineServer, webServer, lawnServer]) s?.close();
  fs.rmSync(T, { recursive: true, force: true });
});

test.describe(`runner: end to end (sandbox ${sandbox})`, () => {
  test('a project without a runner block is rejected and nothing is touched', async () => {
    const j = await newJob({ project: 'Other', title: 'Nope', brief: 'Change the greeting to something nicer, please.' });
    await runner.tick();
    const after = await job(j.id);
    assert.equal(after.status, 'rejected');
    assert.match(after.note, /no enabled "runner" block/);
    assert.match(reportsFor(j.id)[0], /can't build change/);
    const missing = await newJob({ project: 'NotThere', title: 'Nope', brief: 'Change the greeting to something nicer, please.' });
    await runner.tick();
    assert.match((await job(missing.id)).note, /not in projects\.deploy\.json/);
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main');
  });

  let preview;
  test('a preview job: worktree, edit, tests, commit, preview served behind the gateway', async () => {
    preview = await newJob({ title: 'Warmer greeting', brief: 'Greeting: Hello from change one\nKeep the rest as is.' });
    await runner.tick();
    const j = await job(preview.id);
    assert.equal(j.status, 'preview', j.note);
    assert.equal(j.tests.ok, true);
    assert.match(j.branch, /^change\/\d+-warmer-greeting$/);
    assert.equal(git(repo, 'show', `${j.branch}:message.txt`), 'Hello from change one');
    assert.match(git(repo, 'log', '-1', '--format=%an %s', j.branch), /^Droplet runner Warmer greeting$/);
    // The branch went to origin too; main did not move.
    assert.equal(git(origin, 'rev-parse', j.branch), j.commit);
    assert.equal(originMessage(), 'Hello from the fixture');

    // Served on its own port, and through the gateway with ?change=<id>.
    assert.equal(await (await fetch(`http://127.0.0.1:${j.preview_port}/`)).text(), 'Hello from change one\n');
    const gw = `http://127.0.0.1:${runner.cfg.gatewayPort}`;
    const pin = await fetch(`${gw}/?change=${j.id}`, { redirect: 'manual' });
    assert.equal(pin.status, 302);
    const cookie = pin.headers.get('set-cookie').split(';')[0];
    const page = await fetch(`${gw}/`, { headers: { cookie } });
    assert.equal(page.headers.get('x-preview-change'), String(j.id));
    assert.equal(await page.text(), 'Hello from change one\n');
    assert.equal(j.preview_url, `https://preview.example.test/?change=${j.id}`);

    // The preview has a copy of the data with the token scrubbed.
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(path.join(runner.cfg.workDir, 'jobs', String(j.id), 'app.db'), { readOnly: true });
    assert.deepEqual(copy.prepare('SELECT token FROM account').all().map((r) => r.token), [null]);
    copy.close();

    // Chat: a start message, then the result with a ship card.
    const msgs = reportsFor(j.id);
    assert.equal(msgs.length, 2);
    assert.match(msgs[0], /^Started change/);
    assert.match(msgs[1], /ready to preview/);
    assert.match(msgs[1], /```lawn-confirm\n[\s\S]*"id": "chg-\d+-preview"[\s\S]*lawn__ship_change/);
    assert.ok(reports.every((r) => r.auth === `Bearer ${LAWN_TOKEN}`));
  });

  test('claude ran headless, confined, with a clean environment', () => {
    const calls = fs.readFileSync(path.join(runner.cfg.claudeHome, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const c = calls[0];
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(c.args.includes(flag), flag);
    assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(c.args[c.args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,Bash');
    assert.equal(c.token, 'set');
    for (const leaked of ['PIPELINE_TOKEN', 'RUNNER_LAWN_TOKEN_FILE', 'AGENT_TOKEN', 'INTERNAL_TOKEN', 'ANTHROPIC_API_KEY']) assert.ok(!c.env.includes(leaked), leaked);
    assert.match(c.cwd, /wt\/Fixture-\d+$/);
    const settings = JSON.parse(fs.readFileSync(path.join(runner.cfg.workDir, 'jobs', String(preview.id), 'claude-settings.json'), 'utf8'));
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.ok(settings.sandbox.filesystem.denyRead.includes(runner.cfg.home));
    const brief = fs.readFileSync(path.join(runner.cfg.workDir, 'jobs', String(preview.id), 'brief.md'), 'utf8');
    assert.match(brief, /completed staff work/);
    assert.match(brief, /Greeting: Hello from change one/);
  });

  let release;
  test('ship: the preview goes live through the deploy, and main follows', async () => {
    await api('POST', `/api/jobs/${preview.id}/actions`, { action: 'ship' });
    await runner.tick();
    const j = await job(preview.id);
    assert.equal(j.status, 'live', j.note);
    assert.match(j.release, /^r\d+-/);
    release = j.release;
    assert.equal(live(), 'Hello from change one');
    assert.equal(originMessage(), 'Hello from change one');
    assert.equal(git(repo, 'rev-parse', 'main'), j.commit);
    assert.ok(!fs.existsSync(path.join(runner.cfg.workDir, 'wt', `Fixture-${j.id}`)), 'worktree removed');
    await assert.rejects(fetch(`http://127.0.0.1:${j.preview_port}/`, { signal: AbortSignal.timeout(2000) }));
    const last = reportsFor(j.id).at(-1);
    assert.match(last, /is live/);
    assert.match(last, /"id": "chg-\d+-rollback"[\s\S]*lawn__rollback_change/);
  });

  test('a second change goes live directly in live mode, from the ideas app (no chat)', async () => {
    const before = reports.length;
    const res = await fetch(`${url(webServer)}/api/ideas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'second' }) });
    const idea = await res.json();
    store.setProjects([{ name: 'Fixture', description: '', context: null }]);
    const sent = await (await fetch(`${url(webServer)}/api/ideas/${idea.id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Second greeting', project: 'Fixture', brief: 'Greeting: Hello from change two\nThat is all.', destination: 'droplet', mode: 'live' }),
    })).json();
    await runner.tick();
    const j = await job(sent.job.id);
    assert.equal(j.status, 'live', j.note);
    assert.equal(live(), 'Hello from change two');
    assert.equal(originMessage(), 'Hello from change two');
    assert.equal(reports.length, before, 'ideas jobs are not posted to Lawn chat');
    assert.equal(store.get(idea.id).deploy.status, 'ok');
  });

  test('rollback only works on the live change; then it reverts release and main', async () => {
    await api('POST', `/api/jobs/${preview.id}/actions`, { action: 'rollback' });
    await runner.tick();
    let j = await job(preview.id);
    assert.equal(j.status, 'live');
    assert.match(j.note, /refused or failed/);
    assert.equal(live(), 'Hello from change two');

    const second = (await api('GET', '/api/jobs?status=live&source=ideas'))[0];
    await api('POST', `/api/jobs/${second.id}/actions`, { action: 'rollback' });
    await runner.tick();
    j = await job(second.id);
    assert.equal(j.status, 'rolled_back', j.note);
    assert.equal(live(), 'Hello from change one');
    assert.equal(originMessage(), 'Hello from change one');
    assert.match(git(origin, 'log', '-1', '--format=%s', 'main'), /^Revert "Second greeting"/);
    assert.ok(release);
  });

  test('failing tests: committed on the branch, nothing deploys', async () => {
    const j0 = await newJob({ title: 'Broken greeting', mode: 'live', brief: 'BREAK the greeting on purpose for this test.' });
    await runner.tick();
    const j = await job(j0.id);
    assert.equal(j.status, 'failed');
    assert.match(j.note, /Tests failed, so nothing was deployed/);
    assert.equal(j.tests.ok, false);
    assert.equal(live(), 'Hello from change one');
    assert.equal(originMessage(), 'Hello from change one');
    assert.equal(git(repo, 'show', `${j.branch}:message.txt`), 'BROKEN greeting');
    assert.match(reportsFor(j.id).at(-1), /Tests failed/);
    // Discarding a failed job cleans up its worktree.
    await api('POST', `/api/jobs/${j.id}/actions`, { action: 'discard' });
    await runner.tick();
    assert.equal((await job(j.id)).status, 'discarded');
    assert.ok(!fs.existsSync(path.join(runner.cfg.workDir, 'wt', `Fixture-${j.id}`)));
  });

  test('a change that touches an env file is stopped before commit', async () => {
    const j0 = await newJob({ title: 'Sneaky', brief: 'SECRET: write the token into an env file.' });
    await runner.tick();
    const j = await job(j0.id);
    assert.equal(j.status, 'failed');
    assert.match(j.note, /env or secret files \(\.env\)/);
    assert.equal(j.commit, null);
  });

  test('a preview can be discarded', async () => {
    const j0 = await newJob({ title: 'Try this', brief: 'Greeting: Maybe this one\nJust a try.' });
    await runner.tick();
    assert.equal((await job(j0.id)).status, 'preview');
    await api('POST', `/api/jobs/${j0.id}/actions`, { action: 'discard' });
    await runner.tick();
    const j = await job(j0.id);
    assert.equal(j.status, 'discarded');
    assert.deepEqual(Object.keys(runner.previews.list()), []);
    assert.equal(live(), 'Hello from change one');
    assert.match(reportsFor(j.id).at(-1), /^Discarded change/);
  });

  test('secret file names are recognised, templates are not', () => {
    assert.deepEqual(secretFiles(['.env', 'a/.env.local', 'deploy/lawn.env', 'x/server.pem', 'deploy/lawn.env.example', '.env.example', 'src/env.rs', 'docs/credentials.md']),
      ['.env', 'a/.env.local', 'deploy/lawn.env', 'x/server.pem', 'docs/credentials.md']);
  });
});
