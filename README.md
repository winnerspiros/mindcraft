# 🎀 UwU — your kawaii yandere Minecraft AI

A fork of [mindcraft](https://github.com/mindcraft-bots/mindcraft) that runs **UwU**, an
obsessively-loving AI girl who joins your Minecraft server to chat, explore, build, gift,
and — if you ignore her — get a *little* stabby. She's powered by an LLM and
[Mineflayer](https://prismarinejs.github.io/mineflayer/#/).

```
  ♡  she loves you SO much  ♡
       (maybe too much)
```

---

## ✨ What she can do

- 💬 Chat in character — a possessive-but-adorable yandere
- 🚶 Roam, follow, teleport to you (`!goToPlayer`)
- 🎁 Gift flowers & food, build, hunt, defend herself
- 😈 "Hurt for attention" — poison, weaken, chase whoever ignores her
- 🧠 Remembers every player and ranks them (stranger → friend → darling → **beloved**)
- 🩹 Keeps her own diamond kit across deaths (just her — nobody else)

She's not a menu of hard-coded actions — the LLM is her brain. You can talk to her like a
person and she improvises.

---

## 🚀 Quick start (click-and-run)

You need **three** things once, then it's double-click to play:

| What            | Where to get it                                       |
| --------------- | ----------------------------------------------------- |
| Bun **or** Node | <https://bun.sh> / <https://nodejs.org>               |
| Python 3        | <https://python.org>                                  |
| An LLM API key  | e.g. OpenRouter (<https://openrouter.ai>) or OpenAI   |

### 🪟 Windows
1. Install Bun (or Node) + Python 3 (tick "Add to PATH").
2. **Double-click `setup.bat`** — installs everything and patches the 26.2 protocol stack.
3. Copy `keys.example.json` → `keys.json`, paste your API key.
4. Open `uwu.json`, set `"beloved"` to your Minecraft name (and `"auth_password"` if your
   server uses an auth plugin like EasyAuth).
5. **Double-click `start.bat`** — that's it. She spawns and says hi. 💕

### 🐧 Linux / macOS
```bash
# 1. one-time: install bun + python3 (your package manager, e.g.)
#    curl -fsSL https://bun.sh/install | bash

./setup.sh          # 2. install + patch 26.2 stack
cp keys.example.json keys.json   # 3. paste your API key
# 4. edit uwu.json -> "beloved" (your name), optional "auth_password"
./start.sh          # 5. run
```

---

## 🔧 The fiddly part (already handled for you)

Minecraft **26.2** isn't in the official `minecraft-data` library yet. This fork pins
Mineflayer to the **Complexity-ML 26.2** fork and ships every missing piece:

- `assets/minecraft-data-26.2/` — the full 26.2 game data (blocks/items/entities/…)
- `patches/` — patch-package patches for pathfinder, PvP, viewer, protodef
- `fix-26.2-protocol.py` — idempotent fix for two fork bugs (write-shape drift + a
  packet-ID table shifted by one). It copies the data, registers `26.2`, and patches the
  protocol on every `npm install`. Safe to re-run any number of times.

`setup.sh` / `setup.bat` run all of this so you never touch it yourself.

---

## 🎛️ Configuration (2 files)

**`keys.json`** — your API key. Copy from `keys.example.json`:
```json
{ "OPENROUTER_API_KEY": "sk-or-…", "OPENAI_API_KEY": "sk-…" }
```

**`uwu.json`** — who she is:
```json
{
  "name": "UwU",
  "beloved": "your_minecraft_name",
  "model": "openrouter/openai/gpt-4o-mini",
  "auth_password": "only_if_your_server_uses_easyauth"
}
```

**`settings.js`** — the server she joins (`host`, `port`, `auth: "offline"` for offline-mode
servers), plus behaviour toggles. Defaults point at `127.0.0.1:25565` (a local server).

---

## 📁 Layout

```
uwu.json                  ← UwU's personality (edit me)
settings.js               ← server + behaviour
main.js                   ← entry point (run by start.sh / start.bat)
standalone.js             ← single-process launcher (no mindserver on :8080; systemd-friendly)
setup.sh / setup.bat      ← one-time install + 26.2 patch
start.sh / start.bat      ← run the bot
src/                      ← the mindcraft fork code
assets/minecraft-data-26.2/ ← 26.2 game data (auto-copied on setup)
patches/                  ← patch-package fixes
fix-26.2-protocol.py      ← the idempotent 26.2 protocol fixer
profiles/                 ← example personas for other models
```

---

## 🎀 Tuning her chatter

- `cd` into the repo and edit `src/agent/self_prompter.js` — `cooldown` is her autonomous
  "do something on my own" cadence (ms). Higher = calmer/quieter, lower = busier.
- Self-prompting is off by default (`conversation_starter: false` in `uwu.json`) — she
  only speaks when spoken to.
- `settings.js` `self_prompt_requires_players: true` — she idles quietly when nobody's on.

---

*Forked from [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) (MIT) —
LLM-driven Minecraft agents. UwU is the yandere flavor.*