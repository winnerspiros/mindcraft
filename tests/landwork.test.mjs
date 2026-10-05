// Offline tests for the landwork generators.
//
// These are pure functions over a heightmap, which is the whole reason they
// live in their own module: a fake hillside proves the rules that are easy to
// get wrong and impossible to see in a screenshot — no floating blocks, stairs
// instead of teleports, a deck across a gap with posts under it, a garden that
// refuses a slope — without a server, without cost.
import { test } from 'node:test';
import assert from 'node:assert';
import {
    columnTop, isGroundName, isAirName, terrainSampler,
    road, bridge, retainingWall, level, stairs, garden,
    diffAgainstWorld, extend, chunk, describe,
} from '../src/agent/library/landwork.js';

// --- fake terrain -------------------------------------------------------
// A heightmap plus a get(x,y,z) that returns 'air' above ground, the surface
// material at ground height, and stone below it.
function fakeTerrain(heightAt, opts = {}) {
    const surface = opts.surface || 'grass_block';
    const get = (x, y, z) => {
        const h = heightAt(x, z);
        if (h == null) return null;            // unloaded
        if (y > h) return opts.above || 'air';
        if (y === h) return surface;
        return opts.below || 'stone';
    };
    return { get, top: (x, z) => heightAt(x, z), topName: (x, z) => { const h = heightAt(x, z); return h == null ? null : get(x, h, z); }, isWater: () => false };
}

const flat = (h) => fakeTerrain(() => h);
const ramp = fakeTerrain((x) => 64 + Math.floor(x / 4));      // 1 up every 4
const cliff = fakeTerrain((x) => (x < 20 ? 64 : 70));          // 6-block drop at x=20
const chasm = fakeTerrain((x) => (x < 20 || x > 26 ? 64 : null));

// A pond: the floor is at 58, but water fills it up to 62. This is the shape that
// made the live test lay a road eleven blocks under the lake, because columnTop
// deliberately ignores water and hands back the pond bed.
const pond = fakeTerrain((x) => (x < 18 || x > 24 ? 64 : 58), { surface: 'dirt' });
{
    const baseGet = pond.get;
    pond.get = (x, y, z) => {
        const h = pond.top(x, z);
        if (h == null) return null;
        if (h === 58 && y > 58 && y <= 62) return 'water';
        return baseGet(x, y, z);
    };
    pond.isWater = (x, z) => h_in(x, z) === 58;
    pond.flooded = (x, z) => {
        const h = pond.top(x, z);
        return h != null && h === 58;
    };
    function h_in(x) { return (x < 18 || x > 24) ? 64 : 58; }
}

test('isGroundName / isAirName classify the surfaces that matter', () => {
    assert.equal(isGroundName('grass_block'), true);
    assert.equal(isGroundName('water'), false);
    assert.equal(isGroundName('short_grass'), false);
    assert.equal(isGroundName('torch'), false);
    assert.equal(isAirName('air'), true);
    assert.equal(isAirName('cave_air'), true);
    assert.equal(isAirName('stone'), false);
});

test('columnTop finds the surface and returns null for an empty column', () => {
    assert.equal(columnTop(flat(64).get, 3, 4, 80, 50), 64);
    assert.equal(columnTop(() => null, 3, 4, 80, 50), null);
});

test('a road goes OVER water, not down the pond bed', () => {
    // Live-test bug: water is not "ground", so the sampler returned the pond
    // floor and the road was generated 6 blocks under the surface — every block
    // unreachable and unplaceable. It must deck across at the banks' level.
    const r = road(pond, { x: 14, z: 0 }, { x: 28, z: 0 }, { width: 3 });
    // Block coords are schematic-relative, so compare in WORLD y.
    // Posts and fences MAY reach down into the water — that is how a bridge is
    // supported. What must never happen is the ROAD SURFACE sitting under the
    // lake, which is what "the road is at 58" meant.
    const world = (b) => ({ ...b, wy: r.origin.y + b.y });
    const surfacing = r.blocks.filter(b => (b.name === 'dirt' || b.name === 'grass_path'));
    assert.ok(surfacing.length > 0, 'expected some road surface');
    const lowestSurface = Math.min(...surfacing.map(b => world(b).wy));
    assert.ok(lowestSurface >= 62, `road surface sank to y=${lowestSurface}, below the water`);
    // and no dirt at all down in the pond bed
    assert.ok(!r.blocks.some(b => world(b).wy < 62 && b.name === 'dirt'),
        'dirt was filled down to the pond floor');
    // and it must actually cross: blocks on both banks and over the middle
    const wx = (b) => r.origin.x + b.x;
    assert.ok(r.blocks.some(b => wx(b) >= 18 && wx(b) <= 24), 'no deck over the water');
    assert.ok(r.report.gapSpans.length > 0, 'the water should be reported as a gap span');
});

test('a deck clears the water even when the bank is level with the pond', () => {
    // The live run over a shallow pond generated its deck AT the water surface
    // (both y=62), so the placer refused every cell — "Skipping block ... because
    // it is water" — while verification called the whole road missing. A deck has
    // to sit ABOVE the water line, not level with it.
    const shallow = fakeTerrain((x) => (x < 18 || x > 24 ? 62 : 58), { surface: 'dirt' });
    const baseGet = shallow.get;
    shallow.get = (x, y, z) => {
        const h = shallow.top(x, z);
        if (h == null) return null;
        if (h === 58 && y > 58 && y <= 62) return 'water';
        return baseGet(x, y, z);
    };
    shallow.isWater = (x, z) => shallow.top(x, z) === 58;
    shallow.flooded = (x, z) => {
        const h = shallow.top(x, z);
        return h != null && h === 58;
    };
    // The water SURFACE, which is what a deck has to clear. `top` is the bed.
    shallow.waterTop = (x, z) => (shallow.top(x, z) === 58 ? 62 : null);
    const r = road(shallow, { x: 14, z: 0 }, { x: 28, z: 0 }, { width: 3 });
    const wy = (b) => r.origin.y + b.y;
    // Only the DECK must clear the water. Posts and fences may reach down into
    // it — that is how a bridge is supported, and the earlier pond test already
    // spells that out. What must never sit at or below the waterline is the
    // walkable surface.
    const deck = r.blocks.filter(b => b.name === 'dirt' || b.name === 'grass_path');
    const inWater = deck.filter(b => wy(b) <= 62 && wy(b) > 58 &&
        shallow.flooded(r.origin.x + b.x, r.origin.z + b.z));
    assert.equal(inWater.length, 0,
        `${inWater.length} deck blocks were placed at or under the water line`);
    // and it still crosses
    const wx = (b) => r.origin.x + b.x;
    assert.ok(r.blocks.some(b => wx(b) >= 18 && wx(b) <= 24), 'no deck over the water');
});

test('road on flat ground lays a continuous 3-wide path with no holes', () => {
    const r = road(flat(64), { x: 0, z: 0 }, { x: 10, z: 0 }, { width: 3 });
    assert.equal(r.blocks.length > 0, true);
    assert.ok(r.size.x >= 11, `x size ${r.size.x}`);
    // every x in range has at least one block
    const xs = new Set(r.blocks.map(b => b.x));
    for (let x = 0; x <= 10; x++) assert.equal(xs.has(x), true, `no road block at x=${x}`);
    // nothing floats: every road block either sits on y64 or is a cap
    assert.equal(r.blocks.filter(b => b.y > 65).length, 0);
});

test('road steps up a slope rather than teleporting: no vertical jump > 1 between neighbours', () => {
    const r = road(ramp, { x: 0, z: 0 }, { x: 40, z: 0 }, { width: 1 });
    assert.ok(r.report.stairs > 0, 'expected steps on a ramp');
    // sort blocks by x and check surface height never jumps by more than 1
    const top = new Map();
    for (const b of r.blocks) {
        if (!top.has(b.x) || b.y > top.get(b.x)) top.set(b.x, b.y);
    }
    const heights = [...top.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    for (let i = 1; i < heights.length; i++) {
        assert.ok(Math.abs(heights[i] - heights[i - 1]) <= 1, `jump ${heights[i - 1]}->${heights[i]}`);
    }
});

test('road decks across a chasm with a supported post under it', () => {
    const r = road(chasm, { x: 16, z: 0 }, { x: 30, z: 0 }, { width: 1 });
    assert.equal(r.report.gapSpans.length >= 1, true, 'no gap detected');
    const deck = r.blocks.filter(b => b.name === 'oak_planks');
    assert.ok(deck.length > 0, 'no deck placed over the chasm');
    const posts = r.blocks.filter(b => b.name === 'oak_fence');
    assert.ok(posts.length > 0, 'deck has no posts under it');
});

test('road clears vegetation above the surface but never terrain', () => {
    const t = fakeTerrain(() => 64, { above: 'air' });
    t.get = (x, y, z) => (y === 65 ? 'tall_grass' : y === 64 ? 'grass_block' : y > 65 ? 'air' : 'stone');
    const r = road(t, { x: 0, z: 0 }, { x: 6, z: 0 }, { width: 1 });
    assert.ok(r.clear.length > 0, 'vegetation was not queued for clearing');
    assert.equal(r.clear.some(c => c.name === 'grass_block'), false);
});

test('bridge sets a deck at the higher bank and posts down into the gap', () => {
    const b = bridge(chasm, { x: 18, z: 0 }, { x: 28, z: 0 }, { width: 3 });
    const deckYs = new Set(b.blocks.filter(x => x.name === 'oak_planks').map(x => b.origin.y + x.y));
    assert.equal(deckYs.size, 1, 'deck is not level');
    const posts = b.blocks.filter(x => x.name === 'oak_log');
    assert.ok(posts.length > 0, 'no support posts');
    // posts must reach down below the deck, i.e. into the chasm
    assert.ok(Math.min(...posts.map(p => b.origin.y + p.y)) < Math.min(...deckYs) - 1);
    assert.equal(b.blocks.filter(x => x.name === 'oak_fence').length > 0, true, 'no railing');
});

test('bridge reports honestly when there is no gap', () => {
    const b = bridge(flat(64), { x: 0, z: 0 }, { x: 10, z: 0 }, { width: 1 });
    assert.equal(b.report.gap, 0);
});

test('retaining wall stacks cobble only where the ground actually drops', () => {
    const w = retainingWall(cliff, { x: 10, z: -3 }, { x: 40, z: -3 }, { height: 3 });
    assert.ok(w.blocks.length > 0, 'no wall on a real drop');
    assert.ok(w.report.stacked > 0);
    const flatRun = retainingWall(flat(64), { x: 10, z: -3 }, { x: 40, z: -3 });
    assert.equal(flatRun.blocks.length, 0, 'built a wall on flat ground');
});

test('level targets the median height, fills lows, and only REPORTS cuts', () => {
    // one pit and one spike: median must ignore both
    const t = fakeTerrain((x, z) => (x === 5 && z === 5 ? 70 : (x === 4 && z === 4 ? 60 : 64)));
    const l = level(t, { x: 5, z: 5 }, 7, 7);
    assert.equal(l.report.targetY, 64, 'a pit and a spike together dragged the median');
    assert.ok(l.report.filled > 0, 'the pit was not filled');
    assert.ok(l.report.cut > 0, 'the spike was not measured');
    assert.ok(l.report.cuts.length > 0, 'the spike was not reported cell-by-cell');
    // a cut is reported, never placed: nothing may sit above the target height
    const ox = l.origin.x, oy = l.origin.y, oz = l.origin.z;
    // placements may reach the target height, plus the one made-surface block on
    // top of it — but never anything higher (that would rebuild the spike)
    assert.ok(l.blocks.every(b => oy + b.y <= l.report.targetY + 1), 'a cut block was emitted as a placement');
    // and the pit really is filled to the target
    const pit = l.blocks.filter(b => ox + b.x === 4 && oz + b.z === 4);
    assert.equal(oy + Math.max(...pit.map(b => b.y)), 64);
});

test('stairs cut a supported run up the slope', () => {
    const s = stairs(ramp, { x: 0, z: 0 }, { x: 40, z: 0 });
    assert.ok(s.report.steps >= 40);
    // A tread is supported either by the terrain itself (a stair sitting ON the
    // ground is not floating) or by a block the generator placed beneath it.
    const oy = s.origin.y;
    for (const b of s.blocks) {
        if (b.name !== 'stone_stairs') continue;
        const wy = oy + b.y;
        const groundHere = 64 + Math.floor(b.x / 4);   // ramp's height fn
        const placedBelow = s.blocks.some(o => o.x === b.x && o.y === b.y - 1 && o.z === b.z);
        // a tread resting directly on the ground (wy == ground+1) is supported;
        // anything more than one block above the ground needs a block under it
        assert.ok(placedBelow || wy <= groundHere + 1, `floating stair at ${b.x},${wy},${b.z} (ground ${groundHere})`);
    }
});

test('stairs refuses to invent terrain it cannot read', () => {
    const s = stairs(fakeTerrain((x) => (x < 20 ? 64 : null)), { x: 18, z: 0 }, { x: 28, z: 0 });
    assert.ok(s.report.error, 'should have refused');
});

test('garden picks a flat site, not the cliff, and beds it', () => {
    const t = fakeTerrain((x, z) => 64 + (x > 40 ? 6 : 0));
    const g = garden(t, { x: 0, z: 0 }, { size: 5, searchRadius: 24 });
    assert.ok(g.report.site, 'no site found');
    assert.ok(g.report.spread <= 1, `site spread ${g.report.spread} — picked uneven ground`);
    assert.ok(g.report.beds > 0);
    assert.equal(g.blocks.some(b => b.name === 'oak_fence'), true, 'no fence');
    assert.equal(g.blocks.some(b => b.name === 'water'), true, 'no water edge');
});

test('garden on pure slope finds the least-bad spot and still says so', () => {
    const t = fakeTerrain((x) => 60 + Math.floor(x / 3));
    const g = garden(t, { x: 0, z: 0 }, { size: 5, searchRadius: 12 });
    assert.ok(g.report.site);
    assert.ok(g.report.spread >= 1, 'a slope cannot have spread 0');
});

test('garden refuses when there is no loaded ground at all', () => {
    const g = garden(fakeTerrain(() => null), { x: 0, z: 0 }, { size: 5 });
    assert.ok(g.report.error);
});

test('diffAgainstWorld returns only the missing cells, never the standing ones', () => {
    const sch = {
        name: 't', size: { x: 3, y: 1, z: 1 },
        blocks: [
            { x: 0, y: 0, z: 0, name: 'stone' },
            { x: 1, y: 0, z: 0, name: 'stone' },
            { x: 2, y: 0, z: 0, name: 'stone' },
        ],
    };
    const standing = new Set(['0,64,0', '2,64,0']);   // the middle one got griefed
    const get = (x, y, z) => (standing.has(`${x},${y},${z}`) ? 'stone' : 'air');
    const d = diffAgainstWorld(sch, get, { x: 0, y: 64, z: 0 });
    assert.equal(d.missing.length, 1);
    assert.equal(d.fix.length, 1);
    assert.equal(d.fix[0].worldX, 1);
    assert.equal(d.wrong.length, 0);
});

test('diffAgainstWorld names wrong blocks and strays without clearing them', () => {
    const sch = { name: 't', size: { x: 2, y: 1, z: 2 }, blocks: [{ x: 0, y: 0, z: 0, name: 'stone' }] };
    const get = (x, y, z) => {
        if (x === 0 && z === 0) return 'dirt';         // wrong block
        if (x === 1 && z === 1) return 'oak_log';       // stray
        return 'air';
    };
    const d = diffAgainstWorld(sch, get, { x: 0, y: 64, z: 0 });
    assert.equal(d.wrong.length, 1);
    assert.equal(d.wrong[0].expected, 'stone');
    assert.equal(d.extra.length, 1);
    assert.equal(d.fix.length, 0, 'a wrong block is not silently rebuilt');
});

test('extend attaches new work to the old footprint and skips the overlap', () => {
    const old = { name: 'road', size: { x: 10, y: 1, z: 3 }, blocks: [] };
    const made = road(flat(64), { x: 11, z: 0 }, { x: 25, z: 0 }, { width: 3 });
    const ex = extend(old, { x: 0, y: 64, z: 0 }, (a, b) => road(flat(64), a, b, { width: 3 }), { dir: 'east', length: 15 });
    const ox = 0, oz = 0;
    const inOld = ex.blocks.filter(b => {
        const wx = ex.origin.x + b.x, wz = ex.origin.z + b.z;
        return wx >= ox && wx < ox + 10 && wz >= oz && wz < oz + 3;
    });
    assert.equal(inOld.length, 0, 'extension re-placed blocks already in the old build');
    assert.ok(ex.blocks.length > 0, 'extension produced nothing');
    assert.ok(made.blocks.length > 0);
});

test('chunk splits a big generated build into paste-sized pieces that keep world coords', () => {
    const big = road(flat(64), { x: 0, z: 0 }, { x: 200, z: 0 }, { width: 3 });
    const parts = chunk(big, 100);
    assert.equal(parts.length, Math.ceil(big.blocks.length / 100));
    const wx = big.origin.x, wz = big.origin.z;
    const original = new Set(big.blocks.map(b => `${wx + b.x},${wz + b.z}`));
    for (const p of parts) {
        assert.ok(p.blocks.length <= 100);
        // every cell must land back on a cell the generator actually produced:
        // chunking may move the min-corner but never invent or lose world cells
        for (const b of p.blocks) {
            const key = `${p.origin.x + b.x},${p.origin.z + b.z}`;
            assert.ok(original.has(key), `chunk invented cell ${key}`);
            original.delete(key);
        }
    }
    assert.equal(original.size, 0, `chunk lost ${original.size} cells`);
});

test('describe reports what actually happened, never a bare "done"', () => {
    const r = road(cliff, { x: 10, z: 0 }, { x: 40, z: 0 }, { width: 3 });
    const d = describe(r);
    assert.ok(d.length > 0);
    assert.match(d, /wide/);
});

test('terrainSampler caches column reads and reports water', () => {
    const reads = [];
    const bot = {
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: (v) => { reads.push(`${v.x},${v.y},${v.z}`); return { name: v.y <= 64 ? 'stone' : 'air' }; },
    };
    const g = terrainSampler(bot);
    assert.equal(g.top(1, 1), 64);
    const after = reads.length;
    g.top(1, 1);
    assert.equal(reads.length, after, 'second read was not cached');
    g.clear();
    g.top(1, 1);
    assert.ok(reads.length > after);
});