// Small process helpers. Output is captured (tail only) for job logs.
const { spawn, execFileSync } = require('child_process');

const TAIL = 6000;

// Run argv; resolves {code, out} (stdout+stderr tail). Never rejects.
function run(cmd, args, { cwd, env, timeoutMs = 0, onLine } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const take = (d) => {
      out = (out + d).slice(-TAIL * 4);
      if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        out += `\n[runner] timed out after ${Math.round(timeoutMs / 60000)} min`;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      }, timeoutMs);
    }
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: `${out}\n${e.message}`.slice(-TAIL) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.slice(-TAIL) }); });
  });
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
  }).trim();
}

function gitOk(cwd, args, opts) {
  try { return git(cwd, args, opts); } catch { return null; }
}

module.exports = { run, git, gitOk };
