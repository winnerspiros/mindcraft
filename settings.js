const settings = {
    "minecraft_version": "26.3", // native 26.3 via Complexity-ML fork stack + generated 26.3 data + fix-26.3-protocol.py
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25565, // your Minecraft server port
    "auth": "offline", // server has online-mode=false

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": false, // headless box, no browser

    // ── Moderation (she flags, she decides) ────────────────────────────────
    // The watcher only FLAGS suspicious movement as data for her to judge; it
    // never acts on its own. So these change how much she notices, never what
    // she is allowed to do.
    "moderation_cooldown_ms": 30000,   // ms between flags for the same player
    "moderation_speed_limit": 25,      // blocks/sec that counts as suspicious
                                        // (no legitimate movement is near this)

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    // Which profile JSON to load. She runs the FIRST entry. Point this at a
    // different file to swap her whole script, model, modes and commands —
    // e.g. ["./uwu.json", "./uwu-normal.json"] while you compare. Every path
    // is checked at boot by tools/check-config.mjs.
    // (standalone.js lets a PROFILES env var override this; the service does
    // not set one, so this list is what actually runs.)
    "profiles": [
        "./uwu.json",
    ],

    // ── Personality ───────────────────────────────────────────────────────
    // Who she is. This is the master switch; servers.json may override it per
    // server ("personality": "yandere" | "normal"), which wins over this value.
    //
    //   "yandere" - full uwu.json voice: a beloved she is obsessed with,
    //               jealousy, possessiveness, cruel/dangerous edges, kawaii
    //               hearts and ~nya everywhere.
    //   "normal"  - same girl, same warmth and humor, no performance: no
    //               beloved, no jealousy, no possessiveness, no over-emoting.
    //               Still uses every in-game skill. Self-defense stays real.
    //
    // Any other value is rejected at boot (see tools/check-config.mjs) rather
    // than silently falling back to yandere.
    "personality": "normal",

    // NOTE: changes to this file take effect on restart. Most switches are read
    // once when a subsystem is constructed (see agent.js isBelovedName,
    // reflective_memory.js enabled), so editing this file while she runs does
    // nothing. Personality is the exception: personality() resolves on every
    // call, so `personality` DOES apply live. Everything else = restart her:
    //   sudo systemctl restart uwu-bot.service

    "load_memory": true, // persist personality + player dossiers across restarts
    "observe_players": true, // watch nearby players' activities so she can mimic/assist
    // DEAD KEY - kept so an old config does not "lose" it, but nothing reads it.
    // Idle-when-alone behaviour is the two-gear autonomy in self_prompter.js
    // (chatty 45s with players, quiet 150s solo), added in 89e384c.
    "self_prompt_requires_players": true,
    "init_message": "You have just awakened in this world. Introduce yourself in character, casually, the way you would in a group chat.", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en",
    "render_bot_view": false,

    "allow_insecure_coding": true,
    "allow_vision": false,
    "blocked_actions" : [],
    "code_timeout_mins": 3,
    "relevant_docs_count": 5,

    "max_messages": 15,

    // ── Memory & learning ────────────────────────────────────────────��────
    "reflection_memory": true,       // RAG long-term memory (reflection -> embed -> recall)
    "reflection_interval": 15,       // conversational turns between reflections
    "reflection_recall_count": 5,    // top-k memories injected per prompt
    "reflection_max_memories": 200,  // cap on stored memories; oldest are dropped first.
                                      // Lower = fresher but forgets more. Her real store
                                      // currently holds 192, so raising this above ~200
                                      // does nothing until the cap is lifted.
    "learned_skills_enabled": true,  // growing skill library: reuse proven !newAction code via embedding recall
    "learned_skills_max": 100,       // cap on learned skills; oldest dropped first

    // ── Autonomy: how she decides what to do ───────────────────────────────
    "curriculum_enabled": true,   // automatic-curriculum: she proposes her own next goal (Voyager-style)
    "critic_enabled": true,       // self-verification critic: judges whether a goal is actually done
    "goal_check_cycles": 3,       // self-prompt turns between critic+curriculum checks (was 5: with chatty 45s + solo 150s gears a check landed every ~10min, so one stuck goal ate the whole session; 3 rotates faster)
    "goal_stuck_limit": 3,        // consecutive "incomplete" verdicts before she abandons + picks a new goal
    "self_prompt_no_command_strikes": 3, // self-prompt turns with no command before she gives up on
                                      // the current goal and re-plans. Lower = she rethinks
                                      // sooner; higher = she pushes a goal longer before moving on.
    "turn_taking_enabled": true,  // DuplexGen-style: she may pick silence/backchannel over replying to every line

    // ── Mode cooldowns (ms) ────────────────────────────────────────────────
    // How often she may repeat a social/ambient behaviour. Lower = more often.
    "mode_cooldowns": {
        "seek_company":  120000,  // 2 min between going to find someone
        "sleep_together": 180000, // 3 min between following someone to bed
        "sleep_alone":     60000, // 1 min between settling down to sleep
    },
    "num_examples": 2,
    "max_commands": -1,
    "show_command_syntax": false,
    "narrate_behavior": false,
    "chat_bot_messages": true,

    "spawn_timeout": 180,
    "block_place_delay": 0,

    "log_all_prompts": false,
};

export default settings;
