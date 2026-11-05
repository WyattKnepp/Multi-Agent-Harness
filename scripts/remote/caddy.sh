# Runs on the droplet as root, under the global Caddy flock (see deploy.js).
# Writes (or with REMOVE=1 removes) one project's site file in SITES_DIR,
# makes sure the main Caddyfile imports SITES_DIR once, validates, and only
# then reloads. If validation fails, every file goes back to how it was.
# Existing site blocks in the Caddyfile are never edited.
#
# Input (environment): NAME FQDN CADDYFILE SITES_DIR RELOAD REMOVE SITE (file contents)
set -euo pipefail

site="$SITES_DIR/$NAME.caddy"
import_line="import $SITES_DIR/*.caddy"

if [ "${REMOVE:-0}" = 1 ]; then
  [ -f "$site" ] || { echo "no Caddy site file for $NAME"; exit 0; }
  saved=$(mktemp); cp -p "$site" "$saved"; rm -f "$site"
  if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    cp -p "$saved" "$site"; echo "caddy validate failed after removing $site; put it back" >&2; exit 1
  fi
  bash -c "$RELOAD"; echo "removed $site and reloaded Caddy"; exit 0
fi

# A site the user wrote by hand in the main Caddyfile wins; never shadow it.
host_re=$(printf '%s' "$FQDN" | sed 's/[.]/\\./g')
if grep -qE "^[[:space:]]*(https?://)?$host_re(:[0-9]+)?[[:space:]]*([,{]|$)" "$CADDYFILE"; then
  echo "::caddy:: $FQDN already has a site block in $CADDYFILE; leaving it alone"
  exit 0
fi

new=$(mktemp)
printf '%s\n' "$SITE" > "$new"
if [ -f "$site" ] && cmp -s "$new" "$site" && grep -qxF "$import_line" "$CADDYFILE"; then
  echo "::caddy:: $site is up to date"
  exit 0
fi

# One backup of the Caddyfile, taken before the pipeline first touches it.
ls "$CADDYFILE".bak-pipeline-* >/dev/null 2>&1 || cp -p "$CADDYFILE" "$CADDYFILE.bak-pipeline-$(date +%F)"

saved=$(mktemp -d)
cp -p "$CADDYFILE" "$saved/Caddyfile"
had_site=0
[ -f "$site" ] && { cp -p "$site" "$saved/site"; had_site=1; }

mkdir -p "$SITES_DIR"
install -m 644 "$new" "$site"
if ! grep -qxF "$import_line" "$CADDYFILE"; then
  printf '\n# Per-project sites written by the idea pipeline (make caddy).\n%s\n' "$import_line" >> "$CADDYFILE"
  echo "added '$import_line' to $CADDYFILE"
fi

if ! caddy validate --config "$CADDYFILE" --adapter caddyfile > "$saved/validate" 2>&1; then
  tail -n 15 "$saved/validate" >&2
  cp -p "$saved/Caddyfile" "$CADDYFILE"
  if [ "$had_site" = 1 ]; then cp -p "$saved/site" "$site"; else rm -f "$site"; fi
  echo "caddy validate failed; restored the previous files and did not reload" >&2
  exit 1
fi
bash -c "$RELOAD"
echo "::caddy:: wrote $site and reloaded Caddy"
