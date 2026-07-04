#!/usr/bin/env bash
# Pre-publish OTA gate: the working tree's fingerprint must EXACTLY match the
# latest finished production build's runtime, per platform. An eas update
# whose runtime doesn't match the installed build silently never applies.
# Usage: ./scripts/check-ota-gate.sh [ios|android|all]   (default: all)
set -euo pipefail
platforms=${1:-all}
[ "$platforms" = "all" ] && platforms="ios android"
fail=0
for p in $platforms; do
    tree=$(npx expo-updates fingerprint:generate --platform "$p" 2>/dev/null \
        | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).hash)')
    build=$(npx eas build:list --platform "$p" --buildProfile production --status finished --limit 1 --json --non-interactive 2>/dev/null \
        | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].runtimeVersion)')
    if [ "$tree" = "$build" ]; then
        echo "OK  $p: $tree (tree == live production build)"
    else
        echo "FAIL $p: tree=$tree vs build=$build — an OTA now would NOT reach the installed build"
        fail=1
    fi
done
exit $fail
