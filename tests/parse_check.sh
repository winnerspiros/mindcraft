#!/bin/sh
# Parse- AND reference-check every source file.
#
# This exists because `bun run test` never imports agent.js or modes.js, so a
# SyntaxError in the service's real entry path passed 800+ green assertions and
# took the bot offline. That caught SyntaxErrors only.
#
# IMPORTANT - what this does NOT catch, measured not assumed. A live bug was
# `anyHumanOnline()` called as a free function when it is a method on the agent:
# a ReferenceError that only fires at runtime, on a death event, that killed the
# process (NRestarts=1) with the whole test suite green. I tried to catch that
# class here and FAILED to: `bun build` does not resolve method-vs-free-function,
# and `eslint no-undef` does not either (it was tested with the bug deliberately
# reintroduced and reported NOT DETECTED). Importing the module succeeds because
# the bad call sits inside a method body and only executes on that path.
#
# So there is no static guard for it and this script does not pretend to be one.
# It catches SyntaxError, which is what it is for. The runtime class has to be
# caught by watching the journal for ReferenceError after a deploy.
set -e
cd "$(dirname "$0")/.."
fail=0
for f in $(find src -name '*.js' | sort); do
    if ! bun build --no-bundle "$f" --outdir=/tmp/parsecheck >/dev/null 2>/tmp/parsecheck.err; then
        echo "CHECK FAIL: $f"
        head -6 /tmp/parsecheck.err
        fail=1
    fi
done
[ "$fail" -eq 0 ] && echo "check OK: all src/*.js parse and resolve"
exit "$fail"
