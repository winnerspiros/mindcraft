/**
 * landwork.js — terrain-aware building: roads, bridges, terraces, gardens, walls,
 * stairs and levelling that FIT THE LAND instead of sitting in a box.
 *
 * Why this exists alongside schematic.js: schematic.js pastes a fixed design at a
 * fixed origin, and designBuild() can only describe a shape as stacked ASCII
 * layers. Both are house-shaped tools. A road has to follow the ground, a bridge
 * has to find the gap, a garden has to sit on the flattest ground she has, a
 * retaining wall has to trace the contour. Those are terrain problems, so they
 * live here and emit the SAME schematic format everything else already eats
 * ({size, blocks:[{x,y,z,name,props}]}) — so planBuild, adaptSchematic,
 * placeSchematic and verifySchematic all work on them unchanged.
 *
 * Two rules the generators obey, both learned the hard way:
 *  1. No floating blocks. Anything placed above a gap gets a support column or a
 *     post down to the first solid block, and every generator reports the column.
 *  2. Generators are PURE over a heightmap. They take `ground(x,z)` rather than
 *     a bot, so they can be unit-tested offline (tests/landwork.test.mjs) with a
 *     fake hillside and no network. Only terrain() needs the bot.
 */

import * as schematic from './schematic.js';
import * as buildsense from './buildsense.js';
import * as skills from './skills.js';
import * as world from './world.js';
import Vec3 from 'vec3';

// ---------------------------------------------------------------- sampling

const AIR = new Set(['air', 'cave_air', 'void_air']);
// Things you can walk over / dig through — never "the ground".
const SOFT = new Set([
    'water', 'lava', 'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern',
    'dead_bush', 'snow', 'snow_layer', 'vine', 'torch', 'wall_torch', 'redstone_torch',
    'rail', 'sugar_cane', 'lily_pad', 'seagrass', 'kelp', 'poppy', 'dandelion',
    'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
    'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
    'sunflower', 'oxeye_daisy', 'sweet_berry_bush', 'light',
]);

export function isAirName(name) {
    return !name || AIR.has(name);
}

export function isGroundName(name) {
    return !!name && !AIR.has(name) && !SOFT.has(name);
}

/**
 * Highest solid, non-plant Y in a column, or null if the column is empty/unloaded.
 *
 * Water is deliberately NOT ground, so this returns a pond's FLOOR. That is right
 * for `level` and wrong for a road: given a lake, a road built on the floor sank
 * eleven blocks under the water and every placement failed on "can't reach". So
 * callers that lay a surface ask surfaceTop() as well and treat standing water as
 * something to span, not something to build on.
 */
export function columnTop(get, x, z, yHi, yLo) {
    for (let y = yHi; y >= yLo; y--) {
        let name = null;
        try { name = get(x, y, z); } catch (_) { return null; }
        if (isGroundName(name)) return y;
    }
    return null;
}

/**
 * Y of the topmost thing in a column INCLUDING water/lava — i.e. the level you
 * would stand on if you could stand on a lake. Returns the same null contract as
 * columnTop for empty/unloaded columns.
 */
export function columnSurfaceTop(get, x, z, yHi, yLo) {
    for (let y = yHi; y >= yLo; y--) {
        let name = null;
        try { name = get(x, y, z); } catch (_) { return null; }
        if (isGroundName(name) || name === 'water' || name === 'lava') return y;
    }
    return null;
}

/**
 * Live terrain sampler bound to the bot. Cached per (x,z) for the life of one
 * build: a generator asks for the same column many times while working out
 * stairs and supports, and blockAt is not free.
 */
export function terrainSampler(bot) {
    const p = bot.entity.position;
    const yHi = Math.min(320, Math.floor(p.y) + 48);
    const yLo = Math.max(-64, Math.floor(p.y) - 48);
    const cache = new Map();
    const get = (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        return b ? b.name : null;
    };
    /** Block name AND its state properties. Water's `level` is what separates a
     *  SOURCE (0 — it keeps generating) from flowing water (1-7 — it stops when
     *  you plug the source), so flood repair cannot work on names alone. */
    const getState = (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) return null;
        let props = {};
        try {
            const st = typeof b.getProperties === 'function' ? b.getProperties() : (b.metadata || null);
            if (st) props = st;
        } catch (_) {
            // A block with no readable state is normal on an older/forked
            // protocol; treat it as "no level" and let isSourceBlock decide.
            props = {};
        }
        return { name: b.name, level: props.level == null ? null : Number(props.level), props };
    };
    return {
        get,
        getState,
        yHi,
        yLo,
        top(x, z) {
            const k = `${x},${z}`;
            if (!cache.has(k)) cache.set(k, columnTop(get, x, z, yHi, yLo));
            return cache.get(k);
        },
        /**
         * True when the column holds standing water or lava at or above its
         * ground. A road must SPAN such a column (deck over the water) rather
         * than follow the pond floor: `top()` deliberately returns the floor,
         * and building there buries the whole road under the lake.
         */
        flooded(x, z) {
            const floor = this.top(x, z);
            if (floor == null) return false;
            const surf = columnSurfaceTop(get, x, z, yHi, yLo);
            if (surf == null || surf <= floor) return false;
            const name = get(x, surf, z);
            return name === 'water' || name === 'lava';
        },
        /**
         * Height of the standing water's SURFACE in a column, or null if the
         * column is dry. `top` returns the pond BED, which is why a deck built to
         * the bank height can still land level with the water when the bank is no
         * higher than the pond — the placer then refuses every cell as water.
         */
        waterTop(x, z) {
            const floor = this.top(x, z);
            if (floor == null) return null;
            const surf = columnSurfaceTop(get, x, z, yHi, yLo);
            if (surf == null || surf <= floor) return null;
            const name = get(x, surf, z);
            return name === 'water' || name === 'lava' ? surf : null;
        },
        /** Name of the topmost ground block in a column (null if unloaded). */
        topName(x, z) {
            const y = this.top(x, z);
            if (y == null) return null;
            return get(x, y, z);
        },
        isWater(x, z) {
            const y = this.top(x, z);
            return y != null && (get(x, y, z) === 'water' || get(x, y, z) === 'lava');
        },
        clear() { cache.clear(); },
    };
}

/** Distance from (x,z) to the segment (x1,z1)-(x2,z2), for width sweeps. */
function segDist(px, pz, x1, z1, x2, z2) {
    const dx = x2 - x1, dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    let t = len2 ? ((px - x1) * dx + (pz - z1) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cz = z1 + t * dz;
    return { d: Math.hypot(px - cx, pz - cz), t };
}

// ---------------------------------------------------------------- helpers

function blk(list, x, y, z, name, props) {
    list.push(props && Object.keys(props).length ? { x, y, z, name, props } : { x, y, z, name });
}

function finalize(name, blocks, extra = {}) {
    // Normalise to a min-corner-relative schematic, exactly what placeSchematic
    // expects. Generators work in world coords and hand that problem here.
    if (!blocks.length) return { name, size: { x: 1, y: 1, z: 1 }, blocks: [], empty: true, ...extra };
    const minX = Math.min(...blocks.map(b => b.x));
    const minY = Math.min(...blocks.map(b => b.y));
    const minZ = Math.min(...blocks.map(b => b.z));
    const maxX = Math.max(...blocks.map(b => b.x));
    const maxY = Math.max(...blocks.map(b => b.y));
    const maxZ = Math.max(...blocks.map(b => b.z));
    return {
        name,
        size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
        origin: { x: minX, y: minY, z: minZ },
        blocks: blocks.map(b => ({ ...b, x: b.x - minX, y: b.y - minY, z: b.z - minZ })),
        ...extra,
    };
}

/** Fill down from (x,y,z) to the first solid block so nothing is left floating. */
function support(ground, blocks, x, y, z, mat, report, minDepth = 3) {
    const bottom = ground.top(x, z);
    // No known floor under this column = a hole (ravine, chasm). Post a real
    // depth down instead of nothing: a one-block stub under a 7-wide chasm deck
    // is a bridge with nothing holding it up.
    const floor = bottom == null ? y - 1 - minDepth : bottom;
    for (let cy = y - 1; cy > floor; cy--) {
        const existing = blocks.find(b => b.x === x && b.y === cy && b.z === z);
        if (existing) continue;
        blk(blocks, x, cy, z, mat);
        if (report) report.supports++;
    }
}

/** Split a world-coord block list into <= max blocks chunks, each a schematic. */
export function chunk(schem, max) {
    const ox = schem.origin?.x ?? 0, oy = schem.origin?.y ?? 0, oz = schem.origin?.z ?? 0;
    const parts = [];
    for (let i = 0; i < schem.blocks.length; i += max) {
        const slice = schem.blocks.slice(i, i + max);
        const minX = Math.min(...slice.map(b => b.x + ox));
        const minY = Math.min(...slice.map(b => b.y + oy));
        const minZ = Math.min(...slice.map(b => b.z + oz));
        const maxX = Math.max(...slice.map(b => b.x + ox));
        const maxY = Math.max(...slice.map(b => b.y + oy));
        const maxZ = Math.max(...slice.map(b => b.z + oz));
        parts.push({
            name: `${schem.name} (${parts.length + 1})`,
            size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
            origin: { x: minX, y: minY, z: minZ },
            blocks: slice.map(b => ({ ...b, x: b.x + ox - minX, y: b.y + oy - minY, z: b.z + oz - minZ })),
        });
    }
    return parts;
}

// ---------------------------------------------------------------- road

// `path` is grass_path — pretty, but it has no crafting recipe or drop source
// that mcdata knows, so a default road came out "unknown: not gatherable or
// craftable" for its largest material class and could not be built at all. Dirt
// is diggable anywhere on the surface, so it is the default; ask for 'path'
// explicitly when she has wheat and dirt to make some.
export const ROAD_MATERIALS = {
    path: 'grass_path',
    dirt: 'dirt',
    gravel: 'gravel',
    cobble: 'cobblestone',
    stone: 'stone_bricks',
    plank: 'oak_planks',
    sand: 'sand',
    snow: 'snow',
};

/**
 * A road from (x1,z1) to (x2,z2) that sits ON the ground: it follows the
 * surface, steps up and down with stairs instead of teleporting, smooths small
 * bumps with fill/dirt, and throws a plank deck with posts across any gap wider
 * than a step. width=1 gives a trail; 3 gives a road you would actually build.
 *
 * Returns a schematic (world coords normalised) plus a report of what it did,
 * so the command can tell her honestly: metres, gap spans, fill columns.
 */

/**
 * A road from (x1,z1) to (x2,z2) that sits ON the ground: it follows the
 * surface, steps up and down with slabs instead of teleporting, smooths small
 * bumps with fill, and throws a plank deck with posts across any gap wider than
 * a step. width=1 gives a trail; 3 gives a road you would actually build.
 *
 * Two passes, deliberately. Pass 1 walks the CENTERLINE only and decides the
 * shape of the ground (surface height, gaps, drops); pass 2 sweeps the width
 * and emits blocks from that decided shape. Doing it per-cell instead makes
 * gap detection depend on which edge of the road you happen to sample first,
 * which silently produced decks in the wrong place.
 */
export function road(ground, a, b, opts = {}) {
    const {
        width = 3,
        material = 'dirt',
        fill = 'dirt',
        deck = 'oak_planks',
        maxStep = 1,        // vertical change the ground may have before it's a gap
        clear = 3,          // how far above the road to clear vegetation
        name = 'road',
    } = opts;
    const mat = ROAD_MATERIALS[material] || ROAD_MATERIALS.dirt;
    const blocks = [];
    const report = { length: 0, gapSpans: [], fills: 0, supports: 0, stairs: 0, ends: null, width, unloaded: 0 };

    const x1 = Math.round(a.x), z1 = Math.round(a.z), x2 = Math.round(b.x), z2 = Math.round(b.z);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1)));
    const dx = (x2 - x1) / steps, dz = (z2 - z1) / steps;
    const px = -dz, pz = dx;
    const pl = Math.hypot(px, pz) || 1;
    const offsets = [];
    for (let w = -Math.floor((width - 1) / 2); w <= Math.floor((width - 1) / 2); w += 1) offsets.push(w);
    const cxAt = (i, w = 0) => Math.round(x1 + dx * i + (px / pl) * w);
    const czAt = (i, w = 0) => Math.round(z1 + dz * i + (pz / pl) * w);

    // ---- pass 1: the ground along the centerline
    const line = [];
    for (let i = 0; i <= steps; i++) {
        const cx = cxAt(i), cz = czAt(i);
        const top = ground.top(cx, cz);
        if (top == null) report.unloaded++;
        // Standing water is not buildable ground: treat it like a hole so the
        // segmenter decks it as a bridge instead of paving the pond's floor.
        const wet = top != null && typeof ground.flooded === 'function' && ground.flooded(cx, cz);
        line.push({ i, cx, cz, top, flooded: wet });
    }
    const knownIdx = line.map((p, i) => (p.top == null ? -1 : i)).filter(i => i >= 0);
    if (!knownIdx.length) {
        return { name, size: { x: 1, y: 1, z: 1 }, blocks: [], report: { ...report, error: 'no loaded terrain along that line — walk there first' } };
    }
    // A column with no top is EITHER an unloaded chunk or a genuine hole. Do NOT
    // paper over it with the nearest height: that silently erased every ravine and
    // the road ran straight across them at ground level. Mark it a hole; the
    // segmenter then decks it. If the whole neighbourhood is also unread, the
    // caller gets a short build with `unloaded` in the report, not a lie.
    for (let i = 0; i <= steps; i++) {
        if (line[i].top != null) continue;
        let nearest = knownIdx[0];
        for (const k of knownIdx) if (Math.abs(k - i) < Math.abs(nearest - i)) nearest = k;
        line[i] = { ...line[i], hole: true, holeFloor: line[nearest].top };
    }
    // Same for standing water: deck it like a gap. The deck height must come from
    // a DRY neighbour — picking the nearest column of any kind hands back the next
    // pond cell (also 58) and the road quietly builds on the lake bed again.
    const dryIdx = line.map((p, i) => (p.top != null && !p.flooded ? i : -1)).filter(i => i >= 0);
    for (let i = 0; i <= steps; i++) {
        if (!line[i].flooded) continue;
        let nearest = dryIdx.length ? dryIdx[0] : null;
        if (nearest != null) for (const k of dryIdx) if (Math.abs(k - i) < Math.abs(nearest - i)) nearest = k;
        // The deck must clear the WATER, not just reach the bank's height. A bank
        // level with the pond surface puts the deck AT water level, and then the
        // placer correctly refuses every cell ("Skipping block ... because it is
        // water") while verification calls the road missing. Deck one above the
        // higher of the bank and the water surface.
        let floorY = nearest != null ? line[nearest].top : line[i].top;
        // Clear the water SURFACE, not the pond bed: `top` is the bed, so using it
        // here left the deck one block under the surface it has to span.
        const wTop = typeof ground.waterTop === 'function' ? ground.waterTop(line[i].cx, line[i].cz) : null;
        const clearAt = wTop != null ? wTop + 1 : (line[i].top != null ? line[i].top + 1 : null);
        if (floorY != null && clearAt != null) floorY = Math.max(floorY, clearAt);
        line[i] = { ...line[i], hole: true, holeFloor: floorY };
    }

    // Segment the line into runs of walkable ground separated by gaps.
    const segs = [];
    let cur = null;
    for (let i = 0; i <= steps; i++) {
        const p = line[i];
        const prev = i > 0 ? line[i - 1] : null;
        // A hole's deck height is holeFloor (the dry bank, lifted clear of the
        // water) — NOT its own column top. Using p.top put the deck exactly at
        // the water surface, so every cell over the pond was refused as water.
        const deckOf = (q) => (q == null ? null : (q.hole ? (q.holeFloor ?? q.top) : q.top));
        const jump = prev ? (deckOf(p) ?? deckOf(prev)) - (deckOf(prev) ?? 0) : 0;
        const isGap = prev && (p.hole || prev.hole || Math.abs(jump) > maxStep);
        if (!cur || isGap) {
            if (cur) { cur.gapTo = i; segs.push(cur); }
            const seed = deckOf(p) ?? deckOf(prev) ?? 0;
            cur = { from: i, to: i, startTop: seed, endTop: seed };
        } else {
            cur.to = i;
            cur.endTop = deckOf(p) ?? cur.endTop;
        }
    }
    segs.push(cur);

    // ---- pass 2: emit
    for (let s = 0; s < segs.length; s++) {
        const seg = segs[s];
        let carried = null;          // previous station's walking height
        for (let i = seg.from; i <= seg.to; i++) {
            const p = line[i];
            // Ride the ACTUAL surface of this cell. Taking the max of the whole
            // segment instead (an earlier version did) levels a hillside road to the
            // top of the hill: flat, and hanging in the air at the bottom.
            // A gap keeps its sampled `top` (a pond bed, a ravine floor) which is
            // exactly the height we must NOT build at. Use the deck height.
            let surface = p.hole ? (p.holeFloor ?? p.top) : p.top;
            for (const w of offsets) {
                if (p.hole) break;                 // a gap decks; don't take its floor
                const t = ground.top(cxAt(i, w), czAt(i, w));
                // A flooded neighbour must not drag the road down to the pond bed.
                if (t != null && !(typeof ground.flooded === 'function' && ground.flooded(cxAt(i, w), czAt(i, w)))) {
                    surface = surface == null ? t : Math.max(surface, t);
                }
            }
            if (surface == null) surface = p.holeFloor ?? seg.startTop;
            const walk = surface + 1;                 // the block you walk on
            for (const w of offsets) {
                const cx = cxAt(i, w), cz = czAt(i, w);
                // The surface block replaces the top of the ground column, so the
                // terrain's own 1-block step is the step you walk up. Putting a slab
                // on top of that (an earlier version did) made the step cell two
                // blocks higher than its neighbours — a 2-block wall to climb.
                const rise = carried == null ? 0 : walk - carried;
                if (rise !== 0) report.stairs++;
                blk(blocks, cx, walk - 1, cz, mat);
                // Fill only real ground up to the road. Over water there is nothing
                // to fill: `top()` hands back the pond bed, and filling from there
                // dropped a dirt column to the bottom of every lake the road crossed.
                const wet = typeof ground.flooded === 'function' && ground.flooded(cx, cz);
                const here = ground.top(cx, cz);
                const floor = (here == null || wet) ? walk - 1 : here;
                for (let y = floor + 1; y < walk - 1; y++) { blk(blocks, cx, y, cz, fill); report.fills++; }

                // Clear headroom: vegetation only, never a player's block.
                for (let dy = 0; dy <= clear; dy++) {
                    const n = ground.get(cx, walk + dy, cz);
                    if (n && SOFT.has(n)) blocks.push({ _clear: true, x: cx, y: walk + dy, z: cz, name: n });
                }
            }
            carried = walk;
        }
        // Deck the gaps between this segment and the next one.
        if (s < segs.length - 1 && segs[s + 1].from > seg.to) {
            const gy = Math.max(seg.endTop ?? 0, segs[s + 1].startTop ?? 0) + 1;
            const g0 = seg.to, g1 = segs[s + 1].from;
            for (let i = g0; i <= g1; i++) {
                for (const w of offsets) {
                    blk(blocks, cxAt(i, w), gy, czAt(i, w), deck);
                    if (i === g0 || i === g1 || (i - g0) % 3 === 0) {
                        support(ground, blocks, cxAt(i, w), gy - 1, czAt(i, w), 'oak_fence', report);
                    }
                }
            }
            const span = { from: { x: cxAt(g0), z: czAt(g0) }, to: { x: cxAt(g1), z: czAt(g1) }, length: g1 - g0 };
            // Merge with the previous span when it is directly adjacent: a 7-wide
            // ravine is ONE bridge, not seven 1-long ones (each with its own posts).
            const prev = report.gapSpans[report.gapSpans.length - 1];
            if (prev && prev.to.x === span.from.x && prev.to.z === span.from.z) {
                prev.to = span.to;
                prev.length += span.length;
            } else {
                report.gapSpans.push(span);
            }
        }
    }
    if (segs.length > 1) report.spans = segs.length;
    report.length = steps;

    const placed = blocks.filter(b => !b._clear);
    const out = finalize(name, placed, { report });
    out.report = report;
    out.clear = blocks.filter(b => b._clear).map(({ _clear, ...b }) => b);
    report.ends = { x: x2, z: z2 };
    return out;
}

function riseUpFacing(x1, z1, x2, z2) {
    // stairs face the way you climb: from the lower end toward the higher one
    if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) return x2 >= x1 ? 'east' : 'west';
    return z2 >= z1 ? 'south' : 'north';
}

// ---------------------------------------------------------------- bridge

/**
 * A bridge across a gap: deck at the higher of the two bank heights, joists
 * under it, posts every `postEvery` blocks down to the first solid block, and a
 * railing so it is not a suicide plank. Refuses to invent a gap — if the two
 * ends are at the same height with ground between, it says so instead.
 */
export function bridge(ground, a, b, opts = {}) {
    const {
        width = 3,
        deck = 'oak_planks',
        rail = 'oak_fence',
        post = 'oak_log',
        postEvery = 3,
        name = 'bridge',
    } = opts;
    const blocks = [];
    const report = { spans: 0, length: 0, posts: 0, gap: null };

    const x1 = Math.round(a.x), z1 = Math.round(a.z), x2 = Math.round(b.x), z2 = Math.round(b.z);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1)));
    const dx = (x2 - x1) / steps, dz = (z2 - z1) / steps;
    const px = -dz, pz = dx;
    const pl = Math.hypot(px, pz) || 1;
    const offsets = [];
    for (let w = -(width - 1) / 2; w <= (width - 1) / 2; w += 1) offsets.push(Math.round(w));

    const heights = [];
    for (let i = 0; i <= steps; i++) {
        heights.push(ground.top(Math.round(x1 + dx * i), Math.round(z1 + dz * i)));
    }
    const known = heights.filter(h => h != null);
    if (!known.length) return { name, size: { x: 1, y: 1, z: 1 }, blocks: [], report: { error: 'no terrain loaded at those points' } };
    const deckY = Math.max(...known);
    const holes = heights.filter(h => h == null || h < deckY - 2).length;
    report.gap = holes;

    for (let i = 0; i <= steps; i++) {
        const fx = x1 + dx * i, fz = z1 + dz * i;
        for (const w of offsets) {
            const cx = Math.round(fx + (px / pl) * w);
            const cz = Math.round(fz + (pz / pl) * w);
            blk(blocks, cx, deckY, cz, deck);
            if (i % postEvery === 0 || i === steps) {
                // post down to the floor, never a floating deck
                const floor = ground.top(cx, cz);
                const stop = floor == null ? deckY - 4 : floor;
                for (let y = deckY - 1; y > stop; y--) { blk(blocks, cx, y, cz, post); report.posts++; }
            }
        }
        // railing on both edges, only when width > 1
        if (width > 1 && i % 1 === 0) {
            for (const w of [offsets[0], offsets[offsets.length - 1]]) {
                const cx = Math.round(fx + (px / pl) * w);
                const cz = Math.round(fz + (pz / pl) * w);
                blk(blocks, cx, deckY + 1, cz, rail);
            }
        }
    }
    report.spans = 1;
    report.length = steps;
    const out = finalize(name, blocks, { report });
    out.report = report;
    return out;
}

// ---------------------------------------------------------------- terrace / retaining wall

/**
 * A retaining wall that traces a contour: walk from a to b and wherever the
 * ground DROPS AWAY on the far side, stack cobble up to hold the higher side
 * in. Also gives the cheapest, most useful land-shaping tool there is.
 */
export function retainingWall(ground, a, b, opts = {}) {
    const { mat = 'cobblestone', height = 3, name = 'retaining wall' } = opts;
    const blocks = [];
    const report = { length: 0, stacked: 0 };
    const x1 = Math.round(a.x), z1 = Math.round(a.z), x2 = Math.round(b.x), z2 = Math.round(b.z);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1)));
    const dx = (x2 - x1) / steps, dz = (z2 - z1) / steps;
    const px = -dz, pz = dx, pl = Math.hypot(px, pz) || 1;

    for (let i = 0; i <= steps; i++) {
        const fx = x1 + dx * i, fz = z1 + dz * i;
        report.length = i;
        for (let w = -1; w <= 1; w += 2) {
            const cx = Math.round(fx + (px / pl) * w);
            const cz = Math.round(fz + (pz / pl) * w);
            const here = ground.top(cx, cz);
            if (here == null) continue;
            // The ground to hold up: either the higher side across the line, or
            // the ground further along it. Without the second check a wall run
            // ALONG a cliff (rather than across it) finds no drop and builds
            // nothing at all, which is the common case for a hillside terrace.
            const across = ground.top(Math.round(fx - (px / pl) * w), Math.round(fz - (pz / pl) * w));
            const ahead = ground.top(Math.round(fx + dx * 3), Math.round(fz + dz * 3));
            const behind = ground.top(Math.round(fx - dx * 3), Math.round(fz - dz * 3));
            const higher = [across, ahead, behind].filter(h => h != null);
            const drop = higher.length ? Math.max(...higher) - here : 0;
            if (drop < 2) continue;
            for (let k = 1; k <= Math.min(height, drop); k++) {
                blk(blocks, cx, here + k, cz, mat);
                report.stacked++;
            }
        }
    }
    const out = finalize(name, blocks, { report });
    out.report = report;
    return out;
}

// ---------------------------------------------------------------- levelling

/**
 * Level a rectangle to its MEDIAN ground height (median, not mean: one cliff in
 * the middle of a flat plot should not drag the whole thing up a hill). Fill is
 * built out of the block that is actually underfoot where possible, so a levelled
 * lawn looks like a lawn.
 */
export function level(ground, centre, w, d, opts = {}) {
    const { fill = null, name = 'levelled ground' } = opts;
    const blocks = [];
    const report = { cells: 0, filled: 0, cut: 0, targetY: null, cuts: [] };
    const x0 = Math.round(centre.x - w / 2), z0 = Math.round(centre.z - d / 2);
    const heights = [];
    for (let z = z0; z < z0 + d; z++)
        for (let x = x0; x < x0 + w; x++) {
            const t = ground.top(x, z);
            if (t != null) heights.push(t);
        }
    if (!heights.length) return { name, size: { x: 1, y: 1, z: 1 }, blocks: [], report: { error: 'no loaded terrain in that square' } };
    heights.sort((a, b) => a - b);
    const targetY = heights[Math.floor(heights.length / 2)];
    report.targetY = targetY;

    for (let z = z0; z < z0 + d; z++)
        for (let x = x0; x < x0 + w; x++) {
            const t = ground.top(x, z);
            if (t == null) continue;
            report.cells++;
            const mat = fill || ground.get(x, t, z) || 'dirt';
            if (t < targetY) {
                for (let y = t + 1; y <= targetY; y++) blk(blocks, x, y, z, mat);
                report.filled += targetY - t;
            } else if (t > targetY) {
                // Cutting means breaking blocks — recorded, not silently done.
                for (let y = targetY + 1; y <= t; y++) report.cuts.push({ x, y, z, name: ground.get(x, y, z) });
                report.cut += t - targetY;
            } else {
                // One made-surface block on top of ground that is already at the
                // target, so the plot reads as built rather than as raw terrain.
                // Cells that need CUTTING get nothing placed: capping them would
                // rebuild the very spike the level is meant to remove.
                blk(blocks, x, t + 1, z, mat);
            }
        }
    const out = finalize(name, blocks, { report });
    out.report = report;
    return out;
}

// ---------------------------------------------------------------- stairs

/** Cut a walkable stair run up or down a slope between two points. */
export function stairs(ground, a, b, opts = {}) {
    const { mat = 'stone_bricks', name = 'stairs' } = opts;
    const blocks = [];
    const report = { steps: 0, rise: 0 };
    const x1 = Math.round(a.x), z1 = Math.round(a.z), x2 = Math.round(b.x), z2 = Math.round(b.z);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1)));
    const t1 = ground.top(x1, z1), t2 = ground.top(x2, z2);
    if (t1 == null || t2 == null) return { name, size: { x: 1, y: 1, z: 1 }, blocks: [], report: { error: 'terrain not loaded at one end' } };
    const facing = riseUpFacing(x1, z1, x2, z2);
    const rise = t2 - t1;
    report.rise = rise;
    for (let i = 0; i <= steps; i++) {
        const x = Math.round(x1 + ((x2 - x1) * i) / steps);
        const z = Math.round(z1 + ((z2 - z1) * i) / steps);
        // Ride the LOCAL ground as well as the straight run between the ends:
        // a straight line between two points on a stepped slope leaves the treads
        // hanging in the air halfway along.
        const local = ground.top(x, z);
        const y = local == null ? Math.round(t1 + (rise * i) / steps) : Math.max(Math.round(t1 + (rise * i) / steps), local);
        blk(blocks, x, y, z, 'stone_stairs', { facing, half: rise >= 0 ? 'bottom' : 'top' });
        // support under the run so it is not a floating ribbon
        const floor = local;
        const stop = floor == null ? y - 1 : Math.min(floor, y - 1);
        for (let cy = y - 1; cy > stop; cy--) blk(blocks, x, cy, z, 'cobblestone');
        report.steps++;
    }
    const out = finalize(name, blocks, { report });
    out.report = report;
    return out;
}

// ---------------------------------------------------------------- garden

const GARDEN_SOILS = { plains: 'farmland', desert: 'sand', swamp: 'dirt', forest: 'dirt', jungle: 'dirt', taiga: 'dirt' };

/**
 * A garden on the flattest square she can find near a point: tilled beds in
 * rows, a path through the middle, a water border on one edge, a fence round the
 * edge, and a torch or two. She picks the site by scanning candidate squares and
 * taking the one with the smallest height spread — a garden on a 6-block slope
 * is a compost heap, not a garden.
 */
export function garden(ground, near, opts = {}) {
    const {
        size = 7,
        searchRadius = 24,
        biome = 'plains',
        path = 'gravel',
        fence = 'oak_fence',
        crop = 'wheat_seeds',
        water = true,
        name = 'garden',
    } = opts;
    const soil = GARDEN_SOILS[biome] || 'dirt';
    const report = { site: null, tried: 0, spread: null, beds: 0, reason: null };

    // Find the flattest w x w square around `near`.
    let best = null;
    for (let r = 0; r <= searchRadius; r += 2) {
        for (let dz = -r; dz <= r; dz += Math.max(2, r)) {
            for (let dx = -r; dx <= r; dx += Math.max(2, r)) {
                const cx = Math.round(near.x + dx), cz = Math.round(near.z + dz);
                const hs = [];
                let ok = true;
                for (let z = cz - (size >> 1); z <= cz + (size >> 1) && ok; z++)
                    for (let x = cx - (size >> 1); x <= cx + (size >> 1); x++) {
                        const t = ground.top(x, z);
                        if (t == null) { ok = false; break; }
                        hs.push(t);
                    }
                report.tried++;
                if (!ok) continue;
                const spread = Math.max(...hs) - Math.min(...hs);
                if (!best || spread < best.spread) best = { cx, cz, spread, y: Math.round(hs.sort((a, b) => a - b)[hs.length >> 1]) };
                if (best.spread <= 1) { r = searchRadius; break; }
            }
        }
        if (best && best.spread <= 1) break;
    }
    if (!best) return { name, size: { x: 1, y: 1, z: 1 }, blocks: [], report: { ...report, error: 'no flat, loaded square big enough near here' } };
    report.site = { x: best.cx, y: best.y, z: best.cz };
    report.spread = best.spread;

    const blocks = [];
    const half = size >> 1;
    for (let z = best.cz - half; z <= best.cz + half; z++)
        for (let x = best.cx - half; x <= best.cx + half; x++) {
            const t = ground.top(x, z);
            if (t == null) continue;
            // level fill so beds are not floating or buried
            for (let y = t + 1; y <= best.y; y++) blk(blocks, x, y, z, soil === 'farmland' ? 'dirt' : soil);
            const y = best.y + 1;
            const onPath = x === best.cx || z === best.cz;
            const edge = x === best.cx - half || x === best.cx + half || z === best.cz - half || z === best.cz + half;
            if (onPath) blk(blocks, x, y, z, path);
            else { blk(blocks, x, y, z, soil); report.beds++; }
            void edge;
        }
    // fence ring one outside the beds, water channel on the +x edge
    for (let z = best.cz - half - 1; z <= best.cz + half + 1; z++) {
        blk(blocks, best.cx - half - 1, best.y + 1, z, fence);
        blk(blocks, best.cx + half + 1, best.y + 1, z, water ? 'water' : fence);
    }
    for (let x = best.cx - half; x <= best.cx + half; x++) {
        blk(blocks, x, best.y + 1, best.cz - half - 1, fence);
        blk(blocks, x, best.y + 1, best.cz + half + 1, fence);
    }
    // crop seeds on the beds — she plants them if she has any
    report.crop = crop;
    const out = finalize(name, blocks, { report, bedRows: size - 2, soil });
    out.report = report;
    return out;
}

// ---------------------------------------------------------------- repair

/**
 * What is missing from a build that is already standing: compare every expected
 * cell against the world and return ONLY the blocks that need placing. This is
 * the "fix my build" path — it never rebuilds, never clears, never re-gathers a
 * material she does not need.
 */
export function diffAgainstWorld(schem, worldGet, origin, opts = {}) {
    const ignoreAge = opts.ignoreAge !== false;
    const fix = [];
    const missing = [];
    const wrong = [];
    const extra = [];
    const ox = Math.floor(origin.x), oy = Math.floor(origin.y), oz = Math.floor(origin.z);
    for (const b of schem.blocks) {
        const x = ox + b.x, y = oy + b.y, z = oz + b.z;
        let name = null;
        try { name = worldGet(x, y, z); } catch (_) { continue; }
        if (isAirName(name)) { missing.push({ x, y, z, name: b.name }); fix.push({ ...b, worldX: x, worldY: y, worldZ: z }); continue; }
        if (name !== b.name) { wrong.push({ x, y, z, expected: b.name, found: name }); }
    }
    // EXTRA sweep: solid where the design says air (strays to REPORT — this
    // function never removes anything). A Set, not .some() per cell: the naive
    // form is O(footprint x blocks) and a 10k-cell build spends seconds on it.
    const { x: sx, y: sy, z: sz } = schem.size;
    const wanted = new Set(schem.blocks.map(b => `${b.x},${b.y},${b.z}`));
    for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++)
            for (let z = 0; z < sz; z++) {
                let name = null;
                try { name = worldGet(ox + x, oy + y, oz + z); } catch (_) { continue; }
                if (isAirName(name)) continue;
                if (!wanted.has(`${x},${y},${z}`) && !SOFT.has(name)) extra.push({ x: ox + x, y: oy + y, z: oz + z, name });
            }
    return { fix, missing, wrong, extra, ignoreAge };
}

/**
 * Extend a standing build: re-generate the same kind of thing, attached to its
 * existing footprint, returning only the NEW cells (no double-placing what is
 * already there). `extendFn` is any landwork generator.
 */
export function extend(schem, origin, extendFn, opts = {}) {
    const sx = schem.size.x, sy = schem.size.y, sz = schem.size.z;
    const dir = opts.dir || 'east';
    const gap = opts.gap ?? 1;
    const ox = Math.floor(origin.x), oy = Math.floor(origin.y), oz = Math.floor(origin.z);
    const attach = {
        east: { x: ox + sx + gap, z: oz },
        west: { x: ox - gap, z: oz },
        south: { x: ox, z: oz + sz + gap },
        north: { x: ox, z: oz - gap },
        up: { x: ox, z: oz },
    }[dir] || { x: ox + sx + gap, z: oz };
    const far = {
        east: { x: attach.x + (opts.length ?? sx), z: oz },
        west: { x: attach.x - (opts.length ?? sx), z: oz },
        south: { x: ox, z: attach.z + (opts.length ?? sz) },
        north: { x: ox, z: attach.z - (opts.length ?? sz) },
        up: { x: ox, z: oz + sz },
    }[dir];
    const added = extendFn(attach, far, opts);
    // added.blocks are MIN-CORNER-RELATIVE to added.origin, so convert to world
    // before testing against the old footprint. Comparing relatives against
    // world coords (the obvious version of this) filters nothing and
    // re-places the whole old build.
    const ax = added.origin?.x ?? 0, ay = added.origin?.y ?? 0, az = added.origin?.z ?? 0;
    const worldBlocks = added.blocks
        .map(b => ({ ...b, x: ax + b.x, y: ay + b.y, z: az + b.z }))
        .filter(b => !(b.x >= ox && b.x < ox + sx && b.y >= oy && b.y < oy + sy && b.z >= oz && b.z < oz + sz));
    // finalize() expects WORLD coords and subtracts the min corner itself — passing
    // the relatives straight through shifts the whole extension by its own origin.
    const out = finalize(`${schem.name} extended ${dir}`, worldBlocks);
    out.report = added.report;
    out.dir = dir;
    return out;
}

// ---------------------------------------------------------------- planning / execution

/**
 * Turn a generated schematic into the same actionable plan she gets for a
 * design, so she can be honest about whether she has the dirt before she starts
 * moving it. Returns buildsense.planBuild output plus the generator's report.
 */
export function planGenerated(bot, sch) {
    const adapted = buildsense.adaptSchematic(bot, sch);
    return {
        plan: buildsense.planBuild(bot, adapted.schematic),
        adaptation: adapted.changes,
        schematic: adapted.schematic,
        report: sch.report,
    };
}

/**
 * Place a generated schematic in chunks, so a 400-block road is bounded by the
 * paste cap rather than refused. Uses the real paste path (gather + hand-place
 * + verify), chunk by chunk, and returns honest per-chunk numbers.
 */
export async function placeGenerated(bot, sch, opts = {}) {
    const max = opts.max ?? 4000;
    // opts.place lets a caller (and the offline tests) substitute the
    // by-hand placement itself while keeping the chunking, verification and
    // reporting here identical. Production always uses placeSchematic.
    const place = opts.place
    || ((b, part, origin) => schematic.placeSchematic(b, part, origin, 0, part.name));
    const parts = chunk(sch, max);
    const summary = { chunks: parts.length, placed: 0, of: sch.blocks.length, faults: 0, cleared: 0, parts: [] };
    for (const part of parts) {
        // chunk() already resolves each part's own world origin; an override
        // shifts the whole build (a garden placed on the site it chose).
        const origin = opts.originOverride
            ? { x: part.origin.x + (opts.originOverride.x - sch.origin.x),
                y: part.origin.y + (opts.originOverride.y - sch.origin.y),
                z: part.origin.z + (opts.originOverride.z - sch.origin.z) }
            : part.origin;
        const placed = await place(bot, part, origin);
        let v = await schematic.verifySchematic(bot, part, origin, 0);
        while (!v.done) v = await schematic.verifySchematic(bot, part, origin, 0);
        summary.placed += placed;
        summary.faults += (v.missing || 0) + (v.wrongBlock || 0) + (v.wrongState || 0);
        summary.parts.push({ name: part.name, size: part.size, placed, faults: (v.missing || 0) + (v.wrongBlock || 0) + (v.wrongState || 0) });
    }
    // vegetation cleared last, after the surface exists to stand on
    if (sch.clear && sch.clear.length) {
        for (const c of sch.clear) {
            if (opts.skipClear) continue;
            try {
                await skills.breakBlockAt(bot, c.x, c.y, c.z);
                summary.cleared++;
            } catch (_) {
                // one unbreakable plant must not abandon the rest of the sweep
            }
        }
    }
    return summary;
}

/** One-line honest description of what a generator did, for chat/logging. */
export function describe(sch) {
    const r = sch.report || {};
    const bits = [];
    if (r.length) bits.push(`${r.length} long`);
    if (r.width) bits.push(`${r.width} wide`);
    if (r.stairs) bits.push(`${r.stairs} steps`);
    if (r.fills) bits.push(`${r.fills} fill`);
    if (r.gapSpans?.length) bits.push(`${r.gapSpans.length} gap span${r.gapSpans.length === 1 ? '' : 's'}`);
    if (r.posts) bits.push(`${r.posts} post blocks`);
    if (r.targetY != null) bits.push(`levelled to y${r.targetY}`);
    if (r.beds) bits.push(`${r.beds} bed cells`);
    if (r.spread != null) bits.push(`site spread ${r.spread}`);
    if (r.cut) bits.push(`${r.cut} blocks to cut by hand`);
    return bits.join(', ') || 'nothing to do';
}

export { schematic, buildsense, skills, world };

// ---------------------------------------------------------------------------
// FLOOD REPAIR
//
// Spawn floods. Patching the water is the same shape of job as everything else
// here: survey the terrain, find where the water actually comes from, plan a
// cheap fix, place it, then verify. Two phases, because plugging a source and
// reclaiming the ground it drowned are separate pieces of work separated by the
// time it takes water to recede:
//
//   1. PLUG — find water SOURCE blocks (level 0) and put one cheap solid block
//      in each. A source keeps generating forever; flowing water stops as soon
//      as its source is gone, so plugging sources is the only durable fix.
//   2. RETAKE — once the water has receded, fill the air it left with ground.
//      Never run this before the water is actually gone, or she rebuilds the
//      basin she was trying to drain.
//
// An empty bucket works too and leaves no block behind, so the placer is told
// which method to use rather than hardcoding one. Both are offered; the caller
// picks by what she is carrying.

/** Cheap blocks that stop water, best first. Anything solid and non-liquid. */
export const FLOOD_PLUGS = ['cobblestone', 'dirt', 'gravel', 'sand', 'netherrack'];

/**
 * A water block is a SOURCE if its `level` is 0 (or absent — some forks omit
 * level on still water). Level 1-7 is flowing: harmless to leave, it disappears
 * once the source is plugged.
 */
export function isSourceBlock(st) {
    if (!st || (st.name !== 'water' && st.name !== 'flowing_water')) return false;
    if (st.level == null) return true;
    return st.level === 0;
}

/**
 * Survey an area for water and classify it.
 * Returns { sources, flowing, extent, volume } in WORLD coordinates.
 * `radius` is in blocks around `centre`; `ySpan` how far up/down to look.
 */
export function surveyFlood(ground, centre, radius = 12, ySpan = 12) {
    const sources = [];
    const flowing = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    const read = (x, y, z) => (typeof ground.getState === 'function'
        ? ground.getState(x, y, z)
        : (() => { const n = ground.get(x, y, z); return n == null ? null : { name: n, level: null }; })());

    for (let x = Math.round(centre.x - radius); x <= Math.round(centre.x + radius); x++) {
        for (let z = Math.round(centre.z - radius); z <= Math.round(centre.z + radius); z++) {
            for (let y = Math.round(centre.y - ySpan); y <= Math.round(centre.y + ySpan); y++) {
                const st = read(x, y, z);
                if (!st || (st.name !== 'water' && st.name !== 'flowing_water')) continue;
                if (minX > x) minX = x; if (maxX < x) maxX = x;
                if (minZ > z) minZ = z; if (maxZ < z) maxZ = z;
                if (minY > y) minY = y; if (maxY < y) maxY = y;
                (isSourceBlock(st) ? sources : flowing).push({ x, y, z });
            }
        }
    }
    if (!sources.length && !flowing.length) {
        return { sources: [], flowing: [], extent: null, volume: 0, dry: true };
    }
    return {
        sources, flowing,
        extent: { minX, maxX, minY, maxY, minZ, maxZ },
        volume: sources.length + flowing.length,
        dry: false,
    };
}

/**
 * Pick the sources actually worth plugging.
 *
 * A lake is not a leak. Every water surface has source blocks in it, so
 * "plug every source" means paving a pond with cobblestone — on the real spawn
 * area that was 124 blocks for 4 real culprits. A source is a genuine leak when
 * it is FEEDING water that is not itself a stable pool: either it is isolated
 * (nothing else nearby is a source) or it sits at the low edge of a body of
 * water that has spread far and deep below it.
 *
 * Returns { plugs, ponds } — the sources to stop, and the stable pools to leave
 * alone. Reporting both matters: "I left 46 sources because that is a pond" is
 * a different and more useful answer than a number.
 */
export function classifySources(survey, opts = {}) {
    const srcs = survey.sources;
    if (!srcs.length) return { plugs: [], ponds: [], isolated: [] };
    const near = (a, b, dx, dy, dz) =>
        Math.abs(a.x - b.x) <= dx && Math.abs(a.y - b.y) <= dy && Math.abs(a.z - b.z) <= dz;
    // Group sources into clusters. A cluster of many sources close together is a
    // body of water, not a leak.
    const clusters = [];
    for (const s of srcs) {
        let hit = null;
        for (const c of clusters) if (near(s, c.members[0], 6, 3, 6)) { hit = c; break; }
        if (hit) hit.members.push(s);
        else clusters.push({ members: [s] });
    }

    const plugs = [];
    const ponds = [];
    for (const c of clusters) {
        if (c.members.length === 1) {
            // A lone source is a leak — unless the water it feeds is trivial.
            plugs.push(...c.members);
            continue;
        }
        // Many sources together: a pool. Only treat it as a leak if it is also
        // feeding water that has run far below and outside it.
        const ys = c.members.map(m => m.y);
        const lowY = Math.min(...ys);
        const low = c.members.filter(m => m.y === lowY);
        const spread = survey.extent
            ? Math.max(survey.extent.maxX - survey.extent.minX, survey.extent.maxZ - survey.extent.minZ)
            : 0;
        const deep = survey.extent ? survey.extent.minY < lowY - 1 : false;
        if (opts.aggressive && deep && spread > (opts.spreadLimit || 12)) {
            // Plug only the LOWEST edge — that is what actually drains it.
            plugs.push(...low);
        } else {
            ponds.push(...c.members);
        }
    }
    const isolated = plugs.slice();
    return { plugs, ponds, isolated, clusters: clusters.length };
}

/**
 * Plan phase 1: one plug block per water SOURCE, in the schematic format
 * everything else here uses, so it plans, chunks, places and verifies through
 * exactly the same path as a road.
 *
 * `material` is the cheap block to use. Sources are placed highest-first so a
 * plug never ends up underwater before she can reach it.
 */
export function floodPlugPlan(survey, origin, opts = {}) {
    const material = opts.material || 'cobblestone';
    // Plug the leaks, not the ponds. `all` overrides, and is what you want when
    // she genuinely means "stop every drop of water here".
    const targets = opts.all ? survey.sources : (opts.plugs || survey.sources);
    const blocks = targets
        .slice()
        .sort((a, b) => b.y - a.y)
        .map(s => ({
            x: s.x - origin.x,
            y: s.y - origin.y,
            z: s.z - origin.z,
            name: material,
            props: {},
        }));
    const report = {
        sources: survey.sources.length,
        flowing: survey.flowing.length,
        material,
        volume: survey.volume,
        plugging: targets.length,
        pondsLeft: survey.sources.length - targets.length,
        ponds: opts.ponds ? opts.ponds.length : 0,
    };
    const size = blocks.reduce(
        (acc, b) => ({
            x: Math.max(acc.x, b.x + 1), y: Math.max(acc.y, b.y + 1), z: Math.max(acc.z, b.z + 1),
        }),
        { x: 0, y: 0, z: 0 },
    );
    return { name: opts.name || 'flood plug', size, blocks, origin, report };
}

/**
 * Plan phase 2: the ground the flood drowned, to be re-laid once the water is
 * gone. Only cells that are AIR or water right now are planned — anything still
 * holding its original block is left alone, so this cannot flatten terrain she
 * did not flood. Refuses to run while sources remain, which is the whole point
 * of doing this in two phases.
 */
export function floodRetakePlan(survey, origin, opts = {}) {
    const ground = opts.ground;
    const material = opts.material || 'dirt';
    const leftover = survey.sources.length;
    const cells = [];
    // Refuse BEFORE planning a single cell. Building the basin she is trying to
    // drain is worse than doing nothing: the water just fills it again.
    if (leftover > 0) {
        return {
            name: opts.name || 'flood retake',
            size: { x: 0, y: 0, z: 0 },
            blocks: [],
            origin,
            report: {
                retake: 0,
                material,
                blocked: true,
                leftoverSources: leftover,
                reason: `${leftover} water source(s) still flowing — plug them before retaking ground`,
            },
        };
    }
    if (ground) {
        const e = survey.extent;
        const read = (x, y, z) => (typeof ground.get === 'function' ? ground.get(x, y, z) : null);
        for (let x = e.minX; x <= e.maxX; x++) {
            for (let z = e.minZ; z <= e.maxZ; z++) {
                for (let y = e.minY; y <= e.maxY; y++) {
                    const n = read(x, y, z);
                    if (n !== 'air' && n !== 'water') continue;
                    cells.push({
                        x: x - origin.x, y: y - origin.y, z: z - origin.z,
                        name: material, props: {},
                    });
                }
            }
        }
    }
    const size = cells.reduce(
        (acc, b) => ({
            x: Math.max(acc.x, b.x + 1), y: Math.max(acc.y, b.y + 1), z: Math.max(acc.z, b.z + 1),
        }),
        { x: 0, y: 0, z: 0 },
    );
    return {
        name: opts.name || 'flood retake',
        size, blocks: cells, origin,
        report: {
            retake: cells.length,
            material,
            // Refuse honestly rather than building a basin she is trying to drain.
            blocked: leftover > 0,
            leftoverSources: leftover,
            reason: leftover > 0
                ? `${leftover} water source(s) still flowing — plug them before retaking ground`
                : null,
        },
    };
}
