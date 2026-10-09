# Joining a public (offline-mode) server — runbook

One process = one server. Home keeps running untouched; the guest is a
second slot (`uwu-bot@guest`) with its own name, memory, password, pacing.

## 1. Pick the server, check the human gates first

- Version: any 1.7–26.x works (client negotiates). 1.20/1.21 public servers fine.
- Offline mode required (she has no Microsoft account). If the server is
  online-mode-only, stop here — she cannot join.
- Whitelist? Apply / ask the owner to add `UwU_Guest` BEFORE starting her.
- Discord-link / captcha / email-register gates: she cannot solve them.
  A human completes the gate once, or an admin exempts the name.
- Name taken? `username` in the guest entry picks the login name. If the
  server says it is taken, change it there (letters/numbers/underscore).

## 2. Configure (all local, nothing committed)

```bash
cd ~/uwu-bot
python3 - <<'EOF'
import json
d = json.load(open('servers.json'))
g = d['servers']['guest']
g['host'] = 'play.example.net'   # <-- the server
g['port'] = 25565
g['username'] = 'UwU_Guest'      # <-- must be unique on that server
json.dump(d, open('servers.json', 'w'), indent=2)
print('guest ->', g['host'], g['port'], g['username'])
EOF
# public-only password (NEVER the home EasyAuth password):
python3 - <<'EOF'
import json, os
p = 'servers.json.local'
d = json.load(open(p)) if os.path.exists(p) else {'servers': {}}
d.setdefault('servers', {}).setdefault('guest', {})['auth_password'] = 'pick-a-fresh-password-here'
json.dump(d, open(p, 'w'), indent=2)
print('guest password set in servers.json.local (gitignored)')
EOF
```

## 3. Dry-run (no service yet — watch the first join live)

```bash
cd ~/uwu-bot && UWU_SERVER=guest bun standalone.js
```

Watch for, in order:

1. `[server] context=guest ... op=false` — wrong context = stop, fix `active`/env.
2. `[guest-auth] sent /register (try 1/2)` then `authenticated per server message`.
   - `login-only server, sent /login` = name was already registered, normal.
   - `verify/captcha gate seen` or `email-gated register seen` = human step (see §1).
   - Silence + no prompt within 30s = no-auth server, also normal (gate opens,
     kit probe runs, she plays honest).
3. First public line she sends should be AFTER auth. Pre-auth she holds silent.

Then in game, as a nearby player, verify the honest basics:

- She walks (never sprint-jumps), answers when spoken to, at most every ~8s.
- `!sourcing "saddle"` explains the honest chain instead of /give-ing.
- Break a block near her claim-free area? She must NOT dig/place outside her
  own claim. `/sethome` + claim FIRST (`/claim`, GriefDefender/Lands — ask
  the server which), then let her build inside it.
- `/tpa` to her: she accepts for trusted ranks, asks the brain otherwise.

Stop the dry run with Ctrl-C once she is registered, homed, and claimed.

## 4. Go persistent (second slot, home untouched)

```bash
sudo cp ~/uwu-bot/systemd/uwu-bot@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uwu-bot@guest.service
journalctl -u uwu-bot@guest.service -f
```

- Home stays on `uwu-bot.service`. Guest is `uwu-bot@guest.service`.
- Viewer ports: home 3000, guest 3001 (`UWU_COUNT_ID`).
- Memory: `bots/UwU_Guest/` — fresh dossiers, no home people, no home coords.
- Stop: `sudo systemctl stop uwu-bot@guest.service`. Disable: `--now disable`.

## 5. If she gets kicked / banned

- Spam kick: pacing is already quiet (8s chat gap, no consecutive lines,
  2–4 min settle). Check the journal for what she sent just before the kick.
- Anticheat (fly/speed): she never sprints on guest. A flag means a stale
  position packet — report the server + plugin, keep her parked meanwhile.
- Ban: appeal to the admin like any player. Never evade with a new name —
  that burns trust for every future join.

## Reference: what she can/can't do out there

CAN: walk, mine, craft, fish, trade, tame, boat, sleep, chat, whisper,
TPA (consent both sides), starter kits, /sethome /home /spawn, claim,
shop economy, honest melee/bow self-defense (stops when they stop).

CANNOT (refuses cleanly): /tp /give /summon /effect /kick /setblock /data,
RCON anything, console punishment, seed math (seed UNKNOWN), reading other
servers' auth DBs, remembering home people/places (separate memory).
