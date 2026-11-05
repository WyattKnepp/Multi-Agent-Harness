# Claude Code Pipeline

Capture ideas from phone or laptop, get grilled on them by Claude, then send
the resulting brief to a Claude Code agent in the right project, opened as a
herdr tab on the laptop.

```
phone/laptop browser ──► $APP_DOMAIN (droplet, Google login)
                           server/  Express + JSON files, grilling via `claude -p`
                                ▲  /agent/* (bearer token, no Google login)
                                │  polls every 15s
laptop: dispatcher/dispatcher.js (systemd user service)
          ├─► make new (new projects: GitHub repo + droplet clone + port)
          └─► herdr: workspace = project, tab = idea, pane runs `claude`
                       └─► agent's last step: make deploy ──► droplet (pm2 + Caddy)
                                                      └─► POST /agent/ideas/:id/deploy
```

## Flow and statuses

`inbox` → (Grill me) `grilling` → (Write handoff) `review` → (Send) `ready`
→ dispatcher claims it: `dispatching` → `dispatched` | `failed`. `archived`
is a side state. A failed idea can be edited and sent again. Cancel grill
kills any running `claude -p` and resets the idea to a fresh `inbox`; only
`inbox` and `archived` ideas can be deleted (hard delete, 409 otherwise).

Deploys are tracked separately in `idea.deploy` (`{status: ok|failed,
commit, message, log, at}`, the latest `make deploy` for that idea). They
never change `status`: a failed deploy isn't a failed dispatch and must not
offer a resend. The UI shows a red "Deploy failed" or subtle "Deployed" pill
and, on the detail page, the message plus a collapsible log tail.

## server/ (runs on the droplet)

- `server.js`: routes. `/api/*` is for the web app, protected by Caddy's
  `require_login` (oauth2-proxy). `/agent/*` is for the dispatcher. Caddy
  skips the Google login for it, so it checks `AGENT_TOKEN` itself.
- `grill.js`: each idea gets its own `claude -p` session (`--session-id`, then
  `--resume`), with a grilling system prompt that includes the synced project
  list. The handoff is the same session, asked for JSON
  `{title, project, isNew, visibility, brief}`. `visibility` is the new
  project's GitHub repo visibility, `public` only if the idea explicitly asks
  for it, else `private` (also editable on the handoff before sending). It runs in `data/context/`, which holds
  each project's CLAUDE.md (or README.md) as `<project>.md`. The `.md` naming
  keeps Claude from auto-loading them as instructions. It has read-only tools
  (`Read,Glob,Grep`) so it reads up on relevant projects before asking.
  `--strict-mcp-config` keeps claude.ai connectors out of the session (they
  otherwise leak "connector needs auth" chatter into replies).
- Grilling turns are structured (`--json-schema`): `{comment, questions:
  [{id, text, type: single|multi, options}], done}`, stored on the message as
  `text`, `questions`, `done`. A turn that doesn't parse (and every turn from
  before this) is plain `text` and gets the free-text reply. The handoff call
  passes no schema. The griller is told the dispatched agent can't ask the
  user anything, so it settles every open decision in the grill.
- Elaborate (`POST /api/ideas/:id/elaborate {qid}`) resumes the session with
  `--fork-session --no-session-persistence`: it sees the whole thread but
  adds nothing to it and doesn't take the idea's lock. Its explanation lives
  only in the browser (with the turn's answers in localStorage `turn:<id>`)
  and is dropped once the turn is answered.
- `POST /agent/ideas/:id/deploy {status, commit, message, log}` (bearer
  `AGENT_TOKEN`): `make deploy ... IDEA=<id>` reports here. Stored as
  `idea.deploy`, log capped at 4 KB.
- `store.js`: `data/ideas.json`, `data/projects.json` and `data/context/`
  (rewritten on every project sync; files for removed projects are deleted).
- `public/`: plain HTML/CSS/JS with no build step. Mobile-first. Hash routes
  `#/` and `#/idea/<id>`. Drafts are kept in localStorage.
- `start.sh`: pm2 entry point. Sources `config.env` (written by `deploy.sh`
  from the repo `.env`: `PORT`, `AGENT_TOKEN`, `GRILL_MODEL`), then an
  optional hand-made `.env` for server-only extras (`CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_BIN`).

Local dev: `cd server && npm install && AGENT_TOKEN=x PORT=3906 node server.js`
(it needs `claude` logged in locally for grilling).

## dispatcher/ (runs on the laptop)

- Config: the repo-root `.env`, loaded with `process.loadEnvFile`
  (`APP_DOMAIN` or `APP_URL`, `AGENT_TOKEN`, `PROJECTS_DIR`, `POLL_SECONDS`,
  `CLAUDE_ARGS`, `REMOTE_CONTROL`, `HERDR_SESSION`, `HERDR_BIN`). Real env vars win, so for
  testing: `APP_URL=http://localhost:3906 node dispatcher/dispatcher.js --once`.
- Every 10 min (and on start) it PUTs the folders in `PROJECTS_DIR` to
  `/agent/projects`, each with a one-line description and its CLAUDE.md
  (README.md fallback, capped at 60 KB). This is how the griller knows each
  project's context. Restart the service to push a CLAUDE.md edit right away.
- Dispatch: claim → mkdir if `isNew` → `make new PROJECT=<p> VISIBILITY=<v>`
  if `isNew` (or if the folder is still just make new's empty first commit,
  i.e. a resend after a failed make new; a failure fails the dispatch) →
  start herdr headless if it's not
  running → reuse the workspace whose label is the project name, or create one
  → new tab → `herdr agent start idea-<id> --kind claude -- --remote-control=<name> --append-system-prompt-file <brief> "<kickoff>"`.
  Remote Control (on unless `REMOTE_CONTROL=0`) lets you follow the agent from
  the Claude app. It must be `--remote-control=<name>` in one argument: the
  value is optional, so a separate argument would swallow the kickoff.
- `install.sh <server-url>` writes the config and a systemd user unit
  (`idea-dispatcher.service`, `KillMode=process` so a herdr server it started
  survives restarts). Logs: `journalctl --user -u idea-dispatcher -f`.
- Deploy footer: if the project is deployable (an enabled entry in
  `projects.deploy.json`, which make new writes for new projects), the brief
  file gets a "Deploying (last step)" section: when the work is done and
  verified, commit, push and run `make -C <this repo> deploy PROJECT=<p>
  IDEA=<id>`; on failure read the output, fix, run again. New projects are
  also told to start with `npm start` and listen on `$HOST:$PORT`. The repo
  path is derived from `__dirname`. Non-deployable projects get no footer.

### herdr gotchas (learned the hard way)

- herdr prints error JSON on **stderr** with a non-zero exit; success JSON
  goes to stdout.
- `agent start` can't encode a multi-line argument for the shell, and pasting
  a long brief with `agent prompt` leaves it stuck unsent in Claude's input
  box. That's why the brief is a file passed via `--append-system-prompt-file`
  (stored in `~/.local/share/idea-pipeline/briefs/`), and the argv prompt is
  one line.
- With a prompt argument, claude starts working immediately, so `agent start`
  often times out waiting for "ready". The dispatcher then checks
  `pane get` and names the agent with `agent rename <pane> <name>`.
- A folder claude hasn't seen before shows "trust this folder?"
  (`agent_not_ready`). That's left for the user to answer in herdr on
  purpose. The kickoff is in argv, so it runs right after.
- If the herdr server is started from inside a Claude Code session, it
  inherits `CLAUDE_CODE_CHILD_SESSION` and child claudes stop saving
  transcripts. The systemd service doesn't have this problem.

## Configuration

Everything comes from one gitignored `.env` at the repo root; `.env.example`
is the documented template (keep the two in sync when adding a setting).
Per-project hosting settings live in the gitignored `projects.deploy.json`
(template: `projects.deploy.example.json`). The
repo is public and meant to be reusable: never hardcode a host, user, port,
path or domain in committed files.

## Deploy

`./deploy.sh` rsyncs `server/` to `$DROPLET:$APP_DIR` (never touching
`data/`, `.env` or `config.env` there), writes `config.env` from the local
`.env` over ssh stdin, runs `npm install`, and (re)starts pm2 app `$PM2_NAME`
as `$APP_USER`. This is how the pipeline itself ships; its entry in
`projects.deploy.json` is `enabled: false`, so `make deploy` skips it.

## Project hosting and deploy

The root `Makefile` (thin) → `scripts/deploy.js` (laptop) → bash over ssh
(`scripts/remote/deploy.sh` as `APP_USER` under
`flock /tmp/pipeline-deploy-<project>.lock`; `scripts/remote/caddy.sh` as
root under `/tmp/pipeline-caddy.lock`). Every target is idempotent and takes
`DRY_RUN=1` (prints mutating commands and remote scripts instead of running
them; read-only checks still run).

- `make new PROJECT=x [VISIBILITY=private|public]`: in `$PROJECTS_DIR/x`,
  git init + empty initial commit if needed; `gh repo create
  <GITHUB_OWNER or gh user>/x --private --source . --push` (or add the
  existing repo as origin and push); clone it into `$DROPLET_PROJECTS_DIR/x`
  as `APP_USER` (the droplet's git authenticates with its stored PAT via
  `credential.helper store`; an auth error says the PAT probably doesn't cover
  the new repo); allocate a port in `PORT_RANGE_START..END` that no entry
  uses, nothing listens on and no Caddy site points at; write the entry with
  `created`. No pm2 app or Caddy site yet.
- `make deploy PROJECT=x [IDEA=id]`: no enabled entry → "no deploy
  configured for x, skipping", exit 0. Refuses uncommitted local changes or a
  branch behind its upstream; pushes unpushed commits. On the droplet: checks
  the clone is on the same branch, records `HEAD`, stashes droplet-local
  edits to tracked files (npm lockfile churn; `git stash list` keeps them),
  `git fetch` + `git merge --ff-only <laptop HEAD sha>`, then the steps:
  - default: `npm install`, `npm run build` if package.json has one, then
    `pm2 restart <pm2Name> --update-env`, or on first deploy `pm2 start bash
    --name <pm2Name> -- -c "exec <start>"` (provisioning), with
    `PORT=<port> HOST=127.0.0.1`; `pm2 save`.
  - `build` replaces install + build (`""` = none); `start` replaces
    `npm start`; `deploy` replaces build *and* (re)start.
  - health: pm2 status `online` and no restarts over ~5 s, then
    `127.0.0.1:<port><healthPath>` answers < 500 (retries ~15 s).
  - any failure: print the failed version's pm2 logs, `git reset --hard` to
    the recorded HEAD, rebuild, restart (a failed *first* deploy deletes the
    new pm2 app instead), report `failed`, exit 1.
  - success: ensure the Caddy site (`make caddy`, a no-op once it exists),
    report `ok`. Reports go to `POST /agent/ideas/<IDEA>/deploy` only when
    `IDEA` is set (Node `fetch`, token in a header, never argv).
- `make caddy PROJECT=x`: writes `$CADDY_SITES_DIR/x.caddy`
  (`<subdomain>.$BASE_DOMAIN`, each snippet in `CADDY_SITE_IMPORTS`, e.g.
  the TLS snippet and `require_login`, then `reverse_proxy 127.0.0.1:<port>`),
  appends `import $CADDY_SITES_DIR/*.caddy` to `$CADDYFILE` once, takes a
  one-time `Caddyfile.bak-pipeline-<date>` before the first change, runs
  `caddy validate` and restores everything if it fails, else
  `$CADDY_RELOAD`. A host that already has a block in the main Caddyfile is
  left alone (that's how the enrolled hand-made sites are skipped). Never
  edits existing blocks. Warns loudly if `<sub>.$BASE_DOMAIN` doesn't
  resolve; DNS is manual. oauth2-proxy needs `cookie_domains` and
  `whitelist_domains` covering `.$BASE_DOMAIN` for new subdomains' logins to
  work; the scripts don't edit oauth2-proxy.
- Tests gate deploys: `make deploy` first runs `make test` (below) and
  deploys nothing if it fails; no tests → a warning, then it deploys.
- `make restart|logs PROJECT=x`, `make status [PROJECT=x]`: pm2 wrappers;
  status is a table of configured projects with pm2 state, port and URL.
- `make remove PROJECT=x`: deletes the pm2 app, the site file (validate +
  reload) and the droplet clone, then the entry. Only for entries with
  `created` (i.e. from make new; `FORCE=1` overrides). Leaves the GitHub
  repo and the laptop folder.

`projects.deploy.json` (gitignored; real hosts/ports/paths) is keyed by
project folder name; `_`-prefixed keys are comments. Fields, all optional:
`enabled` (false = skip), `port`, `pm2Name` (default the name), `dropletDir`
(default `$DROPLET_PROJECTS_DIR/<name>`), `subdomain` (default lowercased
name), `healthPath` (`/`), `build`, `start`, `deploy`, `created`, `notes`.
`projects.deploy.example.json` documents it; keep the two in step. Existing
hand-hosted apps are enrolled by hand with their real pm2 name, dir, port and
subdomain (their notes record how they were found). The pipeline itself is
`enabled: false`: it keeps deploying with `./deploy.sh`.

## Tests (every project)

One setup for all of the user's projects, so every project gets the same
report.
- **Runner:** Node's built-in `node:test`. Non-Node apps are tested from the
  outside through `child_process`.
- **Report:** `testing/testreport.js` turns JUnit XML into a
  `test-report.testreport` file. `testing/example.testreport` shows the
  format.
- **The rules agents follow:** `testing/test-report/SKILL.md`. It covers what
  to test, temp data dirs, free ports, naming (`describe("api: x")`, plain
  sentences for test names), skip/`todo` (known bug: listed as TODO, doesn't
  fail the run), and staging only your own files.

- `make test PROJECT=x`: runs `x/tests/**/*.test.{js,mjs,cjs,ts,mts}` with
  `node --test` (spec reporter to the terminal, junit to `x/.test-results.xml`).
  It then renders `x/test-report.testreport` and exits non-zero on any
  failure. No tests means a message and exit 0.
- `make skill PROJECT=x` (or `ALL=1`): copies the skill to
  `x/.claude/skills/test-report/SKILL.md`, filling in `{{PIPELINE_DIR}}` and
  `{{PROJECT}}`, and gitignores the two generated files. It's idempotent;
  re-run it after editing the skill.
- nvim: `testing/nvim/testreport.lua` (link it into `~/.config/nvim/plugin/`)
  adds the `testreport` filetype, adding its own folder to the runtimepath
  for `syntax/testreport.lua`. Colors link to the theme's diagnostic groups.
  - Each suite is a fold: `<Tab>` toggles it, `zM`/`zR` fold or unfold all.
  - `]f`/`[f` jump between failures, `]]`/`[[` between suites, and `<CR>` on
    an entry in the FAILURES index jumps to that test.
  - Syntax rules go in a real syntax file because vim's syntax loading
    clears rules defined on FileType.

## Droplet jobs and runner/ (build on the droplet)

A second destination next to the laptop: Claude Code runs headless on the
droplet, the project's tests gate it, then a preview (behind the Google login)
or a live deploy with automatic rollback. One job model for every source:

- **Sources.** Lawn chat (`request_change` tool → Lawn → `POST /api/jobs` with
  `source: lawn` and the chat `thread_id`), and this app's own Send, with
  "Where: Droplet" and "Then: Preview first | Go live" on the handoff
  (`POST /api/ideas/:id/send {destination: 'droplet', mode}` → a job with
  `source: ideas`, `idea_id`; the idea goes to `dispatched` with
  `dispatch: {destination: 'droplet', jobId, mode}` so the laptop never sees
  it). New projects can't go to the droplet.
- **Store.** `server/jobs.js`, `data/jobs.json`, one shared instance per data
  dir (web app and internal API in one process). Statuses: queued → running →
  testing → preview | deploying → live; preview + ship → deploying → live,
  + discard → discarded; live + rollback → rolling_back → rolled_back; failed,
  rejected. Actions (ship/discard/rollback) are requests the runner carries
  out; pending actions are claimed before queued jobs. `releaseStale` (runner
  start) fails a job a crash left mid-step.
- **Internal API** (loopback, `INTERNAL_TOKEN`), self-describing at `GET /api`
  (`server/api-index.js`: method, path, summary, tool, effect, query/body
  JSON Schemas, the same shape as Lawn's `GET /api`, so a tool layer can read
  either): `POST/GET /api/jobs`, `GET /api/jobs/:id[?full=1]`,
  `POST /api/jobs/:id/actions {action}`; runner-only (`agent: false`):
  `POST /api/runner/hello`, `POST /api/runner/claim` (204 when idle),
  `PATCH /api/jobs/:id`. A job from an idea that goes live (or is rolled back)
  sets the idea's `deploy` like `make deploy` does, so it counts as shipped.
- **Web app.** `GET /api/ideas/:id` carries `job` (summary) when the idea was
  sent to the droplet; `POST /api/ideas/:id/job/actions {action}` ships,
  discards or rolls back from the idea page. The page polls while a job is
  busy. A droplet job that ended badly unlocks the handoff for a resend.

`runner/` (pm2 app `droplet-runner` on the droplet, as the app user; no npm
dependencies): `runner.js` claims one job at a time and hands it to
`lib/steps.js`:

- **Target check.** The project needs an entry in `projects.deploy.json` with
  an enabled `runner` block, else the job is `rejected` and nothing is
  touched. Fields: top-level `test` (the gate; no tests → never deploys) and
  `runner: {repo (a bare clone on the droplet), base (default main), push
  (default true), deps, build, preview, previewHealthPath, previewCopy:
  [{sqlite, to, scrub: [sql]}], deploy, rollback, brief}`. Commands run in the
  worktree with `RUNNER_DATA`, `RUNNER_OUT`, `CARGO_TARGET_DIR` (shared),
  `CARGO_BUILD_JOBS`; `deploy` prints `RELEASE=<id>`; `rollback` gets
  `RUNNER_RELEASE`.
- **Build.** Fast-forward the base from origin, `git worktree add -b
  change/<id>-<slug>`, `deps` (jailed, network), `claude -p` (lib/claude.js),
  refuse a change that touches env/secret files, commit on the branch (and
  push it), `test` and `build` (jailed, no network), then preview or deploy.
- **Claude Code.** `--restricted --tools Read,Edit,Write,Glob,Grep,Bash
  --strict-mcp-config --permission-mode dontAsk --permission-prompts none
  --settings <job settings> --append-system-prompt-file <brief>` with the
  completed-staff-work rules. The settings turn on the Bash sandbox
  (bubblewrap, `failIfUnavailable`, no unsandboxed retry): home unreadable
  except the worktree and toolchains, writes only to the worktree and caches,
  network only to the package registries. The environment is rebuilt: PATH,
  toolchain vars, `CLAUDE_CODE_OAUTH_TOKEN`, HOME = a private dir.
- **Jail** (lib/jail.js) for deps/test/build/preview: bwrap with `/`
  read-only, the secret paths hidden (`~/.ssh`, `~/.config`, `~/.openclaw`,
  `~/.claude`, `~/.git-credentials`, `~/idea-pipeline`, `~/lawn/data`, the
  docker socket, ...), only the worktree, job dir and caches writable.
- **Preview** (lib/previews.js): the build on a port from `PREVIEW_PORTS`;
  one gateway on `PREVIEW_GATEWAY` (Caddy `preview.<domain>` behind
  `require_login`); `/?change=<n>` pins a preview by cookie. Previews survive
  a runner restart (`work/previews.json`).
- **Live.** The project's `deploy` (not jailed: it writes releases, talks to
  pm2), then the base branch moves to the deployed commit and is pushed.
  Rollback runs the project's `rollback`, then reverts the commit on the base.
- **Reports.** Every step goes to the job; jobs from Lawn chat also post to
  Lawn (`POST /api/change-requests/:id/report`, Lawn's agent token; Lawn takes
  the thread from the job). Result messages carry a `lawn-confirm` card
  (`chg-<n>-preview` = ship/discard, `chg-<n>-rollback`).
- Config: `~/.config/droplet-runner/runner.env` (mode 600, template
  `runner/runner.env.example`), read by `runner/start.sh`, which refuses root.
  Deploy: `runner/deploy.sh` (rsync `runner/` + `projects.deploy.json`, pm2).
  One-time droplet setup: Lawn's `deploy/CHAT_BUILDER.md`.
- Tests: `cd runner && node --test tests/` (fake `claude`, fixture repo with an
  origin, fake release dir, fake Lawn; uses bubblewrap when it works).
  `LAWN_BIN=<Lawn's backend/target/debug/lawn> node --test tests/lawn-real.test.js`
  runs the same loop through the real Lawn: its change tools file and steer the
  job, and the reports land in a real chat thread. It is skipped without `LAWN_BIN`.
