// UwU choosing where to work. A column with ground under water is not a site:
// that mistake laid a road on the lake bed and every placement failed with
// "nothing to place on". Site selection has to require dry, open air above a
// floor -- you need a head to stand in, not just a floor under your feet.
import { test } from 'node:test';
import assert from 'node:assert';
import { standableTop, findBuildSite } from '../src/agent/library/landwork.js';

// A tiny world: `solid` is the filled ground, `fill` is what sits above it.
function world(fillAbove = {}) {
    const get = (x, y, z) => {
        if (fillAbove[`${x},${z}`] !== undefined) {
            const f = fillAbove[`${x},${z}`];
            if (y === 64) return 'stone';        // ground at y=64
            if (y > 64 && y <= 64 + f) return 'water';
            if (y > 64 + f) return 'air';
            return 'air';
        }
        return y <= 64 ? 'stone' : 'air';
    };
    return get;
}

test('dry open ground is a valid site', () => {
    const y = standableTop(world(), 0, 0, 100, 0, 3);
    assert.equal(y, 64, 'flat dry ground should be standable at its surface');
});

test('a column with water above the ground is NOT a site', () => {
    const g = world({ '0,0': 5 });  // 5 cells of water sitting on the floor
    assert.equal(standableTop(g, 0, 0, 100, 0, 3), null,
        'underwater ground must be rejected -- this is the lake-bed bug');
});

test('water one cell above the ground is enough to reject', () => {
    const g = world({ '0,0': 1 });
    assert.equal(standableTop(g, 0, 0, 100, 0, 3), null,
        'wading depth still counts as flooded, not buildable');
});

test('headroom is required to the requested depth', () => {
    // Floor at 64, standing growth filling 65-66. columnTop ignores plants, so
    // the floor is genuinely 64 and only two cells of head room exist.
    // (A solid slab at 67 would itself count as the new ground -- correct too.)
    const g = (x, y, z) => ((y === 65 || y === 66) ? 'short_grass' : (y <= 64 ? 'stone' : 'air'));
    // Two cells, but they are grass rather than air, so there is nowhere to
    // stand at all: the head check wants open AIR, not merely empty volume.
    assert.equal(standableTop(g, 0, 0, 100, 0, 3), null,
        'growth overhead should not satisfy a head-room requirement');
    assert.equal(standableTop(g, 0, 0, 100, 0, 2), null,
        'two cells of head room should not satisfy a three-cell requirement');
});

test('a raised ledge is still standable -- only WATER overhead disqualifies', () => {
    // Guards against over-correction: the head check is about being able to
    // stand in air, not about demanding perfectly flat ground.
    const g = (x, y, z) => (y <= 66 ? 'stone' : 'air');
    assert.equal(standableTop(g, 0, 0, 100, 0, 3), 66,
        'a two-block-high step is still somewhere a person could work');
});

test('findBuildSite skips flooded ground and picks dry land nearby', () => {
    // Centre is a pond; dry land starts 4 cells east.
    const solid = {};
    for (let x = -10; x <= 10; x++) {
        for (let z = -10; z <= 10; z++) {
            solid[`${x},${z}`] = (x >= 4) ? 0 : 4;   // water everywhere west of x=4
        }
    }
    const site = findBuildSite(world(solid), { x: 0, y: 64, z: 0 }, { step: 2, rings: 6, head: 3 });
    assert.ok(site, 'a site should be found somewhere near the pond');
    assert.ok(site.x >= 4, `site must be on dry land, got x=${site.x}`);
});

test('findBuildSite returns null when nothing nearby is dry', () => {
    // Everything within range is under water. She must NOT be handed a site.
    const solid = {};
    for (let x = -10; x <= 10; x++) {
        for (let z = -10; z <= 10; z++) solid[`${x},${z}`] = 6;
    }
    assert.equal(findBuildSite(world(solid), { x: 0, y: 64, z: 0 }, { step: 2, rings: 4, head: 3 }), null,
        'all-flooded surroundings must yield no site, not a lake-bed site');
});

test('findBuildSite prefers flat ground over the nearest uneven column', () => {
    // A raised ledge runs along x=2; everything else is flat at y=64.
    const step = (x, y, z) => {
        const base = y <= 64 ? 'stone' : 'air';
        if (x === 2) {
            if (y <= 66) return 'stone';
            return y <= 69 ? 'air' : 'air';
        }
        return base;
    };
    const site = findBuildSite(step, { x: 0, y: 64, z: 0 }, { step: 2, rings: 3, head: 3 });
    assert.ok(site, 'should find ground');
    assert.notEqual(site.x, 2, 'should not pick the raised ledge when flat ground is near');
});
