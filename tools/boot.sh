#!/usr/bin/env bash
# Boot wrapper for uwu-bot.
#
# WHY: a dependency install (npm/bun) can silently destroy 26.3 support, and
# the two ways it fails do NOT look like a missing patch:
#   - crash loop: "unsupported protocol version: 26.3"
#   - worse, she CONNECTS while logging hundreds of "Bits per block is too big"
#     per minute and reading back an empty inventory (corrupted world data)
#
# Bun blocks dependency lifecycle scripts by default (bun pm untrusted), so
# package.json "postinstall" does NOT reliably run on `bun install`. A boot-time
# repair is the one place that cannot be skipped.
#
# Repair first (idempotent, ~1s when already correct), then verify loudly, then
# start. If 26.3 support is still missing after repair, fail here with a clear
# message rather than crash-looping with a cryptic protocol error.
set -uo pipefail
cd /home/ubuntu/uwu-bot || exit 1

log() { echo "[boot-wrapper] $*"; }

# 1. Repair. Idempotent: prints "-> no-op" for everything already correct.
if [ -f fix-26.2-protocol.py ]; then
    out=$(python3 fix-26.2-protocol.py 2>&1)
    rc=$?
    # Surface only genuinely APPLIED changes. The generator re-copies a few
    # data files and re-prints "FIXED"/"locked" lines on every run even when
    # nothing differs, so filter on its own summary line instead, which is
    # accurate: "[pf] done: N applied, M already present".
    applied=$(printf '%s\n' "$out" | grep -oE '\[pf\] done: [0-9]+ applied' | grep -oE '[0-9]+' | head -1)
    if [ "$rc" -ne 0 ]; then
        log "WARNING: fix-26.2-protocol.py exited $rc"
        printf '%s\n' "$out" | tail -20 | sed 's/^/[boot-wrapper] /'
    elif [ "${applied:-0}" -gt 0 ] 2>/dev/null; then
        log "repaired 26.3 support ($applied patch(es) applied):"
        printf '%s\n' "$out" | grep -vE 'no-op$' | grep -E 'applied|FIXED|extended|locked|-> /' | sed 's/^/[boot-wrapper]   /'
    else
        log "26.3 support already intact (0 patches needed)"
    fi
fi

# 2. Verify. Catches anything the repair could not fix.
if [ -f tools/check-26-3-support.mjs ]; then
    if ! out=$(/home/ubuntu/.bun/bin/bun tools/check-26-3-support.mjs 2>&1); then
        log "FATAL: 26.3 support is broken and could not be repaired."
        printf '%s\n' "$out" | sed 's/^/[boot-wrapper] /'
        log "Refusing to start; see messages above."
        exit 1
    fi
fi

log "starting uwu-bot"
exec /home/ubuntu/.bun/bin/bun standalone.js