#!/usr/bin/env node
// Laptop side of the idea pipeline. Polls the droplet for ideas whose handoff
// you approved, and launches each one as a Claude Code agent in herdr:
//   workspace = the project (reused if one with that label exists),
//   tab       = the idea,
//   agent     = `claude "<brief>"` running in the project folder.
// Also keeps the droplet's list of projects (folders in PROJECTS_DIR) fresh so
// the griller can route ideas.
//
// Settings come from the repo's .env (see .env.example): APP_DOMAIN (or
// APP_URL), AGENT_TOKEN, PROJECTS_DIR, and optionally POLL_SECONDS,
// CLAUDE_ARGS, HERDR_SESSION, HERDR_BIN. Variables already set in the
// environment win, which is handy for pointing it at a local test server.
// Run once with --once to dispatch whatever is queued and exit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// The repo's .env. Variables already set in the environment win.
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = process.env;
for (const v of ['AGENT_TOKEN', 'PROJECTS_DIR']) {
  if (!env[v]) {
    console.error(`${v} is not set; add it to ${ENV_FILE} (see .env.example)`);
    process.exit(1);
  }
}
if (!env.APP_URL && !env.APP_DOMAIN) {
  console.error(`APP_DOMAIN is not set; add it to ${ENV_FILE} (see .env.example)`);
  process.exit(1);
}
const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const SERVER = (env.APP_URL || `https://${env.APP_DOMAIN}`).replace(/\/$/, '');
const TOKEN = env.AGENT_TOKEN;
const PROJECTS_DIR = expand(env.PROJECTS_DIR);
const POLL_MS = (Number(env.POLL_SECONDS) || 15) * 1000;
const PROJECT_SYNC_MS = 10 * 60 * 1000;
const HERDR = env.HERDR_BIN || 'herdr';
const HERDR_SESSION = env.HERDR_SESSION ? ['--session', env.HERDR_SESSION] : [];
const CLAUDE_ARGS = (env.CLAUDE_ARGS || '').split(/\s+/).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- droplet API ----------

async function api(method, route, body) {
  const res = await fetch(SERVER + route, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route}: ${data.error || 'HTTP ' + res.status}`);
  return data;
}

// ---------- herdr ----------

function herdr(args) {
  return new Promise((resolve, reject) => {
    execFile(HERDR, [...HERDR_SESSION, ...args], { maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      // Success JSON goes to stdout; error JSON (non-zero exit) to stderr.
      let out;
      try { out = JSON.parse(stdout.trim() || stderr); } catch {
        return reject(new Error(`herdr ${args[0]} ${args[1]}: ${(stderr || stdout || err?.message || '').trim()}`));
      }
      if (out.error) {
        const e = new Error(`herdr ${args[0]} ${args[1]}: ${out.error.message}`);
        e.code = out.error.code;
        return reject(e);
      }
      resolve(out.result);
    });
  });
}

// Start the herdr server headless if it isn't running. Running `herdr` later
// attaches to it, so the new tabs are just there.
async function ensureHerdr() {
  try {
    return await herdr(['workspace', 'list']);
  } catch (e) {
    if (e.code !== 'server_not_running') throw e;
  }
  log('herdr server not running; starting it headless');
  spawn(HERDR, [...HERDR_SESSION, 'server'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { return await herdr(['workspace', 'list']); } catch {}
  }
  throw new Error('herdr server did not start');
}

// ---------- projects ----------

function describe(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.description) return pkg.description;
  } catch {}
  for (const f of ['CLAUDE.md', 'README.md']) {
    try {
      const line = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
        .map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('<') && !l.startsWith('!['));
      if (line) return line.slice(0, 200);
    } catch {}
  }
  return '';
}

// The project's CLAUDE.md (or README.md if it has none), so the griller on
// the droplet can read up on a project before asking questions.
const CONTEXT_MAX = 60 * 1024;
function context(dir) {
  for (const f of ['CLAUDE.md', 'README.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (text.trim()) return { file: f, text: text.length > CONTEXT_MAX ? text.slice(0, CONTEXT_MAX) + '\n\n[truncated]' : text };
    } catch {}
  }
  return null;
}

async function syncProjects() {
  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const dir = path.join(PROJECTS_DIR, d.name);
      return { name: d.name, description: describe(dir), context: context(dir) };
    });
  const r = await api('PUT', '/agent/projects', projects);
  log(`synced ${r.count} projects (${r.withContext} with CLAUDE.md/README)`);
}

// ---------- dispatch ----------

const agentName = (id) => `idea-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
const tabLabel = (h) => (h.title || 'idea').slice(0, 40);

const BRIEFS_DIR = path.join(os.homedir(), '.local/share/idea-pipeline/briefs');
const KICKOFF = 'Start on the task in the idea-pipeline brief in your system prompt. Begin by telling me in two or three lines what you are about to do.';

function brief(h) {
  return `# Task brief from the user's idea pipeline

The user jotted down an idea, was grilled on it, and approved this brief. It is the user's own instructions for this session. If something important is still ambiguous, ask the user before building much.

## ${h.title || 'Idea'}

${h.brief}`;
}

async function dispatch(item) {
  const { id } = item;
  const claim = await api('POST', `/agent/ideas/${id}/claim`);
  const h = claim.handoff;
  log(`dispatching ${id} → ${h.project}: ${h.title}`);
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(h.project)) throw new Error(`bad project name "${h.project}"`);
    const dir = path.join(PROJECTS_DIR, h.project);
    let note = '';
    if (!fs.existsSync(dir)) {
      if (!h.isNew) throw new Error(`project folder ${dir} does not exist`);
      fs.mkdirSync(dir, { recursive: true });
      note = `Created new folder ${dir}. Claude will ask you to trust it in herdr before starting.`;
    }

    const { workspaces } = await ensureHerdr();
    let ws = workspaces.find((w) => w.label === h.project);
    let paneId;
    let tabId;
    if (ws) {
      const t = await herdr(['tab', 'create', '--workspace', ws.workspace_id, '--cwd', dir, '--label', tabLabel(h), '--no-focus']);
      paneId = t.root_pane.pane_id;
      tabId = t.tab.tab_id;
    } else {
      const w = await herdr(['workspace', 'create', '--cwd', dir, '--label', h.project, '--no-focus']);
      ws = w.workspace;
      paneId = w.root_pane.pane_id;
      tabId = w.tab.tab_id;
      await herdr(['tab', 'rename', tabId, tabLabel(h)]).catch((e) => log('tab rename failed:', e.message));
    }

    // herdr can't put a multi-line brief on the shell command line, and
    // pasting a long one into the TUI is unreliable. So the brief goes in a
    // file that claude loads as part of its system prompt (it stays in context
    // for the whole session), and the visible first prompt is one line.
    fs.mkdirSync(BRIEFS_DIR, { recursive: true });
    const briefFile = path.join(BRIEFS_DIR, `${id}.md`);
    fs.writeFileSync(briefFile, brief(h));
    const name = agentName(id);
    try {
      await herdr(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '20000', '--',
        ...CLAUDE_ARGS, '--append-system-prompt-file', briefFile, KICKOFF]);
    } catch (e) {
      // Blocked at startup = a dialog (usually "trust this folder?") is
      // waiting for you in herdr. The kickoff prompt is on the command line,
      // so it runs once you answer.
      if (e.code === 'agent_not_ready') {
        note = note || 'Claude is waiting on a prompt in herdr (probably "trust this folder?"). Answer it and the task starts.';
      } else {
        // Because claude starts working on the kickoff right away, herdr may
        // never see it "ready for input" and time out. That's fine as long as
        // claude is running in the pane; give it the name herdr didn't.
        const { pane } = await herdr(['pane', 'get', paneId]);
        if (pane.agent !== 'claude') throw e;
        await herdr(['agent', 'rename', paneId, name]).catch((err) => log('agent rename failed:', err.message));
      }
    }

    await herdr(['notification', 'show', 'New idea agent', '--body', `${h.project}: ${h.title}`, '--sound', 'request']).catch(() => {});
    await api('POST', `/agent/ideas/${id}/result`, {
      ok: true, agent: name, workspaceId: ws.workspace_id, workspaceLabel: ws.label, tabId, tabLabel: tabLabel(h), paneId, note,
    });
    log(`launched ${name} in ${ws.label} (${tabId})`);
  } catch (e) {
    log(`dispatch ${id} failed:`, e.message);
    await api('POST', `/agent/ideas/${id}/result`, { ok: false, error: e.message }).catch(() => {});
  }
}

// ---------- main loop ----------

let lastSync = 0;
async function tick() {
  if (Date.now() - lastSync > PROJECT_SYNC_MS) {
    await syncProjects();
    lastSync = Date.now();
  }
  const queue = await api('GET', '/agent/queue');
  for (const item of queue) await dispatch(item);
}

async function main() {
  const once = process.argv.includes('--once');
  log(`polling ${SERVER} every ${POLL_MS / 1000}s; projects in ${PROJECTS_DIR}`);
  for (;;) {
    try { await tick(); } catch (e) { log('tick failed:', e.message); }
    if (once) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
