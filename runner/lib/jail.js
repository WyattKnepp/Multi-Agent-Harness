// Runs a project's own commands (deps, tests, build, preview) inside bubblewrap:
// the whole filesystem read-only, the secret paths hidden, and only the
// worktree, the job's data dir and the build caches writable. Tests and builds
// get no network (`net: false`); only the deps step and previews share the
// host network (previews must listen on a loopback port).
//
// Live deploys and rollbacks do NOT go through here: they must write the
// release dirs and talk to pm2, and the user chose to go live.
const fs = require('fs');

function exists(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

// argv to run `command` (a shell string) in `cwd`.
function wrap(cfg, { command, cwd, writable = [], net = false }) {
  if (cfg.sandbox === 'none') return ['bash', ['-c', command]];
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent',
    '--new-session',
  ];
  if (!net) args.push('--unshare-net');
  for (const p of cfg.secretPaths) {
    const st = exists(p);
    if (!st) continue;
    if (st.isDirectory()) args.push('--tmpfs', p);
    else args.push('--ro-bind', '/dev/null', p);
  }
  for (const w of [cwd, ...writable]) {
    if (!w) continue;
    fs.mkdirSync(w, { recursive: true });
    args.push('--bind', w, w);
  }
  // A git worktree's .git is a file pointing into the repo; tests may run git
  // status/diff, so the repo stays readable (it is under ro-bind /).
  args.push('--chdir', cwd, '--', 'bash', '-c', command);
  return ['bwrap', args];
}

function available() {
  try {
    require('child_process').execFileSync('bwrap', ['--ro-bind', '/', '/', '--unshare-pid', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { wrap, available };
