#!/usr/bin/env bash
# Switch her between home and a public server with one command.
#
#   tools/server-switch.sh status          — where is she right now?
#   tools/server-switch.sh home            — back to YandereCraft (default)
#   tools/server-switch.sh guest           — out to the public server
#   tools/server-switch.sh guest <entry>   — out to a named servers.json entry
#
# WHY one at a time: this box is 1 OCPU. Two bots + Fabric + viewer = swap
# death. The switch always stops the other side first, so exactly one of
# uwu-bot.service / uwu-bot@*.service runs. Memory namespaces
# (bots/UwU vs bots/UwU_Guest) keep the two lives apart on disk, so going
# back and forth loses nothing — she picks up each life where she left it.
set -uo pipefail

HOME_UNIT="uwu-bot.service"
usage() {
    echo "usage: $0 status | home | guest [servers.json entry]"
    echo "  status          show which side she is on"
    echo "  home            stop guest slot, start home bot"
    echo "  guest [entry]   stop home bot, start guest slot (default entry: guest)"
}

is_active() { sudo systemctl is-active --quiet "$1" 2>/dev/null; }

do_status() {
    local h="stopped" g="stopped" gwhich=""
    is_active "$HOME_UNIT" && h="RUNNING"
    for u in $(sudo systemctl list-units 'uwu-bot@*.service' --no-legend 2>/dev/null | awk '{print $1}'); do
        if is_active "$u"; then g="RUNNING"; gwhich="$u"; fi
    done
    echo "home:  $h"
    echo "guest: $g ${gwhich:+($gwhich)}"
    if [ "$h" = "RUNNING" ] && [ "$g" = "RUNNING" ]; then
        echo "WARNING: both sides running — 1 OCPU cannot hold this. Run '$0 home' or '$0 guest' to settle her on one side."
        return 1
    fi
    if [ "$h" = "stopped" ] && [ "$g" = "stopped" ]; then
        echo "she is nowhere. Run '$0 home' or '$0 guest'."
        return 1
    fi
    return 0
}

check_guest_ready() {
    local entry="${1:-guest}"
    # Entry must exist in servers.json (+ .local overlay counts).
    local host
    host=$(UWU_ENTRY="$entry" node -e "
try {
  const fs = require('fs');
  const f = JSON.parse(fs.readFileSync('servers.json','utf8'));
  let l = null; try { l = JSON.parse(fs.readFileSync('servers.json.local','utf8')); } catch(e) {}
  const e = ((f.servers||{})[process.env.UWU_ENTRY]||{});
  const o = ((l&&l.servers||{})[process.env.UWU_ENTRY]||{});
  console.log((o.host||e.host||'').trim());
} catch(e) { console.log(''); }" 2>/dev/null) || host=""
    if [ -z "$host" ]; then
        echo "no '$entry' entry in servers.json — copy the guest block, set host/port, then retry."
        return 1
    fi
    if [ "$host" = "play.example.net" ]; then
        echo "guest entry still points at the play.example.net placeholder."
        echo "edit servers.json (host/port for the real public server) and put its"
        echo "auth_password in servers.json.local (never the home password), then retry."
        return 1
    fi
    echo "guest target: $host"
    return 0
}

cd /home/ubuntu/uwu-bot || exit 1

case "${1:-}" in
    status) do_status ;;
    home)
        echo "bringing her home..."
        for u in $(sudo systemctl list-units 'uwu-bot@*.service' --no-legend 2>/dev/null | awk '{print $1}'); do
            echo "  stopping $u"
            sudo systemctl stop "$u"
        done
        sudo systemctl start "$HOME_UNIT"
        sleep 3
        do_status
        ;;
    guest)
        entry="${2:-guest}"
        check_guest_ready "$entry" || exit 1
        echo "sending her out to '$entry'..."
        echo "  stopping $HOME_UNIT"
        sudo systemctl stop "$HOME_UNIT"
        # Instance name = servers.json entry (UWU_SERVER=%i in the template).
        sudo systemctl start "uwu-bot@${entry}"
        sleep 3
        do_status
        ;;
    *) usage; exit 1 ;;
esac
