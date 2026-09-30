// Minecraft knowledge layer (2026-09-30).
//
// WHY: 26.3 breaks her two perception channels in different ways — entities are
// withheld from bot.entities (RCON is the only source), and anti-xray replaces
// hidden ores with stone in the CLIENT view. So she is routinely confident and
// WRONG about what she is looking at. This module gives her a ground truth to
// check against, loaded from the registry she already ships
// (assets/minecraft-data-26.3/*.json: 1286 blocks, 161 entities, 1658 items).
//
// Everything here is a pure lookup — no bot calls, no I/O beyond the one-time
// JSON load — so it is safe to call from a brain turn, a mode tick, or headless.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is src/utils, so assets/ at the REPO ROOT is two levels up.
const DATA_DIRS = [
    path.resolve(__dirname, '../../assets/minecraft-data-26.3'),
    path.resolve(__dirname, '../../assets/minecraft-data-26.2'),
    path.resolve(__dirname, '../assets/minecraft-data-26.3'),
];

let _db = null;

function loadRegistry(file) {
    for (const dir of DATA_DIRS) {
        const p = path.join(dir, file);
        try {
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (_) {}
    }
    return null;
}

function build() {
    if (_db) return _db;
    const blocks = loadRegistry('blocks.json') || [];
    const entities = loadRegistry('entities.json') || [];
    const items = loadRegistry('items.json') || [];
    const biomes = loadRegistry('biomes.json') || [];

    const byName = new Map();
    const display = new Map();
    const add = (arr, kind) => {
        for (const e of arr) {
            if (!e || !e.name) continue;
            const n = String(e.name);
            // first definition wins: blocks.json is loaded before items.json and
            // both define e.g. "air"/"chest", and block meaning wins for blocks.
            if (!byName.has(n)) byName.set(n, { name: n, kind, def: e });
            if (e.displayName && !display.has(n)) display.set(n, String(e.displayName));
            else if (e.displayName && !display.has(n + '|' + kind)) display.set(n + '|' + kind, String(e.displayName));
        }
    };
    add(blocks, 'block');
    add(items, 'item');
    add(entities, 'entity');

    // Drops are ITEM ids, and block ids and item ids are SEPARATE namespaces
    // that collide (id 1012 is block 'potted_warped_roots' and item 'diamond').
    // Mapping blocks first made diamond ore "drop potted_warped_roots".
    // Items are the only correct source for a drop list.
    const idToName = new Map();
    for (const e of items) if (e && e.name && e.id != null) idToName.set(e.id, e.name);

    _db = {
        byName,
        display,
        idToName,
        counts: { block: blocks.length, item: items.length, entity: entities.length, biome: biomes.length },
        blocks, entities, items, biomes,
    };
    return _db;
}

// "oak_log" -> "Oak Log"; "pillager" -> "Pillager"; unknown -> the raw name.
export function displayName(name) {
    if (!name) return 'unknown';
    const n = String(name);
    const db = build();
    return db.display.get(n) || db.display.get(n + '|block') || n;
}

// Player names are NOT in the block/item/entity registry, so a lowercased RCON
// name like "uwu" has no display entry and would be reported as "uwu" instead
// of "UwU". Prefer the real casing from bot.players when the caller has a bot.
export function displayPlayer(bot, name) {
    const n = String(name || '');
    try {
        if (bot && bot.players) {
            for (const k of Object.keys(bot.players)) {
                if (k.toLowerCase() === n.toLowerCase()) return k;   // real casing
            }
        }
    } catch (_) {}
    return displayName(n);
}

// Fuzzy match a human/typed phrase onto a real registry name.
// "diamond ore" -> "diamond_ore", "oak log" -> "oak_log", "pillager" -> "pillager".
export function resolveName(phrase) {
    if (!phrase) return null;
    const db = build();
    const raw = String(phrase).trim();
    if (db.byName.has(raw)) return raw;
    const snake = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (db.byName.has(snake)) return snake;
    // strip a leading minecraft: namespace
    const ns = snake.replace(/^minecraft_/, '');
    if (db.byName.has(ns)) return ns;
    // try display-name match ("Oak Log" -> oak_log)
    for (const [n, d] of db.display) {
        if (d.toLowerCase() === raw.toLowerCase()) return n;
    }
    return null;
}

export function kindOf(name) {
    const db = build();
    const e = db.byName.get(String(name));
    return e ? e.kind : null;
}

// Everything the bot should know about one thing, as a flat readable object.
export function describeThing(name) {
    const db = build();
    const key = resolveName(name);
    if (!key) return null;
    const entry = db.byName.get(key);
    const d = entry.def;
    const out = { name: key, kind: entry.kind, display: displayName(key) };
    if (entry.kind === 'block') {
        if (d.hardness != null) out.hardness = d.hardness;
        if (d.resistance) out.resistance = d.resistance;
        if (d.stackSize != null) out.stackSize = d.stackSize;
        if (d.material) out.material = d.material;
        if (d.diggable === false) out.needsTool = true;
        if (d.emitLight) out.lightLevel = d.emitLight;
        if (d.transparent) out.transparent = true;
        if (d.boundingBox && d.boundingBox !== 'block') out.shape = d.boundingBox;
        // drops are numeric state ids in this registry, sometimes already
        // names — map ids back to names so she can say "drops Diamond" and not
        // "drops 1012".
        if (d.drops && d.drops.length) {
            out.drops = d.drops.map(x => {
                if (typeof x === 'string') return x;
                if (x && typeof x === 'object' && x.name) return String(x.name);
                const id = Number(x);
                const nm = build().idToName.get(id);
                return nm || String(x);
            });
        }
    } else if (entry.kind === 'entity') {
        if (d.width != null) out.width = d.width;
        if (d.height != null) out.height = d.height;
        if (d.type) out.category = d.type;
    } else if (entry.kind === 'item') {
        if (d.stackSize != null) out.stackSize = d.stackSize;
    }
    return out;
}

export function registryCounts() {
    return build().counts;
}

// Every name she knows, optionally filtered by kind. Used by the brain to answer
// "what is X" / "what blocks are there" without guessing.
export function allNames(kind = null) {
    const db = build();
    const out = [];
    for (const [n, e] of db.byName) {
        if (kind && e.kind !== kind) continue;
        out.push(n);
    }
    return out;
}
