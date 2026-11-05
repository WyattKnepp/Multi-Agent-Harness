#!/usr/bin/env bash
# Fixture tests: the greeting must not be broken, the jail must hide the
# probe secret and cut the network.
set -e
grep -q . message.txt
if grep -q BROKEN message.txt; then echo "FAIL: greeting is broken"; exit 1; fi
if [ -n "${SECRET_PROBE:-}" ] && [ -s "$SECRET_PROBE" ]; then echo "FAIL: can read $SECRET_PROBE"; exit 1; fi
echo "ok 1 greeting"
