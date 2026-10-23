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
          └─► herdr: workspace = project, tab = idea, pane runs `claude`
```

## Flow and statuses

`inbox` → (Grill me) `grilling` → (Write handoff) `review` → (Send) `ready`
→ dispatcher claims it: `dispatching` → `dispatched` | `failed`. `archived`
is a side state. A failed idea can be edited and sent again. Cancel grill
kills any running `claude -p` and resets the idea to a fresh `inbox`; only
`inbox` and `archived` ideas can be deleted (hard delete, 409 otherwise).

## server/ (runs on the droplet)

- `server.js`: routes. `/api/*` is for the web app, protected by Caddy's
  `require_login` (oauth2-proxy). `/agent/*` is for the dispatcher. Caddy
  skips the Google login for it, so it checks `AGENT_TOKEN` itself.
- `grill.js`: each idea gets its own `claude -p` session (`--session-id`, then
  `--resume`), with a grilling system prompt that includes the synced project
  list. The handoff is the same session, asked for JSON
  `{title, project, isNew, brief}`. It runs in `data/context/`, which holds
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
- Dispatch: claim → mkdir if `isNew` → start herdr headless if it's not
  running → reuse the workspace whose label is the project name, or create one
  → new tab → `herdr agent start idea-<id> --kind claude -- --remote-control=<name> --append-system-prompt-file <brief> "<kickoff>"`.
  Remote Control (on unless `REMOTE_CONTROL=0`) lets you follow the agent from
  the Claude app. It must be `--remote-control=<name>` in one argument: the
  value is optional, so a separate argument would swallow the kickoff.
- `install.sh <server-url>` writes the config and a systemd user unit
  (`idea-dispatcher.service`, `KillMode=process` so a herdr server it started
  survives restarts). Logs: `journalctl --user -u idea-dispatcher -f`.

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
is the documented template (keep the two in sync when adding a setting). The
repo is public and meant to be reusable: never hardcode a host, user, port,
path or domain in committed files.

## Deploy

`./deploy.sh` rsyncs `server/` to `$DROPLET:$APP_DIR` (never touching
`data/`, `.env` or `config.env` there), writes `config.env` from the local
`.env` over ssh stdin, runs `npm install`, and (re)starts pm2 app `$PM2_NAME`
as `$APP_USER`.
