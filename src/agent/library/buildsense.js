import { readFileSync, writeFileSync, existsSync } from 'fs';
import Vec3 from 'vec3';
import * as mc from '../../utils/mcdata.js';
import * as schematic from './schematic.js';
import * as world from './world.js';

// "Build sense" — the deterministic engine behind the four build-skill modules:
//   A. imagine  -> parseDesignSpec (LLM layers/palette -> schematic format)
//   B. understand -> summarizeRegion (block histogram + structure classification)
//   C. plan    -> estimateSchematic (materials + effort report)
//   + a known-builds registry (her builds AND players' builds) and a site-check.
//
// All of this is zero-LLM plumbing that the LLM (her brain) drives by choice; none
// of it decides WHAT or WHEN to build. That stays with her mood + relationship.

const AIR = new Set(['air', 'cave_air', 'void_air']);

// Blocks that mark terrain (not a player's construction). Anything else in a
// region counts as "built" for the site-check and classification heuristics.
const NATURAL = new Set([
    'air', 'cave_air', 'void_air', 'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt',
    'stone', 'cobblestone', 'mossy_cobblestone', 'gravel', 'sand', 'red_sand', 'water',
    'lava', 'bedrock', 'deepslate', 'tuff', 'diorite', 'andesite', 'granite', 'calcite',
    'dripstone_block', 'mud', 'clay', 'snow', 'snow_block', 'ice', 'packed_ice',
    'sandstone', 'red_sandstone', 'grass', 'tall_grass', 'fern', 'dead_bush', 'vine',
    'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'copper_ore',
    'lapis_ore', 'emerald_ore', 'deepslate_coal_ore', 'deepslate_iron_ore',
    'deepslate_gold_ore', 'deepslate_diamond_ore', 'deepslate_redstone_ore',
    'deepslate_copper_ore', 'deepslate_lapis_ore', 'deepslate_emerald_ore',
]);

// Largest design the LLM may request in one go. 32x32x20 = 20480 is too much for
// hand placing on a 1-OCPU box; keep designs modest but roomy (10k cells cap).
const MAX_DESIGN_CELLS = 10000;

export function isAir(name) {
    return !name || AIR.has(name);
}

// Run a thunk and return its result, or a fallback if it throws. Used to keep
// mcdata lookups from hard-crashing a plan when the registry isn't ready yet.
function safeGet(fn, fallback = null) {
    try { return fn(); } catch (e) { return fallback; }
}

// Canonicalize + validate a block name against the connection's registry.
// Returns the real name, or null. Tolerant of the two most common slips the LLM
// makes: trailing 's' ("oak_plank" -> "oak_planks") and stray case/space.
export function canonicalBlockName(bot, name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    if (!n) return null;
    const blocksByName = bot.registry?.blocksByName || {};
    if (blocksByName[n]) return n;
    if (blocksByName[n.replace(/[ _]/g, '_')]) return n.replace(/[ _]/g, '_');
    if (blocksByName[n + 's']) return n + 's';
    if (n.endsWith('s') && blocksByName[n.slice(0, -1)]) return n.slice(0, -1);
    return null;
}

// Count items by name from the bot inventory.
export function inventoryCounts(bot) {
    const c = {};
    const items = (bot && bot.inventory && bot.inventory.items) ? bot.inventory.items() : [];
    for (const it of items) c[it.name] = (c[it.name] || 0) + it.count;
    return c;
}

/**
 * Parse an LLM-authored design spec into the schematic.js block-list format.
 * Contract (see the design prompt): { name, layers: string[][], palette: {char:block} }
 *   layers[y][z][x] = single character; '.' or space = air; bottom layer is y=0.
 * Every non-air cell must have a palette entry; block names are validated against
 * the registry. Returns { name, size:{x,y,z}, blocks:[{x,y,z,name}] }.
 */
export function parseDesignSpec(bot, spec) {
    if (!spec || !Array.isArray(spec.layers) || spec.layers.length === 0)
        throw new Error('Design is missing its "layers" (an array of row-arrays, bottom layer first).');
    if (!spec.palette || typeof spec.palette !== 'object')
        throw new Error('Design is missing its "palette" (single-char keys -> block names).');

    const palette = {};
    for (const [rawKey, rawVal] of Object.entries(spec.palette)) {
        const key = String(rawKey);
        if (key.length !== 1) throw new Error(`Palette key "${key}" must be a single character.`);
        if (key === '.') { palette[key] = null; continue; } // '.' is reserved for air
        const name = canonicalBlockName(bot, rawVal);
        if (!name) throw new Error(`Palette block "${rawVal}" is not a known Minecraft block.`);
        palette[key] = name;
    }

    const layers = spec.layers.map(l => (Array.isArray(l) ? l : [l])); // tolerate a single-string layer
    const height = layers.length;
    const depth = Math.max(...layers.map(l => l.length));
    let width = 0;
    for (const layer of layers) for (const row of layer) width = Math.max(width, String(row).length);
    if (!width || !depth || !height) throw new Error('Design has zero size.');

    const cells = width * depth * height;
    if (cells > MAX_DESIGN_CELLS)
        throw new Error(`Design is ${width}x${depth}x${height} = ${cells} cells (cap ${MAX_DESIGN_CELLS}). Make it smaller.`);

    const blocks = [];
    for (let y = 0; y < height; y++) {
        for (let z = 0; z < depth; z++) {
            const row = layers[y][z] !== undefined ? String(layers[y][z]) : '';
            for (let x = 0; x < width; x++) {
                const ch = x < row.length ? row[x] : '.';
                if (ch === '.' || ch === ' ' || ch === '') continue; // air
                if (!(ch in palette)) throw new Error(`Layer ${y} row ${z} uses "${ch}", which has no palette entry.`);
                const name = palette[ch];
                if (!name) continue;
                blocks.push({ x, y, z, name });
            }
        }
    }

    return { name: spec.name || 'designed', size: { x: width, y: height, z: depth }, blocks };
}

/**
 * Understand an existing region: block histogram, dominant material, how much of
 * it is constructed vs terrain, whether it is hollow, and a rough structure type.
 * Uses captureRegion so only loaded chunks near the bot are read.
 */
export async function summarizeRegion(bot, p1, p2) {
    const sch = await schematic.captureRegion(bot, p1, p2);
    const { size } = sch;

    const hist = {};
    for (const b of sch.blocks) hist[b.name] = (hist[b.name] || 0) + 1;
    const sorted = Object.entries(hist).sort((a, b) => b[1] - a[1]);
    const topBlocks = sorted.slice(0, 6).map(([n, c]) => `${n} x${c}`);
    const dominant = sorted[0] ? sorted[0][0] : 'air';

    const total = sch.blocks.length;
    const builtCount = sch.blocks.filter(b => !NATURAL.has(b.name)).length;
    const builtRatio = total ? builtCount / total : 0;

    // Occupy a set of (x,y,z) for interior sampling.
    const occupied = new Set(sch.blocks.map(b => `${b.x},${b.y},${b.z}`));
    let interior = 0, interiorAir = 0;
    let topLayer = 0, topLayerSolid = 0;
    for (let y = 0; y < size.y; y++)
        for (let z = 0; z < size.z; z++)
            for (let x = 0; x < size.x; x++) {
                const key = `${x},${y},${z}`;
                const isSolid = occupied.has(key);
                if (y === size.y - 1) { topLayer++; if (isSolid) topLayerSolid++; }
                if (x > 0 && x < size.x - 1 && z > 0 && z < size.z - 1 && y > 0 && y < size.y - 1) {
                    interior++; if (!isSolid) interiorAir++;
                }
            }
    const interiorAirFrac = interior ? interiorAir / interior : 0;
    const hasRoof = topLayer ? topLayerSolid / topLayer > 0.4 : false;

    const type = classify(size, builtRatio, interiorAirFrac, hasRoof);
    const pal = topBlocks.join(', ') || 'empty/air';
    const summary =
        `${size.x}x${size.y}x${size.z} ${type}${dominant !== 'air' ? ` (mostly ${dominant})` : ''}` +
        ` — ${total} blocks, ${Math.round(builtRatio * 100)}% constructed${interior ? `, ${Math.round(interiorAirFrac * 100)}% hollow` : ''}` +
        `${hasRoof ? ', roofed' : ', open-top'}. Palette: ${pal}.`;

    return {
        size,
        total,
        builtRatio,
        hollowFraction: interiorAirFrac,
        hasRoof,
        type,
        dominant,
        topBlocks,
        summary,
        unloaded: sch.unloaded || 0,
    };
}

function classify(size, builtRatio, interiorAir, hasRoof) {
    const { x: w, y: h, z: d } = size;
    if (builtRatio < 0.3) return 'terrain / natural landscape';
    if (h >= 3 && w <= 2 && d <= 2) return 'tower or pillar';
    if (h <= 3 && (w >= 4 * d || d >= 4 * w)) return 'wall or fence line';
    if (interiorAir > 0.25 && hasRoof) return 'building (hollow + roofed)';
    if (interiorAir > 0.25) return 'structure (hollow, open-top)';
    return 'solid structure / monument';
}

// Her surroundings are bounded: the bot connects with viewDistance 'short'
// (~9x9 loaded chunks). Block searches beyond this are invisible, so gathering
// feasibility is capped to the loaded area — this is the "am I aware I can reach
// the materials" factor, not just "does a recipe exist".
const GATHER_RADIUS = 48;
const PROXIMITY_SCAN_LIMIT = 6; // only do expensive nearby-scans for the biggest shortfalls

/**
 * Materials + effort + gathering-feasibility report for building a schematic.
 * For every block type: how many she needs vs has, whether it can be crafted,
 * what block it drops from, whether a tool is required and if she has one, and
 * (for the biggest shortfalls) how many sources are actually within her loaded
 * area. Returns { total, missing, rows:[...] } where each row carries a `status`
 * in: have | craft | gather | gather-tool | unavailable | unknown.
 */
export function planBuild(bot, schematic) {
    const inv = inventoryCounts(bot);
    const invNames = new Set(Object.keys(inv));
    const need = {};
    for (const b of schematic.blocks) need[b.name] = (need[b.name] || 0) + 1;

    const total = schematic.blocks.length;
    const rows = Object.entries(need)
        .map(([name, count]) => {
            const have = inv[name] || 0;
            const short = Math.max(0, count - have);
            // Guard each mcdata lookup: on a fresh/transient connection mcdata may not
            // be ready, and a plan should degrade to "unknown" rather than crash.
            const recipe = safeGet(() => mc.getItemCraftingRecipes(name), null);
            const sources = safeGet(() => mc.getItemBlockSources(name), null);
            const tools = safeGet(() => mc.getBlockHarvestTools(name), null);
            const source = sources && sources[0] ? sources[0] : null;
            let craftNow = false;
            let ingredients = '';
            if (recipe) {
                const keys = Object.keys(recipe[0][0]);
                craftNow = keys.length > 0 && keys.every(i => invNames.has(i));
                ingredients = keys.map(k => `${k} x${recipe[0][0][k]}`).join(', ');
            }
            const tool = tools && tools.length ? tools[tools.length - 1] : null; // most capable
            const hasTool = tools ? tools.some(t => invNames.has(t)) : true;     // no tool needed => true
            return { name, need: count, have, short, craftable: !!recipe, craftNow, ingredients, tool, hasTool, tools, source };
        })
        .sort((a, b) => b.short - a.short || b.need - a.need);

    const missing = rows.reduce((s, r) => s + r.short, 0);

    // Bounded surroundings scan: for the biggest shortfalls, count how many source
    // blocks are actually within her loaded area, and set the row's status. Craftable
    // materials are skipped — their "source" is themselves, so the craft path (not a
    // block search) is the honest explanation of how to obtain them.
    const toScan = rows.filter(r => r.short > 0 && r.source && !r.craftable).slice(0, PROXIMITY_SCAN_LIMIT);
    const nearby = new Map();
    for (const r of toScan) {
        let found = 0;
        try {
            const blocks = world.getNearestBlocksWhere(
                bot, b => b && b.name === r.source, GATHER_RADIUS, 32
            );
            found = blocks.length;
        } catch (e) { found = 0; }
        nearby.set(r.name, found);
    }

    for (const r of rows) {
        if (r.short === 0) { r.status = 'have'; continue; }
        if (r.craftable && r.craftNow) { r.status = 'craft'; continue; }
        if (r.craftable) { r.status = 'craft-gather'; continue; } // craftable, but needs ingredients
        if (r.source) {
            const n = nearby.get(r.name); // undefined => not scanned (beyond the top-6)
            if (n === undefined) { r.status = r.hasTool ? 'gather' : 'gather-tool'; continue; }
            if (n > 0) { r.status = r.hasTool ? 'gather' : 'gather-tool'; }
            else { r.status = 'unavailable'; }
            r.nearby = n;
            continue;
        }
        r.status = 'unknown'; // no known drop source (rare/bought/enchanted)
    }

    return { total, missing, rows };
}

const STATUS_LABEL = {
    have: 'have enough',
    craft: 'craftable from what I have',
    'craft-gather': 'craftable, need base ingredients',
    gather: 'gatherable nearby',
    'gather-tool': 'nearby source, but need a tool',
    unavailable: 'no source in my loaded area (would need to explore)',
    unknown: 'no known drop source (rare/uncraftable)',
};

export function formatPlan(plan, label) {
    const lines = [`${label}: ${plan.total} blocks, ${plan.rows.length} material types.`];
    for (const r of plan.rows) {
        let detail = STATUS_LABEL[r.status] || r.status;
        if (r.status === 'craft-gather') detail += ` (${r.ingredients || 'base items'})`;
        if (r.status === 'gather') detail += ` (${r.nearby} source blocks within ${GATHER_RADIUS}m)`;
        if (r.status === 'gather-tool') detail += ` — need ${r.tool}`;
        if (r.status === 'unavailable') detail += ` (0 ${r.source} nearby)`;
        lines.push(`- ${r.name}: ${r.have}/${r.need} — ${detail}`);
    }
    if (plan.missing === 0) lines.push('All materials already on hand — build freely.');
    else lines.push(`Total to acquire/craft/gather: ${plan.missing} blocks.`);
    return lines.join('\n');
}

// ---- known-builds registry (her builds AND players' builds) ----

// Compact "what is this schematic" summary for use as a design reference:
// size + dominant materials + any authored description.
export function referenceSummary(schematic) {
    const hist = {};
    for (const b of schematic.blocks || []) hist[b.name] = (hist[b.name] || 0) + 1;
    const mats = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n]) => n).join(', ');
    const s = schematic.size || { x: 0, y: 0, z: 0 };
    const desc = schematic.description ? ` — ${schematic.description}` : '';
    return `a ${s.x}x${s.y}x${s.z} structure made of ${mats || 'nothing'}${desc}`;
}

export function knownBuildsPath(agentName) {
    return `./bots/${agentName}/known_builds.json`;
}

export function loadKnownBuilds(agentName) {
    const p = knownBuildsPath(agentName);
    if (!existsSync(p)) return [];
    try {
        const d = JSON.parse(readFileSync(p, 'utf8'));
        return Array.isArray(d.builds) ? d.builds : [];
    } catch { return []; }
}

export function recordKnownBuild(agentName, entry) {
    const p = knownBuildsPath(agentName);
    const builds = loadKnownBuilds(agentName);
    builds.push({ ...entry, t: Date.now() });
    writeFileSync(p, JSON.stringify({ builds: builds.slice(-100) }, null, 2));
}

/**
 * Site-awareness: how many cells in the target footprint already hold a
 * constructed (non-terrain) block. Used to warn her before she pastes a design
 * over a player's build or her own earlier work.
 */
export function occupiedCells(bot, origin, size) {
    let built = 0;
    const ox = Math.floor(origin.x), oy = Math.floor(origin.y), oz = Math.floor(origin.z);
    for (let y = 0; y < size.y && y + oy < 320; y++)
        for (let z = 0; z < size.z; z++)
            for (let x = 0; x < size.x; x++) {
                const b = bot.blockAt(new Vec3(ox + x, oy + y, oz + z));
                if (b && !AIR.has(b.name) && !NATURAL.has(b.name)) built++;
            }
    return built;
}