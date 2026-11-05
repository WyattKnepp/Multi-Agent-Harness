#!/usr/bin/env bash
# Fixture live deploy into a fake release dir ($1): copy, switch, health check,
# switch back on failure. Prints RELEASE=<id> like Lawn's droplet-runner.sh.
set -euo pipefail
dir=$1
id="r$(date +%s%N)-$(git rev-parse --short HEAD)"
mkdir -p "$dir/releases"
cp -r . "$dir/releases/$id"
old=$(readlink "$dir/current" 2>/dev/null || true)
ln -sfn "releases/$id" "$dir/current"
if grep -q UNHEALTHY "$dir/current/message.txt"; then
	[ -n "$old" ] && ln -sfn "$old" "$dir/current"
	echo "health check failed; rolled back to $old"
	exit 1
fi
if [ -n "$old" ]; then ln -sfn "$old" "$dir/previous"; fi
echo "RELEASE=$id"
