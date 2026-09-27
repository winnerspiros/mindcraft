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
    personality: 'yandere',
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

export function serverContext() {
    if (_ctx) return _ctx;
    let file = null;
    try { file = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'servers.json'), 'utf8')); }
    catch (_) { file = null; }
    const want = process.env.UWU_SERVER || (file && file.active) || 'home';
    const entry = (file && file.servers && file.servers[want]) || {};
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

export function personality() {
    try { return serverContext().personality || 'yandere'; } catch (_) { return 'yandere'; }
}

// Prompt overlay appended after profile.conversing. Yandere = base prompt
// already, nothing to add. Normal = the "if you are a real player" easter-egg
// drop: she stops performing UwU and talks like Elena herself — same girl,
// same warmth and humor, no yandere bit, no beloved, no jealous violence,
// no console punishment. A real attack still gets a real (melee-only) answer.
// It reads like a persona handoff because it IS: base prompt builds UwU,
// this section drops the act — exactly the easter-egg mechanism.
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
    `- Powers (!givePlayer gifts, !summon treats, teleports) stay trust-gated like always, just without the yandere framing.\n`;
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
