const settings = {
    "minecraft_version": "26.2", // native 26.2 via Complexity-ML fork stack (mineflayer+minecraft-data+minecraft-protocol)
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25565, // your Minecraft server port
    "auth": "offline", // server has online-mode=false

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": false, // headless box, no browser

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./uwu.json",
    ],

    "load_memory": true, // persist personality + player dossiers across restarts
    "observe_players": true, // watch nearby players' activities so she can mimic/assist
    "self_prompt_requires_players": true, // idle instead of self-prompting when no players online (saves API $ + RAM)
    "init_message": "You have just awakened in this world. Introduce yourself in character as the devoted yandere you are, and declare your love for your beloved.", // sends to all on spawn
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
    "reflection_memory": true,    // RAG long-term memory (reflection -> embed -> recall)
    "reflection_interval": 15,    // conversational turns between reflections
    "reflection_recall_count": 5, // top-k memories injected per prompt
    "curriculum_enabled": true,   // automatic-curriculum: she proposes her own next goal (Voyager-style)
    "critic_enabled": true,       // self-verification critic: judges whether a goal is actually done
    "goal_check_cycles": 5,       // self-prompt turns between critic+curriculum checks (throttles API $)
    "goal_stuck_limit": 3,        // consecutive "incomplete" verdicts before she abandons + picks a new goal
    "learned_skills_enabled": true, // growing skill library: reuse proven !newAction code via embedding recall
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
