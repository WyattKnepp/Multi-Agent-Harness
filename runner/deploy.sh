#!/usr/bin/env bash
# Ship runner/ and projects.deploy.json to the droplet (laptop side), then
# (re)start pm2 app droplet-runner as APP_USER. Same .env as ./deploy.sh
# (DROPLET, DROPLET_KEY, APP_USER); RUNNER_DIR defaults to ~APP_USER/droplet-runner.
# Never touches the runner's env file, work dir or caches on the droplet.
#   runner/deploy.sh             deploy and (re)start
#   runner/deploy.sh --no-start  deploy the files only (first install, before runner.env is filled)
#   runner/deploy.sh --dry-run   show what rsync would change; change nothing
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$here/.env" ]] || { echo "no .env: cp .env.example .env and fill it in" >&2; exit 1; }
set -a; . "$here/.env"; set +a
for v in DROPLET DROPLET_KEY APP_USER; do
  [[ -n "${!v:-}" ]] || { echo "set $v in .env (see .env.example)" >&2; exit 1; }
done
[[ -f "$here/projects.deploy.json" ]] || { echo "no projects.deploy.json" >&2; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$here/projects.deploy.json"
RUNNER_DIR="${RUNNER_DIR:-/home/$APP_USER/droplet-runner}"
dry=()
start=1
case "${1:-}" in
--dry-run) dry=(--dry-run --itemize-changes) ;;
--no-start) start=0 ;;
"") ;;
*) echo "unknown argument $1" >&2; exit 2 ;;
esac
key="${DROPLET_KEY/#\~/$HOME}"
ssh_opts="-i $key -o ControlMaster=auto -o ControlPath=/tmp/deploy-ssh-%C -o ControlPersist=60"
ssh_=(ssh $ssh_opts "$DROPLET")

"${ssh_[@]}" "mkdir -p '$RUNNER_DIR'"
rsync -az "${dry[@]}" -e "ssh $ssh_opts" \
  --exclude tests --exclude work --exclude cache \
  "$here/runner/" "$DROPLET:$RUNNER_DIR/"
rsync -az "${dry[@]}" -e "ssh $ssh_opts" "$here/projects.deploy.json" "$DROPLET:$RUNNER_DIR/projects.deploy.json"
[[ ${#dry[@]} -eq 0 ]] || { echo "(dry run: nothing changed)"; exit 0; }
# Connected as root (DROPLET=root@...): the files must still belong to the app user.
"${ssh_[@]}" "if [ \"\$(id -u)\" = 0 ]; then chown -R '$APP_USER': '$RUNNER_DIR'; fi"
[[ $start == 1 ]] || { echo "files in $RUNNER_DIR; not started (--no-start)"; exit 0; }

"${ssh_[@]}" bash -s <<EOF
set -euo pipefail
as_app() { if [ "\$(id -un)" = "$APP_USER" ]; then "\$@"; else sudo -H -u "$APP_USER" "\$@"; fi; }
if [ "\$(id -u)" = 0 ]; then chown -R "$APP_USER": "$RUNNER_DIR"; fi
if as_app pm2 describe droplet-runner >/dev/null 2>&1; then
  as_app pm2 restart droplet-runner
else
  as_app pm2 start "$RUNNER_DIR/start.sh" --name droplet-runner --interpreter bash
fi
as_app pm2 save
EOF
echo "droplet-runner deployed to $RUNNER_DIR"
