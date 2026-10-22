#!/usr/bin/env bash
# Install the dispatcher as a systemd *user* service on this laptop.
# All settings come from the repo's .env (see .env.example).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env_file="$(cd "$here/.." && pwd)/.env"
[[ -f "$env_file" ]] || { echo "no $env_file: cp .env.example .env and fill it in" >&2; exit 1; }
for v in APP_DOMAIN AGENT_TOKEN PROJECTS_DIR; do
  grep -qE "^$v=[^[:space:]#]" "$env_file" || { echo "set $v in $env_file (see .env.example)" >&2; exit 1; }
done

# systemd user services get a bare PATH; bake in the current one so node,
# herdr and claude (mise shims etc.) resolve the same way they do in a shell.
node_bin="$(command -v node)"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir"
cat > "$unit_dir/idea-dispatcher.service" <<EOF
[Unit]
Description=Idea pipeline dispatcher (droplet → herdr)
After=network-online.target

[Service]
ExecStart=$node_bin $here/dispatcher.js
Environment=PATH=$PATH
Restart=always
RestartSec=10
# The dispatcher may start a headless herdr server; don't kill it (and every
# agent in it) when the dispatcher restarts.
KillMode=process

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable idea-dispatcher.service
systemctl --user restart idea-dispatcher.service
echo "started. logs: journalctl --user -u idea-dispatcher -f"
