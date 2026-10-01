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

import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
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

// Known-dead keys, with the commit that superseded each. Annotated in
// settings.js; listed here so they are not rediscovered as new warnings.
const KNOWN_DEAD = {
    self_prompt_requires_players: 'superseded by two-gear autonomy (89e384c)',
};

console.log(`\nsettings.js — ${declared.length} keys\n`);
const unread = declared.filter((k) => !used.has(k) && !BOOT_READ.has(k));
for (const k of unread) {
    console.log(`  DEAD   ${k}${KNOWN_DEAD[k] ? ` (known: ${KNOWN_DEAD[k]})` : ''}`);
}
if (!unread.length) console.log('  (none)');
const unknown = unread.filter((k) => !KNOWN_DEAD[k]);
if (unknown.length) warn(`${unknown.length} unread key(s) do nothing: ${unknown.join(', ')}`);

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
    'reflection_max_memories', 'learned_skills_max',
    'goal_check_cycles', 'goal_stuck_limit', 'self_prompt_no_command_strikes',
    'num_examples', 'max_commands', 'spawn_timeout', 'block_place_delay',
];
// Nested objects get their own shape check below; they are not scalars.
const OBJECT_KEYS = new Set(['mode_cooldowns', 'modes', 'only_chat_with', 'blocked_actions', 'profiles']);
console.log('\ntype checks:');
for (const k of BOOLEAN_KEYS) {
    if (OBJECT_KEYS.has(k)) continue;
    if (k in settings && typeof settings[k] !== 'boolean') {
        err(`${k} should be a boolean, got ${JSON.stringify(settings[k])} (a non-empty string is truthy in JS)`);
    }
}
for (const k of NUMBER_KEYS) {
    if (OBJECT_KEYS.has(k)) continue;
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
// mode_cooldowns: every value must be a non-negative integer number of ms.
// A string here is the classic footgun: "60000" * 1 works once and then every
// comparison silently misbehaves.
const COOLDOWNS = ['seek_company', 'sleep_together', 'sleep_alone'];
if (!('mode_cooldowns' in settings)) err('mode_cooldowns block is missing');
else if (typeof settings.mode_cooldowns !== 'object' || settings.mode_cooldowns === null) {
    err('mode_cooldowns must be an object', `got ${typeof settings.mode_cooldowns}`);
} else {
    for (const k of COOLDOWNS) {
        const v = settings.mode_cooldowns[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            err(`mode_cooldowns.${k} must be a number of ms, got ${JSON.stringify(v)}`);
        } else if (v < 0) {
            err(`mode_cooldowns.${k} must be >= 0, got ${v}`);
        }
    }
    for (const k of Object.keys(settings.mode_cooldowns)) {
        if (!COOLDOWNS.includes(k)) {
            warn(`mode_cooldowns.${k} is not a known cooldown (${COOLDOWNS.join(', ')}) - it will do nothing`);
        }
    }
}

if (settings.goal_stuck_limit < 1) err('goal_stuck_limit must be >= 1');
if (settings.self_prompt_no_command_strikes < 1) err('self_prompt_no_command_strikes must be >= 1');
if (settings.reflection_max_memories < 1) err('reflection_max_memories must be >= 1');
if (settings.learned_skills_max < 1) err('learned_skills_max must be >= 1');
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

// --- 5b. every valid personality must have a usable script -----------------
// A third persona name added to PERSONALITIES but with no personas/<name>.json
// would validate fine here, then fail at RUNTIME: personaPrompt() logs a
// warning and falls back to the yandere profile + overlay, so the bot would
// quietly perform as yandere on a server configured for something else. Catch
// it here, at boot, instead of mid-conversation.
console.log('\npersona scripts:');
const { personaPrompt } = await import('../src/utils/server_context.js');
for (const name of PERSONALITIES) {
    if (name === 'yandere') {
        // Intentionally empty: yandere IS the base profile, so the profile
        // prompt is used verbatim. Nothing to validate.
        console.log('  ok     yandere (base profile, uses profile prompt verbatim)');
        continue;
    }
    const fp = path.join(ROOT, 'personas', `${name}.json`);
    if (!existsSync(fp)) {
        err(`personality "${name}" is valid but personas/${name}.json does not exist`,
            'She would fall back to the yandere profile at runtime and quietly');
        console.log('    perform as yandere. Create the file, or remove the name from PERSONALITIES.');
        continue;
    }
    let data = null;
    try {
        data = JSON.parse(readFileSync(fp, 'utf8'));
    } catch (e) {
        err(`personas/${name}.json is not valid JSON: ${e.message}`);
        continue;
    }
    if (typeof data.conversing !== 'string' || data.conversing.length < 500) {
        err(`personas/${name}.json has no usable "conversing" script`,
            `   found: ${typeof data.conversing}, length ${(data.conversing || '').length}`);
        continue;
    }
    // And prove the loader actually resolves it, not just that the file parses.
    setSettings({ ...rootSettings, personality: name });
    const resolvedScript = personaPrompt();
    if (!resolvedScript) {
        err(`persona "${name}" is configured but personaPrompt() returned nothing`);
    } else {
        console.log(`  ok     ${name} -> personas/${name}.json (${resolvedScript.length} chars)`);
    }
}
setSettings(rootSettings);

// --- 5c. no module may read settings at IMPORT time ------------------------
// src/agent/settings.js starts as {} and is filled by setSettings() at boot
// (standalone.js). Anything that reads a config key at module top level runs
// BEFORE that, sees undefined, and crashes the bot on startup. I hit this
// exactly: mode cooldowns read as
//   cooldown: settings.mode_cooldowns.sleep_together
// inside the module-level `modes_list` const, which threw
//   TypeError: undefined is not an object
// and crash-looped her. Caught by booting her, NOT by any config test - so
// check the source shape here.
// Enumerate every source module we can safely import in isolation.
const SRC = path.join(ROOT, 'src');
function* walkFiles(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === 'library') continue;
            yield* walkFiles(fp);
            continue;
        }
        if (!e.name.endsWith('.js')) continue;
        // Entry points and browser/server code are not importable standalone.
        if (/^(standalone|init-mindcraft|index)\.js$/.test(e.name)) continue;
        yield fp;
    }
}

// A config read is only dangerous at IMPORT time, when the settings object is
// still {} because setSettings() has not run. The symptom is a boot
// crash-loop, and no config test catches it because a config test has already
// injected the real config.
//
// Four detection approaches were tried here; three were wrong. Recorded so the
// work is not repeated:
//   1. Indentation - misses the real case (below), which is indented.
//   2. Brace-depth counting - `export class Agent {` closes only at EOF, so
//      every read inside a method looks top-level. False positives everywhere.
//   3. Importing each module - importing executes it; init_agent.js prints a
//      usage banner and calls process.exit, killing the check.
//   4. Locating function bodies to exclude - same string-escaping flaw; a
//      `'\n'` literal left a stray brace, so one 4-line function's "body"
//      swallowed the whole file and the check silently went blind.
//
// The lesson: parsing JS with string regexes is the bug, not the fix. So check
// the specific shape that actually broke instead of trying to prove a general
// property.
//
// The real bug was a config read in a mode object's PROPERTY position:
//
//     const modes_list = [ { name: 'sleep_together',
//                            cooldown: settings.mode_cooldowns.x } ]
//
// modes_list is a module-level const, so that property is evaluated at import.
// A read inside the same object's update() method is safe and must be allowed,
// because a function body does not run at import.
//
// So the check is: no `settings.` in a property position inside modes_list.
// That is a per-line property test, not a parse, and it cannot be confused by
// strings or brace nesting.
console.log('import-time settings reads:');
const NL = String.fromCharCode(10);
let eager = 0;
const modesPath = path.join(ROOT, 'src/agent/modes.js');
const modesSrc = String(readFileSync(modesPath, 'utf8'));
const anchor = modesSrc.indexOf('const modes_list = [');
if (anchor === -1) {
    err('modes.js no longer contains `const modes_list = [`',
        '   This import-time check is anchored to it; update the check to match.');
    eager++;
} else {
    const lines = modesSrc.slice(anchor).split(NL);
    const end = lines.findIndex((l) => l === '];');
    const body = end === -1 ? lines : lines.slice(0, end);
    // Property position: `key: settings....` — a value assigned straight from
    // config when the object literal is built.
    const PROP = /^\s*[a-z_][a-zA-Z0-9_]*\s*:\s*(?:[^,]*?\b)?settings\./;
    let hits = 0;
    for (const [i, line] of body.entries()) {
        if (!PROP.test(line)) continue;
        err(`src/agent/modes.js:${i + 1} sets a mode property from config at import time`,
            `   ${line.trim().slice(0, 90)}`);
        eager++; hits++;
    }
    if (!hits) {
        console.log(`  ok     modes_list (${body.length} lines, import time) sets no property from config`);
    }
}

// Top-level `settings.x = ...` in a non-init module writes into the empty
// settings object at import and is then overwritten by setSettings().
for (const f of walkFiles(SRC)) {
    for (const [i, line] of String(readFileSync(f, 'utf8')).split(NL).entries()) {
        if (line !== line.trimStart()) continue;
        const bare = line.trimStart();
        if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*')) continue;
        if (!/^settings\.[a-z_]+\s*=/.test(bare)) continue;
        if (path.basename(f).startsWith('init-')) continue;
        err(`${path.relative(ROOT, f)}:${i + 1} assigns to settings at import time`,
            `   ${bare.slice(0, 90)}`);
        eager++;
    }
}
if (!eager) console.log('  ok     no module reads or writes config before setSettings() runs');

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