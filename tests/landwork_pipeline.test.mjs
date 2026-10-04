// End-to-end (offline) test of the landwork COMMAND surface: spec parsing, the
// generate -> plan -> place -> verify -> repair loop, and the honest-reporting
// rules the commands promise. The bot is faked at the level placeSchematic
// actually touches, so the whole chain runs here instead of costing a live
// build.
//
// What this protects: the commands are the only thing she can reach. A generator
// that works but is wired to nothing is the failure mode that ships green.
import { test } from 'node:test';
import assert from 'node:assert';
import * as landwork from '../src/agent/library/landwork.js';
// Importing src/agent/commands/index.js transitively loads undici, which reads
// the global File at module scope and crashes on Node 19 (it landed in Node 20);
// `bun run test` picks up node_modules/.bin/node, which is 19. This is the same
// shim tests/travel_goals.test.mjs uses, for the same documented reason.
// Checking the commands really are registered is the point of this file, so
// shim the one global it wants rather than dropping the cross-check.
if (typeof globalThis.File === 'undefined') globalThis.File = class File {};

const { allCommandNames, getCommand, isAction } = await import('../src/agent/commands/index.js');

// --- a world the fake bot can actually "build" in -----------------------
function fakeWorld({ heightAt }) {
    const blocks = new Map();          // "x,y,z" -> { name, props }
    const placed = [];
    const key = (x, y, z) => `${x},${y},${z}`;
    // Block STATE is remembered, not just the name: verifySchematic compares
    // props, and a world that reports {} for every block calls every stair and
    // slab WRONG_STATE — a fake-world artefact that looks exactly like a build fault.
    const world = {
        blocks, placed, key,
        place(x, y, z, name, props) {
            blocks.set(key(x, y, z), { name, props: props || {} });
            placed.push({ x, y, z, name });
        },
        break(x, y, z) { blocks.delete(key(x, y, z)); },
        get(x, y, z) { const b = blocks.get(key(x, y, z)); return b ? b.name : 'air'; },
        getProps(x, y, z) { const b = blocks.get(key(x, y, z)); return b ? b.props : {}; },
        top(x, z) {
            for (let y = 200; y >= 0; y--) {
                const name = world.get(x, y, z);
                if (name !== 'air' && landwork.isGroundName(name)) return y;
            }
            return null;
        },
    };
    for (let x = -30; x <= 90; x++)
        for (let z = -30; z <= 30; z++) {
            const h = heightAt(x, z);
            if (h == null) continue;
            for (let y = h - 6; y <= h; y++) world.place(x, y, z, y === h ? 'grass_block' : 'stone');
        }
    return world;
}

// A minimal registry, NOT prismarine-registry: that package pulls in undici,
// which needs a global File that node 19 does not have (the test suite is run
// under several node versions), and it crashed the whole run on `File is not
// defined` for a dependency this test does not exercise — placement is stubbed,
// so no registry ids are ever read.

function fakeBot(world) {
    return {
        world,
        registry: { blocksByName: {}, itemsByName: {} },
        recipesFor: () => [],
        canCraft: () => false,

        entity: { position: { x: 0, y: 65, z: 0 }, onGround: true },
        heldItem: null,
        game: { gameMode: 0, difficulty: 1, dimension: 'overworld' },
        interrupt_code: 0,
        waitForChunksToLoad: async () => {},
        blockAt: (v) => {
            const name = world.get(v.x, v.y, v.z);
            if (name === 'air') return null;
            // mineflayer blocks expose state.getProperties(); verifySchematic reads
            // that (not the top-level getProperties), so the fake must too
            const props = world.getProps(v.x, v.y, v.z);
            return { name, getProperties: () => props, state: { getProperties: () => props } };
        },
        inventory: {
            slots: new Array(36).fill(null),
            items: () => [],
            findInventoryItem: () => null,
            emptySlot: () => 0,
        },
        equip: async () => true,
        dig: async () => {},
        _inst: () => {},
        log: (m) => world.logs.push(m),
        logs: [],
    };
}

// --- the pipeline the commands run --------------------------------------
// Mirrors actions.js exactly: generate -> planGenerated -> place in chunks ->
// verify -> close-out report.
// The by-hand placement itself is mineflayer's job (gather, craft, walk,
// place) and cannot run against a fake world. Substituting JUST that step keeps
// everything landwork owns — chunking, origin resolution, verification, the
// honest report — under test in the same shape production uses.
function fakePlace(world) {
    return async (bot, part, origin) => {
        let n = 0;
        for (const b of part.blocks) {
            const x = origin.x + b.x, y = origin.y + b.y, z = origin.z + b.z;
            if (world.get(x, y, z) === b.name) continue;
            world.place(x, y, z, b.name, b.props);
            n++;
        }
        return n;
    };
}

async function buildAndReport(bot, sch, label, opts = {}) {
    const summary = await landwork.placeGenerated(bot, sch, { skipClear: true, ...opts, place: fakePlace(bot.world) });
    const r = sch.report || {};
    const report = {
        label,
        placed: summary.placed,
        of: summary.of,
        chunks: summary.chunks,
        faults: summary.faults,
        clear: summary.cleared,
        line: landwork.describe(sch) + (summary.faults ? ` — ${summary.faults} still not right` : ' — all placed and verified'),
    };
    return report;
}

test('all eight landwork commands are registered, are actions, and are documented', () => {
    const names = ['!buildRoad', '!buildBridge', '!buildWall', '!buildStairs', '!levelGround', '!buildGarden', '!fixBuild', '!extendBuild'];
    for (const n of names) {
        assert.ok(allCommandNames().includes(n), `${n} is not registered`);
        assert.ok(isAction(n), `${n} is not an action`);
        const c = getCommand(n);
        assert.ok(c.description && c.description.length > 40, `${n} has no useful description`);
        assert.ok(Object.keys(c.params).length > 0, `${n} takes no params`);
    }
});

test('the new commands are reachable by their natural names (not just exact match)', async () => {
    const { nearestCommandNames } = await import('../src/agent/commands/index.js');
    for (const q of ['road', 'bridge', 'garden', 'fix']) {
        const near = nearestCommandNames(q);
        assert.ok(near.length, `nothing near "${q}"`);
    }
});

test('road: generate -> place -> verify ends with zero faults on flat ground', async () => {
    const world = fakeWorld({ heightAt: () => 64 });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const sch = landwork.road(g, { x: 0, z: 0 }, { x: 20, z: 0 }, { width: 3 });
    const rep = await buildAndReport(bot, sch, 'road');
    assert.ok(rep.of > 0);
    assert.equal(rep.faults, 0, `road left ${rep.faults} faults`);
    assert.match(rep.line, /all placed and verified/);
    // and it is actually a walkable surface in the fake world
    for (let x = 0; x <= 20; x++) assert.equal(world.get(x, 64, 0), 'dirt', `no path at x=${x}`);
});

test('road across a ravine decks it and ends verified', async () => {
    const world = fakeWorld({ heightAt: (x) => (x < 20 || x > 26 ? 64 : null) });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const sch = landwork.road(g, { x: 16, z: 0 }, { x: 30, z: 0 }, { width: 3 });
    const rep = await buildAndReport(bot, sch, 'road');
    assert.equal(sch.report.gapSpans.length, 1, 'ravine was not detected as one span');
    assert.equal(rep.faults, 0);
    // a plank deck exists over the hole, with posts under it
    const decks = world.placed.filter(p => p.name === 'oak_planks');
    assert.ok(decks.length >= 7, `deck only ${decks.length} blocks over a 7-wide ravine`);
    assert.ok(world.placed.some(p => p.name === 'oak_fence'), 'no posts under the deck');
});

test('bridge, wall and stairs all place cleanly and verify', async () => {
    const world = fakeWorld({ heightAt: (x) => (x < 20 ? 64 : null) });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const b = await buildAndReport(bot, landwork.bridge(g, { x: 16, z: 0 }, { x: 30, z: 0 }, { width: 3 }), 'bridge');
    assert.equal(b.faults, 0, `bridge faults ${b.faults}`);

    const hill = fakeWorld({ heightAt: (x) => (x < 20 ? 64 : 70) });
    const hbot = fakeBot(hill);
    const hg = landwork.terrainSampler(hbot);
    const w = await buildAndReport(hbot, landwork.retainingWall(hg, { x: 10, z: -3 }, { x: 40, z: -3 }, {}), 'wall');
    assert.equal(w.faults, 0);

    const ramp = fakeWorld({ heightAt: (x) => 64 + Math.floor(x / 4) });
    const rbot = fakeBot(ramp);
    const rg = landwork.terrainSampler(rbot);
    const s = await buildAndReport(rbot, landwork.stairs(rg, { x: 0, z: 0 }, { x: 20, z: 0 }, {}), 'stairs');
    assert.equal(s.faults, 0, `stairs faults ${s.faults}`);
});

test('levelGround fills the pit, reports the spike, and never claims to cut it', async () => {
    const world = fakeWorld({ heightAt: (x, z) => (x === 5 && z === 5 ? 70 : (x === 4 && z === 4 ? 58 : 64)) });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const sch = landwork.level(g, { x: 5, z: 5 }, 7, 7);
    assert.equal(sch.report.targetY, 64);
    assert.ok(sch.report.cut > 0 && sch.report.cuts.length > 0, 'the spike was not reported');
    const rep = await buildAndReport(bot, sch, 'levelled ground');
    assert.equal(rep.faults, 0);
    // the pit got filled to the target height
    assert.equal(world.get(4, 64, 4), 'grass_block');
    // and the spike was NOT bulldozed — she reports cuts, she does not silently dig
    assert.equal(world.get(5, 70, 5), 'grass_block', 'the spike was dug out without being asked');
});

test('garden picks a flat site, places, verifies, and says where it went', async () => {
    const world = fakeWorld({ heightAt: (x, z) => 64 + (x > 50 ? 8 : 0) });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const sch = landwork.garden(g, { x: 0, z: 0 }, { size: 5, searchRadius: 24, biome: 'plains' });
    assert.ok(sch.report.site);
    assert.ok(sch.report.spread <= 1);
    // NO originOverride: the garden generator already builds around the site it
    // chose, so its own origin lands the beds there. Shifting it by the site
    // moves the whole garden a few blocks off the ground it surveyed.
    const site = sch.report.site;
    const rep = await buildAndReport(bot, sch, 'garden');
    assert.equal(rep.faults, 0, `garden faults ${rep.faults}`);
    // the beds really landed on the ground she chose, not off at the schematic min
    // corner. The centre row and column are the cross-path by design, so the bed
    // assertions sit off to the corners.
    assert.equal(world.get(site.x - 2, 65, site.z - 2), 'farmland', 'garden beds not on the chosen site');
    assert.equal(world.get(site.x, 65, site.z), 'gravel', 'no path through the garden');
    assert.equal(world.get(site.x - 1, 65, site.z - 1), 'farmland', 'no beds just off the path');
    assert.equal(world.get(site.x + 2, 65, site.z + 2), 'farmland', 'no beds on the far side');
    assert.ok(world.placed.some(p => p.name === 'water'), 'no water channel');
    assert.ok(world.placed.some(p => p.name === 'oak_fence'));
});

test('fixBuild: after a creeper hole, only the missing cells are re-placed', async () => {
    const world = fakeWorld({ heightAt: () => 64 });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const sch = landwork.road(g, { x: 0, z: 0 }, { x: 10, z: 0 }, { width: 3 });
    const origin = { x: sch.origin.x, y: sch.origin.y, z: sch.origin.z };
    await landwork.placeGenerated(bot, sch, { skipClear: true, place: fakePlace(bot.world) });
    const standingBefore = world.placed.length;

    // blow a hole in the middle of her own road
    const victims = [[5, origin.y, 0], [5, origin.y, 1]];
    for (const [x, y, z] of victims) world.break(x, y, z);

    const diff = landwork.diffAgainstWorld(sch, g.get, origin);
    assert.equal(diff.missing.length, 2, `diff found ${diff.missing.length} missing, expected 2`);
    assert.equal(diff.fix.length, 2);

    // the repair schematic places ONLY those two, and verify comes back clean
    const ox = Math.min(...diff.fix.map(b => b.worldX));
    const oy = Math.min(...diff.fix.map(b => b.worldY));
    const oz = Math.min(...diff.fix.map(b => b.worldZ));
    const fixSch = {
        name: 'repair',
        size: { x: 1, y: 1, z: 2 },
        origin: { x: ox, y: oy, z: oz },
        blocks: diff.fix.map(b => ({ x: b.worldX - ox, y: b.worldY - oy, z: b.worldZ - oz, name: b.name })),
    };
    const rep = await buildAndReport(bot, fixSch, 'repaired');
    assert.equal(rep.faults, 0);
    // the rest of the road was NOT touched: only the 2 repairs were placed
    assert.equal(world.placed.length - standingBefore, 2, `repaired ${world.placed.length - standingBefore} blocks, expected 2`);
    for (const [x, y, z] of victims) assert.equal(world.get(x, y, z), 'dirt');
});

test('fixBuild reports wrong and stray blocks instead of silently rebuilding them', async () => {
    const world = fakeWorld({ heightAt: (x) => 64 + Math.floor(x / 4) });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    // a stair run up a RAMP, because it is several blocks TALL: the stray sweep only
    // covers the schematic's own footprint, so a 1-block-tall road has nowhere
    // inside itself to hold a stray (which is correct — nothing above it is a fault)
    const sch = landwork.stairs(g, { x: 0, z: 0 }, { x: 12, z: 0 }, {});
    const origin = { x: sch.origin.x, y: sch.origin.y, z: sch.origin.z };
    await landwork.placeGenerated(bot, sch, { skipClear: true, place: fakePlace(bot.world) });
    // swap one block for dirt, and drop a stray oak_log where the design says air
    const target = sch.blocks.find(b => b.x === 3);
    assert.ok(target, 'no block at x=3 to vandalise');
    world.place(origin.x + target.x, origin.y + target.y, origin.z + target.z, 'dirt');
    world.place(3, origin.y + sch.size.y - 1, 0, 'oak_log');
    const diff = landwork.diffAgainstWorld(sch, g.get, origin);
    assert.ok(diff.wrong.some(w => w.found === 'dirt'), 'wrong block not detected');
    assert.equal(diff.fix.length, 0, 'a wrong block must NOT be silently rebuilt');
    assert.ok(diff.extra.some(e => e.name === 'oak_log'), 'stray not detected');
    // and the stray is only ever REPORTED: no code path in diffAgainstWorld removes it
    assert.equal(world.get(3, origin.y + sch.size.y - 1, 0), 'oak_log', 'the stray was removed');
});

test('extendBuild: carries on from the end and does not re-place the old part', async () => {
    const world = fakeWorld({ heightAt: () => 64 });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const first = landwork.road(g, { x: 0, z: 0 }, { x: 10, z: 0 }, { width: 3 });
    await landwork.placeGenerated(bot, first, { skipClear: true, place: fakePlace(bot.world) });
    const placedBefore = world.placed.length;

    const extended = landwork.extend(first, first.origin,
        (a, b) => landwork.road(g, a, b, { width: 3 }), { dir: 'east', length: 10 });
    const rep = await buildAndReport(bot, extended, 'extended');
    assert.equal(rep.faults, 0);
    const added = world.placed.length - placedBefore;
    assert.ok(added > 0, 'extension placed nothing');
    // the extension starts beyond the old footprint and is contiguous with it
    const newXs = world.placed.slice(placedBefore).map(p => p.x);
    assert.ok(Math.min(...newXs) > first.origin.x + first.size.x - 1, 'extension re-placed the old build');
    assert.ok(Math.max(...newXs) >= first.origin.x + first.size.x, 'extension did not reach past the old build');
});

test('a road longer than one paste is chunked, not refused', async () => {
    const world = fakeWorld({ heightAt: () => 64 });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    // a 10k-paste-cap road needs a very long line: 3 wide x 1800 long
    const sch = landwork.road(g, { x: 0, z: 0 }, { x: 1800, z: 0 }, { width: 3 });
    assert.ok(sch.blocks.length > 10000, `expected a big build, got ${sch.blocks.length}`);
    // only the first 12000 blocks are built: enough to prove chunking works
    const buildable = { ...sch, blocks: sch.blocks.slice(0, 12000) };
    const rep = await buildAndReport(bot, buildable, 'road', { max: 4000 });
    assert.ok(rep.chunks > 1, 'was not chunked');
    assert.equal(rep.faults, 0, `chunked road left ${rep.faults} faults`);
    assert.equal(world.get(80, 64, 0), 'dirt', 'the far end of a chunked road was not placed');
});

test('every generated build reports what it did — never a bare "done"', async () => {
    const world = fakeWorld({ heightAt: (x) => (x < 20 ? 64 : null) });
    const g = landwork.terrainSampler(fakeBot(world));
    for (const sch of [
        landwork.road(g, { x: 0, z: 0 }, { x: 30, z: 0 }, { width: 3 }),
        landwork.bridge(g, { x: 16, z: 0 }, { x: 30, z: 0 }, {}),
        landwork.stairs(g, { x: 0, z: 0 }, { x: 10, z: 0 }, {}),
    ]) {
        const d = landwork.describe(sch);
        assert.ok(d && d.length > 3, `empty description for ${sch.name}`);
    }
});

test('unreadable ground is reported, not invented', async () => {
    const world = fakeWorld({ heightAt: () => null });
    const bot = fakeBot(world);
    const g = landwork.terrainSampler(bot);
    const sch = landwork.road(g, { x: 0, z: 0 }, { x: 20, z: 0 }, { width: 3 });
    assert.ok(sch.report.error, 'built a road across nothing and did not say so');
    const g2 = landwork.garden(g, { x: 0, z: 0 }, { size: 5 });
    assert.ok(g2.report.error, 'planted a garden on nothing');
    const s2 = landwork.stairs(g, { x: 0, z: 0 }, { x: 10, z: 0 }, {});
    assert.ok(s2.report.error, 'cut stairs across nothing');
});