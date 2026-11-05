#!/usr/bin/env node
// Project hosting for the idea pipeline. The Makefile is the entry point:
//   node scripts/deploy.js <new|deploy|caddy|restart|status|logs|remove>
// with PROJECT, IDEA, VISIBILITY and DRY_RUN in the environment.
//
// Runs on the laptop. Droplet work goes over ssh (one shared connection) as
// bash scripts on stdin: scripts/remote/*.sh for the long ones. Settings come
// from the repo .env; per-project settings from projects.deploy.json (see
// projects.deploy.example.json and CLAUDE.md).
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const CONFIG_FILE = path.join(ROOT, 'projects.deploy.json');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = process.env;
const expand = (p) => p && p.replace(/^~(?=$|\/)/, os.homedir());
const DRY = /^(1|true|yes)$/i.test(env.DRY_RUN || '');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const say = (...a) => console.log('==>', ...a);
const warn = (msg) => console.error(`\n!!! ${msg.split('\n').join('\n!!! ')}\n`);

function need(...vars) {
  for (const v of vars) if (!env[v]) fail(`set ${v} in ${ENV_FILE} (see .env.example)`);
}

// ---------- config ----------

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    fail(`can't read ${CONFIG_FILE}: ${e.message}`);
  }
}

function writeConfig(cfg) {
  if (DRY) return say(`[dry run] would write ${path.basename(CONFIG_FILE)}:`, JSON.stringify(cfg, null, 2));
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
}

// Keys starting with "_" are comments.
const projectNames = (cfg) => Object.keys(cfg).filter((k) => !k.startsWith('_'));

// The entry with defaults filled in, or null if the project isn't deployable.
function entryFor(name, cfg = readConfig()) {
  const e = cfg[name];
  if (!e || name.startsWith('_') || e.enabled === false) return null;
  return {
    name,
    dropletDir: e.dropletDir || `${env.DROPLET_PROJECTS_DIR}/${name}`,
    pm2Name: e.pm2Name === undefined ? name : e.pm2Name,
    port: e.port || null,
    subdomain: e.subdomain === undefined ? defaultSubdomain(name) : e.subdomain,
    healthPath: e.healthPath || '/',
    start: e.start || 'npm start',
    build: e.build,
    deploy: e.deploy || '',
    created: e.created || null,
  };
}

const defaultSubdomain = (name) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
const fqdn = (e) => e.subdomain && env.BASE_DOMAIN ? `${e.subdomain}.${env.BASE_DOMAIN}` : null;

function project() {
  const name = env.PROJECT;
  if (!name) fail('PROJECT=<folder name> is required');
  if (!NAME_RE.test(name)) fail(`bad project name "${name}"`);
  return name;
}

// ---------- running things ----------

const SSH_OPTS = () => ['-i', expand(env.DROPLET_KEY), '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=/tmp/deploy-ssh-%C', '-o', 'ControlPersist=60', '-o', 'BatchMode=yes'];

const q = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
const exports_ = (vars) => Object.entries(vars).map(([k, v]) => `export ${k}=${q(v)}`).join('\n') + '\n';

// Run a command. Output streams to the terminal and is also returned.
// mutating: in DRY_RUN, print it instead of running it.
function run(cmd, args, { input, mutating = true, quiet = false, cwd } = {}) {
  if (DRY && mutating) {
    console.log(`[dry run] ${[cmd, ...args].map((a) => (/[\s'"$]/.test(a) ? q(a) : a)).join(' ')}`);
    if (input) console.log(input.replace(/^/gm, '[dry run] | '));
    return Promise.resolve({ code: 0, out: '' });
  }
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    const tee = (stream) => (d) => { out += d; if (!quiet) stream.write(d); };
    p.stdout.on('data', tee(process.stdout));
    p.stderr.on('data', tee(process.stderr));
    p.on('error', (e) => resolve({ code: 127, out: out + e.message }));
    p.on('close', (code) => resolve({ code, out }));
    if (input != null) p.stdin.end(input);
  });
}

// Synchronous local command for quick checks; returns trimmed stdout or null.
function local(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// A bash script on the droplet, as the ssh user (root) or as APP_USER.
// lock: a flock name, held for the whole script.
function remote(script, { vars = {}, asApp = false, lock, ...opts } = {}) {
  need('DROPLET', 'DROPLET_KEY', 'APP_USER');
  let cmd = 'bash -s';
  if (asApp) cmd = `if [ "$(id -un)" = ${q(env.APP_USER)} ]; then bash -s; else sudo -H -u ${q(env.APP_USER)} bash -s; fi`;
  if (lock) {
    const file = `/tmp/pipeline-${lock}.lock`;
    cmd = `exec 9>>${q(file)}; chmod 666 ${q(file)} 2>/dev/null; flock -w 900 9 || { echo "timed out waiting for ${lock} lock" >&2; exit 1; }; ${cmd}`;
  }
  // cd somewhere APP_USER can read, so git and npm don't trip on root's home.
  const body = exports_(vars) + 'cd /tmp\n' + script;
  return run('ssh', [...SSH_OPTS(), env.DROPLET, cmd], { input: body, ...opts });
}

const remoteScript = (name) => fs.readFileSync(path.join(__dirname, 'remote', name), 'utf8');

// Lines like "::status:: ok" printed by the remote scripts.
function markers(out) {
  const m = {};
  for (const [, k, v] of out.matchAll(/^::(\w+):: ?(.*)$/gm)) m[k] = v;
  return m;
}

// ---------- reporting ----------

async function report(status, { commit = '', message = '', log = '' } = {}) {
  if (!env.IDEA) return;
  const server = (env.APP_URL || (env.APP_DOMAIN && `https://${env.APP_DOMAIN}`) || '').replace(/\/$/, '');
  if (!server || !env.AGENT_TOKEN) return warn('APP_DOMAIN/APP_URL or AGENT_TOKEN not set; not reporting the deploy to the web app');
  const body = { status, commit, message, log: log.slice(-4096) };
  if (DRY) return say(`[dry run] would POST ${server}/agent/ideas/${env.IDEA}/deploy`, JSON.stringify({ ...body, log: `(${body.log.length} chars)` }));
  try {
    const res = await fetch(`${server}/agent/ideas/${encodeURIComponent(env.IDEA)}/deploy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AGENT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    if (!res.ok) warn(`reporting the deploy to the web app failed: HTTP ${res.status}`);
    else say(`reported "${status}" to the web app for idea ${env.IDEA}`);
  } catch (e) {
    warn(`reporting the deploy to the web app failed: ${e.message}`);
  }
}

// ---------- checks ----------

async function checkDns(e) {
  const host = fqdn(e);
  if (!host) return;
  let got;
  try { got = await dns.resolve4(host); } catch {
    return warn(`DNS: ${host} does not resolve.\nAdd an A record for it (or a wildcard *.${env.BASE_DOMAIN}) pointing at the droplet, or the site won't be reachable.`);
  }
  const dropletHost = env.DROPLET.replace(/^.*@/, '');
  const droplet = await dns.resolve4(dropletHost).catch(() => [dropletHost]);
  if (!got.some((ip) => droplet.includes(ip))) say(`DNS: ${host} resolves to ${got.join(', ')} (not the droplet itself; fine if it's behind a proxy like Cloudflare)`);
}

function siteFile(e) {
  const imports = (env.CADDY_SITE_IMPORTS || '').split(/\s+/).filter(Boolean);
  return [
    `# Managed by the idea pipeline (make caddy PROJECT=${e.name}). Edits are overwritten.`,
    `${fqdn(e)} {`,
    ...imports.map((i) => `\timport ${i}`),
    `\treverse_proxy 127.0.0.1:${e.port}`,
    '}',
  ].join('\n');
}

// ---------- targets ----------

async function caddy(e) {
  need('BASE_DOMAIN', 'CADDYFILE', 'CADDY_SITES_DIR', 'CADDY_RELOAD');
  if (!e.port || !e.subdomain) return say(`${e.name} has no port or subdomain, so no Caddy site`);
  await checkDns(e);
  const r = await remote(remoteScript('caddy.sh'), {
    lock: 'caddy',
    vars: { NAME: e.name, FQDN: fqdn(e), CADDYFILE: env.CADDYFILE, SITES_DIR: env.CADDY_SITES_DIR, RELOAD: env.CADDY_RELOAD, SITE: siteFile(e) },
  });
  if (r.code !== 0) fail(`Caddy site for ${fqdn(e)} failed (see above); Caddy config was left as it was`);
}

async function targetCaddy() {
  const e = entryFor(project());
  if (!e) fail(`no deploy configured for ${env.PROJECT} in ${path.basename(CONFIG_FILE)}`);
  await caddy(e);
}

async function allocatePort(cfg) {
  const lo = Number(env.PORT_RANGE_START), hi = Number(env.PORT_RANGE_END);
  if (!lo || !hi || lo > hi) fail('set PORT_RANGE_START and PORT_RANGE_END in .env');
  const used = new Set(projectNames(cfg).map((n) => cfg[n].port).filter(Boolean));
  // Listening now, or already referenced by a Caddy site (an app may be down).
  const r = await remote(`ss -ltnH | awk '{print $4}' | sed 's/.*://'
cat ${q(env.CADDYFILE || '/dev/null')} ${q(env.CADDY_SITES_DIR || '/nonexistent')}/*.caddy 2>/dev/null | grep -oE '(localhost|127\\.0\\.0\\.1):[0-9]+' | sed 's/.*://'`,
  { mutating: false, quiet: true });
  if (r.code !== 0) fail(`couldn't list ports on the droplet:\n${r.out}`);
  for (const p of r.out.split(/\s+/).filter(Boolean)) used.add(Number(p));
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  fail(`no free port in ${lo}-${hi}`);
}

async function targetNew() {
  const name = project();
  need('PROJECTS_DIR', 'DROPLET_PROJECTS_DIR');
  const visibility = env.VISIBILITY === 'public' ? 'public' : 'private';
  const dir = path.join(expand(env.PROJECTS_DIR), name);
  const git = (...a) => run('git', ['-C', dir, ...a]);

  // 1. Local repo + GitHub repo.
  if (!fs.existsSync(dir)) { say(`mkdir ${dir}`); if (!DRY) fs.mkdirSync(dir, { recursive: true }); }
  if (local('git', ['-C', dir, 'rev-parse', '--show-toplevel']) !== dir) {
    say(`git init ${dir}`);
    if ((await git('init', '-q')).code) fail('git init failed');
  }
  if (local('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD']) == null) {
    if ((await git('commit', '-q', '--allow-empty', '-m', 'Initial commit')).code) fail('initial commit failed');
  }
  const owner = env.GITHUB_OWNER || local('gh', ['api', 'user', '-q', '.login']) || fail('gh is not logged in (run: gh auth login)');
  const repo = `${owner}/${name}`;
  const origin = local('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  if (origin) {
    say(`origin is already ${origin}; pushing`);
    if ((await git('push', '-q', '-u', 'origin', 'HEAD')).code) fail('git push failed');
  } else if (local('gh', ['repo', 'view', repo, '--json', 'name']) != null) {
    say(`GitHub repo ${repo} already exists; adding it as origin and pushing`);
    if ((await git('remote', 'add', 'origin', `https://github.com/${repo}.git`)).code) fail('git remote add failed');
    if ((await git('push', '-q', '-u', 'origin', 'HEAD')).code) fail('git push failed');
  } else {
    say(`creating ${visibility} GitHub repo ${repo}`);
    const r = await run('gh', ['repo', 'create', repo, `--${visibility}`, '--source', dir, '--remote', 'origin', '--push']);
    if (r.code) fail(`gh repo create ${repo} failed`);
  }

  // 2. Clone on the droplet, as APP_USER. Its git already has GitHub
  // credentials (the PAT) for plain https URLs.
  const cfg = readConfig();
  const old = cfg[name] || {};
  const dropletDir = old.dropletDir || `${env.DROPLET_PROJECTS_DIR}/${name}`;
  const r = await remote(`set -uo pipefail
if [ -d "$DIR/.git" ]; then
  echo "==> $DIR is already cloned on the droplet; fetching"
  git -C "$DIR" fetch -q origin
  exit $?
fi
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then echo "$DIR exists on the droplet and is not a git clone" >&2; exit 1; fi
echo "==> cloning $URL into $DIR"
err=$(git clone -q "$URL" "$DIR" 2>&1) && exit 0
echo "$err" >&2
echo "$err" | grep -qiE 'authentication|could not read username|repository not found|403|permission denied' && exit 3
exit 1`, { asApp: true, vars: { DIR: dropletDir, URL: `https://github.com/${repo}.git` } });
  if (r.code === 3) fail(`cloning ${repo} on the droplet was refused. The droplet's GitHub personal access token probably doesn't cover this new repo: give it access to all repositories (or add ${repo}), then re-run make new PROJECT=${name}.`);
  if (r.code) fail('cloning on the droplet failed (see above)');

  // 3. Port + config entry. No pm2 app or Caddy site yet: the first deploy
  // provisions those once there is code to run.
  const port = old.port || await allocatePort(cfg);
  cfg[name] = {
    port,
    pm2Name: old.pm2Name || name,
    dropletDir,
    subdomain: old.subdomain || defaultSubdomain(name),
    ...old,
    created: old.created || new Date().toISOString().slice(0, 10),
  };
  writeConfig(cfg);
  say(`${name}: github.com/${repo} (${visibility}), droplet ${dropletDir}, port ${port}, https://${cfg[name].subdomain}.${env.BASE_DOMAIN || '<BASE_DOMAIN>'} after the first make deploy`);
}

async function targetDeploy() {
  const name = project();
  const e = entryFor(name);
  if (!e) {
    say(readConfig()[name] ? `deploy is disabled for ${name} in ${path.basename(CONFIG_FILE)}, skipping` : `no deploy configured for ${name}, skipping`);
    return;
  }
  const dir = path.join(expand(env.PROJECTS_DIR), name);

  // Tests first: a red suite never reaches the server.
  const tests = await runTests(name);
  if (tests === 'fail') fail(`tests failed, so nothing was deployed. Read ${path.join(dir, REPORT)}, fix, commit, and run make deploy again.`);
  if (tests === 'none') warn(`${name} has no tests (tests/**/*.test.js); deploying untested`);

  // Deploy exactly what's committed and on GitHub.
  if (local('git', ['-C', dir, 'rev-parse', '--show-toplevel']) !== dir) fail(`${dir} is not a git repo`);
  const dirty = local('git', ['-C', dir, 'status', '--porcelain']);
  if (dirty) fail(`${dir} has uncommitted changes; commit (or gitignore) them first:\n${dirty}`);
  const branch = local('git', ['-C', dir, 'branch', '--show-current']) || fail('detached HEAD; check out a branch first');
  const upstream = local('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '@{u}']);
  if (!upstream) {
    say(`pushing ${branch} to origin`);
    if ((await run('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'HEAD'])).code) fail('git push failed');
  } else {
    await run('git', ['-C', dir, 'fetch', '-q', 'origin'], { mutating: false });
    const [behind, ahead] = (local('git', ['-C', dir, 'rev-list', '--left-right', '--count', '@{u}...HEAD']) || '0 0').split(/\s+/).map(Number);
    if (behind) fail(`${branch} is ${behind} commit(s) behind ${upstream}; pull/rebase, then deploy again`);
    if (ahead) {
      say(`pushing ${ahead} commit(s) to ${upstream}`);
      if ((await run('git', ['-C', dir, 'push', '-q'])).code) fail('git push failed');
    }
  }
  const sha = local('git', ['-C', dir, 'rev-parse', 'HEAD']);

  say(`deploying ${name} ${sha.slice(0, 7)} to ${e.dropletDir}`);
  const build = e.build === undefined ? {} : { BUILD_SET: 1, BUILD: e.build };
  const r = await remote(remoteScript('deploy.sh'), {
    asApp: true,
    lock: `deploy-${name}`,
    vars: { DIR: e.dropletDir, SHA: sha, BRANCH: branch, PM2: e.pm2Name || '', PORT: e.port || '', HEALTH_PATH: e.healthPath, START: e.start, DEPLOY_CMD: e.deploy, ...build },
  });
  if (DRY) return;
  const m = markers(r.out);
  if (r.code !== 0 || m.status !== 'ok') {
    const message = m.message || `deploy failed (exit ${r.code})`;
    await report('failed', { commit: sha, message, log: r.out });
    fail(`${message}\nRead the output above, fix the problem, commit, and run make deploy again.`);
  }

  // Provisioning: the app is up, so make sure its site exists. A no-op
  // (no reload) once it does.
  if (e.port && e.subdomain) {
    try { await caddy(e); } catch (err) {
      await report('failed', { commit: sha, message: `app deployed, but its Caddy site failed: ${err.message}`, log: r.out });
      throw err;
    }
  }
  const url = fqdn(e) && e.port ? ` at https://${fqdn(e)}` : '';
  await report('ok', { commit: sha, message: `deployed ${sha.slice(0, 7)}${url}`, log: r.out });
  say(`deployed ${name} ${sha.slice(0, 7)}${url}`);
}

// ---------- tests (see testing/test-report/SKILL.md) ----------

const TEST_FILE = /\.test\.(c|m)?(js|ts)$|\.test\.mts$/;
const REPORT = 'test-report.testreport';
const RESULTS = '.test-results.xml';

function testFiles(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (TEST_FILE.test(ent.name)) found.push(path.relative(dir, full));
    }
  };
  walk(path.join(dir, 'tests'));
  return found.sort();
}

// Runs the project's tests with node:test and writes its .testreport.
// Returns 'none' | 'pass' | 'fail'.
async function runTests(name) {
  const dir = path.join(expand(env.PROJECTS_DIR), name);
  if (!fs.existsSync(dir)) fail(`no folder ${dir}`);
  const files = testFiles(dir);
  if (!files.length) return 'none';
  say(`testing ${name}: ${files.length} file(s) in tests/`);
  const results = path.join(dir, RESULTS);
  fs.rmSync(results, { force: true });
  const t = await run(process.execPath, ['--test', '--test-timeout=60000',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=junit', `--test-reporter-destination=${results}`, ...files], { cwd: dir, mutating: false });
  if (!fs.existsSync(results)) fail(`the test run crashed before writing results (exit ${t.code}); see output above`);
  const r = await run(process.execPath, [path.join(ROOT, 'testing', 'testreport.js'), results,
    '--root', dir, '--project', name, '--out', path.join(dir, REPORT), '--cmd', `make test PROJECT=${name}`], { mutating: false });
  if (r.code === 2) fail('could not render the test report (see above)');
  say(`report: ${path.join(dir, REPORT)}`);
  // The report decides: node exits non-zero for todo-only failures too.
  return r.code === 0 ? 'pass' : 'fail';
}

async function targetTest() {
  const name = project();
  const result = await runTests(name);
  if (result === 'none') return say(`${name} has no tests yet (tests/**/*.test.js); see the test-report skill`);
  if (result === 'fail') fail(`tests failed; see ${path.join(expand(env.PROJECTS_DIR), name, REPORT)}`);
}

// Install the test-report skill into a project (or every folder with ALL=1):
// .claude/skills/test-report/SKILL.md with this repo's path filled in, and
// the generated files gitignored. Idempotent.
async function targetSkill() {
  const base = expand(env.PROJECTS_DIR);
  const names = env.ALL === '1'
    ? fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
    : [project()];
  const src = fs.readFileSync(path.join(ROOT, 'testing', 'test-report', 'SKILL.md'), 'utf8');
  for (const name of names) {
    const dir = path.join(base, name);
    const text = src.replaceAll('{{PIPELINE_DIR}}', ROOT).replaceAll('{{PROJECT}}', name);
    const dest = path.join(dir, '.claude', 'skills', 'test-report', 'SKILL.md');
    const gi = path.join(dir, '.gitignore');
    const ignore = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    const missing = [REPORT, RESULTS].filter((f) => !ignore.split('\n').map((l) => l.trim()).includes(f));
    if (DRY) { say(`[dry run] would write ${dest}${missing.length ? ` and gitignore ${missing.join(', ')}` : ''}`); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const changed = !fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== text;
    if (changed) fs.writeFileSync(dest, text);
    if (missing.length) fs.writeFileSync(gi, ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + `# test-report (generated)\n${missing.join('\n')}\n`);
    say(`${name}: skill ${changed ? 'installed' : 'up to date'}${missing.length ? `, gitignored ${missing.join(', ')}` : ''}`);
  }
}

function pm2Target(e) {
  if (!e.pm2Name) fail(`${e.name} has no pm2 app`);
  return e.pm2Name;
}

async function targetRestart() {
  const e = entryFor(project()) || fail(`no deploy configured for ${env.PROJECT}`);
  const r = await remote(`pm2 restart ${q(pm2Target(e))} && pm2 save >/dev/null`, { asApp: true, lock: `deploy-${e.name}` });
  if (r.code) fail('pm2 restart failed');
}

async function targetLogs() {
  const e = entryFor(project()) || fail(`no deploy configured for ${env.PROJECT}`);
  await remote(`pm2 logs ${q(pm2Target(e))} --lines ${Number(env.LINES) || 100} --nostream`, { asApp: true, mutating: false });
}

async function targetStatus() {
  const cfg = readConfig();
  const names = env.PROJECT ? [project()] : projectNames(cfg);
  const r = await remote('pm2 jlist 2>/dev/null', { asApp: true, mutating: false, quiet: true });
  if (r.code) fail(`pm2 jlist failed on the droplet:\n${r.out}`);
  const apps = new Map(JSON.parse(r.out.slice(r.out.indexOf('['))).map((p) => [p.name, p]));
  const rows = [['PROJECT', 'PM2', 'STATUS', 'RESTARTS', 'UPTIME', 'PORT', 'URL']];
  for (const n of names) {
    const e = entryFor(n, cfg);
    if (!e) { rows.push([n, '-', cfg[n] ? 'disabled' : 'not configured', '', '', '', '']); continue; }
    const p = e.pm2Name && apps.get(e.pm2Name);
    const up = p && p.pm2_env.status === 'online' ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) : null;
    rows.push([n, e.pm2Name || '-', p ? p.pm2_env.status : e.pm2Name ? 'not started' : '-', p ? String(p.pm2_env.restart_time) : '',
      up == null ? '' : up < 120 ? `${up}m` : up < 2880 ? `${Math.round(up / 60)}h` : `${Math.round(up / 1440)}d`,
      e.port ? String(e.port) : '', fqdn(e) && e.port ? `https://${fqdn(e)}` : '']);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  for (const row of rows) console.log(row.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
}

async function targetRemove() {
  const name = project();
  const cfg = readConfig();
  // Disabled entries can still be removed.
  const e = cfg[name] && entryFor(name, { [name]: { ...cfg[name], enabled: true } });
  if (!e) { say(`no deploy config for ${name}; nothing to remove`); return; }
  // Only remove what make new set up; an enrolled hand-made app is not ours to delete.
  if (!e.created && env.FORCE !== '1') fail(`${name} wasn't created by make new; refusing to remove it (FORCE=1 to override)`);
  const base = env.DROPLET_PROJECTS_DIR.replace(/\/+$/, '');
  if (!e.dropletDir.startsWith(base + '/') || e.dropletDir.includes('..')) fail(`refusing to delete ${e.dropletDir}: not inside ${base}`);

  if (e.pm2Name) {
    await remote(`pm2 describe "$PM2" >/dev/null 2>&1 && pm2 delete "$PM2" >/dev/null && pm2 save >/dev/null && echo "==> deleted pm2 app $PM2" || echo "==> no pm2 app $PM2"`,
      { asApp: true, lock: `deploy-${name}`, vars: { PM2: e.pm2Name } });
  }
  if (e.subdomain && env.CADDY_SITES_DIR) {
    const r = await remote(remoteScript('caddy.sh'), {
      lock: 'caddy', vars: { NAME: name, REMOVE: 1, CADDYFILE: env.CADDYFILE, SITES_DIR: env.CADDY_SITES_DIR, RELOAD: env.CADDY_RELOAD },
    });
    if (r.code) fail('removing the Caddy site failed');
  }
  const r = await remote(`if [ -d "$DIR" ]; then rm -rf -- "$DIR" && echo "==> deleted $DIR"; else echo "==> no clone at $DIR"; fi`,
    { asApp: true, vars: { DIR: e.dropletDir } });
  if (r.code) fail(`deleting ${e.dropletDir} failed`);
  delete cfg[name];
  writeConfig(cfg);
  say(`removed ${name} from the droplet and ${path.basename(CONFIG_FILE)}. The GitHub repo and ${path.join(expand(env.PROJECTS_DIR || ''), name)} are untouched.`);
}

const TARGETS = { test: targetTest, skill: targetSkill, new: targetNew, deploy: targetDeploy, caddy: targetCaddy, restart: targetRestart, status: targetStatus, logs: targetLogs, remove: targetRemove };

const target = TARGETS[process.argv[2]];
if (!target) {
  console.error(`usage: make <${Object.keys(TARGETS).join('|')}> PROJECT=<name> [IDEA=<id>] [VISIBILITY=private|public] [ALL=1] [DRY_RUN=1]`);
  process.exit(2);
}
target().catch((e) => {
  console.error(`\nerror: ${e.message}`);
  if (!(e instanceof Fail)) console.error(e.stack);
  process.exit(1);
});
