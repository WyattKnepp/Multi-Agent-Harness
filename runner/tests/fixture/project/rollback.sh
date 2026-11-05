#!/usr/bin/env bash
# Fixture rollback: only if $RUNNER_RELEASE is live, switch to previous.
set -euo pipefail
dir=$1
cur=$(basename "$(readlink "$dir/current")")
[ "$cur" = "$RUNNER_RELEASE" ] || {
	echo "release $RUNNER_RELEASE is not live ($cur is)"
	exit 1
}
prev=$(readlink "$dir/previous")
ln -sfn "$prev" "$dir/current"
ln -sfn "releases/$cur" "$dir/previous"
echo "rolled back to $prev"
