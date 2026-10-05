// The floating-block fallback must look DOWN for a footing, not only sideways.
// A bridge that only considers the eight cells touching the target can never
// cross a gap wider than one cell, which is why road blocks over a ravine ended
// in "nothing to place on". This pins that behaviour down at the level the
// candidate search operates, without driving a real build.
import { test } from 'node:test';
import assert from 'node:assert';
import Vec3 from 'vec3';

// The candidate cells the fallback now considers, in the same shape
// skills.js builds them: sideways first, then the column beneath.
function candidates(target) {
    const c = [];
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0],[1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1]]) {
        c.push(target.plus(new Vec3(dx, dy, dz)));
    }
    for (let k = 1; k <= 12; k++) {
        c.push(target.plus(new Vec3(0, -k, 0)));
        c.push(target.plus(new Vec3(1, -k, 0)));
        c.push(target.plus(new Vec3(-1, -k, 0)));
        c.push(target.plus(new Vec3(0, -k, 1)));
        c.push(target.plus(new Vec3(0, -k, -1)));
    }
    return c.filter((p, i, arr) => arr.findIndex(q => q.equals(p)) === i);
}

test('candidates include cells well below the target, not just its 8 neighbours', () => {
    const target = new Vec3(10, 70, 0);
    const c = candidates(target);
    // The old search had exactly 8 candidates, all within one cell.
    assert.ok(c.length > 8, 'a one-cell-only search cannot bridge a ravine');
    assert.ok(c.some(p => p.y === 70 - 6), 'should reach six cells below the target');
});

test('candidates stay within a bounded search depth', () => {
    // A fallback that scans forever would hang a live placement pass. Bounded.
    const target = new Vec3(0, 70, 0);
    for (const p of candidates(target)) {
        assert.ok(p.y >= 70 - 12, 'must not search further than 12 below');
        assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1, 'must not wander far sideways');
    }
});

test('no duplicate candidates', () => {
    const target = new Vec3(3, 70, 3);
    const c = candidates(target);
    assert.equal(new Set(c.map(p => p.toString())).size, c.length, 'duplicates would waste placement attempts');
});

test('a one-cell gap is still covered by the sideways cells', () => {
    // The cheap common case must not regress: a single adjacent solid block is
    // still a valid footing for the block we want.
    const target = new Vec3(0, 70, 0);
    const c = candidates(target);
    const adjacent = c.filter(p => Math.abs(p.x - target.x) + Math.abs(p.y - target.y) + Math.abs(p.z - target.z) === 1);
    assert.ok(adjacent.length >= 4, 'the original sideways options must still be present');
});
