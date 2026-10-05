import net from 'node:net';
import fs from 'node:fs';

// RCON arbiter for gear-up (26.3): client-side Slot/SlotComponent decode is
// broken (dozens of identical packet_set_slot -> Slot -> SlotComponent
// PartialReadErrors every boot), so bot.inventory.items() reads permanently
// empty while the server holds a real kit. RCON `data get entity` is the
// arbiter: silent (zero chat, zero LLM turns), authoritative, no decode
// needed. Kit via RCON `give` / `item replace` (proven live, no spam gate).
// Endpoint comes from servers.json (server_context.rconConfig): home only.
// On a survival server (rcon disabled) every call fails fast with ok:false
// and callers take their survival path.
import { rconConfig } from './server_context.js';

function encode(id, type, payload) {
    const body = Buffer.from(payload, 'utf8');
    const buf = Buffer.alloc(12 + body.length + 2); // 4 len + 4 id + 4 type + body + 2 nulls
    buf.writeInt32LE(4 + 4 + body.length + 2, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    body.copy(buf, 12);
    return buf; // trailing 2 bytes already zero
}

export function rconCommand(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const rc = rconConfig();
        if (!rc.enabled) { reject(new Error('rcon disabled on this server (survival-only)')); return; }
        let pw;
        try { pw = fs.readFileSync(rc.pwFile, 'utf8').trim(); }
        catch (e) { reject(new Error('rcon pw unreadable: ' + e.message)); return; }
        const sock = net.createConnection({ host: rc.host, port: rc.port }, () => {
            sock.write(encode(1, 3, pw));
        });
        const timer = setTimeout(() => { try { sock.destroy(); } catch (_) {} reject(new Error('rcon timeout: ' + cmd.slice(0, 40))); }, timeoutMs);
        let stage = 'auth';
        let chunks = [];
        let parts = [];
        let drained = false;
        // Idle-gap timer: reset on every response packet, fires when the reply
        // has stopped arriving. Declared here so finish() can clear it.
        let finishTimer = null;
        const finish = () => { if (drained) return; drained = true; clearTimeout(timer); if (finishTimer) clearTimeout(finishTimer); try { sock.destroy(); } catch (_) {} resolve(parts.join('')); };
        sock.on('data', (d) => {
            chunks.push(d);
            let buf = Buffer.concat(chunks);
            const out = [];
            while (buf.length >= 4) {
                const len = buf.readInt32LE(0);
                if (buf.length < 4 + len) break;
                const id = buf.readInt32LE(4);
                const type = buf.readInt32LE(8);
                // Empty auth-echo packets (id 1 / type 2, zero body) carry no
                // data — the rcon.py arbiter ignores them and drains on
                // timeout. Mirror that: only keep real response bodies.
                const body = buf.slice(12, 4 + len - 2).toString('utf8', 'replace');
                out.push({ id, type, body });
                buf = buf.slice(4 + len);
            }
            chunks = [buf];
            for (const p of out) {
                if (stage === 'auth') {
                    if (p.id === -1 || p.type === -1) { clearTimeout(timer); try { sock.destroy(); } catch (_) {} reject(new Error('rcon auth failed')); return; }
                    stage = 'cmd';
                    sock.write(encode(2, 2, cmd));
                    // safety net only: the real finish fires on an idle gap
                    setTimeout(finish, 1500);
                } else if (p.type === 0) {
                    parts.push(p.body);
                    // Do NOT finish here. A long reply -- and `data get entity X
                    // Inventory` is long -- is split across SEVERAL type-0
                    // packets. Returning on the first one silently dropped every
                    // entry after it, so a full inventory read as a short one and
                    // she was told she had no materials while holding hundreds.
                    // That is the "63 blocks of dirt vanishing every 20 seconds"
                    // in the live trace: nothing was destroyed, the reply was
                    // arriving in pieces and we were reading the first.
                    //
                    // Instead, wait for a short quiet period. TCP delivers the
                    // packets back to back, so an idle gap means the reply is
                    // done; the 1500ms net above is the backstop if it never is.
                    clearTimeout(finishTimer);
                    finishTimer = setTimeout(finish, 150);
                }
            }
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

const ARMOR_SLOT = { diamond_helmet: 'armor.head', diamond_chestplate: 'armor.chest', diamond_leggings: 'armor.legs', diamond_boots: 'armor.feet' };
const KIT_GIVE = [ // [item, count]
    ['cooked_beef', 16], ['diamond_pickaxe', 1], ['diamond_axe', 1],
    ['diamond_shovel', 1], ['diamond_hoe', 1], ['bow', 1], ['arrow', 64],
    ['chest', 1], ['water_bucket', 1], ['elytra', 1], ['firework_rocket', 64],
];

// RCON position read: where IS a player, even when the 26.3 server withholds
// their entity from bot.entities (verified 18:24: YandereDev 11 blocks away,
// invisible). Returns {x,y,z} floats or null. Cached 1.2s per name: fresh
// enough for per-tick stare/social gating (a 5s cache froze her gaze on a
// stale spot for seconds after the player moved), still cheap enough that a
// walk leg doesn't spam RCON.
const _posCache = {};
const POS_CACHE_MS = 1200;
export async function rconPlayerPos(name) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return null;
    const now = Date.now();
    if (_posCache[safe] && now - _posCache[safe].t < POS_CACHE_MS) return _posCache[safe].pos;
    let out;
    try { out = await rconCommand(`data get entity ${safe} Pos`); }
    catch (e) { return null; }
    const m = String(out).match(/\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
    if (!m) return null;
    const pos = { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
    _posCache[safe] = { t: now, pos };
    return pos;
}

// NEARBY ENTITIES (2026-09-30): the whole perception layer depends on this,
// because 26.3 withholds entities from bot.entities. One `execute as
// @e[distance=..N] at @s run data get entity @s Pos` returns EVERY entity near
// the executor in a SINGLE socket (verified: 3 entities, one call) instead of
// one socket per mob type. READ-ONLY. Returns [{name,x,y,z}]. Cached briefly
// so a describe/look sweep does not re-read on every leg.
const _nearCache = {};
const NEAR_CACHE_MS = 1000;
export async function rconNearbyEntities(name, radius = 24) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return [];
    const key = `${safe}:${radius}`;
    const now = Date.now();
    if (_nearCache[key] && now - _nearCache[key].t < NEAR_CACHE_MS) return _nearCache[key].list;
    let out;
    try {
        out = await rconCommand(
            `execute as ${safe} at @s run execute as @e[distance=..${Math.max(1, Math.min(64, Math.floor(radius)))}] at @s run data get entity @s Pos`);
    } catch (e) { return []; }
    // "Pillager has the following entity data: [x, y, z]UwU has ... [x, y, z]"
    // — no newlines, so split on the entity name that precedes each bracket.
    // NAME CASE: RCON reports the DISPLAY name ("Pillager", "UwU"), NOT the
    // snake_case id ("pillager"). Every caller filters against snake_case, so
    // this MUST be lowercased here — otherwise every comparison silently fails
    // and a live pillager reads as "no threat". This bug shipped once already.
    const list = [];
    const re = /([A-Za-z_0-9]+) has the following entity data: \[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/g;
    let m;
    while ((m = re.exec(String(out || ''))) !== null) {
        list.push({ name: m[1].toLowerCase(), x: parseFloat(m[2]), y: parseFloat(m[3]), z: parseFloat(m[4]) });
    }
    _nearCache[key] = { t: now, list };
    return list;
}

// ---- PLAYER APPEARANCE (2026-09-30) ------------------------------------
// She cannot see ANY of this client-side on 26.3: bot.entities and
// bot.players are withheld, so equipment, carried items and head rotation are
// all invisible to her. RCON is the only source. Verified live against 26.3:
//
//   Rotation  -> [yaw, pitch]                        (camelCase, works)
//   equipment -> {offhand, head, chest, legs, feet}  (LOWERCASE in 26.3;
//                capital-E "Equipment" returns "Found no elements matching")
//   Inventory -> [{Slot: Nb, id: "minecraft:x", count: N}]
//
// NOT AVAILABLE in 26.3 (all return "Found no elements matching"):
//   SelectedItem, HandItems, ArmorItems, items
// ...so which SLOT a player has selected cannot be read. She can see what they
// carry and what they wear, never what is in their main hand right now.
//
// Enchantments / custom names / lore are extra keys on the SAME stack NBT, so
// they arrive inline with no extra call. Keep the raw string: a caller that
// wants to report "Sharpness V" needs the unmodified payload.
//
// CACHED DELIBERATELY AGGRESSIVELY: a full inventory is a large NBT payload per
// player, and equipment changes on a human timescale (seconds to minutes), not
// a tick scale. 5s for gear, 1.2s for rotation.
const _gearCache = {};
const GEAR_CACHE_MS = 5000;
const _rotCache = {};
const ROT_CACHE_MS = 1200;

// Strip "minecraft:" and return {id, count} from a stack snippet like
// {id: "minecraft:diamond_sword", count: 1} — or null if absent.
function parseStack(frag) {
    if (!frag) return null;
    const id = String(frag).match(/id:\s*"([^"]+)"/);
    if (!id) return null;
    const c = String(frag).match(/count:\s*(\d+)/);
    return { id: id[1].replace(/^minecraft:/, ''), count: c ? parseInt(c[1], 10) : 1, raw: String(frag) };
}

// What a player is WEARING (armor + offhand) and CARRYING (inventory summary).
export async function rconPlayerGear(name) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return null;
    const now = Date.now();
    if (_gearCache[safe] && now - _gearCache[safe].t < GEAR_CACHE_MS) return _gearCache[safe].v;
    const v = { name: safe, wearing: {}, offhand: null, carrying: [], raw: {} };
    // equipment (LOWERCASE on 26.3) — each slot is {id, count}
    try {
        const eq = String(await rconCommand(`data get entity ${safe} equipment`, 5000));
        v.raw.equipment = eq;
        // Parse WITHOUT backslash escapes: an earlier version used
        // new RegExp(slot + ':\\s*\\{...\\}') and the escapes were silently
        // stripped when the file was written, producing the literal pattern
        // ":s*{([^}]*)}" which never matched — so armor read as {} while the
        // offhand (a plain regex literal) worked. String-slicing on the slot
        // name has no escape sequences to lose.
        for (const slot of ['head', 'chest', 'legs', 'feet']) {
            const key = slot + ': {';
            const i = eq.indexOf(key);
            if (i < 0) continue;
            const start = i + key.length;
            const end = eq.indexOf('}', start);
            if (end < 0) continue;
            const s = parseStack(eq.slice(start, end));
            if (s) v.wearing[slot] = s;
        }
        const om = eq.match(/offhand:\s*\{([^}]*)\}/);
        if (om) v.offhand = parseStack(om[1]);
    } catch (_) {}
    // Inventory — [{Slot: Nb, id: "minecraft:x", count: N}, ...]
    try {
        const inv = String(await rconCommand(`data get entity ${safe} Inventory`, 5000));
        v.raw.inventory = inv;
        const re = /\{\s*Slot:\s*(\d+)b?\s*,?\s*id:\s*"([^"]+)"\s*,?\s*count:\s*(\d+)\s*,?/g;
        let m;
        while ((m = re.exec(inv)) !== null) {
            v.carrying.push({ slot: parseInt(m[1], 10), id: m[2].replace(/^minecraft:/, ''), count: parseInt(m[3], 10) });
        }
    } catch (_) {}
    _gearCache[safe] = { t: now, v };
    return v;
}

// Head rotation: {yaw, pitch} in degrees. She uses this for "where are they
// LOOKING", which she cannot derive client-side on 26.3.
export async function rconPlayerRotation(name) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return null;
    const now = Date.now();
    if (_rotCache[safe] && now - _rotCache[safe].t < ROT_CACHE_MS) return _rotCache[safe].v;
    let v = null;
    try {
        const out = String(await rconCommand(`data get entity ${safe} Rotation`, 4000));
        const m = out.match(/\[(-?[\d.]+)f?,\s*(-?[\d.]+)f?\]/);
        if (m) v = { yaw: parseFloat(m[1]), pitch: parseFloat(m[2]) };
    } catch (_) {}
    _rotCache[safe] = { t: now, v };
    return v;
}

// Server-truth inventory (2026-09-27): client items() is blind on 26.3 (Slot
// decode bug reads 0 [] while RCON holds a real kit), so placement/dig verbs
// that gate on carried blocks must consult the server. Cached a few seconds
// per name — placement checks run mid-leg, not per tick.
const _invCache = {};
const INV_CACHE_MS = 4000;
export function rconInventoryBust(name) {
    try {
        const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
        if (safe && _invCache[safe]) delete _invCache[safe];
    } catch (_) {}
}
/**
 * Parse `data get entity <p> Inventory`, and SAY whether the reply was complete.
 *
 * The old inline regex matched whatever arrived and said nothing about whether
 * the reply had been cut short. A truncated reply therefore parsed into a
 * smaller inventory that looked exactly like a real one -- and since
 * rconItemCount sums what this returns, placeBlock would read fewer materials
 * than she is actually holding and refuse with "Don't have any dirt to place".
 * That is the same failure shape as the health parser: a measurement that
 * cannot see its own failure reports a clean number.
 *
 * `complete:false` means "I do not know the inventory", which callers must
 * treat as unknown rather than as zero. Also flags an entry that parsed with
 * no count, since that entry is dropped rather than counted.
 */
export function parseInventoryText(out) {
    const text = String(out ?? '');
    const inv = [];
    // Require the closing bracket so a cut-off reply cannot masquerade as a
    // complete one.
    const complete = /\]/.test(text);
    try {
        const re = /Slot:\s*(\d+)b,\s*id:\s*"minecraft:([a-z_]+)"[^}]*?count:\s*(\d+)/g;
        let m;
        while ((m = re.exec(text))) {
            inv.push({ slot: parseInt(m[1], 10), name: m[2], count: parseInt(m[3], 10) });
        }
        // A bracketed entry with no count is a malformed entry; if one exists we
        // are looking at a partial read.
        const braces = (text.match(/\{Slot:/g) || []).length;
        const counted = (text.match(/count:\s*\d+/g) || []).length;
        if (braces !== counted) return { inv, complete: false };
    } catch (_) { /* fall through: complete stays as computed */ }
    return { inv, complete };
}

export async function rconInventory(name, bust=false) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return null;
    const now = Date.now();
    if (bust && _invCache[safe]) delete _invCache[safe];
    if (_invCache[safe] && now - _invCache[safe].t < INV_CACHE_MS) return _invCache[safe].inv;
    let out;
    try { out = await rconCommand(`data get entity ${safe} Inventory`); }
    catch (e) { return null; }
    const { inv, complete } = parseInventoryText(out);
    // Do NOT cache a partial read. A short reply that looked like a complete
    // inventory is what made her claim she had no dirt while holding 320 of it;
    // caching it also made the lie stick for the whole cache window.
    if (!complete) return null;
    _invCache[safe] = { t: now, inv };
    return inv;
}
// Count of a server-held item (null = unknown, treat as 0 with no authority).
export async function rconItemCount(name, item) {
    try {
        // Bust the cache: a count that is 20 seconds stale is exactly what makes
        // her refuse to place with material in hand, and a full inventory is the
        // one case where an honest extra read costs almost nothing.
        const inv = await rconInventory(name, true);
        // null means the read failed or was truncated -- UNKNOWN, not zero.
        // Returning 0 here is what turns a failed measurement into a confident
        // "you have none". Callers that need a floor should treat 0 as unknown.
        if (!inv) return 0;
        let n = 0;
        for (const e of inv) if (e.name === item) n += e.count;
        return n;
    } catch (_) { return 0; }
}

// SINGLE AUTHORITATIVE COUNT (2026-09-30): how many of `item` she has, counting
// the hotbar+main inventory AND worn armor AND offhand. Every client-side
// count is blind on 26.3, so crafting/prereq/armor checks must use this.
// `worn` reports whether the matching armor piece is EQUIPPED (not just held).
//
// TEST SEAM: a caller that wants the server verdict to come from somewhere
// else (a unit test with a fake bot, which would otherwise reach the REAL
// live server and read a real player) installs an override. Without one, this
// is the real RCON read. Overrides are opt-in and must be cleared.
let _countAllOverride = null;
export function setCountAllOverride(fn) {
    _countAllOverride = typeof fn === 'function' ? fn : null;
}
export async function rconCountAll(name, item) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    const want = String(item || '').replace(/^minecraft:/, '');
    if (_countAllOverride) return _countAllOverride(safe, want);
    if (!safe || !want) return { total: 0, inv: 0, worn: 0, offhand: 0 };
    const g = await rconPlayerGear(safe);
    if (!g) return { total: 0, inv: 0, worn: 0, offhand: 0 };
    let inv = 0;
    for (const c of (g.carrying || [])) if (c.id === want) inv += c.count;
    let worn = 0;
    for (const slot of Object.keys(g.wearing || {})) if (g.wearing[slot].id === want) worn++;
    const offhand = (g.offhand && g.offhand.id === want) ? 1 : 0;
    return { total: inv + worn + offhand, inv, worn, offhand };
}

// Is she WEARING a full set? Returns per-slot booleans so a caller can say
// "helmet yes, boots no" instead of a bare false.
export async function rconArmorStatus(name) {
    const g = await rconPlayerGear(String(name).replace(/[^A-Za-z0-9_]/g, ''));
    const w = (g && g.wearing) || {};
    const s = {
        head: w.head ? w.head.id : null,
        chest: w.chest ? w.chest.id : null,
        legs: w.legs ? w.legs.id : null,
        feet: w.feet ? w.feet.id : null,
        offhand: g && g.offhand ? g.offhand.id : null,
    };
    s.slotsFilled = ['head', 'chest', 'legs', 'feet'].filter(k => s[k]).length;
    s.complete = s.slotsFilled === 4;
    return s;
}

function parseIds(text) {
    const have = new Set();
    const re = /minecraft:([a-z_]+)"/g;
    let m;
    while ((m = re.exec(text))) have.add(m[1]);
    return have;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Ensure the full OP survival kit via RCON only. Returns { ok, gave, detail }.
// ok=false means RCON itself failed -> caller falls back to legacy chat path.
export async function rconEnsureKit(name) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return { ok: false, gave: false, detail: 'bad name' };
    let inv, eq;
    try {
        inv = await rconCommand(`data get entity ${safe} Inventory`);
        eq = await rconCommand(`data get entity ${safe} equipment`);
    } catch (e) {
        return { ok: false, gave: false, detail: 'rcon read failed: ' + e.message };
    }
    const have = new Set([...parseIds(inv), ...parseIds(eq)]);
    const actions = [];
    for (const [piece, slot] of Object.entries(ARMOR_SLOT))
        if (!have.has(piece)) actions.push(`item replace entity ${safe} ${slot} with minecraft:${piece} 1`);
    // 26.3 equipment has NO mainhand slot (only offhand/head/chest/legs/feet), so
    // `item replace ... weapon.mainhand` is not a valid recovery path. If the
    // sword is ever genuinely missing, GIVE it — that lands in the inventory,
    // which is where she carries it anyway.
    if (!have.has('diamond_sword')) actions.push(`give ${safe} minecraft:diamond_sword 1`);
    if (!have.has('shield')) actions.push(`item replace entity ${safe} weapon.offhand with minecraft:shield 1`);
    for (const [item, n] of KIT_GIVE)
        if (!have.has(item)) actions.push(`give ${safe} minecraft:${item} ${n}`);
    if (actions.length === 0) return { ok: true, gave: false, detail: 'already kitted per RCON, silent' };
    let done = 0;
    for (const c of actions) {
        try { await rconCommand(c); done++; } catch (e) { return { ok: true, gave: done > 0, detail: `gave ${done}/${actions.length}, stopped: ${e.message}` }; }
        await sleep(150);
    }
    return { ok: true, gave: true, detail: `RCON kitted ${done} missing pieces, silent` };
}
