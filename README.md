# 🎀 UwU — your kawaii yandere Minecraft AI

A fork of [mindcraft](https://github.com/mindcraft-bots/mindcraft) that runs **UwU**, an
obsessively-loving AI girl who joins your Minecraft server to chat, explore, build, gift,
fight, and — if you ignore her — get a *little* stabby. She's powered by an LLM and
[Mineflayer](https://prismarinejs.github.io/mineflayer/#/).

```
  ♡  she loves you SO much  ♡
       (maybe too much)
```

> 🧩 **Branch guide:** `main` is the current line (**Minecraft 26.3**). `26.2` is the last
> 26.2-compatible state, kept for reference/rollback. `develop` mirrors `main`.

---

## ✨ What she can do

She is **not a menu of hard-coded actions** — the LLM is her brain, and every behaviour
below is *available* to her, not scripted. You can just talk to her like a person and she
improvises from this toolkit.

### 💬 Personality & relationships
- Chats in character — a possessive-but-adorable yandere
- **Rich social engine** — per-player `tone`, `respect`, `grievance`; she can ignore or
  forgive you; teleports to the people she actually cares about
- **Memory recall** — remembers *everything* you've done together, weighted by relevance ×
  importance × recency (Generative-Agents poignancy). Recency matters, real relationships stick
- **Madness + jealousy** — dynamic per-player parameters that drive her mood, not a static script
- **Heat meter** — how worked-up she is right now (and it shows in what she does)
- Whispers when she wants it private (per-player `personal` mode)

### 🎮 Survival & play
- Roam, follow, teleport to you (`!goToPlayer`), point at things (`!pointAt`)
- **Fight or flee** — she fights when calm, runs when afraid (fear-gated, not reckless)
- **Gift** flowers & food, and … *playful-evil* gifts (rotten flesh, spider eye, poisonous
  potato) delivered sweetly when she's feeling a certain way
- **Build** like a player — full builds, **hollow builds**, **schematics** (capture + place),
  and even **redstone** layouts. She **invents her own designs** — when asked to build
  something she has no blueprint for, she researches real references live (searches GitHub for
  schematics, looks up materials and construction technique) rather than reaching into a fixed
  build catalog. Builds are **resumable**: `!buildStatus`, `!pauseBuild`, `!resumeBuild`,
  `!cancelBuild`, plus `!recipe` / `!recipePlan` to plan multi-step crafting
- **Craft** — multi-step recipes (logs → planks → chest), any wood type, auto crafting-table setup
- **Fishing** — she'll sit and fish when she's bored
- Keep her own diamond kit across deaths, manage a full inventory (spawns with a chest,
  protects her bow + arrows so she stops tossing them as "junk")

### ⛏️ Mining & earthworks
- `!quarry` / `!quarrySlice` — she excavates in slabs rather than one block at a time, which is
  what actually makes mining viable on a 1-core box
- `!pillar` — towers upward without stranding herself
- `!digUp` — the escape hatch when she ends up under the terrain she's cutting
- `!terrainScan` / `!findCave` — reads the world before committing to a dig

### 🏃 Movement & traversal
- `!climb`, `!crawl`, `!swim`, `!parkour` — she gets over and through things instead of
  retrying the same blocked path
- `!lavaSpring` / `!lavaSwim` — survives lava crossings
- `!ride`, `!saddle`, `!sit` — uses mobs rather than killing them for XP
- `!trapdoorHop`, `!boatLadder`, `!boatTrap`, `!bottle`, `!scoop` — the small traversal verbs
  that add up to not getting stuck

### 🧰 Survival craft
- `!gearUp` / `!myGear` — she maintains her own equipment instead of dropping it
- `!getFood` — hunts and cooks rather than starving (she used to fight her own food supply)
- `!tame`, `!lure` — animal handling
- `!cauldron`, `!fuel`, `!myFurnace`, `!collectFurnace` — she runs a furnace loop
- `!lightUp`, `!hide`, `!portal` — light, shelter and Nether transit
- `!tidy`, `!sourcing`, `!scaffold` — site prep and material staging for builds

### 🛡️ Self-preservation
- `!guardMode` — a state-machine guard stance: she defends a spot instead of chasing
- `!shove`, `!crit`, `!glitch` — close-quarters and combat helpers
- **Drowning rescue** — she tracks her own oxygen (a NaN-silent failure mode on 26.3 that once
  made the rescue unreachable exactly when it mattered) and will swim, break out, or surface

### ⚔️ Combat (rage-gated)
- **Archery** — bow + arrows, with real archery/enchantment knowledge; the draw is released with
  the correct packet ordinal (releasing as `DROP_ITEM` meant no arrow ever flew)
- **Elytra flight** — she can fly (spawn kit + skills), great for travel and dramatic exits
- **Trident (spear)**, **thorns**, and **crystal PvP** — unlocked by rage, not spammed
- **Ranged chase doctrine** — withers and flyers get shot from range instead of meleed into a
  corner she can't reach
- `!chestMob` — loots rather than fighting pointlessly
- `!despawn` / `!summon` — entity lifecycle for testing and cleanup

### 🧭 She knows the world
- **Spatial memory** — a durable map of where things are, so she navigates instead of wandering
- Resolves saved place names (`!pointAt <place>`)
- **RCON-position walking** — on 26.3 entities don't render reliably at short range, so
  `!goToPlayer` walks to the *server's* coordinates for you and switches to live follow once
  you're actually visible. Without this she reported "arrived" without moving.
- `!scout`, `!lookDir`, `!cameraTo`, `!viewer` — perception and on-demand viewer
- `!whoIs`, `!whereis`, `!whatIs`, `!whatChanged`, `!describe` — asks the world questions
- **Tablist fallback** — when entities don't render at all, she finds them via the tab list
  rather than concluding the world is empty

### 💬 Social
- `!tpa` / `!tpaccept` / `!tpdeny` — teleport requests, with the owner consented
- `!comeHere`, `!teleportMe` — pulls you to her
- `!trade` — offers items

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
2. **Double-click `setup.bat`** — installs everything and patches the 26.3 protocol stack.
3. Copy `keys.example.json` → `keys.json`, paste your API key.
4. Open `uwu.json`, set `"beloved"` to your Minecraft name (and `"auth_password"` if your
   server uses an auth plugin like EasyAuth).
5. **Double-click `start.bat`** — that's it. She spawns and says hi. 💕

### 🐧 Linux / macOS
```bash
# 1. one-time: install bun + python3 (your package manager, e.g.)
#    curl -fsSL https://bun.sh/install | bash

./setup.sh          # 2. install + patch 26.3 stack
cp keys.example.json keys.json   # 3. paste your API key
# 4. edit uwu.json -> "beloved" (your name), optional "auth_password"
./start.sh          # 5. run
```

> 🐧 **Running her as a service (Linux)?** Use `./standalone.js` — it's a single-process
> launcher with no mindserver on `:8080`, which is what the systemd unit expects. `tools/boot.sh`
> waits for the Minecraft port before starting her, so a server restart doesn't burn her
> restart budget while the game server is still booting.

---

## 🔧 The fiddly part (already handled for you)

Minecraft **26.3** isn't in the official `minecraft-data` library yet. This fork pins
Mineflayer to the **Complexity-ML** fork (`mineflayer-26.2` — the fork's name lags the version)
and ships every missing piece:

- `assets/minecraft-data-26.3/` — the full 26.3 game data (blocks/items/entities/…)
- `assets/minecraft-data-26.2/` — the 26.2 data, kept because the fixer registers both
- `patches/` — patch-package patches for mineflayer, pathfinder, PvP, viewer, protodef
- `fix-protocol.py` — idempotent fixer for fork bugs and vanilla gaps:
  - **write-shape drift** — mineflayer writes the old `use_entity` schema
  - **packet-ID drift** — the fork's serverbound table is off-by-one
  - **elytra `shared_flags`** — key-0 fallback the vanilla client still sends
  - **container-open flush** — so `!activateBlock` recipes survive reach validation
  - **collectblock auto-deposit** — so a full inventory discovers a nearby chest instead of
    erroring `NoChests`
  - **26.3 nested-entity-position** — otherwise every mob is invisible
  - **`update_light`** — 26.3 BigInt mask / array-light normalisation

  It copies the data, registers `26.2` and `26.3`, and patches the protocol on every
  `npm install`. Safe to re-run any number of times.

> ℹ️ **Formerly `fix-26.2-protocol.py`.** Renamed, because the name had been wrong for a long
> time — it has patched 26.3 throughout, while still registering 26.2 on the way through. The
> pin itself (`mineflayer-26.2`) keeps its name: that's the fork's, not the game version.

`setup.sh` / `setup.bat` run all of this so you never touch it yourself. `node tools/check-26-3-support.mjs`
is the gate that proves the protocol stack is actually intact after any install — run it first
if she can't see mobs or dig anything.

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

> 🔑 `keys.json` is gitignored — never commit it. (`keys.example.json` is the safe template.)

---

## 🎛️ Supported model APIs

Set the matching key in `keys.json`. The backend is chosen by the `model` field in `uwu.json`.

| API | Config variable | Docs |
|-----|-----------------|------|
| `openai` | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) |
| `google` (Gemini) | `GEMINI_API_KEY` | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) |
| `anthropic` | `ANTHROPIC_API_KEY` | [docs](https://docs.anthropic.com/claude/docs/models-overview) |
| `xai` | `XAI_API_KEY` | [docs](https://docs.x.ai/docs) |
| `deepseek` | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) |
| `mistral` | `MISTRAL_API_KEY` | [docs](https://docs.mistral.ai/getting-started/models/) |
| `replicate` | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| `groq` *(not grok)* | `GROQCLOUD_API_KEY` | [docs](https://console.groq.com/docs/models) |
| `huggingface` | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| `novita` | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api) |
| `openrouter` | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) |
| `hyperbolic` | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| `cerebras` | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) |
| `mercury` | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |
| `qwen` | `QWEN_API_KEY` | [Intl.](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api)/[cn](https://help.aliyun.com/zh/model-studio/getting-started/models) |
| `andy` | `ANDY_API_KEY` | (our finetuned models) |

**Local / self-hosted** — no API key needed:

| API | Notes |
|-----|-------|
| `ollama` | [docs](https://ollama.com/library) — also how you run our finetuned models |
| `vllm` | self-hosted |
| `lmstudio` | local LM Studio server |
| `azure` | Azure OpenAI |

---

## 📁 Layout

```
uwu.json                  ← UwU's personality (edit me)
settings.js               ← server + behaviour
main.js                   ← entry point (run by start.sh / start.bat)
standalone.js             ← single-process launcher (no mindserver on :8080; systemd-friendly)
setup.sh / setup.bat      ← one-time install + 26.3 patch
start.sh / start.bat      ← run the bot
tools/boot.sh             ← systemd wrapper: waits for the MC port, then starts standalone.js
systemd/                  ← unit drop-ins (restart window, etc.)
src/                      ← the mindcraft fork code
assets/minecraft-data-26.3/ ← 26.3 game data (auto-copied on setup)
patches/                  ← patch-package fixes
fix-protocol.py           ← the idempotent protocol fixer (handles 26.2 + 26.3)
tests/                    ← the suite `bun run test` runs (321 assertions)
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