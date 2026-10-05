// Site choice is only useful if she goes there. relocateToSite() decides
// whether to walk, and — just as important — when NOT to. Moving for the sake
// of moving wastes food and can walk her off a good spot into a worse one.
import { test } from 'node:test';
import assert from 'node:assert';
import { relocateToSite, standableTop } from '../src/agent/library/landwork.js';

// Water depth per column; 0 means dry open ground.
function world(depth) {
    const key = (x, z) => depth[`${x},${z}`] ?? 0;
    return (x, y, z) => {
        const d = key(x, z);
        if (y <= 64) return 'stone';
        if (y > 64 && y <= 64 + d) return 'water';
        return 'air';
    };
}

function fakeBot(get, pos) {
    return {
        entity: { position: { floored: () => pos } },
        // goToPosition reads bot.modes before doing anything else. Not in cheat
        // mode, so it proceeds to pathfinding, which this stub cannot satisfy --
        // so it returns false. That is enough: these tests are about the DECISION
        // to relocate, not about pathfinding succeeding.
        modes: { isOn: () => false },
    };
}

test('standing on dry ground: she stays put and says why', async () => {
    // A bot whose blockAt the sampler never calls, so any movement attempt
    // would throw -- proving no walk was attempted.
    const bot = fakeBot(() => { throw new Error('should not sample'); }, { x: 0, y: 65, z: 0 });
    const r = await relocateToSite(bot, { get: world({}) });
    assert.equal(r.moved, false, 'must not walk when already on good ground');
    assert.match(r.why, /already on dry/);
});

test('standing in water: she looks for somewhere else', async () => {
    // Pond at the origin, dry land 4 cells east.
    const depth = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) depth[`${x},${z}`] = x >= 4 ? 0 : 4;
    const bot = fakeBot(null, { x: 0, y: 65, z: 0 });
    // Injected mover: records where she aimed, then reports arrival there.
    let aimed = null;
    const r = await relocateToSite(bot, {
        get: world(depth), rings: 6,
        goTo: async (b, x, y, z) => {
            aimed = { x, y, z };
            b.entity.position.floored = () => ({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
            return true;
        },
    });
    assert.notEqual(r.why, 'already on dry open ground',
        'standing in water must not read as good ground');
    assert.ok(aimed, 'she must actually try to walk to dry ground');
    assert.ok(aimed.x >= 4, 'she should walk east to dry land, got x=' + (aimed && aimed.x));
    assert.equal(r.moved, true, 'a successful walk reports moved');
});

test('surrounded by water: no site, and she says so rather than pretending', async () => {
    const depth = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) depth[`${x},${z}`] = 6;
    const bot = fakeBot(null, { x: 0, y: 65, z: 0 });
    const r = await relocateToSite(bot, { get: world(depth), rings: 4 });
    assert.equal(r.moved, false);
    assert.equal(r.site, null, 'no site may be invented when everything is flooded');
    assert.match(r.why, /no dry open ground/);
});

test('relocating is not an error state — every return carries a reason', async () => {
    // A caller that treats `moved:false` as failure will log spurious errors.
    const bot = fakeBot(null, { x: 0, y: 65, z: 0 });
    for (const depth of [{}, { '0,0': 6 }]) {
        const r = await relocateToSite(bot, { get: world(depth), rings: 2, goTo: async () => false });
        assert.equal(typeof r.moved, 'boolean');
        assert.equal(typeof r.why, 'string');
        assert.ok(r.why.length > 0, 'a non-move must always explain itself');
    }
});

test('standableTop is what relocation is judged on', async () => {
    // Guard: if this drifts, relocation silently stops working.
    assert.equal(standableTop(world({}), 0, 0, 100, 0, 3), 64, 'dry ground stands');
    assert.equal(standableTop(world({ '0,0': 4 }), 0, 0, 100, 0, 3), null, 'flooded ground does not');
});
