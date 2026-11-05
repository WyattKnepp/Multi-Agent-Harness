// What the runner does with one claimed job: build (new job), ship, discard,
// rollback. Every outcome is written to the job (pipeline internal API) and,
// for jobs from Lawn chat, posted to that chat thread.
const fs = require('fs');
const path = require('path');
const { projectFor } = require('./config');
const claude = require('./claude');
const jail = require('./jail');
const { run, git, gitOk } = require('./sh');

// Files the change may never touch: env files and key material. Templates
// (*.example, *.sample, *.template) are fine.
const SECRET_FILE = /(^|\/)(\.env[^/]*|[^/]+\.env|[^/]*\.(pem|key|p12|pfx)|credentials[^/]*|\.git-credentials|\.npmrc|id_[a-z0-9]+)$/i;
const TEMPLATE = /\.(example|sample|template)$/i;
const secretFiles = (files) => files.filter((f) => SECRET_FILE.test(f) && !TEMPLATE.test(f));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
const tail = (s, n = 1500) => (s.length > n ? '…' + s.slice(-n) : s);
const fence = (s) => '```\n' + tail(String(s).trim(), 1200).replace(/```/g, "'''") + '\n```';

function card(id, summary, description, tool) {
  return '```lawn-confirm\n' + JSON.stringify({
    id, summary, changes: [{ action: 'other', description, tool, args: { id: Number(id.split('-')[1]) } }],
  }, null, 2) + '\n```';
}

function createSteps({ cfg, pipe, lawn, previews, log }) {
  const paths = (job) => ({
    wt: path.join(cfg.workDir, 'wt', `${job.project}-${job.id}`),
    data: path.join(cfg.workDir, 'jobs', String(job.id)),
  });
  const gitId = ['-c', `user.name=${cfg.gitName}`, '-c', `user.email=${cfg.gitEmail}`];

  async function set(job, patch, chat) {
    const updated = await pipe.update(job.id, patch);
    Object.assign(job, updated);
    if (chat) await lawn.report(job, chat);
    log(`job ${job.id}: ${patch.status || job.status}${patch.note ? ` - ${patch.note}` : ''}`);
    return job;
  }
  const finish = (job, patch, chat) => set(job, { ...patch, done: true }, chat);

  // Environment for project commands: nothing secret, toolchains and caches.
  function stepEnv(job, p, extra = {}) {
    return {
      PATH: [path.join(cfg.cargoHome, 'bin'), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      HOME: cfg.home,
      USER: process.env.USER || 'runner',
      LANG: 'C.UTF-8',
      CARGO_HOME: cfg.cargoHome,
      RUSTUP_HOME: cfg.rustupHome,
      CARGO_TARGET_DIR: cfg.targetDir,
      CARGO_BUILD_JOBS: String(cfg.cargoJobs),
      npm_config_cache: cfg.npmCache,
      CI: '1',
      RUNNER_JOB: String(job.id),
      RUNNER_DATA: p.data,
      RUNNER_OUT: path.join(p.data, 'out'),
      ...extra,
    };
  }

  // A project command inside the jail. net: the deps step only.
  function jailed(job, p, command, { net = false } = {}) {
    const [cmd, args] = jail.wrap(cfg, {
      command, cwd: p.wt, net,
      writable: [p.data, cfg.targetDir, path.join(cfg.cargoHome, 'registry'), path.join(cfg.cargoHome, 'git'), cfg.npmCache],
    });
    return run(cmd, args, { cwd: p.wt, env: stepEnv(job, p), timeoutMs: cfg.stepTimeoutMs });
  }

  // Bring the local base branch up to the remote's (fast-forward only).
  function syncBase(project) {
    const { repo, base } = project;
    gitOk(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    let local = gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
    const remote = gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
    if (remote && (!local || gitOk(repo, ['merge-base', '--is-ancestor', local, remote]) !== null)) {
      if (local !== remote) git(repo, ['update-ref', `refs/heads/${base}`, remote, ...(local ? [local] : [])]);
      local = remote;
    }
    if (!local) throw new Error(`branch ${base} not found in ${repo}`);
    return local;
  }

  // After a successful deploy, the base branch (and the remote's) moves to the
  // deployed commit, so the next change starts from what is live.
  function advanceBase(project, commit) {
    const { repo, base } = project;
    const old = syncBase(project);
    if (gitOk(repo, ['merge-base', '--is-ancestor', old, commit]) === null) {
      return `${base} moved while this deployed; merge ${commit.slice(0, 7)} by hand`;
    }
    git(repo, ['update-ref', `refs/heads/${base}`, commit, old]);
    if (!project.push) return '';
    const pushed = gitOk(repo, ['push', '--quiet', 'origin', `${commit}:refs/heads/${base}`]);
    return pushed === null ? `could not push ${base} to origin; run git push from the droplet clone` : '';
  }

  function removeWorktree(project, p) {
    gitOk(project.repo, ['worktree', 'remove', '--force', p.wt]);
    gitOk(project.repo, ['worktree', 'prune']);
  }

  // Tests, then (re)build. Returns null when both pass, else the failure patch.
  async function testAndBuild(job, project, p) {
    if (project.test) {
      await set(job, { status: 'testing', note: 'Running the tests' });
      const t = await jailed(job, p, project.test);
      if (t.code !== 0) {
        return { patch: { status: 'failed', note: 'Tests failed, so nothing was deployed', tests: { ok: false, summary: tail(t.out, 400) }, log: `\n[tests]\n${t.out}` }, out: t.out };
      }
      await set(job, { tests: { ok: true, summary: tail(t.out, 400) }, note: 'Tests passed' });
    } else if (job.mode === 'live' || job.action?.type === 'ship') {
      return { patch: { status: 'failed', note: `${project.name} declares no tests in projects.deploy.json, and the runner never deploys untested code` }, out: '' };
    }
    if (project.build) {
      const b = await jailed(job, p, project.build);
      if (b.code !== 0) return { patch: { status: 'failed', note: 'The build failed', log: `\n[build]\n${b.out}` }, out: b.out };
    }
    return null;
  }

  // Copy the configured SQLite databases for the preview (consistent snapshot,
  // then the scrub statements, e.g. clearing OAuth tokens).
  function seedPreview(project, p) {
    const { DatabaseSync } = require('node:sqlite');
    for (const c of project.previewCopy) {
      const to = path.join(p.data, path.basename(c.to || c.sqlite));
      fs.rmSync(to, { force: true });
      if (!fs.existsSync(c.sqlite)) continue;
      const src = new DatabaseSync(c.sqlite, { readOnly: true });
      src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
      src.close();
      const db = new DatabaseSync(to);
      for (const sql of c.scrub || []) { try { db.exec(sql); } catch (e) { log(`scrub skipped (${e.message}): ${sql}`); } }
      db.close();
      fs.chmodSync(to, 0o600);
    }
  }

  async function startPreview(job, project, p) {
    if (!project.preview) return { error: `${project.name} has no runner.preview command` };
    seedPreview(project, p);
    return previews.start(job.id, { command: project.preview, cwd: p.wt, data: p.data, env: stepEnv(job, p), healthPath: project.previewHealthPath });
  }

  async function deploy(job, project, p) {
    await set(job, { status: 'deploying', note: 'Deploying: database backup, release switch, health check' },
      job.source === 'lawn' ? `Change ${job.id} passed its tests. Deploying it live now (database backup, health check, automatic rollback).` : null);
    const d = await run('bash', ['-c', project.deploy], { cwd: p.wt, env: stepEnv(job, p), timeoutMs: cfg.stepTimeoutMs });
    if (d.code !== 0) {
      return finish(job, { status: 'failed', note: 'The deploy failed; the previous release is back in place', log: `\n[deploy]\n${d.out}` },
        `**Change ${job.id} did not go live.** The deploy failed and the previous release is back in place. Nothing changed for you.\n\n${fence(d.out)}`);
    }
    const release = /^RELEASE=(\S+)/m.exec(d.out)?.[1] || null;
    const commit = git(p.wt, ['rev-parse', 'HEAD']);
    const warn = advanceBase(project, commit);
    removeWorktree(project, p);
    const note = `Live${release ? ` as release ${release}` : ''}${warn ? `; ${warn}` : ''}`;
    return finish(job, { status: 'live', release, commit, note, log: `\n[deploy]\n${d.out}` }, [
      `**Change ${job.id} is live: ${job.title}.**`,
      `Commit \`${commit.slice(0, 7)}\` on \`${project.base}\`${release ? `, release \`${release}\`` : ''}. Reload Lawn to see it.${warn ? `\n\nNote: ${warn}.` : ''}`,
      card(`chg-${job.id}-rollback`, `Roll back change ${job.id} (${job.title})`, `Switch back to the release before change ${job.id} and revert its commit`, 'lawn__rollback_change'),
      'Roll it back?',
    ].join('\n\n'));
  }

  async function build(job) {
    const found = projectFor(cfg, job.project);
    if (found.error) {
      return finish(job, { status: 'rejected', note: found.error },
        `**I can't build change ${job.id} on the droplet:** ${found.error}. Nothing was touched.`);
    }
    const project = found.project;
    const p = paths(job);
    fs.mkdirSync(p.data, { recursive: true, mode: 0o700 });

    let baseSha;
    const branch = `change/${job.id}-${slug(job.title)}`;
    try {
      baseSha = syncBase(project);
      fs.mkdirSync(path.dirname(p.wt), { recursive: true });
      if (fs.existsSync(p.wt)) removeWorktree(project, p);
      git(project.repo, ['worktree', 'add', '--quiet', '-b', branch, p.wt, baseSha]);
    } catch (e) {
      return finish(job, { status: 'failed', note: `Could not create the worktree: ${String(e.stderr || e.message).trim()}` },
        `**Change ${job.id} failed before it started:** could not create a git worktree of ${project.name}.`);
    }
    await set(job, { status: 'running', branch, base: project.base, note: 'Claude Code is working on it' },
      `Started change ${job.id} (${job.title}) on branch \`${branch}\`. Claude Code is writing it now; I'll post here when it's ${job.mode === 'live' ? 'live' : 'ready to preview'}.`);

    if (project.deps) {
      const d = await jailed(job, p, project.deps, { net: true });
      if (d.code !== 0) return finish(job, { status: 'failed', note: 'Installing dependencies failed', log: `\n[deps]\n${d.out}` }, `**Change ${job.id} failed:** installing dependencies failed.\n\n${fence(d.out)}`);
    }

    const c = await claude.run(cfg, job, project, p.wt, p.data);
    await set(job, { log: `\n[claude]\n${c.summary}\n${c.log}` });
    if (!c.ok) {
      return finish(job, { status: 'failed', note: 'Claude Code did not finish' }, `**Change ${job.id} failed:** Claude Code did not finish.\n\n${fence(c.summary)}`);
    }
    const changed = git(p.wt, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
    if (!changed.length) {
      return finish(job, { status: 'failed', note: 'Claude Code made no changes' }, `**Change ${job.id}: Claude Code made no changes.**\n\n${c.summary}`);
    }
    const bad = secretFiles(changed);
    if (bad.length) {
      return finish(job, { status: 'failed', note: `The change touched env or secret files (${bad.join(', ')}), so the runner stopped` },
        `**Change ${job.id} stopped:** it touched env or secret files (${bad.join(', ')}). Nothing was committed or deployed.`);
    }

    // Commit before the tests, on the change's own branch: a failing change is
    // still a normal commit the user can read. Only a passing one ships.
    git(p.wt, ['add', '-A']);
    git(p.wt, [...gitId, 'commit', '--quiet', '-m', `${job.title}\n\n${tail(job.brief, 1500)}\n\nChange ${job.id} from ${job.source === 'lawn' ? 'Lawn chat' : job.source === 'ideas' ? 'the ideas app' : 'the API'}, built by the droplet runner.`]);
    const commit = git(p.wt, ['rev-parse', 'HEAD']);
    if (project.push) gitOk(p.wt, ['push', '--quiet', 'origin', `${branch}:refs/heads/${branch}`]);
    await set(job, { commit, note: `Committed ${commit.slice(0, 7)} (${changed.length} file${changed.length === 1 ? '' : 's'})` });

    const failure = await testAndBuild(job, project, p);
    if (failure) {
      return finish(job, failure.patch, `**Change ${job.id} failed: ${failure.patch.note}.** The commit \`${commit.slice(0, 7)}\` is on branch \`${branch}\` if you want to read it.\n\n${fence(failure.out)}\n\nClaude's summary:\n\n${c.summary}`);
    }

    if (job.mode === 'live') return deploy(job, project, p);

    const pv = await startPreview(job, project, p);
    if (pv.error) {
      return finish(job, { status: 'failed', note: `The preview did not start: ${pv.error}`, log: `\n[preview]\n${pv.log || ''}` },
        `**Change ${job.id} built, but the preview did not start:** ${pv.error}.${pv.log ? `\n\n${fence(pv.log)}` : ''}`);
    }
    const url = `${cfg.previewBaseUrl}/?change=${job.id}`;
    return finish(job, { status: 'preview', preview_port: pv.port, preview_url: url, note: 'Preview ready' }, [
      `**Change ${job.id} is ready to preview: ${job.title}.**`,
      `Open ${url} (same Google login). It runs on a copy of your data, without chat or Google Calendar. Tests passed; commit \`${commit.slice(0, 7)}\` on \`${branch}\`.`,
      c.summary,
      card(`chg-${job.id}-preview`, `Ship change ${job.id} (${job.title}) live`, `Deploy ${branch}: database backup, health check, automatic rollback. Reject discards the preview.`, 'lawn__ship_change'),
      'Ship it?',
    ].join('\n\n'));
  }

  async function ship(job) {
    const found = projectFor(cfg, job.project);
    if (found.error) return finish(job, { status: 'preview', note: found.error }, `Can't ship change ${job.id}: ${found.error}.`);
    const project = found.project;
    const p = paths(job);
    if (!fs.existsSync(p.wt)) return finish(job, { status: 'failed', note: 'The worktree is gone; ask for the change again' });
    previews.stop(job.id);
    const base = syncBase(project);
    if (gitOk(p.wt, ['merge-base', '--is-ancestor', base, 'HEAD']) === null) {
      // Another change went live since this one was built: replay it on top.
      if (gitOk(p.wt, [...gitId, 'rebase', '--quiet', base]) === null) {
        gitOk(p.wt, ['rebase', '--abort']);
        await startPreview(job, project, p);
        return finish(job, { status: 'preview', note: `Can't ship: it conflicts with a newer live change on ${project.base}` },
          `**Change ${job.id} can't ship:** it conflicts with a change that went live after it was built. The preview is still up; discard it and ask for the change again.`);
      }
      await set(job, { commit: git(p.wt, ['rev-parse', 'HEAD']), note: `Rebased onto ${project.base}` });
      const failure = await testAndBuild(job, project, p);
      if (failure) return finish(job, failure.patch, `**Change ${job.id} did not ship: ${failure.patch.note}** after rebasing onto the newer ${project.base}.\n\n${fence(failure.out)}`);
    }
    return deploy(job, project, p);
  }

  async function discard(job) {
    previews.stop(job.id);
    const found = projectFor(cfg, job.project);
    if (found.project) removeWorktree(found.project, paths(job));
    fs.rmSync(paths(job).data, { recursive: true, force: true });
    return finish(job, { status: 'discarded', note: job.branch ? `Discarded; branch ${job.branch} is kept` : 'Discarded' },
      `Discarded change ${job.id}. Nothing was deployed${job.branch ? `; the branch \`${job.branch}\` is kept if you want it later` : ''}.`);
  }

  async function rollback(job) {
    const found = projectFor(cfg, job.project);
    if (found.error || !found.project.rollback) {
      return finish(job, { status: 'live', note: found.error || `${job.project} has no runner.rollback command` }, `Can't roll back change ${job.id}: ${found.error || 'no rollback command is configured'}.`);
    }
    const project = found.project;
    await set(job, { status: 'rolling_back', note: 'Rolling back' });
    const r = await run('bash', ['-c', project.rollback], {
      cwd: cfg.workDir, env: stepEnv(job, paths(job), { RUNNER_RELEASE: job.release || '' }), timeoutMs: cfg.stepTimeoutMs,
    });
    if (r.code !== 0) {
      return finish(job, { status: 'live', note: 'Rollback refused or failed; still live', log: `\n[rollback]\n${r.out}` },
        `**Change ${job.id} was not rolled back.** It is still live.\n\n${fence(r.out)}`);
    }
    // Keep the base branch equal to what runs: revert the change's commit.
    let warn = '';
    const tmp = path.join(cfg.workDir, 'wt', `revert-${job.id}`);
    try {
      const base = syncBase(project);
      gitOk(project.repo, ['worktree', 'remove', '--force', tmp]);
      git(project.repo, ['worktree', 'add', '--quiet', '--detach', tmp, base]);
      git(tmp, [...gitId, 'revert', '--no-edit', job.commit]);
      warn = advanceBase(project, git(tmp, ['rev-parse', 'HEAD']));
    } catch (e) {
      warn = `could not revert ${String(job.commit).slice(0, 7)} on ${project.base} (${String(e.stderr || e.message).trim().split('\n')[0]}); revert it by hand`;
    } finally {
      gitOk(project.repo, ['worktree', 'remove', '--force', tmp]);
    }
    return finish(job, { status: 'rolled_back', note: `Rolled back${warn ? `; ${warn}` : ''}`, log: `\n[rollback]\n${r.out}` },
      `**Rolled back change ${job.id} (${job.title}).** The previous release is live again${warn ? `.\n\nNote: ${warn}` : ` and the commit is reverted on \`${project.base}\``}.`);
  }

  const fail = (job, status, note) => finish(job, { status, note }, `**Change ${job.id}: ${note}.**`);

  return { build, ship, discard, rollback, fail, secretFiles };
}

module.exports = { createSteps, secretFiles };
