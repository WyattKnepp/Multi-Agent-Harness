// Previews: each one is the branch build running on its own loopback port from
// PREVIEW_PORTS, inside the jail. One gateway on PREVIEW_GATEWAY fronts them
// all, so Caddy needs a single site (preview.<domain>, behind the Google login)
// and DNS a single record:
//   https://preview.<domain>/?change=7   pins change 7 (cookie) and redirects to /
//   any other request                    goes to the pinned change, else the newest
// State is kept in <work>/previews.json, so a runner restart brings them back.
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const jail = require('./jail');

const COOKIE = 'runner_change';

function createPreviews(cfg, log) {
  const stateFile = path.join(cfg.workDir, 'previews.json');
  const procs = new Map(); // job id -> child
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const portFree = (port) => new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });

  async function allocate() {
    const used = new Set(Object.values(state).map((p) => p.port));
    for (let p = cfg.previewPorts[0]; p <= cfg.previewPorts[1]; p++) {
      if (!used.has(p) && await portFree(p)) return p;
    }
    return null;
  }

  function spawnPreview(id, spec) {
    const [cmd, args] = jail.wrap(cfg, { command: spec.command, cwd: spec.cwd, writable: [spec.data], net: true });
    const logFile = fs.openSync(path.join(spec.data, 'preview.log'), 'a');
    const child = spawn(cmd, args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', logFile, logFile], detached: true });
    fs.closeSync(logFile);
    child.on('exit', (code) => {
      if (procs.get(id) === child) { procs.delete(id); log(`preview ${id} exited (${code})`); }
    });
    procs.set(id, child);
    spec.pid = child.pid;
    save();
  }

  async function healthy(port, healthPath, timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(2000) });
        if (r.status < 500) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  function stop(id) {
    const child = procs.get(String(id));
    procs.delete(String(id));
    // A preview left by an earlier runner process has only its pid in the state.
    const pid = child?.pid || state[id]?.pid;
    if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } }
    delete state[id];
    save();
  }

  return {
    // spec: {command, cwd, data, env, healthPath}. Resolves {port} or {error, log}.
    async start(id, spec) {
      stop(id);
      const port = await allocate();
      if (!port) return { error: `no free preview port in ${cfg.previewPorts.join('-')}; discard an old preview first` };
      const env = { ...spec.env, PORT: String(port), HOST: '127.0.0.1' };
      state[id] = { port, command: spec.command, cwd: spec.cwd, data: spec.data, env, healthPath: spec.healthPath, at: new Date().toISOString() };
      save();
      spawnPreview(String(id), state[id]);
      if (await healthy(port, spec.healthPath)) return { port };
      let tail = '';
      try { tail = fs.readFileSync(path.join(spec.data, 'preview.log'), 'utf8').slice(-2000); } catch { /* none */ }
      stop(id);
      return { error: `the preview did not answer ${spec.healthPath} on port ${port} within 60 s`, log: tail };
    },
    stop,
    list: () => ({ ...state }),
    // After a runner restart: start every preview that was running.
    async restore(keep) {
      for (const [id, spec] of Object.entries(state)) {
        if (!keep(id) || !fs.existsSync(spec.cwd)) { delete state[id]; continue; }
        if (!(await portFree(spec.port))) continue; // still running (detached)
        spawnPreview(id, spec);
        log(`preview ${id} restarted on ${spec.port}`);
      }
      save();
    },
    stopAll() { for (const id of procs.keys()) { try { process.kill(-procs.get(id).pid, 'SIGTERM'); } catch { /* gone */ } } },
    gateway() {
      const [host, port] = cfg.previewGateway.split(':');
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const pick = url.searchParams.get('change');
        if (pick && state[pick]) {
          url.searchParams.delete('change');
          res.writeHead(302, { location: url.pathname + url.search, 'set-cookie': `${COOKIE}=${pick}; Path=/; HttpOnly; SameSite=Lax; Secure` });
          return res.end();
        }
        const cookie = /(?:^|;\s*)runner_change=(\d+)/.exec(req.headers.cookie || '')?.[1];
        const ids = Object.keys(state).sort((a, b) => Number(b) - Number(a));
        const id = cookie && state[cookie] ? cookie : ids[0];
        if (!id) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          return res.end('No preview is running.\n');
        }
        const up = http.request({ host: '127.0.0.1', port: state[id].port, method: req.method, path: req.url, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode, { ...r.headers, 'x-preview-change': id });
          r.pipe(res);
        });
        up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`Preview ${id} is not answering.\n`); });
        req.pipe(up);
      });
      server.listen(Number(port), host, () => log(`preview gateway on http://${cfg.previewGateway}`));
      return server;
    },
  };
}

module.exports = { createPreviews };
