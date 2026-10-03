// Regression: the unstick rescue must WALK OUT when she already has a way out.
//
// Measured live, twice. She stalled with OPEN AIR on every side:
//   - a 7-wide pocket at y54, clear from offset -3 to +2
//   - later a corridor clear at +2/+3
// She was never walled in. She had somewhere to walk the whole time.
//
// But the rescue only knew how to DIG, and its candidate filter keeps only solid
// blocks. With air all round it found nothing, freed stayed 0, and it reported
// nothing and changed nothing - while the goal loop kept handing her !scout and
// !searchForBlock, which cannot path out of a one-block pocket. A 4-minute sample
// showed 0 blocks of travel with 11 commands executed.
//
// Digging is only the right answer when the walls really are the problem. Prefer
// the exit she already has.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const modes = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
const code = modes.replace(/\/\/[^\n]*/g, '');

// The rescue body: from the stillness trigger to the end of the dig block.
const start = modes.indexOf('if ((this._idleStill || 0) >= 40');
const end = modes.indexOf('if (freed > 0)', start);
const body = modes.slice(start, end);
const bcode = body.replace(/\/\/[^\n]*/g, '');

test('the rescue body was located', () => {
    assert.ok(start > 0 && end > start, 'could not slice the stillness rescue body');
});

test('an open lateral neighbour is treated as an exit, not a wall', () => {
    assert.match(bcode, /openSides\s*=/,
        'the rescue must look for open sides before it looks for diggable walls');
    assert.match(bcode, /b\.name === 'air' \|\| b\.name === 'cave_air'/,
        'air and cave_air both count as open - cave_air is what caves actually are');
});

test('she WALKS the exit rather than digging through it', () => {
    const walkAt = bcode.indexOf('openSides');
    const digAt = bcode.indexOf('const cands =');
    assert.ok(walkAt > 0 && digAt > walkAt,
        'the walk must come BEFORE the dig; otherwise the dig wins on air, finds nothing, and the rescue is inert again');
    assert.match(bcode, /skills\.goToPosition\(\s*bot,\s*t\.x,\s*t\.y,\s*t\.z/,
        'she must actually path out with goToPosition');
});

test('walking is only believed if she really moved', () => {
    // goToPosition returning true does not mean she moved; she has returned true
    // while standing still. Require displacement before claiming success.
    assert.match(bcode, /distanceTo\(before\) > 0\.8/,
        'a walk that does not displace her must not report "Found my way out"');
});

test('every open side is tried, so a dead end cannot block the real exit', () => {
    assert.match(bcode, /for \(const \{ dx, dz \} of openSides\)/,
        'only the first open side must be walked; one dead-end pocket would block the corridor');
});

test('a failed walk still falls through to digging', () => {
    // Digging remains correct when she really is walled in, so the fallback must
    // survive: the loop body must not always return.
    const loop = bcode.slice(bcode.indexOf('for (const { dx, dz } of openSides)'),
                             bcode.indexOf('const cands ='));
    assert.ok(loop.length > 0, 'the open-side loop was not found');
    // The return must be NESTED inside the moved check, not sitting at the top
    // level of the loop body - otherwise a failed walk skips digging forever.
    const returnAt = loop.indexOf('return;');
    assert.ok(returnAt > 0, 'no return found in the walk loop');
    assert.match(loop.slice(0, returnAt), /if \(moved\) \{/,
        'the return is not guarded by the movement check - a failed walk would skip digging forever');
    assert.equal((loop.match(/\breturn;/g) || []).length, 1,
        'exactly one return in the loop, inside the moved guard');
});

test('the water swim still runs before both', () => {
    assert.match(bcode, /swimToNearestAir/,
        'water must still be handled first - walking out of a pool is not the rescue');
    assert.ok(bcode.indexOf('swimToNearestAir') < bcode.indexOf('openSides'),
        'the swim must stay ahead of the lateral-air walk');
});
