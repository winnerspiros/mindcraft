// Standalone single-process launcher for the UwU bot.
//
// Runs the Agent directly in-process — no mindserver, no express/socket.io
// supervisor, no child process. The supervisor (main.js + mindserver on :8080)
// existed only to (a) hand settings to the agent over socket.io and (b) restart
// the agent child. Here settings are injected straight via setSettings() and
// restart is delegated to systemd (Restart=always). This drops the ~20MB
// supervisor + express + socket.io server from RSS.
//
// All serverProxy socket methods are now null-safe (see mindserver_proxy.js),
// so the Agent's login()/shutdown()/sendOutputToServer() calls become no-ops
// instead of throwing.

import settings from './settings.js';
import { setSettings } from './src/agent/settings.js';
import { Agent } from './src/agent/agent.js';
import { serverProxy } from './src/agent/mindserver_proxy.js';
import { readFileSync } from 'fs';

// --- env overrides (parity with main.js) ---
if (process.env.MINECRAFT_PORT) settings.port = process.env.MINECRAFT_PORT;
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    settings.profiles = JSON.parse(process.env.PROFILES);
}
if (process.env.INSECURE_CODING) settings.allow_insecure_coding = true;
if (process.env.BLOCKED_ACTIONS) settings.blocked_actions = JSON.parse(process.env.BLOCKED_ACTIONS);
if (process.env.MAX_MESSAGES) settings.max_messages = process.env.MAX_MESSAGES;
if (process.env.NUM_EXAMPLES) settings.num_examples = process.env.NUM_EXAMPLES;
if (process.env.LOG_ALL) settings.log_all_prompts = process.env.LOG_ALL;
if (process.env.SETTINGS_JSON) {
    try {
        Object.assign(settings, JSON.parse(process.env.SETTINGS_JSON));
    } catch (err) {
        console.error('Failed to parse SETTINGS_JSON:', err);
    }
}

// --- load the profile (single-bot: settings.profiles[0]) ---
const profile_path = settings.profiles[0];
const profile_json = JSON.parse(readFileSync(profile_path, 'utf8'));
settings.profile = profile_json;

// Inject the full settings (incl. profile) into the agent's settings object.
// This is what the mindserver's `get-settings` socket handler used to do.
setSettings(settings);

const load_memory = settings.load_memory || false;
const init_message = settings.init_message || null;

const agent = new Agent();
serverProxy.setAgent(agent);

(async () => {
    try {
        await agent.start(load_memory, init_message, 0);
    } catch (error) {
        console.error('Failed to start agent:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
