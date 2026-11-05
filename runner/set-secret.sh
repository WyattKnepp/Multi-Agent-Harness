#!/usr/bin/env bash
# Set KEY in the runner's env file without the value ever appearing in argv,
# the terminal or a log. The value comes from stdin when piped, else from a
# hidden prompt:
#   sed -n 's/^INTERNAL_TOKEN=//p' ~/idea-pipeline/.env | tail -n 1 | ~/droplet-runner/set-secret.sh PIPELINE_TOKEN
#   ~/droplet-runner/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN      (asks; paste, Enter)
set -euo pipefail
KEY=${1:?usage: set-secret.sh KEY}
[[ "$KEY" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "bad key $KEY" >&2; exit 2; }
F=${RUNNER_ENV_FILE:-$HOME/.config/droplet-runner/runner.env}
umask 077
mkdir -p "$(dirname "$F")"
touch "$F"
chmod 600 "$F"
if [ -t 0 ]; then
	read -rsp "Value for $KEY (hidden): " VAL
	echo
else
	IFS= read -r VAL || true
fi
VAL=$(printf '%s' "$VAL" | tr -d "\"'\r" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
[ -n "$VAL" ] || { echo "empty value; $KEY not changed" >&2; exit 1; }
export VAL KEY
tmp=$(mktemp "$F.XXXXXX")
awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
	index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
	{ print }
	END { if (!done) print k "=" v }' "$F" >"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$F"
echo "$KEY set in $F (${#VAL} characters)"
