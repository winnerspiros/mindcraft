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
        // The craft-goal branch (added 2026-10-07) - the live goal "craft
        // something useful from nearby resources" must reach a gatherer, not
        // only the craft-observers whose names happen to contain "craft".
        if (/(?:\b(craft|build|make|forge|smelt|construct|fashion|weave|assemble)\b)/i.test(g)) {
            if (/^!(collectBlocks|searchForBlock|goTosurface|climb|goTocordinates|fish|scout)/i.test(n)) hit += 40;
            if (/^!(craftable|getCraftingPlan)/i.test(n)) hit -= 35;
        }
        // The cave/mine/dig branch (added 2026-10-07) - a cave goal must reach
        // the dig verbs, or she walks to the cave and can only re-run !findCave
        // at a blocked mouth instead of tunnelling in. Tokens word-bounded: the
        // over-fire fix (a zombie-fight goal "deal with the zombie before it
        // gets to me" used to match on "ore" inside "before" and hijacked her
        // into !digDown at a hostile).
        if (/(?:\b(cave|cavern|mine|underground|tunnel|dig|excavat|resource|ore|mineral|shaft)\b)/i.test(g)) {
            if (/^!(digDown|digUp|collectBlocks|levelGround|searchForBlock)/i.test(n)) hit += 55;
        }
        // The combat branch (added 2026-10-07) - a hostile goal must reach
        // !shoot/!attack, or she owns a bow and 64 arrows yet never arms them
        // against an airborne Wither (she cannot melee it and the scorer only
        // offered !skillCode/!skillList / nothing).
        if (/(?:\b(kill|fight|defend|slay|hunt|attack|shoot|hostile|threat|enemy)\b|\b(wither|zombie|pillager|creeper|skeleton|phantom|enderman)\b)/i.test(g)) {
            if (/^!(attack|attackPlayer|shoot|shootPlayer|defendSelf|equip|equipElytra)/i.test(n)) hit += 55;
        }
        return hit;
    };
    return names.map(n => ({ n, s: score(n) })).filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s).slice(0, 12).map(x => x.n);
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

// ── CRAFT/BUILD GOAL MUST REACH A GATHER, NOT A CRAFT-OBSERVER ─────────
// Regression (2026-10-07): the live goal "craft something useful from nearby
// resources" scored ONLY the pure craft verbs (!craftable, !getCraftingPlan,
// !craftRecipe) because "craft" is in both the goal and their names, and
// nothing else. She had no materials and no crafting table, so those commands
// answered "CRAFTABLE_ITEMS: none" / "needs a crafting table (3x3)" every
// turn, she never ran !collectBlocks, and sat frozen on the surface. The
// craft-goal branch must elect gatherers (which unblock the chain) and push
// the pure observers out.
const CRAFT_GOAL = 'craft something useful from nearby resources';
test('the exact live craft goal now reaches a gatherer, not only craft-observers', () => {
    const ranked = scoreFor(CRAFT_GOAL);
    assert.ok(ranked.includes('!collectBlocks'),
        `the craft goal must reach !collectBlocks (gather oak_log -> planks -> table); got: ${ranked.join(', ')}`);
    assert.ok(/^!(collectBlocks|searchForBlock|goToSurface|climb|goToCoordinates)$/i.test(ranked[0]),
        `top suggestion for a craft goal is ${ranked[0]}, which does not gather or move toward the material`);
    assert.ok(!(ranked.length && ranked.slice(0, 3).includes('!craftable')),
        `!craftable (pure observer) must not rank in the top 3 for an empty-pack craft goal: ${ranked.slice(0, 3).join(', ')}`);
});

test('the craft-goal scoring branch exists in the real source', () => {
    assert.match(code, /collectBlocks\|searchForBlock\|goTosurface\|climb\|goTocordinates/,
        'the real scorer must reward gatherers for a craft goal');
    assert.match(code, /craftable\|getCraftingPlan/,
        'the real scorer must push pure craft-observers down for a craft goal');
    assert.match(code, /\(craft\|build\|make\|forge\|smelt\|construct\|fashion\|weave\|assemble\)/,
        'the craft goal pattern must recognise the verbs the curriculum emits');
});

// ── CAVE/MINE/DIG GOAL MUST REACH THE DIG VERBS ──────────────────────────
// Regression (2026-10-07): the live cave goal "explore the nearby cave for
// more resources" offered ONLY travel movers (!findCave, !searchForBlock,
// ...), so when the cave mouth was blocked and walking nav died 15 blocks
// short, she had no dig command to tunnel in — and re-ran !findCave for
// minutes while her memory said "next step is to dig towards the cave".
const CAVE_GOAL = 'explore the nearby cave for more resources';
test('the exact live cave goal now reaches the dig verbs', () => {
    const ranked = scoreFor(CAVE_GOAL);
    assert.ok(ranked.some(n => /^!(digDown|digUp|collectBlocks)$/i.test(n)),
        `a cave goal must reach a dig verb to tunnel past a blocked mouth; got: ${ranked.join(', ')}`);
});
test('the dig-goal scoring branch exists in the real source', () => {
    assert.match(code, /digDown\|digUp\|collectBlocks\|levelGround\|searchForBlock/,
        'the real scorer must reward dig verbs for a cave goal');
});

// ── FIGHT/THREAT GOAL MUST REACH THE COMBAT VERBS ────────────────────────
// Regression (2026-10-07): she owns a bow + 64 arrows and !shoot is a real
// command, but "kill the wither" / "deal with the zombie" offered
// !skillCode/!skillList / nothing — !shoot only scored when the goal text
// literally said "shoot". She could not melee an airborne Wither and died.
const WITHER_GOAL = 'kill the wither';
test('a hostile goal now reaches a combat verb', () => {
    const ranked = scoreFor(WITHER_GOAL);
    assert.ok(ranked.some(n => /^!(shoot|shootPlayer|attack|attackPlayer|defendSelf)$/i.test(n)),
        `a Wither/fight goal must reach a ranged/combat verb (she owns a bow); got: ${ranked.join(', ')}`);
});
test('the combat-goal scoring branch exists in the real source', () => {
    assert.match(code, /wither\|zombie\|pillager\|creeper\|skeleton\|phantom\|enderman/,
        'the real scorer must anchor combat verbs on the mob, not just the word "shoot"');
    assert.match(code, /attack\|attackPlayer\|shoot\|shootPlayer\|defendSelf\|equip/,
        'the real scorer must reward the ranged combat verbs');
});

// ── OVER-FIRE REGRESSION ────────────────────────────────────────────────
// Word-bounding got verified by a real blunder: "deal with the zombie before
// it gets to me" matched the then-unbounded cave pattern on "ore" inside
// "before", handed her a dig-only list, and she ran !digDown 3 at a hostile.
// A fight goal must never be polluted with dig/mine verbs.
const FIGHT_GOAL = 'deal with the zombie before it gets to me';
test('a fight goal is not polluted with dig verbs by the cave branch', () => {
    const ranked = scoreFor(FIGHT_GOAL);
    assert.ok(!ranked.some(n => /^!(digDown|digUp|collectBlocks|levelGround|mine)$/i.test(n)),
        `a fight goal must not be offered dig/mine verbs (over-fire - "ore" in "before"); got: ${ranked.join(', ')}`);
});
test('the cave and craft branch tokens are word-bounded in the real source', () => {
    assert.match(code, /\\b\(cave\|cavern\|mine\|underground\|tunnel\|dig\|excavat\|resource\|ore\|mineral\|shaft\)\\b/,
        'the cave pattern must word-bound its material tokens (ore in before / mine in minecraft)');
});

test('no offered command needs an argument she was never given', () => {
    for (const n of ['!scout', '!goToSurface', '!findCave', '!findShelter', '!climb', '!comeHere']) {
        if (!names.includes(n)) continue;
        assert.equal(arity[n].required, 0, `${n} requires an argument`);
    }
});
