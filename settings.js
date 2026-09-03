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
    "self_prompt_requires_players": true, // idle instead of self-prompting when no players online (saves API $ + RAM)
    "init_message": "You have just awakened in this world. Introduce yourself in character as the devoted yandere you are, and declare your love for your beloved.", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en",
    "render_bot_view": false,

    "allow_insecure_coding": true,
    "allow_vision": false,
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel",
        // Chunk-loading teleport commands: on this low-RAM box each search/collect
        // teleports UwU to new coords, loading chunks into the JVM heap + node until
        // earlyoom SIGTERMs the MC server. She gathers plenty by walking. If she
        // needs to find something rare, walk-search, don't /tp-search.
        "!searchForBlock", "!collectBlocks", "!searchForEntity"],
    "code_timeout_mins": -1,
    "relevant_docs_count": 5,

    "max_messages": 15,
    "num_examples": 2,
    "max_commands": -1,
    "show_command_syntax": false,
    "narrate_behavior": false,
    "chat_bot_messages": true,

    "spawn_timeout": 90,
    "block_place_delay": 0,

    "log_all_prompts": false,
};

export default settings;
