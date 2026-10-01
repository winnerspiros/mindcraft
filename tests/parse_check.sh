#!/bin/sh
# Parse-check every source file. `bun run test` never imports agent.js or
# modes.js, so a SyntaxError in the service's real entry path passes the whole
# offline suite and only shows up as a restart loop in the journal.
set -e
cd "$(dirname "$0")/.."
fail=0
for f in $(find src -name '*.js' | sort); do
    if ! bun build --no-bundle "$f" --outdir=/tmp/parsecheck >/dev/null 2>/tmp/parsecheck.err; then
        echo "PARSE FAIL: $f"
        head -4 /tmp/parsecheck.err
        fail=1
    fi
done
[ "$fail" -eq 0 ] && echo "parse OK: all src/*.js"
exit "$fail"
