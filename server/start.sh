#!/usr/bin/env bash
# pm2 entry point. config.env is written by deploy.sh from the repo's .env
# (PORT, AGENT_TOKEN, GRILL_MODEL). An optional hand-made .env next to it can
# add anything droplet-only, e.g. CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_BIN.
cd "$(dirname "$0")"
# Don't inherit Anthropic credentials from pm2's environment (another app's
# API key would override claude's own login). Set them in .env on purpose.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
set -a
[ -f config.env ] && . ./config.env
[ -f .env ] && . ./.env
set +a
export PATH="$HOME/.local/bin:$PATH"
exec node server.js
