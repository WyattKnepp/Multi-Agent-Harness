#!/usr/bin/env bash
# pm2 entry point for the droplet runner (as the app user, never root):
#   pm2 start ~/droplet-runner/start.sh --name droplet-runner --interpreter bash
# Settings come from ~/.config/droplet-runner/runner.env (mode 600), read here
# so the tokens never enter pm2's process list or dump file.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" != 0 ] || { echo "droplet-runner: refusing to run as root" >&2; exit 1; }
ENV_FILE=${RUNNER_ENV_FILE:-$HOME/.config/droplet-runner/runner.env}
[ -f "$ENV_FILE" ] || { echo "droplet-runner: no $ENV_FILE (see CHAT_BUILDER.md)" >&2; exit 1; }
perm=$(stat -c %a "$ENV_FILE")
[ "$perm" = 600 ] || { echo "droplet-runner: $ENV_FILE must be mode 600 (is $perm)" >&2; exit 1; }
# Never inherit another app's Anthropic credentials from pm2's environment.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
exec node runner.js
