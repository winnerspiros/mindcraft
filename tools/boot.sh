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
if [ -f fix-protocol.py ]; then
    out=$(python3 fix-protocol.py 2>&1)
    rc=$?
    # Surface only genuinely APPLIED changes. The generator re-copies a few
    # data files and re-prints "FIXED"/"locked" lines on every run even when
    # nothing differs, so filter on its own summary line instead, which is
    # accurate: "[pf] done: N applied, M already present".
    applied=$(printf '%s\n' "$out" | grep -oE '\[pf\] done: [0-9]+ applied' | grep -oE '[0-9]+' | head -1)
    if [ "$rc" -ne 0 ]; then
        log "WARNING: fix-protocol.py exited $rc"
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

# 3. Wait for the game server to accept connections BEFORE starting.
#
# WHY: without this she connects while the server is still booting (this box takes
# ~36-120s) and dies on a refused connection. Each attempt burned a systemd restart
# slot, and 5 attempts inside StartLimitIntervalSec parked the service in `failed`
# -- indistinguishable from "the bot doesn't auto-connect". Waiting here converts a
# wasted crash-restart into a single clean start, which is what lets the (now much
# wider) start limiter do its real job of catching genuine faults.
#
# Deliberately bounded: if the server never opens the port, we start anyway and let
# mineflayer + systemd handle it. This wait must never become a reason the bot
# refuses to boot -- that would convert "flaky" into "permanently down".
#
# Guest slot (UWU_SERVER set, e.g. uwu-bot@guest): resolve host/port from
# servers.json (+ .local overlay) so the wait probes the REMOTE server, not
# localhost. Home keeps the old 127.0.0.1:25565 default.
WAIT_HOST="127.0.0.1"; WAIT_PORT="25565"
if [ -n "${UWU_SERVER:-}" ] && [ -f servers.json ]; then
    WH=$(UWU_SERVER="$UWU_SERVER" node -e "try{const fs=require('fs');const f=JSON.parse(fs.readFileSync('servers.json','utf8'));let l=null;try{l=JSON.parse(fs.readFileSync('servers.json.local','utf8'))}catch(e){}const e=((f.servers||{})[process.env.UWU_SERVER]||{});const o=((l&&l.servers||{})[process.env.UWU_SERVER]||{});console.log((o.host||e.host||'')+':'+(o.port||e.port||''))}catch(e){}" 2>/dev/null || true)
    WH_HOST="${WH%%:*}"; WH_PORT="${WH##*:}"
    [ -n "$WH_HOST" ] && WAIT_HOST="$WH_HOST"
    [ -n "$WH_PORT" ] && WAIT_PORT="$WH_PORT"
fi
log "waiting for minecraft server on $WAIT_HOST:$WAIT_PORT ..."
server_up=0
for _ in $(seq 1 60); do
    if (exec 3<>/dev/tcp/$WAIT_HOST/$WAIT_PORT) 2>/dev/null; then
        server_up=1
        break
    fi
    sleep 2
done
if [ "$server_up" -eq 1 ]; then
    log "server is accepting connections"
else
    log "WARNING: server not up after 120s; starting anyway (systemd will retry)"
fi

log "starting uwu-bot"
exec /home/ubuntu/.bun/bin/bun standalone.js