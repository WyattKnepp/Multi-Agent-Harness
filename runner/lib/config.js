// Runner settings (environment, normally ~/.config/droplet-runner/runner.env
// loaded by start.sh) and per-project settings (projects.deploy.json).
const fs = require('fs');
const os = require('os');
const path = require('path');

const expand = (p) => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);

function parseRange(s, fallback) {
  const m = /^(\d+)-(\d+)$/.exec(String(s || fallback));
  if (!m || Number(m[1]) > Number(m[2])) throw new Error(`bad port range ${s}`);
  return [Number(m[1]), Number(m[2])];
}

function fromEnv(env = process.env) {
  const home = os.homedir();
  const runnerHome = expand(env.RUNNER_HOME || path.join(home, 'droplet-runner'));
  const cfg = {
    home,
    runnerHome,
    workDir: expand(env.RUNNER_WORK_DIR || path.join(runnerHome, 'work')),
    projectsFile: expand(env.PROJECTS_FILE || path.join(runnerHome, 'projects.deploy.json')),
    pipelineUrl: (env.PIPELINE_URL || 'http://127.0.0.1:3007').replace(/\/$/, ''),
    pipelineToken: env.PIPELINE_TOKEN || '',
    lawnUrl: (env.RUNNER_LAWN_URL || 'http://127.0.0.1:3101').replace(/\/$/, ''),
    lawnTokenFile: expand(env.RUNNER_LAWN_TOKEN_FILE || path.join(home, '.config/lawn/agent-token')),
    claudeBin: expand(env.CLAUDE_BIN || path.join(home, '.local/bin/claude')),
    claudeToken: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    claudeModel: env.CLAUDE_MODEL || '',
    claudeTimeoutMs: (Number(env.CLAUDE_TIMEOUT_MINUTES) || 45) * 60_000,
    stepTimeoutMs: (Number(env.STEP_TIMEOUT_MINUTES) || 40) * 60_000,
    pollMs: (Number(env.POLL_SECONDS) || 5) * 1000,
    previewPorts: parseRange(env.PREVIEW_PORTS, '3191-3199'),
    previewGateway: env.PREVIEW_GATEWAY || '127.0.0.1:3190',
    previewBaseUrl: (env.PREVIEW_BASE_URL || 'http://127.0.0.1:3190').replace(/\/$/, ''),
    sandbox: env.RUNNER_SANDBOX || 'bwrap', // bwrap | none (none is for local tests only)
    cargoJobs: Number(env.CARGO_BUILD_JOBS) || 2,
    cargoHome: expand(env.CARGO_HOME || path.join(home, '.cargo')),
    rustupHome: expand(env.RUSTUP_HOME || path.join(home, '.rustup')),
    npmCache: expand(env.NPM_CACHE || path.join(home, '.npm')),
    targetDir: expand(env.SHARED_TARGET_DIR || path.join(runnerHome, 'cache/cargo-target')),
    gitName: env.RUNNER_GIT_NAME || 'Droplet runner',
    gitEmail: env.RUNNER_GIT_EMAIL || 'droplet-runner@localhost',
    // Hosts Claude's Bash may reach (builds need the package registries).
    allowedDomains: (env.SANDBOX_ALLOWED_DOMAINS
      || 'crates.io,index.crates.io,static.crates.io,registry.npmjs.org,github.com,codeload.github.com,objects.githubusercontent.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Paths no build, test, preview or Claude Bash command may read. Directories
    // are hidden behind an empty tmpfs, files behind /dev/null.
    secretPaths: (env.SECRET_PATHS || [
      '~/.ssh', '~/.config', '~/.openclaw', '~/.claude', '~/.claude.json', '~/.git-credentials',
      '~/.gitconfig', '~/.npmrc', '~/.pm2', '~/idea-pipeline', '~/lawn/data', '~/backups',
      '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.docker', '/opt/openclaw.env',
      '/run/docker.sock', '/var/run/docker.sock',
    ].join(',')).split(',').map((s) => expand(s.trim())).filter(Boolean),
  };
  cfg.claudeHome = path.join(cfg.workDir, 'claude-home');
  return cfg;
}

// The runner only touches projects with an entry in projects.deploy.json that
// has a `runner` block not switched off. Returns {project} or {error}.
function projectFor(cfg, name) {
  let all;
  try {
    all = JSON.parse(fs.readFileSync(cfg.projectsFile, 'utf8'));
  } catch (e) {
    return { error: `can't read ${cfg.projectsFile}: ${e.message}` };
  }
  if (!name || name.startsWith('_') || !Object.prototype.hasOwnProperty.call(all, name)) {
    return { error: `${name} is not in projects.deploy.json, so the runner won't touch it` };
  }
  const p = all[name];
  if (!p || typeof p !== 'object' || !p.runner || p.runner.enabled === false) {
    return { error: `${name} is in projects.deploy.json but has no enabled "runner" block, so the runner won't touch it` };
  }
  const r = p.runner;
  if (!r.repo) return { error: `${name}: runner.repo (the droplet clone to branch from) is not set` };
  return {
    project: {
      name,
      repo: expand(r.repo),
      base: r.base || 'main',
      push: r.push !== false,
      test: p.test || '',
      deps: r.deps || '',
      build: r.build || '',
      preview: r.preview || '',
      previewHealthPath: r.previewHealthPath || p.healthPath || '/',
      previewCopy: Array.isArray(r.previewCopy) ? r.previewCopy : [],
      deploy: r.deploy || '',
      rollback: r.rollback || '',
      brief: r.brief || '',
    },
  };
}

module.exports = { fromEnv, projectFor, expand, parseRange };
