// Validates settings.js. Run: node tools/check-config.mjs  (exit 0 ok, 1 bad)
//
// Purpose: a typo in a config key is silent. `personaltiy: true` or
// `reflection_memroy: false` just reads as undefined and the feature keeps its
// hardcoded default, so you think you turned something off and it is still on.
// This checks every declared key is one the code actually reads, every value is
// the right type, and enums only contain known-good values.
//
// Deliberately does NOT validate servers.json's full schema: that file is
// per-server and optional, and the bot already fails soft on it.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const rootSettings = (await import('../settings.js')).default;
// src/utils/server_context.js reads src/agent/settings.js, which starts EMPTY
// and is filled by setSettings() at boot (standalone.js line ~45). Without this
// injection personality() sees settings.personality === undefined and reports
// a bogus "invalid value" warning. Mirror what the bot does.
const { setSettings } = await import('../src/agent/settings.js');
setSettings(rootSettings);
const settings = (await import('../src/agent/settings.js')).default;
let errors = 0;
let warnings = 0;

const err = (m) => { console.error(`  ERROR  ${m}`); errors++; };
const warn = (m) => { console.warn(`  WARN   ${m}`); warnings++; };

// --- 1. every declared key must actually be read by the code ---------------
const declared = Object.keys(settings);
const grep = execSync(
    `grep -rhoE 'settings\\.[a-z_]+' --include=*.js src/ || true`,
    { encoding: 'utf8' }
);
const used = new Set(grep.split(/\s+/).filter(Boolean).map((k) => k.replace('settings.', '')));

// Read by standalone.js/main.js at boot (not via `settings.` prefix).
const BOOT_READ = new Set([
    'profiles', 'port', 'host', 'auth', 'minecraft_version', 'load_memory',
    'init_message', 'mindserver_port', 'auto_open_ui', 'profile',
]);

console.log(`\nsettings.js — ${declared.length} keys\n`);
console.log('unread keys (declared but never read):');
let unread = 0;
for (const k of declared) {
    if (used.has(k) || BOOT_READ.has(k)) continue;
    console.log(`  DEAD   ${k}`);
    unread++;
}
if (!unread) console.log('  (none)');
else if (unread === 1 && declared.includes('self_prompt_requires_players')) {
    // Known: replaced by two-gear autonomy (89e384c). Annotated in settings.js.
    console.log('  DEAD   self_prompt_requires_players (known; superseded by two-gear autonomy)');
} else {
    warn(`${unread} key(s) do nothing — remove them or wire them up`);
}

// --- 2. types must match ----------------------------------------------------
// Anything explicitly listed as boolean must actually be boolean. A string
// "false" is truthy in JS, so `"reflection_memory": "false"` would ENABLE it.
const BOOLEAN_KEYS = [
    'load_memory', 'observe_players', 'self_prompt_requires_players', 'speak',
    'chat_ingame', 'render_bot_view', 'allow_insecure_coding', 'allow_vision',
    'reflection_memory', 'curriculum_enabled', 'critic_enabled',
    'learned_skills_enabled', 'turn_taking_enabled', 'narrate_behavior',
    'chat_bot_messages', 'log_all_prompts',
    'nsfw',
];
const NUMBER_KEYS = [
    'port', 'mindserver_port', 'code_timeout_mins', 'relevant_docs_count',
    'max_messages', 'reflection_interval', 'reflection_recall_count',
    'goal_check_cycles', 'goal_stuck_limit', 'num_examples', 'max_commands',
    'spawn_timeout', 'block_place_delay',
];
console.log('\ntype checks:');
for (const k of BOOLEAN_KEYS) {
    if (k in settings && typeof settings[k] !== 'boolean') {
        err(`${k} should be a boolean, got ${JSON.stringify(settings[k])} (a non-empty string is truthy in JS)`);
    }
}
for (const k of NUMBER_KEYS) {
    if (k in settings && typeof settings[k] !== 'number') {
        err(`${k} should be a number, got ${JSON.stringify(settings[k])}`);
    }
}

// --- 3. enums must be valid -------------------------------------------------
console.log('\nenum checks:');
const { PERSONALITIES } = await import('../src/utils/server_context.js');
if (!('personality' in settings)) err('personality key is missing entirely');
else if (!PERSONALITIES.includes(settings.personality)) {
    err(`personality must be one of ${PERSONALITIES.join(' | ')}, got ${JSON.stringify(settings.personality)}`);
} else console.log(`  ok     personality = ${settings.personality}`);

// --- 4. ranges that matter -------------------------------------------------
if (settings.goal_stuck_limit < 1) err('goal_stuck_limit must be >= 1');
if (settings.reflection_recall_count < 1) err('reflection_recall_count must be >= 1');
if (settings.goal_check_cycles < 1) err('goal_check_cycles must be >= 1');
if (settings.reflection_interval < 1) err('reflection_interval must be >= 1');

// --- 5. the personality switch must be reachable ---------------------------
console.log('\npersonality resolution:');
const { personality, personalityOverlay } = await import('../src/utils/server_context.js');
const active = personality();
console.log(`  active persona: ${active}`);
if (active === 'normal' && !personalityOverlay()) {
    err('personality is "normal" but personalityOverlay() returned nothing — normal mode would behave exactly like yandere');
} else if (active === 'yandere') {
    console.log('  overlay: none (yandere is the base prompt)');
} else {
    console.log(`  overlay: ${personalityOverlay().length} chars`);
}

// --- 6. servers.json personality, if it names one --------------------------
try {
    const servers = JSON.parse(readFileSync(path.join(ROOT, 'servers.json'), 'utf8'));
    for (const [name, s] of Object.entries(servers.servers || {})) {
        if (!('personality' in s)) continue;
        const v = s.personality;
        if (v === null) console.log(`  ${name}: personality null -> inherits settings.js`);
        else if (!PERSONALITIES.includes(v)) err(`servers.json [${name}].personality = ${JSON.stringify(v)} is not one of ${PERSONALITIES.join(' | ')}`);
        else console.log(`  ${name}: overrides with "${v}"`);
    }
} catch (e) {
    warn(`could not read servers.json: ${e.message}`);
}

console.log(`\n${errors ? 'FAILED' : 'OK'} — ${errors} error(s), ${warnings} warning(s)\n`);
process.exit(errors ? 1 : 0);