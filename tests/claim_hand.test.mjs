// Behavioural tests for claimHand(), the wrapper that makes a chew own the hand.
//
// This matters more than it looks. claimHand() replaces bot.equip for the whole
// process. If the claim ever got stuck true, EVERY equip would queue forever -
// mining, bow, gear-up, respawn kit - with no exception and no way back, because
// the only exit is eatNow's own finally(). These tests pin the two escapes:
//
//   1. the deadline releases a wedged claim so equipping recovers
//   2. the queue is bounded, because the pathfinder re-equips every tick it has
//      a dig goal and would otherwise pile up without limit
//
// They also pin the reentrancy rule that got this wrong once already: the eater
// must bypass its own queue, or eatNow deadlocks on the equip it just gated.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { claimHand } from '../src/agent/library/skills.js';

const foods = (n, name) => Array.from({ length: n }, () => ({ name: name || `f${n}`, count: 1 }));

// A stand-in for mineflayer's bot with just the surface claimHand touches.
function fakeBot({ equipDelay = 0 } = {}) {
    const calls = [];
    const bot = {
        heldItem: null,
        equip: async (item) => {
            calls.push(item.name);
            if (equipDelay) await new Promise(r => setTimeout(r, equipDelay));
            bot.heldItem = item;
            return true;
        },
        _equipCalls: calls,
    };
    return claimHand(bot);
}

test('a chew defers other equips, and they run once it finishes', async () => {
    const bot = fakeBot();
    const food = { name: 'cooked_beef', count: 4 };

    bot._eating = true;
    bot._eatingHand = food;
    bot._eatingStamp = Date.now();

    const sword = { name: 'diamond_sword' };
    const queued = bot.equip(sword, 'hand');

    // Deferred, not performed: the sword must not reach the hand mid-chew.
    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(bot._equipCalls, [],
        'a weapon was equipped over an active chew');
    assert.strictEqual(bot.heldItem, null);

    // Ending the bite must let the deferred work actually happen.
    bot._eating = false;
    await bot._releaseHand();
    assert.deepStrictEqual(bot._equipCalls, ['diamond_sword'],
        'the queued equip was lost instead of run');
    await queued;
    assert.strictEqual(bot.heldItem.name, 'diamond_sword');
});

test("the eater's own equip bypasses the queue (no deadlock)", async () => {
    const bot = fakeBot();
    const food = { name: 'cooked_beef', count: 4 };
    bot._eating = true;
    bot._eatingHand = food;
    bot._eatingStamp = Date.now();

    // This is exactly what eatNow does: claim, then equip. If the wrapper
    // queued it, this await would never settle and eating would hang forever.
    const res = await Promise.race([
        bot.equip(food, 'hand'),
        new Promise(r => setTimeout(() => r('DEADLOCK'), 500)),
    ]);
    assert.notStrictEqual(res, 'DEADLOCK', 'the eater deadlocked against its own claim');
    assert.deepStrictEqual(bot._equipCalls, ['cooked_beef']);
    assert.strictEqual(bot.heldItem.name, 'cooked_beef');
});

test('a wedged claim is released, so equipping recovers', async () => {
    const bot = fakeBot();
    bot._eating = true;
    bot._eatingStamp = Date.now() - 60000; // the finally() never ran
    bot._eatingHand = { name: 'ghost_food' };

    const sword = { name: 'diamond_sword' };
    const res = await Promise.race([
        bot.equip(sword, 'hand'),
        new Promise(r => setTimeout(() => r('WEDGED'), 500)),
    ]);
    assert.notStrictEqual(res, 'WEDGED',
        'a stale claim wedged every equip in the process with no way back');
    assert.deepStrictEqual(bot._equipCalls, ['diamond_sword']);
});

test('the queue is bounded - a long chew cannot grow it without limit', async () => {
    const bot = fakeBot();
    bot._eating = true;
    bot._eatingStamp = Date.now();

    // The pathfinder re-equips every tick while it has a dig goal.
    const pending = [];
    for (let i = 0; i < 400; i++) {
        pending.push(bot.equip({ name: `pick_${i}` }, 'hand'));
    }
    assert.ok(bot._handQueue.length <= 8,
        `queue grew to ${bot._handQueue.length} - unbounded`);

    // Every dropped caller must be settled, not left hanging on a promise that
    // will never resolve.
    bot._eating = false;
    await bot._releaseHand();
    const results = await Promise.all(pending);
    assert.strictEqual(results.length, 400);
    assert.ok(results.every(r => r !== undefined),
        'a dropped equip left a promise unresolved');
});

test('installing twice does not wrap equip twice', () => {
    const bot = fakeBot();
    const wrapped = bot.equip;
    claimHand(bot);
    claimHand(bot);
    assert.strictEqual(bot.equip, wrapped, 'equip was re-wrapped on a second claimHand');
});

test('releasing an empty queue is a no-op, not a throw', async () => {
    const bot = fakeBot();
    await bot._releaseHand();
    await bot._releaseHand();
    assert.deepStrictEqual(bot._equipCalls, []);
});

// The deadline and cap must actually exist in the source, not just in the fake.
test('the safety limits are real constants in the source', () => {
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    assert.ok(/const CLAIM_TIMEOUT_MS = \d+;/.test(src),
        'no timeout constant - a wedged claim could never recover');
    assert.ok(/const MAX_QUEUE = \d+;/.test(src),
        'no queue cap - the pathfinder could grow it without limit');
    // The eater bypass must be checked BEFORE the queueing branch, or the
    // eater's own equip gets queued and eating deadlocks.
    const wrapper = src.slice(src.indexOf('bot.equip = async'));
    const bypass = wrapper.indexOf('bot._eatingHand === args[0]');
    const queue = wrapper.indexOf('_handQueue.push');
    assert.ok(bypass > -1, 'the eater has no bypass');
    assert.ok(bypass < queue,
        'the queueing branch runs before the eater bypass - eatNow would deadlock');
});