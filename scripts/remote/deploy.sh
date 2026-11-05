# Runs on the droplet as APP_USER, under the project's flock (see deploy.js).
# Fast-forwards the clone to the commit the laptop just pushed, builds,
# (re)starts the pm2 app and health-checks it. On any failure it resets to the
# commit that was there before, rebuilds and restarts that, and says so.
# The laptop reads the `::key:: value` lines it prints.
#
# Input (environment): DIR SHA BRANCH PM2 PORT HEALTH_PATH START
#   DEPLOY_CMD        replaces build + start when set
#   BUILD_SET, BUILD  BUILD replaces the default install + build when BUILD_SET=1 ("" = no build)
set -uo pipefail

say() { echo "==> $*"; }
out() { echo "::$1:: $2"; }
die() { out status failed; out message "$1"; exit 1; }

cd "$DIR" 2>/dev/null || die "no clone at $DIR on the droplet (run make new)"
[ -d .git ] || die "$DIR on the droplet is not a git clone"
cur_branch=$(git branch --show-current)
[ "$cur_branch" = "$BRANCH" ] || die "droplet clone is on branch '$cur_branch' but you are deploying '$BRANCH'"

prev=$(git rev-parse HEAD)
had_app=0
if [ -n "$PM2" ] && pm2 describe "$PM2" >/dev/null 2>&1; then had_app=1; fi

# Anything edited on the droplet (usually npm lockfile churn) would block the
# fast-forward. Keep it recoverable in the stash rather than losing it.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git stash push -q -m "pipeline deploy $(date -u +%FT%TZ): droplet-local changes" \
    && say "stashed droplet-local changes to tracked files (see: git stash list)"
fi

say "fetching $SHA"
git fetch -q origin || die "git fetch failed on the droplet (is the GitHub token still valid?)"
git merge -q --ff-only "$SHA" || die "can't fast-forward the droplet clone from ${prev:0:7} to ${SHA:0:7}; nothing was changed"

build() {
  if [ -n "${DEPLOY_CMD:-}" ]; then say "deploy override: $DEPLOY_CMD"; bash -c "$DEPLOY_CMD"; return; fi
  if [ "${BUILD_SET:-0}" = 1 ]; then
    [ -z "$BUILD" ] && return 0
    say "build: $BUILD"; bash -c "$BUILD"; return
  fi
  [ -f package.json ] || { say "no package.json, nothing to install"; return 0; }
  say "npm install"
  npm install --no-audit --no-fund || return 1
  if node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)'; then
    say "npm run build"; npm run build
  fi
}

start() {
  [ -n "${DEPLOY_CMD:-}" ] && return 0 # the override (re)starts the app itself
  [ -n "$PM2" ] || return 0
  if [ -n "$PORT" ]; then export PORT HOST=127.0.0.1; fi
  if pm2 describe "$PM2" >/dev/null 2>&1; then
    say "pm2 restart $PM2"; pm2 restart "$PM2" --update-env >/dev/null || return 1
  else
    say "pm2 start $PM2: $START"
    pm2 start bash --name "$PM2" --cwd "$DIR" -- -c "exec $START" >/dev/null || return 1
  fi
  pm2 save >/dev/null
}

pm2_state() { # prints "<status> <restart count>"
  pm2 jlist 2>/dev/null | node -e '
    const p = JSON.parse(require("fs").readFileSync(0, "utf8")).find((x) => x.name === process.argv[1]);
    console.log(p ? `${p.pm2_env.status} ${p.pm2_env.restart_time}` : "missing 0");' "$PM2"
}

health() {
  if [ -n "$PM2" ]; then
    sleep 2
    read -r s0 r0 <<<"$(pm2_state)"
    [ "$s0" = online ] || { echo "pm2 says $PM2 is $s0"; return 1; }
    sleep 5
    read -r s1 r1 <<<"$(pm2_state)"
    [ "$s1" = online ] && [ "$r1" = "$r0" ] || { echo "$PM2 did not stay up (status $s1, restarts $r0 -> $r1)"; return 1; }
  fi
  if [ -n "$PORT" ]; then
    local url="http://127.0.0.1:$PORT${HEALTH_PATH:-/}" code=000
    for _ in $(seq 1 15); do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")
      [ "$code" != 000 ] && break
      sleep 1
    done
    [ "$code" != 000 ] && [ "$code" -lt 500 ] || { echo "health check $url returned $code"; return 1; }
    say "health check $url: $code"
  fi
}

rollback() {
  local reason=$1 how
  if [ -n "$PM2" ] && pm2 describe "$PM2" >/dev/null 2>&1; then
    echo "--- pm2 logs $PM2 (failed version) ---"
    pm2 logs "$PM2" --lines 30 --nostream --raw 2>&1 | tail -n 30
    echo "---"
  fi
  say "FAILED: $reason. Rolling back to ${prev:0:7}"
  git reset -q --hard "$prev"
  if [ "$had_app" = 1 ] || [ -z "$PM2" ]; then
    if build && start && health >/dev/null; then how="the previous version is back up"
    else how="the rollback also failed, the app may be down"; fi
  else
    pm2 delete "$PM2" >/dev/null 2>&1; pm2 save >/dev/null
    how="first deploy, so the new pm2 app was removed"
  fi
  out status failed
  out commit "$SHA"
  out message "$reason. Rolled back to ${prev:0:7}: $how."
  exit 1
}

build || rollback "build failed"
start || rollback "starting the app failed"
reason=$(health 2>&1) || rollback "${reason:-health check failed}"
[ -n "$reason" ] && echo "$reason"
out status ok
out commit "$SHA"
out message "deployed ${SHA:0:7}"
