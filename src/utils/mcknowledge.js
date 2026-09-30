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

// Fuel + smelting knowledge (2026-09-30).
//
// WHY: `getSmeltingFuel` only knew three tiers (coal/charcoal, then anything
// containing "log" or "planks", then coal_block/lava_bucket) and had no concept
// of BURN TIME, so she could not tell whether a fuel choice was wasteful or
// whether a batch would even finish. She also never went to GET fuel when she
// had none — she just reported failure. The registry (26.3 blocks.json /
// items.json) carries no fuel or burn-time data at all, so it lives here.
//
// BURN TIME is in SECONDS of furnace burning (Minecraft's own numbers), which
// is what "how long will this take" has to be computed from: one smelt is 10s
// of burn, so a fuel item lasting 8s cannot finish even one item on its own
// unless something else is already burning.

const FUEL_SECONDS = {
    // --- best: long burn, use these first ---
    coal_block: 800,
    lava_bucket: 1000,
    // --- good ---
    coal: 80,
    charcoal: 80,
    blaze_rod: 120,
    // --- planks: the backbone early game ---
    oak_planks: 15, spruce_planks: 15, birch_planks: 15, jungle_planks: 15,
    acacia_planks: 15, dark_oak_planks: 15, mangrove_planks: 15, cherry_planks: 15,
    bamboo_planks: 15, crimson_planks: 15, warped_planks: 15,
    bamboo_mosaic: 15,
    // --- logs: half a plank's value, so never prefer over planks ---
    oak_log: 7.5, spruce_log: 7.5, birch_log: 7.5, jungle_log: 7.5,
    acacia_log: 7.5, dark_oak_log: 7.5, mangrove_log: 7.5, cherry_log: 7.5,
    crimson_stem: 7.5, warped_stem: 7.5, bamboo_block: 7.5,
    stripped_oak_log: 7.5, stripped_spruce_log: 7.5, stripped_birch_log: 7.5,
    stripped_jungle_log: 7.5, stripped_acacia_log: 7.5, stripped_dark_oak_log: 7.5,
    stripped_mangrove_log: 7.5, stripped_cherry_log: 7.5,
    stripped_crimson_stem: 7.5, stripped_warped_stem: 7.5,
    // --- crafted stick: 5 items per stick, so the efficient early fuel ---
    stick: 5,
    // --- useless as fuel, listed so she never wastes a search on them ---
    sapling: 0, dead_bush: 0, bowl: 0,
};

// Items worth CRAFTING into fuel, best ratio first: [output, perInput]
const FUEL_CRAFTING = [
    ['coal_block', ['coal', 9]],        // 9 coal -> 800s, by far the best
    ['charcoal', ['log', 1]],           // log -> charcoal (smelts logs)
    ['stick', ['planks', 2]],           // 2 planks -> 4 sticks = 20s, better than 2 planks
];

// Anything else wooden that burns, matched by pattern when the name is unknown.
const FUEL_PATTERNS = [
    [/^coal_block$/, 800],
    [/^lava_bucket$/, 1000],
    [/^blaze_rod$/, 120],
    [/^coal$/, 80],
    [/^charcoal$/, 80],
    [/_planks$|planks$/, 15],
    [/_log$|_wood$|_stem$|^bamboo_block$/, 7.5],
    [/^stick$/, 5],
];

export function fuelSeconds(name) {
    if (!name) return 0;
    const n = String(name);
    if (FUEL_SECONDS[n] != null) return FUEL_SECONDS[n];
    for (const [re, secs] of FUEL_PATTERNS) if (re.test(n)) return secs;
    return 0;
}

export function isFuel(name) {
    return fuelSeconds(name) > 0;
}

// How many items one unit of this fuel can smelt. Fractional fuels (a log is
// 7.5s) are rounded UP to 1, not floored to 0: a log DOES burn a furnace, and
// in practice logs smelt one item each because a fresh furnace's initial burn
// covers the remainder. Flooring to 0 made her believe logs were useless fuel
// and report "0 smelts" for the thing she was actually holding.
export function smeltsPerFuel(name) {
    const s = fuelSeconds(name);
    if (s <= 0) return 0;
    return Math.max(1, Math.floor(s / 10));
}

// Best fuel she is carrying, judged by burn time per item rather than by a
// hardcoded tier list — so a stack of coal beats a stack of planks without
// anyone maintaining a preference order.
export function bestFuelIn(inventoryItems) {
    let best = null;
    for (const it of (inventoryItems || [])) {
        const secs = fuelSeconds(it.name);
        if (secs <= 0) continue;
        if (!best || secs > best.seconds) best = { name: it.name, count: it.count || 1, seconds: secs };
    }
    return best;
}

// Everything she could use as fuel right now, best first — lets her answer
// "what can I burn?" without guessing.
export function fuelOptions(inventoryItems) {
    const out = [];
    for (const it of (inventoryItems || [])) {
        const secs = fuelSeconds(it.name);
        if (secs > 0) out.push({ name: it.name, count: it.count || 1, seconds: secs, smelts: smeltsPerFuel(it.name) });
    }
    out.sort((a, b) => b.seconds - a.seconds);
    return out;
}

// Can she make fuel from what she is carrying? Returns the best option with a
// reason, or null. This is the "go get fuel first" half of the loop.
export function fuelSheCouldMake(inventoryItems) {
    const have = new Map();
    for (const it of (inventoryItems || [])) have.set(it.name, (have.get(it.name) || 0) + (it.count || 1));
    // coal_block first: the biggest win by far
    if ((have.get('coal') || 0) >= 9) return { make: 'coal_block', from: 'coal', need: 9, seconds: 800 };
    // charcoal from logs, but ONLY if a furnace exists to smelt them in --
    // the caller decides that, since charcoal is itself a smelted product.
    for (const [log] of [['oak_log'], ['spruce_log'], ['birch_log'], ['jungle_log'], ['acacia_log'], ['dark_oak_log'], ['any_log']]) {
        if (log === 'any_log') {
            const anyLog = [...have.keys()].find(n => /_log$|_stem$|^bamboo_block$/.test(n) && (have.get(n) || 0) > 0);
            if (anyLog) return { make: 'charcoal', from: anyLog, need: 1, seconds: 80, needsFurnace: true };
        } else if ((have.get(log) || 0) > 0) {
            return { make: 'charcoal', from: log, need: 1, seconds: 80, needsFurnace: true };
        }
    }
    // sticks beat planks for fuel, and she usually has planks already
    for (const p of ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks']) {
        if ((have.get(p) || 0) >= 2) return { make: 'stick', from: p, need: 2, seconds: 20, yields: 4 };
    }
    return null;
}

// SMELT_SECONDS is how long one item takes in a furnace (Minecraft's own 10s).
export const SMELT_SECONDS = 10;

// Will this fuel last the whole batch? Returns how many items it can smelt.
export function fuelCovers(fuelName, fuelCount, num) {
    const per = Math.max(1, fuelCount) * smeltsPerFuel(fuelName);
    return { covers: per >= num, canSmelt: per, shortBy: Math.max(0, num - per) };
}

// Honest time estimate. A batch cannot outrun its fuel: the furnace burns one
// item per SMELT_SECONDS, so if the fuel runs out the rest stalls and needs
// refuelling. The estimate is therefore the WORK time, and fuelCovers() tells
// the caller whether it will actually finish.
export function estimateSmeltSeconds({ num = 1 }) {
    return Math.max(0, num) * SMELT_SECONDS;
}

export { FUEL_SECONDS, FUEL_CRAFTING };

