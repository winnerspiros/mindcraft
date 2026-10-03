// Regression: her activity list must contain commands that ACTUALLY MOVE HER.
//
// Measured over 20 minutes, wedged on a 1-block pillar at y54 (dirt floor at
// y52, water and stone walls, open air above):
//
//   15  !collectBlocks
//    4  !breedAnimals
//    2  !nearbyBlocks
//    1  !lookDir
//   ---------------------
//   22 commands executed. Zero of them moved her.
//
// Every one of those is an observation or a same-spot action. The list had no
// travel command in it at all, so she said "not sure what else to do, guess
// i'll just explore" and then ran !breedAnimals. 203 commands existed; the mobile
// ones were simply never offered.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const sp = readFileSync(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');
const start = sp.indexOf('const ACTIVITIES = [');
const end = sp.indexOf('];', start);
const code = sp.slice(start, end);
const activities = [...code.matchAll(/cmd: '(![a-zA-Z_]+)', needsArgs: (true|false)/g)]
    .map(m => ({ cmd: m[1], needsArgs: m[2] }));

// Importing src/agent/commands/index.js transitively loads undici, which reads
// the global File at module scope and crashes on Node 19 (it landed in Node 20).
// This is the same shim tests/plain_text_and_chatter.test.mjs applies, and for
// the same documented reason - mindcraft's own runtime provides the global, a
// bare `node tests/...` does not. Shim the one global it wants rather than
// skipping the cross-check: verifying these commands exist and take no argument
// is the entire point of this file.
if (typeof globalThis.File === 'undefined') globalThis.File = class File {};

test('the activity list is parseable and non-trivial', () => {
    assert.ok(activities.length >= 10, `only ${activities.length} activities found`);
});

test('she is offered commands that make her travel', () => {
    const mobile = ['!scout', '!findShelter', '!climb', '!goToSurface', '!findCave', '!comeHere'];
    for (const cmd of mobile) {
        assert.ok(activities.some(a => a.cmd === cmd),
            `${cmd} is missing - without travel goals she never leaves the spot`);
    }
});

test('travel goals are phrased as travel, so the goal text carries the intent', () => {
    const goals = [...code.matchAll(/cmd: '![a-zA-Z_]+', needsArgs: \w+, goal: '([^']+)'/g)].map(m => m[1]);
    const travelish = goals.filter(g => /travel|explore|go |get back|hunting|find some/.test(g));
    assert.ok(travelish.length >= 4,
        `only ${travelish.length} travel-shaped goals among ${goals.length}; she cannot act on a goal she never sees`);
});

test('no duplicate commands in the list', () => {
    const seen = new Set();
    for (const a of activities) {
        assert.ok(!seen.has(a.cmd), `${a.cmd} is listed twice`);
        seen.add(a.cmd);
    }
});

// The runtime filter already drops anything not in allCommandNames(), but a
// typo would silently remove the activity rather than fail, which is how this
// bug survived. Check the names against the real registry.
test('every activity names a command that EXISTS', async () => {
    const mod = await import('../src/agent/commands/index.js');
    const have = new Set(mod.allCommandNames());
    for (const a of activities) {
        assert.ok(have.has(a.cmd), `${a.cmd} is not in the command registry`);
    }
});

test('the travel commands take no required argument, so she cannot emit a bare one', async () => {
    const mod = await import('../src/agent/commands/index.js');
    const ar = mod.allCommandArity();
    for (const a of activities) {
        if (!/scout|findShelter|climb|goToSurface|findCave|comeHere/.test(a.cmd)) continue;
        assert.equal(ar[a.cmd].required, 0,
            `${a.cmd} requires ${ar[a.cmd].required} arg(s); the goal text alone would not supply it`);
    }
});
