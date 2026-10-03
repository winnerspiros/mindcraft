// Regression: the unstuck idle rescue must ACT on being stuck, not just narrate.
//
// Measured live, twice:
//  1. 1x1 water pocket (dirt walls, water at feet+head, air only at y51):
//     y oscillated 49 -> 51.6 -> 49.6 -> 49.0 over 12 min, 124 rescue cycles.
//  2. 5-deep pool (feet y52, head y53, surface y54): position byte-identical
//     across a 45s sample while `unstuck` fired every 15s and its ENTIRE log
//     output was "Unpausing mode unstuck" / "elbow_room". Goals went back to
//     0 commands executed.
//
// Cause: the idle rescue filters out water candidates, so in water every
// candidate is dropped, freed stays 0, and nothing happens. And swimToNearestAir
// - which CAN find an exit - was only reached after swimUp's 8s jump-hold gives
// up, which just hovers her in place.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
const code = src.replace(/\/\/[^\n]*/g, '');

const idleStart = code.indexOf('const fp = bot.entity.position.floored()');
const idleEnd = code.indexOf('to get out~');
assert.ok(idleStart > -1 && idleEnd > idleStart, 'the idle rescue block was not found');
const idle = code.slice(idleStart, idleEnd);

test('the unstuck rescue detects being in water', () => {
    assert.match(idle, /const inWater = wet\(/,
        'the rescue must check whether she is submerged before choosing a strategy');
    assert.match(idle, /bubble_column/,
        'bubble columns are water; treating them as dry would skip the swim');
});

test('when in water it swims to a real exit instead of digging nothing', () => {
    const swimAt = idle.indexOf('skills.swimToNearestAir');
    const candsAt = idle.indexOf('const cands = [[1,0]');
    assert.ok(swimAt > -1, 'a submerged rescue must try the directional swim');
    assert.ok(candsAt > -1, 'the wall-dig fallback must still exist');
    assert.ok(swimAt < candsAt,
        'swimming must come FIRST: the wall-dig filter rejects water, so reaching it first means doing nothing in a pool');
    assert.match(idle, /skills\.swimUp\(bot, 3000\)/,
        'with no lateral exit she must still try to rise to the surface');
});

test('a successful swim ends the rescue instead of digging', () => {
    // The message and the return are separated by the say() call, so match the
    // control flow rather than literal adjacency.
    const swimOk = idle.indexOf('const ok = await skills.swimToNearestAir(bot, 4000)');
    const retAt = idle.indexOf('return;', swimOk);
    const candsAt = idle.indexOf('const cands = [[1,0]');
    assert.ok(swimOk > -1 && retAt > swimOk && retAt < candsAt,
        'a successful lateral swim must return before the wall-dig candidates are even built');
});

test('the water candidates are still rejected, so digging is the rock fallback', () => {
    assert.match(idle, /b\.name !== 'water'/,
        'water is not a block worth digging; if this is removed the rescue would try to mine the pool');
});

test('swimToNearestAir is actually exported', () => {
    const skills = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    assert.match(skills, /export async function swimToNearestAir\(/,
        'skills.swimToNearestAir is undefined unless it is exported - the rescue would throw');
});
// The DROWNING rescue had the same defect independently: in an open pool it
// ran the wall-dig uselessly while a real air exit sat one block over.
test('the drowning rescue tries a lateral swim before digging', () => {
    const digAt = code.indexOf('Dug ${freed} block${freed === 1');
    const swimAt = code.indexOf('Swam sideways out of the water~');
    assert.ok(swimAt > -1, 'the drowning rescue must try swimToNearestAir');
    assert.ok(swimAt < digAt, 'the lateral swim must come before the wall-dig');
    // It must be the DIRECTIONAL helper: swimUp is the jump-hold that measurably
    // cannot leave a pool, so reaching for that here would be the same bug.
    assert.match(code.slice(Math.max(0, swimAt - 400), swimAt),
        /skills\.swimToNearestAir\(bot, 4000\)/,
        'the swim must use the directional helper, not the jump-hold');
});

// THE ROOT CAUSE. swimUp reported success while she was still drowning, so the
// caller returned early and the lateral swim never ran. Instrumented live:
//   [swimup-dbg] loop-exit feet=air head=air y=54.59
// while RCON said she was at y=52.0 with water at feet AND head. 15 rescue
// fires, 0 escapes, position byte-identical across a 45s sample.
test('swimUp only reports success when the HEAD is dry too', () => {
    const skills = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const fn = skills.slice(skills.indexOf('export async function swimUp'));
    const after = fn.slice(fn.indexOf('} finally {'));
    assert.match(after, /dry\(feetEnd\) && dry\(headEnd\)/,
        'a feet-only check returns true while her head is still submerged');
    assert.doesNotMatch(after, /if \(feet && feet\.name !== 'water'\) return true;/,
        'the feet-only success test is exactly the bug - floating is not breathing');
    assert.match(after, /bubble_column/,
        'a bubble column is water; treating it as dry would hide a real hazard');
});
