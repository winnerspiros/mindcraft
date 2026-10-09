// Enchanting-table and brewing-stand ledger (2026-09-30).
//
// WHY: the furnace ledger taught that a station is a thing you OWN and use over
// time. Enchanting and brewing had the same gap, plus a nastier one specific to
// container GUIs: if she leaves an item sitting in an enchanting table or a brew
// running in a stand, and something (or someone) takes it, nothing notices. A
// player would check. So these entries record WHAT WAS LEFT INSIDE, and the
// audit compares memory against the live window contents.

import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';

// Station ledger path is per-agent (see furnace_ledger.js): the guest
// account's tables/stands stay off the home account.
function ledgerPath(bot) {
    const name = (bot && (bot.username || bot.name)) || 'UwU';
    return `./bots/${name}/stations.json`;
}
const KEEP = 24;

function read(bot) {
    const LEDGER = ledgerPath(bot);
    try {
        if (fs.existsSync(LEDGER)) {
            const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
            if (d && typeof d === 'object') { d.tables = d.tables || []; d.stands = d.stands || []; return d; }
        }
    } catch (_) {}
    return { tables: [], stands: [] };
}
function write(bot, d) {
    const LEDGER = ledgerPath(bot);
    try {
        d.tables = (d.tables || []).slice(0, KEEP);
        d.stands = (d.stands || []).slice(0, KEEP);
        fs.writeFileSync(LEDGER, JSON.stringify(d, null, 2));
    } catch (_) {}
}
const keyOf = (x, y, z) => `${x},${y},${z}`;

function upsert(bucket, blockName, pos, extra = {}) {
    const d = read(bot);
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const k = keyOf(x, y, z);
    let e = d[bucket].find(r => r.k === k);
    if (!e) {
        e = { k, x, y, z, block: blockName, firstSeen: Date.now(), uses: 0, inside: [], history: [] };
        d[bucket].push(e);
    }
    e.t = Date.now();
    e.lastSeen = Date.now();
    e.alive = true;
    if (extra.origin) e.origin = extra.origin;
    write(bot, d);
    return e;
}

// --- enchanting tables ---------------------------------------------------

export function rememberTable(bot, pos, extra = {}) {
    return upsert('tables', 'enchanting_table', pos, extra);
}

// Record that she left an item sitting in the table. This is the "did someone
// take it" breadcrumb.
export function noteTableItem(bot, pos, itemName, n = 1) {
    const d = read(bot);
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.tables.find(r => r.k === k);
    if (!e) return null;
    e.t = Date.now();
    e.inside = (e.inside || []).filter(x => x.item !== itemName);
    e.inside.push({ item: itemName, n, t: Date.now() });
    write(bot, d);
    return e;
}

export function noteEnchant(bot, pos, enchantName, level, itemName) {
    const d = read(bot);
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.tables.find(r => r.k === k);
    if (!e) return null;
    e.t = Date.now();
    e.uses = (e.uses || 0) + 1;
    e.history = (e.history || []).slice(-5);
    e.history.push({ ench: enchantName, level, item: itemName, t: Date.now() });
    e.inside = [];   // the item came back out with the enchantment on it
    write(bot, d);
    return e;
}

export function nearestTable(bot, maxDist = 256) {
    const d = read(bot);
    const me = bot && bot.entity ? bot.entity.position : null;
    const list = d.tables
        .filter(e => e.alive !== false)
        .map(e => ({ ...e, dist: me ? Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z) : null }))
        .filter(e => e.dist == null || e.dist <= maxDist)
        .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    return list[0] || null;
}

// Did the table vanish, or is its contents gone?
export function auditTables(bot, scanRange = 24) {
    const d = read(bot);
    const changed = [];
    const me = bot && bot.entity ? bot.entity.position : null;
    for (const e of d.tables) {
        if (e.alive === false) continue;
        if (me) {
            const dist = Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z);
            if (dist > scanRange * 2) continue;   // too far to conclude anything
        }
        let b = null;
        try { b = bot.blockAt(new Vec3(e.x, e.y, e.z)); } catch (_) {}
        if (!b || b.name !== 'enchanting_table') {
            const had = (e.inside || []).length > 0;
            e.alive = false;
            e.lostAt = Date.now();
            e.lostHow = had ? 'destroyed-with-item-inside' : 'destroyed';
            e.notes = (e.notes || []).slice(-4);
            e.notes.push(had
                ? `It was broken with ${e.inside.map(i => i.item).join(', ')} still inside`
                : 'It was gone when I came back');
            changed.push(e);
        }
    }
    if (changed.length) write(bot, d);
    return changed;
}

// The important one: the table is still there, but the item she left in it is
// gone. That is theft, and it is NOT the same as the table being broken.
export function noteTableItemMissing(bot, pos, expectedItem) {
    const d = read(bot);
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.tables.find(r => r.k === k);
    if (!e) return null;
    e.t = Date.now();
    e.notes = (e.notes || []).slice(-4);
    e.notes.push(`${expectedItem} was no longer in my table when I came back`);
    e.stolen = (e.stolen || []).slice(-4);
    e.stolen.push({ item: expectedItem, t: Date.now() });
    e.inside = (e.inside || []).filter(x => x.item !== expectedItem);
    write(bot, d);
    return e;
}

// --- brewing stands -----------------------------------------------------

export function rememberStand(bot, pos, extra = {}) {
    return upsert('stands', 'brewing_stand', pos, extra);
}

// What was loaded in the stand, and what brew was in progress.
export function noteStandLoad(bot, pos, { bottles = 0, ingredient = null, fuel = 0, effect = null }) {
    const d = read(bot);
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.stands.find(r => r.k === k);
    if (!e) return null;
    e.t = Date.now();
    e.brewing = { bottles, ingredient, fuel, effect, startedAt: Date.now() };
    write(bot, d);
    return e;
}

export function noteBrewed(bot, pos, effect, count) {
    const d = read(bot);
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.stands.find(r => r.k === k);
    if (!e) return null;
    e.t = Date.now();
    e.uses = (e.uses || 0) + 1;
    e.brewing = null;   // the stand is empty now
    e.history = (e.history || []).slice(-5);
    e.history.push({ effect, count, t: Date.now() });
    write(bot, d);
    return e;
}

export function nearestStand(bot, maxDist = 256) {
    const d = read(bot);
    const me = bot && bot.entity ? bot.entity.position : null;
    const list = d.stands
        .filter(e => e.alive !== false)
        .map(e => ({ ...e, dist: me ? Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z) : null }))
        .filter(e => e.dist == null || e.dist <= maxDist)
        .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    return list[0] || null;
}

export function auditStands(bot, scanRange = 24) {
    const d = read(bot);
    const changed = [];
    const me = bot && bot.entity ? bot.entity.position : null;
    for (const e of d.stands) {
        if (e.alive === false) continue;
        if (me) {
            const dist = Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z);
            if (dist > scanRange * 2) continue;
        }
        let b = null;
        try { b = bot.blockAt(new Vec3(e.x, e.y, e.z)); } catch (_) {}
        if (!b || b.name !== 'brewing_stand') {
            const wasBrewing = !!e.brewing;
            e.alive = false;
            e.lostAt = Date.now();
            e.lostHow = wasBrewing ? 'destroyed-mid-brew' : 'destroyed';
            e.notes = (e.notes || []).slice(-4);
            e.notes.push(wasBrewing
                ? `It was broken while I had ${e.brewing.bottles} brewing (${e.brewing.effect || e.brewing.ingredient}) inside`
                : 'It was gone when I came back');
            changed.push(e);
        }
    }
    if (changed.length) write(bot, d);
    return changed;
}

export function describeStations(bot) {
    const t = nearestTable(bot);
    const s = nearestStand(bot);
    const bits = [];
    if (!t && !s) return 'I do not have an enchanting table or brewing stand I remember.';
    if (t) {
        bits.push(`My enchanting table is at ${t.x}, ${t.y}, ${t.z}${t.dist != null ? `, ${t.dist.toFixed(0)}m away` : ''}`);
        if (t.uses) bits.push(`I have enchanted ${t.uses} time${t.uses === 1 ? '' : 's'} in it`);
        if (t.history && t.history.length) {
            const h = t.history[t.history.length - 1];
            bits.push(`last: ${h.enchant ? h.enchant + ' ' + h.level + ' on my ' + String(h.item).replace(/_/g, ' ') : h.item}`);
        }
        if (t.inside && t.inside.length) bits.push(`I left ${t.inside.map(i => `${i.n} ${i.item}`).join(' and ')} in it`);
        if (t.stolen && t.stolen.length) bits.push(`something took ${t.stolen.map(i => i.item).join(', ')} out of it once`);
    }
    if (s) {
        bits.push(`My brewing stand is at ${s.x}, ${s.y}, ${s.z}${s.dist != null ? `, ${s.dist.toFixed(0)}m away` : ''}`);
        if (s.brewing) bits.push(`it has ${s.brewing.bottles} brewing with ${s.brewing.ingredient}${s.brewing.effect ? ` for ${s.brewing.effect}` : ''} — about ${Math.max(0, Math.round((Date.now() - s.brewing.startedAt) / 1000))}s in`);
        if (s.history && s.history.length) {
            const h = s.history[s.history.length - 1];
            bits.push(`last: ${h.count} ${h.effect}`);
        }
    }
    return bits.join('. ') + '.';
}
