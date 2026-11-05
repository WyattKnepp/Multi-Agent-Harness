#!/usr/bin/env node
// Droplet runner: builds the change jobs approved in Lawn's chat or sent from
// the ideas app with destination "droplet". One job at a time. See CLAUDE.md
// ("runner/") and Lawn's deploy/CHAT_BUILDER.md for the setup.
//
//   claim (pipeline internal API) -> build | ship | discard | rollback (lib/steps.js)
//
// Runs under pm2 as the app user (start.sh and checkSetup refuse root).
const fs = require('fs');
const config = require('./lib/config');
const api = require('./lib/api');
const jail = require('./lib/jail');
const { createPreviews } = require('./lib/previews');
const { createSteps } = require('./lib/steps');

const log = (...a) => console.log(new Date().toISOString(), ...a);

function checkSetup(cfg) {
  const problems = [];
  if (process.getuid && process.getuid() === 0) problems.push('refusing to run as root');
  if (!cfg.pipelineToken) problems.push('PIPELINE_TOKEN is not set (the ideas app INTERNAL_TOKEN)');
  if (!cfg.claudeToken) problems.push('CLAUDE_CODE_OAUTH_TOKEN is not set (run `claude setup-token` once; see CHAT_BUILDER.md)');
  if (!fs.existsSync(cfg.claudeBin)) problems.push(`no Claude Code at ${cfg.claudeBin}`);
  if (cfg.sandbox !== 'none' && !jail.available()) problems.push('bubblewrap does not work here (install bubblewrap + socat and the AppArmor profile; see CHAT_BUILDER.md)');
  return problems;
}

async function handle(steps, claimed) {
  const { job, kind } = claimed;
  try {
    if (kind === 'build') await steps.build(job);
    else if (kind === 'ship') await steps.ship(job);
    else if (kind === 'discard') await steps.discard(job);
    else if (kind === 'rollback') await steps.rollback(job);
  } catch (e) {
    log(`job ${job.id}: ${kind} crashed: ${e.stack || e.message}`);
    // Release the claim so the queue keeps moving; the job says what happened.
    const status = kind === 'build' ? 'failed' : job.status;
    await steps.fail(job, status, `The runner hit an error during ${kind}: ${e.message}`).catch(() => {});
  }
}

// The runner without the process wiring: tests drive tick() directly.
async function createRunner(cfg, { gateway = true } = {}) {
  fs.mkdirSync(cfg.workDir, { recursive: true, mode: 0o700 });
  const pipe = api.pipeline(cfg);
  const lawn = api.lawn(cfg, log);
  const previews = createPreviews(cfg, log);
  const steps = createSteps({ cfg, pipe, lawn, previews, log });
  const released = (await pipe.hello()).released;
  if (released) log(`released ${released} job(s) left by an earlier run`);
  const live = new Set((await pipe.list({ status: 'preview', limit: 100 })).map((j) => String(j.id)));
  await previews.restore((id) => live.has(id));
  const server = gateway ? previews.gateway() : null;
  return {
    previews,
    // Handle at most one job; resolves the claim (null when idle).
    async tick() {
      let claimed = null;
      try { claimed = await pipe.claim(); } catch (e) { log(`claim failed: ${e.message}`); }
      if (claimed) {
        log(`job ${claimed.job.id}: ${claimed.kind} (${claimed.job.project}, ${claimed.job.mode}, from ${claimed.job.source})`);
        await handle(steps, claimed);
      }
      return claimed;
    },
    stop() { previews.stopAll(); if (server) server.close(); },
  };
}

async function main() {
  const cfg = config.fromEnv();
  const problems = checkSetup(cfg);
  if (problems.length) {
    for (const p of problems) console.error(`droplet-runner: ${p}`);
    process.exit(1);
  }
  const runner = await createRunner(cfg);
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; runner.stop(); process.exit(0); });
  log(`droplet runner up: ${cfg.pipelineUrl}, projects ${cfg.projectsFile}, sandbox ${cfg.sandbox}`);
  while (!stopping) {
    const claimed = await runner.tick();
    if (!claimed) await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { main, createRunner, checkSetup };
