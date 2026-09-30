// Furnace ledger (2026-09-30).
//
// WHY: smeltItem was a one-shot — it found a furnace, smelted, walked away and
// forgot. A player remembers THEIR furnace: where it is, what they keep in it,
// that they crafted it themselves, and that someone broke it or stole from it.
// This is that memory, persisted to bots/UwU/furnaces.json so it survives
// restarts and death.
//
// It also answers the question a one-shot can never answer: "the furnace I
// left smelting iron is gone, what happened?"

import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';

const LEDGER = './bots/UwU/furnaces.json';
const KEEP_ENTRIES = 24;      // do not grow without bound
const STALE_MS = 1000 * 60 * 60 * 24 * 30;  // forget a note after 30 days

function read() {
    try {
        if (fs.existsSync(LEDGER)) {
            const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
            if (d && Array.isArray(d.furnaces)) return d;
        }
    } catch (_) {}
    return { furnaces: [] };
}

function write(d) {
    try {
        d.furnaces.sort((a, b) => (b.t || 0) - (a.t || 0));
        d.furnaces = d.furnaces.slice(0, KEEP_ENTRIES);
        fs.writeFileSync(LEDGER, JSON.stringify(d, null, 2));
    } catch (_) {}
}

const keyOf = (x, y, z) => `${x},${y},${z}`;

// Remember a furnace. `origin` records HOW she got it (crafted / found / given)
// so she can tell "my furnace" from "one that was already here".
export function rememberFurnace(bot, pos, extra = {}) {
    const d = read();
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const k = keyOf(x, y, z);
    let e = d.furnaces.find(f => f.k === k);
    if (!e) {
        e = { k, x, y, z, origin: extra.origin || 'found', firstSeen: Date.now(), uses: 0, smelted: {}, notes: [] };
        d.furnaces.push(e);
    }
    e.t = Date.now();
    e.lastSeen = Date.now();
    e.alive = true;
    if (extra.origin) e.origin = extra.origin;
    if (extra.placedByHer) e.placedByHer = true;
    write(d);
    return e;
}

export function noteSmelt(bot, pos, itemName, count) {
    const d = read();
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.furnaces.find(f => f.k === k);
    if (!e) return null;
    e.t = Date.now();
    e.uses = (e.uses || 0) + 1;
    e.smelted[itemName] = (e.smelted[itemName] || 0) + count;
    // keep the tail of recent work, not every item she has ever smelted
    e.recent = (e.recent || []).slice(-5);
    e.recent.push({ item: itemName, n: count, t: Date.now() });
    write(d);
    return e;
}

// Her furnaces, nearest first.
export function knownFurnaces(bot) {
    const d = read();
    const me = bot && bot.entity ? bot.entity.position : null;
    const out = d.furnaces.map(f => ({
        ...f,
        dist: me ? Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z) : null,
    }));
    out.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    return out;
}

export function nearestKnownFurnace(bot, maxDist = 256) {
    const list = knownFurnaces(bot).filter(f => f.dist == null || f.dist <= maxDist);
    return list.length ? list[0] : null;
}

// Mark a furnace as gone. `how` is why: 'destroyed' (block no longer there),
// 'stolen' (block gone AND she is missing the contents she logged), or
// 'picked-up' (she collected it back into her pack).
export function markFurnace(bot, pos, how, detail = '') {
    const d = read();
    const k = keyOf(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const e = d.furnaces.find(f => f.k === k);
    if (!e) return null;
    e.alive = false;
    e.lostAt = Date.now();
    e.lostHow = how;
    if (detail) e.lostDetail = detail;
    const nm = detail ? ` (${detail})` : '';
    e.notes = (e.notes || []).slice(-5);
    e.notes.push(`Lost ${how}${nm} at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    write(d);
    return e;
}

// Reconcile memory against the world: any furnace she remembers that is NOT
// within scan range of where it was recorded has almost certainly been broken
// or removed. Called when she goes looking for a furnace she expected to exist.
export function auditFurnaces(bot, scanRange = 24) {
    const d = read();
    const changed = [];
    const now = Date.now();
    for (const f of d.furnaces) {
        if (f.alive === false) continue;
        // do not audit a furnace she is nowhere near — absence of evidence
        const me = bot && bot.entity ? bot.entity.position : null;
        if (me) {
            const dist = Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z);
            if (dist > scanRange * 2) continue;   // too far to conclude anything
        }
        let found = null;
        try { found = bot.blockAt(new Vec3(f.x, f.y, f.z)); } catch (_) {}
        let isFurnace = false;
        try { isFurnace = !!found && /furnace|smoker/.test(found.name); } catch (_) {}
        if (!isFurnace) {
            const wasHolding = (() => {
                try { return bot.inventory.items().some(i => /furnace/.test(i.name)); } catch (_) { return false; }
            })();
            f.alive = false;
            f.lostAt = now;
            f.lostHow = wasHolding ? 'picked-up' : 'destroyed';
            f.notes = (f.notes || []).slice(-5);
            f.notes.push(wasHolding
                ? `I picked it back up at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
                : `It was gone when I came back at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
            changed.push(f);
        }
    }
    if (changed.length) write(d);
    return changed;
}

// A short honest sentence about a furnace, for chat: where it is, whether it is
// still there, and what she has made in it.
export function describeFurnace(bot) {
    const f = nearestKnownFurnace(bot);
    if (!f) return 'I do not have a furnace I remember.';
    if (f.alive === false) {
        return `My furnace at ${f.x}, ${f.y}, ${f.z} is gone — ${f.lostHow === 'picked-up' ? 'I picked it back up' : 'it was destroyed'}${f.lostDetail ? ' (' + f.lostDetail + ')' : ''}.`;
    }
    const bits = [`My furnace is at ${f.x}, ${f.y}, ${f.z}${f.dist != null ? `, ${f.dist.toFixed(0)}m away` : ''}`];
    if (f.origin) bits.push(`I ${f.origin === 'crafted' ? 'crafted it myself' : 'found it'}`);
    if (f.uses) bits.push(`I have smelted ${f.uses} batch${f.uses === 1 ? '' : 'es'} in it`);
    const recent = (f.recent || []).slice(-2).map(r => `${r.n} ${String(r.item).replace(/_/g, ' ')}`);
    if (recent.length) bits.push(`last: ${recent.join(', ')}`);
    return bits.join('. ') + '.';
}
