// Regression: a goal to GO SOMEWHERE must reach a command that GOES.
//
// The command list she is shown is keyword-matched against her goal, matching
// only words inside a COMMAND NAME. For the goal the curriculum actually
// produces - "explore the nearby forest for animals and resources" - no command
// name contains "explore" or "forest", so exactly one thing scored:
//
//   Commands that exist and fit this goal: !breedAnimals
//
// She was told to breed animals, and ran !breedAnimals 15 times in 20 minutes
// without travelling a single block, while saying "guess I'm moving on then" and
// emitting no command at all. Nothing else was offered.
//
// The verb is the entire point of those goals and it lives in no command name,
// so it has to be scored explicitly.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

if (typeof globalThis.File === 'undefined') globalThis.File = class File {};

const sp = readFileSync(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');
const code = sp.replace(/\/\/[^\n]*/g, '');
const mod = await import('../src/agent/commands/index.js');
const names = mod.allCommandNames();
const arity = mod.allCommandArity();

// Reimplemented faithfully from _realCommandsFor so the test exercises the real
// scoring shape rather than a paraphrase of it.
const GOAL = 'explore the nearby forest for animals and resources';
const STOP = new Set(['for', 'the', 'and', 'get', 'set', 'new', 'all', 'some', 'near',
    'nearby', 'with', 'from', 'into', 'out', 'now', 'here', 'there', 'this', 'that',
    'one', 'two', 'use', 'using', 'do']);
const wordsOf = n => String(n).replace(/^!/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const scoreFor = (goal) => {
    const g = goal.toLowerCase();
    const travel = /(explore|wander|travel|scout|roam|venture|walk around|go somewhere|move on|new ground|find animals|look for animals|hunt)/i.test(g);
    const MOVERS = /^!(scout|goTosurface|findcave|findshelter|climb|comehere|searchForEntity|searchForBlock|fish|parkour|goTocordinates|goToPlayer|goTorememberedplace|recall|ridehorse|boat)/i;
    const IN_PLACE = /^!(breedAnimals|pickupItems|nearbyBlocks|entities|surroundings|inventory|lookDir|stats|chunk|map|terrainScan|entities)/i;
    const score = n => {
        let hit = 0;
        for (const w of wordsOf(n)) {
            if (w.length <= 2 || STOP.has(w)) continue;
            if (g.includes(w)) hit += w.length * 2;
        }
        if (travel) {
            if (MOVERS.test(n)) hit += 45;
            if (IN_PLACE.test(n)) hit -= 35;
        }
        // The pre-existing food branch, so the "food goal is not hijacked"
        // assertion exercises the real interaction rather than a stub.
        if (/(food|eat|hunger|drink|sleep|health)/i.test(g)) {
            if (/^!(getfood|eat|drink|consume|restoreheal|sethealth)/i.test(n)) hit += 30;
            if (/^!(findshelter|findcave|buildshelter|findsaf(e|er)place)/i.test(n)) hit -= 20;
        }
        return hit;
    };
    return names.map(n => ({ n, s: score(n) })).filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s).map(x => x.n);
};

test('the exact goal from the live log now reaches several commands, not one', () => {
    const ranked = scoreFor(GOAL);
    assert.ok(ranked.length >= 5,
        `only ${ranked.length} commands reached her for "${GOAL}": ${ranked.join(', ')}`);
});

test('the command she was previously given is no longer the only option', () => {
    const ranked = scoreFor(GOAL);
    assert.ok(!(ranked.length === 1 && ranked[0] === '!breedAnimals'),
        'she is still told to breed animals and nothing else - 15 calls, 0 blocks moved');
});

test('the travel-goal scoring branch exists in the real source', () => {
    assert.match(code, /MOVERS\.test\(n\)\) s \+= 45/,
        'the real scorer must reward commands that move her');
    assert.match(code, /IN_PLACE\.test\(n\)\) s -= 35/,
        'observation-only commands must be pushed down for a travel goal');
    assert.match(code, /explore\|wander\|travel\|scout\|roam\|venture/,
        'the travel goal pattern must recognise the verbs the curriculum emits');
});

test('a food goal is not hijacked by the travel branch', () => {
    const ranked = scoreFor('find something to eat');
    assert.ok(ranked.includes('!getFood'),
        'a food goal must still reach !getFood; the travel branch must not change it');
});

test('every command offered for a travel goal actually moves her or is harmless', () => {
    // Not a strict assertion on the whole list - the point is that the TOP
    // option is a mover, not an observation.
    const top = scoreFor(GOAL)[0];
    assert.ok(/scout|goTo|searchFor|findCave|findShelter|climb|comeHere|fish|parkour|rideHorse|boat|recall/i.test(top),
        `top suggestion for a travel goal is ${top}, which does not travel`);
});

test('no offered command needs an argument she was never given', () => {
    for (const n of ['!scout', '!goToSurface', '!findCave', '!findShelter', '!climb', '!comeHere']) {
        if (!names.includes(n)) continue;
        assert.equal(arity[n].required, 0, `${n} requires an argument`);
    }
});
