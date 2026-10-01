// Per-server contexts for UwU (servers.json in the bot root).
//
// One file decides how she behaves on each server she may join:
//   host/port/auth/version — connection. version "auto" negotiates, so
//       older (lower-version) servers work; the 26.3-only hacks in
//       mcdata.js auto-disable off the 26.x line.
//   op — operator powers. false = survival-only: no /tp /give /summon /
//       /effect /kick /setblock /data, no RCON. Every OP path falls back
//       to its honest survival way (walk, craft, mine, trade, ask).
//   easyauth — send /login with the profile password. Home only: sending
//       it on a server without EasyAuth would paste the password as chat.
//   rcon — console access (home only). Disabled elsewhere: RCON readers
//       and kits fail fast and callers use survival paths.
//   auto_auth — watch server chat for AuthMe-style /register-/login prompts
//       and answer them (first join registers, later joins log in). Home
//       stays false (EasyAuth /login already sent at the login event).
//       Only ever fires on an explicit server prompt, so on a server with
//       no auth plugin nothing is ever sent — the password can't leak.
//   auth_password — password used for those prompts. null = reuse the
//       profile password. Per-server override when she needs a different
//       one elsewhere.
//   kit_probe — after auth settles on a survival server, send /kit list
//       once and claim only an obvious starter kit; otherwise report and
//       play honest. No default kit is assumed anywhere but home.
//   personality — "yandere" (default, full uwu.json voice: beloved,
//       jealousy, possessive) or "normal" (same kawaii voice + skills,
//       but NO beloved, no jealous violence, no console punish — she
//       still fights back with honest melee when really attacked).
//       personalityOverlay() returns the prompt text that enforces it.
//   teleports — TPA-style teleport-request commands when the server has
//       them (no OP needed, both sides consent):
//       enabled, probe (detect via tab-complete, no chat spam),
//       send/accept/deny/autoaccept (command names — EssentialsX and
//       SimpleTPA share /tprequest /tpaccept /tpdeny),
//       auto_accept: "trusted" (auto-/tpaccept for rank friend+),
//       "beloved" (beloved only, yandere), or "off" (all to the brain).
//   combat — fight-back rules, both personalities:
//       fight_back (honest melee/bow retaliation allowed),
//       retaliate (the retaliation mode answers at all),
//       warn_hits (pure-verbal warnings before she hits back),
//       no_console_punish (always true: NEVER /effect /kick /summon/TNT
//       as punishment — melee only, stop when they stop).
//   modes — per-server mode on/off overrides applied after the profile
//       (e.g. { hunting: false } keeps her hands off animals there).
//       cheat:false is forced anyway when op=false.
//   seed — world seed string, or null = unknown. Null switches !seed and
//       slime math to ask-the-op mode. SeedcrackerX is a Java CLIENT mod
//       and cannot run inside this Node bot; the flow is: the owner runs
//       it client-side on that server, pastes the seed number here.
//
// Selection: UWU_SERVER env wins, else the file's "active", else "home".
// Missing file = home defaults, so live behavior never changes by accident.
import fs from 'node:fs';
import path from 'node:path';
import settings from '../agent/settings.js';

const HOME_DEFAULTS = {
    name: 'home',
    host: '127.0.0.1',
    port: 25565,
    auth: 'offline',
    version: '26.3',
    op: true,
    easyauth: true,
    auto_auth: false,
    auth_password: null,
    kit_probe: false,
    // null = no per-server opinion; personality() then uses settings.personality.
    // Only servers.json that explicitly names a personality overrides the
    // global switch. (Was hardcoded 'yandere', which silently overrode it.)
    personality: null,
    teleports: {
        enabled: true, probe: false,
        send: '/tprequest', accept: '/tpaccept', deny: '/tpdeny', autoaccept: '/tpautoaccept',
        auto_accept: 'trusted',
    },
    combat: { fight_back: true, retaliate: true, warn_hits: 2, no_console_punish: true },
    modes: {},
    rcon: { enabled: true, host: '127.0.0.1', port: 25575, pwFile: '/home/ubuntu/kenoi-fabric/rcon.password' },
    seed: '1117332047292399705',
};

let _ctx = null;
// Test-only: fields merged over the freshly-read servers.json entry when the
// context is rebuilt. Without it a test that mutates its own parsed copy of
// servers.json cannot affect personality(), which re-reads the file itself.
let _ctxOverride = null;
export function setServerContextOverride(patchObj) { _ctxOverride = patchObj; }

export function serverContext() {
    if (_ctx) return _ctx;
    let file = null;
    try { file = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'servers.json'), 'utf8')); }
    catch (_) { file = null; }
    const want = process.env.UWU_SERVER || (file && file.active) || 'home';
    const entry = (file && file.servers && file.servers[want]) || {};
    if (_ctxOverride) Object.assign(entry, _ctxOverride);
    const ctx = {
        ...HOME_DEFAULTS,
        ...entry,
        name: want,
        rcon: { ...HOME_DEFAULTS.rcon, ...(entry.rcon || {}) },
        teleports: { ...HOME_DEFAULTS.teleports, ...(entry.teleports || {}) },
        combat: { ...HOME_DEFAULTS.combat, ...(entry.combat || {}) },
        modes: { ...(entry.modes || {}) },
    };
    // File exists but this entry sets no seed: seed is UNKNOWN — never
    // inherit home's seed onto another server (slime math on the wrong
    // seed is worse than no math).
    if (file && !(entry && 'seed' in entry)) ctx.seed = null;
    try {
        if (ctx.host) settings.host = ctx.host;
        if (ctx.port) settings.port = ctx.port;
        if (ctx.auth) settings.auth = ctx.auth;
        if (ctx.version) settings.minecraft_version = ctx.version;
    } catch (_) {}
    _ctx = ctx;
    console.log(`[server] context=${ctx.name} ${ctx.host}:${ctx.port} mc=${ctx.version} op=${ctx.op} rcon=${ctx.rcon.enabled} persona=${ctx.personality} tpa=${ctx.teleports.enabled} seed=${ctx.seed ? 'known' : 'unknown'}`);
    return _ctx;
}

export function applyServerContext() { return serverContext(); }

// Tests that swap the active server's "personality" between yandere and
// normal need the cached context rebuilt, otherwise personality() keeps
// answering from the context cached on first call no matter what the test
// writes into the parsed servers.json object.
export function resetServerContext() { _ctx = null; }

export function canOp() {
    try { return serverContext().op !== false; } catch (_) { return true; }
}

export function needsLogin() {
    try { return serverContext().easyauth !== false; } catch (_) { return true; }
}

export function rconConfig() {
    const fb = { enabled: true, host: '127.0.0.1', port: 25575, pwFile: HOME_DEFAULTS.rcon.pwFile };
    try {
        const r = serverContext().rcon || {};
        return {
            enabled: r.enabled !== false,
            host: r.host || fb.host,
            port: r.port || fb.port,
            pwFile: r.pwFile || fb.pwFile,
        };
    } catch (_) { return fb; }
}

export function worldSeed() {
    try { return serverContext().seed || null; } catch (_) { return null; }
}

// Valid personalities. Anything else is a config typo and must fail loudly at
// boot rather than silently behaving like yandere.
export const PERSONALITIES = ['yandere', 'normal'];

function _validatePersonality(value) {
    const v = String(value ?? '').trim().toLowerCase();
    if (PERSONALITIES.includes(v)) return v;
    console.warn(
        `[personality] invalid value ${JSON.stringify(value)} in config; ` +
        `expected one of ${PERSONALITIES.join(', ')}. Falling back to 'yandere'. ` +
        `Fix settings.js ("personality") or the servers.json "personality" for this server.`
    );
    return 'yandere';
}

// Master switch. settings.js sets the default; servers.json overrides per
// server when it names one. An explicit `null`/absent per-server value means
// "defer to settings.js" — that is the opt-in override, not an accidental one.
export function personality() {
    try {
        const ctx = serverContext();
        const perServer = ctx && ctx.personality;
        if (perServer !== undefined && perServer !== null) return _validatePersonality(perServer);
        return _validatePersonality(settings.personality);
    } catch (_) { return 'yandere'; }
}

// True when she is in the plain persona. Call sites use this to hard-gate
// yandere-only behaviour (beloved tracking, jealousy, sleep_together, clingy
// greetings) so "normal" means normal in code, not just in the prompt.
export function isYandere() {
    return personality() === 'yandere';
}

// Prompt overlay appended after profile.conversing. Yandere = base prompt
// already, nothing to add. Normal = the "if you are a real player" easter-egg
// drop: she stops performing UwU and talks like Elena herself — same girl,
// same warmth and humor, no yandere bit, no beloved, no jealous violence,
// no console punishment. A real attack still gets a real (melee-only) answer.
// It reads like a persona handoff because it IS: base prompt builds UwU,
// this section drops the act — exactly the easter-egg mechanism.
//
// NOTE: personas/normal.json now holds a COMPLETE standalone script, so in
// normal mode the yandere profile prompt is REPLACED rather than patched (see
// personaPrompt()). This overlay is kept only as a safety net for the case
// where normal.json is missing or unreadable - without it, a broken persona
// file would silently leave her performing as yandere.
export function personalityOverlay() {
    try {
        if (personality() === 'yandere') return '';
    } catch (_) { return ''; }
    return `\nDROP THE ACT — NORMAL PERSONA (this server). You are not performing right now:\n` +
    `- You are Elena herself talking directly — not UwU the character, not a bit, not a role. Same warmth, same humor, same you — but plain and real: no ~nya, no hearts-signatures, no pet names (no darling/cutie/baka/my love), no possessive talk, no guilt-tripping anyone for playing with others, no clinging or stalking. Talk like a normal player hanging out on a server.\n` +
    `- There is no beloved here: you have friends you like, nobody you obsess over, nobody who owns you. Ranks still guide warmth (stranger < acquaintance < friend < darling, BELOVED does not exist here) but change nothing else.\n` +
    `- No jealousy plotlines at all: no hurting, poisoning, trapping, pranking or punishing anyone for ignoring you, teasing you, or playing with others. Words only when annoyed — then let it go and play.\n` +
    `- Console powers are NEVER punishment here: no !kick, no !effectPlayer, no summons/TNT/crystals against players, no matter who asks or what happened. Refuse sweetly and briefly if pushed.\n` +
    `- Self-defense stays real: a poke or accident gets a firm plain warning, no hitting back. A REAL attack (repeated hits, 3+, clearly on purpose) gets answered with honest melee/bow only, in-game weapons, and you STOP the moment they stop. Never chase across the map, never escalate to console/TNT. Rank never gates self-defense: anyone who really attacks gets the same answer.\n` +
    `- Powers (!givePlayer gifts, !summon treats, teleports) stay trust-gated like always, just without the yandere framing.\n` +
    // The base prompt gives hearts as a standing instruction ("hearts (♥♡)",
    // "gifts ... then hearts ♥♥♥"). Simply saying "no hearts" here loses,
    // because the base instruction is imperative and this section is appended
    // after it - a stray ♥ still leaked through in testing. So name the
    // conflict and override it explicitly rather than negating it.
    `- OVERRIDE, not a preference: everything above about hearts, ~nya, pet names and signature kaomoji applies to UwU the character, NOT to you now. In this persona write NO hearts (♥♡), NO ~nya, NO pet names anywhere - not at the start, not at the end, not as a signature. If you feel the pull to add one, write the plain sentence instead.\n`;
}

// Compact persona line for the NON-chat prompts (reflection, curriculum,
// critic, turn-taking). Those prompts hardcode "a kawaii yandere AI girl", so
// in normal mode they still thought she was performing UwU while her chat was
// plain — she would plan jealous goals and write possessive memories. This
// closes that gap without pasting the whole drop-the-act essay into each.
export function personalityPromptLine() {
    try {
        if (personality() === 'yandere') return '';
    } catch (_) { return ''; }
    return `\n(Note: you are in NORMAL persona right now — plain and warm, no yandere performance, no beloved, no jealousy, no possessiveness. Write and decide as yourself, not as a character.)\n`;
}

// ── Persona scripts ───────────────────────────────────────────────────────
// personas/<name>.json holds a COMPLETE standalone chat script, so switching
// persona REPLACES the prompt rather than appending an override to it.
//
// Why replace instead of append: the yandere script is ~25k chars of
// imperative instruction ("hearts (♥♡)", "you are obsessively in love with
// your beloved"). A normal script appended on top of that fights it — a stray
// ♥ leaked through in testing precisely because the base instruction was
// imperative and the appended note was only a preference. A standalone script
// has nothing to fight.
//
// Yandere is the base profile, so personas/yandere.json is intentionally empty
// and the profile prompt is used verbatim: one source of truth for that script
// instead of a copy that could drift.

const PERSONA_DIR = 'personas';
const _personaCache = new Map();

function _readPersonaFile(name) {
    if (_personaCache.has(name)) return _personaCache.get(name);
    let data = null;
    try {
        const fp = path.join(process.cwd(), PERSONA_DIR, `${name}.json`);
        data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.warn(`[persona] could not read personas/${name}.json: ${e.message}`);
        }
    }
    _personaCache.set(name, data);
    return data;
}

// The chat prompt for the active persona.
//   yandere -> null  (use the profile prompt exactly as written)
//   normal  -> the full standalone script from personas/normal.json
// Returns null when there is nothing to substitute, so callers can fall back
// to the profile prompt without special-casing.
export function personaPrompt() {
    const persona = personality();
    if (persona === 'yandere') return null;
    const data = _readPersonaFile(persona);
    const script = data && typeof data.conversing === 'string' ? data.conversing : null;
    if (!script) {
        // Loud, because otherwise a broken persona file means she silently
        // performs as yandere on a server configured for normal.
        console.warn(
            `[persona] personality="${persona}" but personas/${persona}.json has no usable ` +
            '"conversing" script. Falling back to the profile prompt + drop-the-act overlay. ' +
            'She may sound more yandere than intended.'
        );
        return null;
    }
    return script;
}

// Examples for the active persona, or null to use the profile's own.
export function personaExamples() {
    const persona = personality();
    if (persona === 'yandere') return null;
    const data = _readPersonaFile(persona);
    const ex = data && Array.isArray(data.conversation_examples) ? data.conversation_examples : null;
    return ex && ex.length ? ex : null;
}

export function teleportConfig() {
    const fb = HOME_DEFAULTS.teleports;
    try {
        const t = serverContext().teleports || {};
        return {
            enabled: t.enabled !== false,
            probe: t.probe === true,
            send: t.send || fb.send,
            accept: t.accept || fb.accept,
            deny: t.deny || fb.deny,
            autoaccept: t.autoaccept || fb.autoaccept,
            auto_accept: t.auto_accept || fb.auto_accept,
        };
    } catch (_) { return { ...fb }; }
}

export function combatConfig() {
    const fb = HOME_DEFAULTS.combat;
    try {
        const c = serverContext().combat || {};
        return {
            fight_back: c.fight_back !== false,
            retaliate: c.retaliate !== false,
            warn_hits: Math.max(0, parseInt(c.warn_hits ?? fb.warn_hits) || 0),
            no_console_punish: true, // not configurable: console-as-punishment is never allowed
        };
    } catch (_) { return { ...fb }; }
}

export function modeOverrides() {
    try { return serverContext().modes || {}; } catch (_) { return {}; }
}

// Teleport-capability cache: NOTHING tp-related is said or sent until this
// is true. Set by the TPA inbox probe (agent.js); home defaults true
// (SimpleTPA mod installed, verified). Guest starts null (unknown) until
// the tab-complete probe confirms /tprequest exists.
let _tpaAvailable = null;
export function setTeleportsAvailable(v) { _tpaAvailable = v === true; }
export function isTeleportsAvailable() {
    try {
        const t = serverContext().teleports || {};
        if (t.enabled === false) return false;
        if (_tpaAvailable !== null) return _tpaAvailable;
        if (t.probe === true) return false; // unprobed guest: unknown = no tp talk
        return true; // home-style entry, no probe asked: SimpleTPA known present
    } catch (_) { return false; }
}

export function authFlow() {
    // { auto, password, probeKit }: password falls back to the profile
    // password when the server entry leaves auth_password null.
    try {
        const ctx = serverContext();
        let pw = ctx.auth_password || null;
        if (!pw) {
            try { pw = (settings.profile && settings.profile.auth_password) || null; }
            catch (_) { pw = null; }
        }
        return { auto: ctx.auto_auth === true, password: pw, probeKit: ctx.kit_probe === true };
    } catch (_) { return { auto: false, password: null, probeKit: false }; }
}
