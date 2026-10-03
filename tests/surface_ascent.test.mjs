// Regression: !goToSurface must not report success without climbing, and she must
// have a way out of a cave at all.
//
// Two distinct bugs, one place.
//
// 1. goToSurface returned true unconditionally. It called
//    goToPosition(bot, x, y+1, z, 0) and then `return true`, discarding the
//    boolean. And that call could not have detected arrival even in principle:
//    goToPosition measures arrival in the XZ PLANE ONLY, via
//    `dxz <= min_distance + 1`, deliberately - "Y mismatches (standing a block
//    above/below the target) must not read as failure". goToSurface targets her
//    OWN column, so dxz is ~0 from the first tick.
//
//    Measured live: 5 runs of !goToSurface logged
//        Going to the surface at y=62.
//        Going to the surface at y=63.
//    while she stood at y=18 throughout. Five successes, zero progress, and
//    nothing in the log distinguished "arrived" from "never tried".
//
// 2. There was no digUp. She could tunnel DOWN (9x !digDown to y18) with no
//    command to tunnel back up, so every cave was a one-way trip.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const sk = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const cmds = readFileSync(new URL('../src/agent/commands/actions.js', import.meta.url), 'utf8');
const sCode = sk.replace(/\/\/[^\n]*/g, '');
const cCode = cmds.replace(/\/\/[^\n]*/g, '');

const fnBody = (src, name) => {
    const start = src.indexOf(`export async function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    return src.slice(start, src.indexOf('\n}', start));
};
const goToSurface = fnBody(sk, 'goToSurface');
const digUp = fnBody(sk, 'digUp');

test('goToSurface is not an unconditional success', () => {
    // The old shape was goToPosition(...) followed by `return true`, with the
    // boolean discarded. A log() line may sit between them, so match
    // "goToPosition then return true" across intervening statements rather than
    // requiring them adjacent - the first version of this test only matched the
    // adjacent form and therefore PASSED against the real bug.
    const flat = goToSurface.replace(/\s+/g, ' ');
    assert.doesNotMatch(flat, /goToPosition\([^)]*\);[\s\S]{0,200}?return true;/,
        'goToPosition is followed by a bare `return true` - its boolean is being discarded');
    // And the function must actually look at her own Y somewhere before deciding.
    assert.match(flat, /Math\.floor\(bot\.entity\.position\.y\)/,
        'goToSurface must read her live Y; otherwise no verdict it returns can mean anything vertical');
});

test('goToSurface judges arrival VERTICALLY, not by the pathfinder', () => {
    assert.match(goToSurface, /nowY >= block\.position\.y \+ 1 - 2/,
        'arrival must be measured against her own Y - XZ is always ~0 in her own column, which is why the old check could never fail');
});

test('goToSurface records where she started, to tell progress from nothing', () => {
    assert.match(goToSurface, /const startY = Math\.floor\(pos\.y\)/,
        'without the starting Y there is no way to distinguish partial climb from no attempt');
});

test('goToSurface tunnels when pathfinding cannot climb', () => {
    assert.match(goToSurface, /await digUp\(bot, 6\)/,
        'pathfinding has no route to a block 44 overhead in solid rock; without tunnelling she stays trapped');
    assert.ok(goToSurface.indexOf('digUp(bot, 6)') > goToSurface.indexOf('goToPosition('),
        'try the path first, then tunnel');
});

test('the tunnelling loop is bounded and cannot spin', () => {
    assert.match(goToSurface, /guard\+\+ < \d+/,
        'an unbounded climb loop would run until the action timeout');
    assert.match(goToSurface, /if \(Math\.floor\(bot\.entity\.position\.y\) <= before\) break/,
        'digUp returning true is not proof of height - the loop must verify it actually gained, or it spins forever');
});

test('digUp exists and is a real staircase, not a wrapper', () => {
    assert.ok(digUp.length > 0, 'digUp not found');
    assert.match(digUp, /breakBlockAt\(/,
        'digUp must actually break blocks; it cannot path vertically through solid rock');
    assert.match(digUp, /Math\.min\(Math\.max\(distance, 1\), (\d+)\)/,
        'digUp must be bounded per call, like digDown - a long leg per block wedged past the action timeout');
});

test('digUp is bounded at the same limit as digDown', () => {
    const down = fnBody(sk, 'digDown').match(/Math\.min\(Math\.max\(distance, 1\), (\d+)\)/);
    const up = digUp.match(/Math\.min\(Math\.max\(distance, 1\), (\d+)\)/);
    assert.ok(down && up, 'could not read the per-call caps');
    assert.equal(+up[1], +down[1],
        'digUp and digDown must share the per-call cap; asymmetry is how one of them ends up suicide-timed');
});

test('digUp refuses hazards rather than tunnelling into them', () => {
    for (const hazard of ['lava', 'bedrock']) {
        assert.match(digUp, new RegExp(`${hazard}`),
            `digUp must refuse ${hazard}, not dig through it`);
    }
});

test('digUp reports honestly when it stops short', () => {
    assert.match(digUp, /no further progress/,
        'digUp must say when it stopped rather than implying success');
    assert.match(digUp, /return climbed > 0/,
        'partial climb must be reported as partial, not as the full distance');
});

test('!digUp is registered and mirrors !digDown arity', async () => {
    if (typeof globalThis.File === 'undefined') globalThis.File = class File {};
    const mod = await import('../src/agent/commands/index.js');
    const names = mod.allCommandNames();
    const arity = mod.allCommandArity();
    assert.ok(names.includes('!digUp'), '!digUp is not in the command registry');
    assert.equal(arity['!digUp'].required, arity['!digDown'].required,
        '!digUp must take the same argument as !digDown');
    // And goToSurface must stay argument-free - it is offered as a self-prompt
    // activity, and only the goal text is emitted to her.
    assert.equal(arity['!goToSurface'].required, 0);
});

test('the command handler calls the real skill', () => {
    assert.match(cCode, /skills\.digUp\(agent\.bot, distance\)/,
        '!digUp must dispatch to skills.digUp');
});