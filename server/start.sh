#!/usr/bin/env bash
# pm2 entry point. config.env is written by deploy.sh from the repo's .env
# (PORT, AGENT_TOKEN, GRILL_MODEL). An optional hand-made .env next to it can
# add anything droplet-only, e.g. CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_BIN.
cd "$(dirname "$0")"
set -a
[ -f config.env ] && . ./config.env
[ -f .env ] && . ./.env
set +a
export PATH="$HOME/.local/bin:$PATH"
exec node server.js
