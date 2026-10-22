#!/usr/bin/env bash
# Push server/ to the droplet, write its settings from .env, and (re)start it
# under pm2 as APP_USER. The droplet's data/ and hand-made .env are never
# touched. config.env is rewritten on every deploy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$here/.env" ]] || { echo "no .env: cp .env.example .env and fill it in" >&2; exit 1; }
set -a; . "$here/.env"; set +a

for v in DROPLET DROPLET_KEY APP_USER APP_DIR AGENT_TOKEN; do
  [[ -n "${!v:-}" ]] || { echo "set $v in .env (see .env.example)" >&2; exit 1; }
done
PORT="${PORT:-3006}"
PM2_NAME="${PM2_NAME:-idea-pipeline}"
key="${DROPLET_KEY/#\~/$HOME}"
# One shared SSH connection for every step, so servers that rate-limit SSH
# (e.g. ufw "limit") don't refuse the later ones.
ssh_opts="-i $key -o ControlMaster=auto -o ControlPath=/tmp/deploy-ssh-%C -o ControlPersist=60"
ssh_=(ssh $ssh_opts "$DROPLET")

"${ssh_[@]}" "mkdir -p '$APP_DIR'"
rsync -az --delete -e "ssh $ssh_opts" \
  --exclude node_modules --exclude data --exclude .env --exclude config.env \
  "$here/server/" "$DROPLET:$APP_DIR/"

# Server settings go over ssh stdin, so the token never shows up in a process list.
printf 'PORT=%s\nAGENT_TOKEN=%s\nGRILL_MODEL=%s\n' "$PORT" "$AGENT_TOKEN" "${GRILL_MODEL:-}" \
  | "${ssh_[@]}" "umask 077; cat > '$APP_DIR/config.env'"

"${ssh_[@]}" bash -s <<EOF
set -euo pipefail
as_app() { if [ "\$(id -un)" = "$APP_USER" ]; then "\$@"; else sudo -H -u "$APP_USER" "\$@"; fi; }
if [ "\$(id -u)" = 0 ]; then chown -R "$APP_USER": "$APP_DIR"; fi
cd "$APP_DIR"
as_app npm install --omit=dev --no-audit --no-fund --silent
if as_app pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  as_app pm2 restart "$PM2_NAME"
else
  as_app pm2 start start.sh --name "$PM2_NAME" --interpreter bash
fi
as_app pm2 save
EOF
echo "deployed to $APP_DIR, listening on 127.0.0.1:$PORT"
