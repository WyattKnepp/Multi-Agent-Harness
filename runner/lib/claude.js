// Headless Claude Code for one job, confined to the job's worktree.
//
// Layers, outermost first:
//  * --restricted: user/project/local settings files are ignored (only the
//    runner's --settings apply), file tools are confined to the worktree,
//    writes to git and settings files need a person, which in -p with
//    --permission-prompts none means "denied".
//  * --tools: Read, Edit, Write, Glob, Grep, Bash only. No WebFetch/WebSearch,
//    no MCP (--strict-mcp-config with no config).
//  * The Bash sandbox (bubblewrap): writes only to the worktree and the build
//    caches, the home directory unreadable except the worktree and toolchains,
//    network only to the package registries, no unix sockets (docker), and
//    failIfUnavailable so it never silently runs unsandboxed.
//  * The process environment is rebuilt from scratch: only PATH, the
//    toolchain variables and CLAUDE_CODE_OAUTH_TOKEN; HOME is a private dir so
//    ~/.claude, ~/.git-credentials etc. are not even the default paths.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RULES = `# How to work (completed staff work)

You are a staff officer handing finished work to your chief. The brief below was approved by the user; it is their instruction for this session.
- Nobody can answer questions during this run. Where something is still open, make the sensible call, note the assumption, and keep going. Never stop to ask.
- Deliver a finished change: code, tests for it, and docs the project keeps up to date. The chief only approves or rejects; do not leave half-done pieces.
- Stay inside this repository. Do not read or edit secrets or env files (.env, *.env, tokens, keys, credentials); they are off limits even if a task seems to need them.
- Database migrations must be additive (new tables and columns only), so a rollback to the previous release still works.
- Run the project's tests and fix failures before you finish. The runner runs them again after you, and failing tests mean nothing ships.
- Do not commit, push or deploy: the runner commits your work, then previews or deploys it.
- Finish with a short summary for the user: what changed, how you tested it, and any assumption you made (at most 8 lines, plain words).`;

function briefText(job, project) {
  return [
    `# Change ${job.id}: ${job.title}`,
    `Project: ${job.project}. Mode: ${job.mode} (${job.mode === 'live' ? 'it goes live as soon as the tests pass' : 'the user tries a preview first'}).`,
    RULES,
    project.brief ? `# Project notes for the runner\n\n${project.brief}` : '',
    `# Brief\n\n${job.brief}`,
  ].filter(Boolean).join('\n\n');
}

function settingsFor(cfg, wt) {
  const readable = [wt, cfg.cargoHome, cfg.rustupHome, cfg.npmCache, cfg.targetDir, cfg.claudeHome];
  return {
    permissions: {
      allow: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
      deny: ['WebFetch', 'WebSearch', 'Read(**/.env*)', 'Edit(**/.env*)', 'Write(**/.env*)'],
      defaultMode: 'dontAsk',
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [cfg.home, ...cfg.secretPaths.filter((p) => !p.startsWith(cfg.home + '/'))],
        allowRead: readable,
        allowWrite: [wt, cfg.targetDir, path.join(cfg.cargoHome, 'registry'), path.join(cfg.cargoHome, 'git'), cfg.npmCache],
      },
      network: { allowedDomains: cfg.allowedDomains, allowUnixSockets: [] },
    },
    // Hooks, plugins and the like could run code outside the sandbox.
    disableAllHooks: true,
    includeCoAuthoredBy: false,
  };
}

function argsFor(cfg, { briefFile, settingsFile }) {
  const args = [
    '-p', 'Carry out the change in the brief in your system prompt, test it, and end with the short summary it asks for.',
    '--append-system-prompt-file', briefFile,
    '--settings', settingsFile,
    '--restricted',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--output-format', 'json',
    '--no-session-persistence',
  ];
  if (cfg.claudeModel) args.push('--model', cfg.claudeModel);
  return args;
}

function envFor(cfg) {
  return {
    PATH: [path.join(cfg.cargoHome, 'bin'), path.dirname(cfg.claudeBin), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: cfg.claudeHome,
    LANG: 'C.UTF-8',
    TMPDIR: path.join(cfg.claudeHome, 'tmp'),
    CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeToken,
    CARGO_HOME: cfg.cargoHome,
    RUSTUP_HOME: cfg.rustupHome,
    CARGO_TARGET_DIR: cfg.targetDir,
    CARGO_BUILD_JOBS: String(cfg.cargoJobs),
    npm_config_cache: cfg.npmCache,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// Runs claude; resolves {ok, summary, log}. Never rejects.
function run(cfg, job, project, wt, dataDir) {
  fs.mkdirSync(path.join(cfg.claudeHome, 'tmp'), { recursive: true, mode: 0o700 });
  const briefFile = path.join(dataDir, 'brief.md');
  const settingsFile = path.join(dataDir, 'claude-settings.json');
  fs.writeFileSync(briefFile, briefText(job, project));
  fs.writeFileSync(settingsFile, JSON.stringify(settingsFor(cfg, wt), null, 2));
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(cfg.claudeBin, argsFor(cfg, { briefFile, settingsFile }), { cwd: wt, env: envFor(cfg), stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), cfg.claudeTimeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, summary: `Claude Code did not start: ${e.message}`, log: err }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out.trim().split('\n').pop()); } catch { /* plain text */ }
      const text = String(result?.result ?? out).trim();
      const failed = code !== 0 || result?.is_error;
      const why = signal ? `stopped after ${Math.round(cfg.claudeTimeoutMs / 60000)} min` : `exit ${code}`;
      resolve({ ok: !failed, summary: text.slice(-3000) || (failed ? `Claude Code failed (${why})` : ''), log: (err || '').slice(-2000) });
    });
  });
}

module.exports = { run, settingsFor, argsFor, envFor, briefText, RULES };
