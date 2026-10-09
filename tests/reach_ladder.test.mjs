// BEHAVIOURAL: the never-give-up ladder must actually MOVE her.
// Static source-code checks ("ladder exists") pass while the rungs are inert
// — a renamed helper, a swallowed await, a rung that always throws quietly
// reads fine to a regex and strands her live. So this drives the REAL
// exported reachPosition/goToPosition/goToBlockAdjacent against a mock bot
// with a scripted pathfinder: each rung's failure mode is simulated
// (straight leg fails, waypoints fail, ...) and the test asserts she climbs
// to the NEXT rung and eventually reports arrival. Failure = fabricated
// wiring, not missing prose.
import test from 'node:test';
import assert from 'node:assert';
import { Vec3 } from 'vec3';
import { createRequire } from 'node:module';
import * as skills from '../src/agent/library/skills.js';

const require = createRequire(import.meta.url);
// Real block registry: Movements reads a dozen named ids at construction.
// A hand-rolled stub rots; the real data does not.
const mcdata = require('minecraft-data')('1.21.4');

// Minimal bot the real ladder accepts. The pathfinder is scripted per test:
// plan(script) answers getPathTo, goto() teleports to the goal (the mock
// world has no obstacles — arrival is what the rungs must produce).
function mockBot({ plan, items = [], pos = new Vec3(0, 64, 0), water = false, rconCounts = null } = {}) {
    const p = pos.clone();
    const state = { planCalls: [], gotoGoals: [], pos: p };
    const bot = {
        username: 'TestUwU',
        output: '',
        entity: { position: state.pos, yaw: 0 },
        health: 20, food: 20,
        interrupt_code: false,
        heldItem: null,
        modes: { isOn: () => false, pause: () => {} },
        inventory: {
            items: () => items.slice(),
            slots: {},
            findInventoryItem: (n) => items.find(i => i.name === n) || null,
        },
        players: {},
        registry: mcdata,
        version: '1.21.4',
        blockAt: (v) => {
            const feet = state.pos;
            // feet block: water when the test says wet, else air
            if (Math.floor(v.x) === Math.floor(feet.x) && Math.floor(v.z) === Math.floor(feet.z)
                && (Math.floor(v.y) === Math.floor(feet.y) || Math.floor(v.y) === Math.floor(feet.y) + 1))
                return water ? { name: 'water', position: v.clone() } : { name: 'air', boundingBox: 'empty', position: v.clone() };
            return { name: 'stone', boundingBox: 'block', diggable: true, drops: [1], position: v.clone(), canHarvest: () => true };
        },
        findBlocks: () => [new Vec3(2, 64, 0)],
        pathfinder: {
            setMovements: () => {},
            isMoving: () => false,
            stop: () => {},
            setGoal: () => {},
            getPathTo: async (movements, goal, timeout) => {
                state.planCalls.push({ x: goal.x ?? goal.target?.x, y: goal.y ?? goal.target?.y, timeout });
                return plan(goal, state);
            },
            goto: async (goal) => {
                state.gotoGoals.push(goal);
                const gx = goal.x ?? goal.target?.x ?? state.pos.x;
                const gy = goal.y ?? goal.target?.y ?? state.pos.y;
                const gz = goal.z ?? goal.target?.z ?? state.pos.z;
                state.pos.x = gx; state.pos.y = gy; state.pos.z = gz;
            },
        },
        setControlState: () => {},
        look: async () => {}, lookAt: async () => {},
        equip: async () => {}, activateItem: async () => {},
        waitForTicks: async () => {},
        dig: async (b) => { bot._dug = (bot._dug || 0) + 1; },
        agent: { self_prompter: { reportNav: () => {} } },
    };
    bot._state = state;
    return bot;
}
const failPlan = async () => ({ status: 'no-path' });
const okPlan = async () => ({ status: 'success', cost: 10, path: [] });

test('rung 1: open ground walks straight, single plan, arrival true', async () => {
    const bot = mockBot({ plan: okPlan });
    const ok = await skills.reachPosition(bot, 5, 64, 0, 2, 'test-target');
    assert.equal(ok, true, 'open ground must arrive');
    assert.ok(bot.output.length > 0, 'ladder must narrate');
});

test('rung 2: straight leg fails, waypoints carry a far target home', async () => {
    // goToGoal retries internally (destructive probe, long retry, loosened
    // probe), so ONE failed plan call is not a failed leg. Fail the whole
    // first leg's probe batch; waypoint hops after that succeed.
    let n = 0;
    const bot = mockBot({ plan: async () => (++n <= 5 ? { status: 'no-path' } : { status: 'success', cost: 10, path: [] }) });
    const ok = await skills.reachPosition(bot, 40, 64, 0, 2, 'far-target');
    assert.equal(ok, true, 'waypoint rung must carry a far target home');
    assert.ok(bot._state.gotoGoals.length >= 2, `expected waypoint hops, got ${bot._state.gotoGoals.length} goto calls`);
});

test('rung 3: blocked start sidesteps (escapeStuck) then re-plans', async () => {
    // fail until the sidestep goal (free-space probe at 2,64,0) succeeds once
    let n = 0;
    const bot = mockBot({
        plan: async (goal) => {
            n++;
            const gx = goal.x ?? goal.target?.x;
            if (gx === 2) return { status: 'success', cost: 5, path: [] }; // sidestep lands
            return n < 6 ? { status: 'no-path' } : { status: 'success', cost: 10, path: [] };
        },
    });
    const ok = await skills.reachPosition(bot, 6, 64, 0, 1, 'blocked-target');
    assert.equal(ok, true, 'sidestep + re-plan must unstick a blocked start');
    assert.match(bot.output, /Sidestep|sidestep|open ground/i, 'must narrate the sidestep rung');
});

test('rung 6 honest: walled in with no pickaxe says so, returns false', async () => {
    const bot = mockBot({ plan: failPlan, items: [], pos: new Vec3(0, 64, 0) });
    const ok = await skills.reachPosition(bot, 30, 64, 0, 2, 'walled-target');
    assert.equal(ok, false, 'no route + no pick must be an honest false, not a hang');
    assert.match(bot.output, /no pickaxe/i, 'must name the missing pickaxe');
});

test('rung 0 wet-first: a wet bot swims before any walking', async () => {
    let swam = 0;
    const bot = mockBot({ plan: failPlan, water: true });
    bot.blockAt = (v) => {
        swam++;
        if (swam > 4) return { name: 'air', boundingBox: 'empty', position: v.clone() };
        if (Math.floor(v.x) === 0 && Math.floor(v.z) === 0 && (Math.floor(v.y) === 64 || Math.floor(v.y) === 65))
            return { name: 'water', position: v.clone() };
        return { name: 'stone', boundingBox: 'block', diggable: true, drops: [1], position: v.clone(), canHarvest: () => true };
    };
    const ok = await skills.reachPosition(bot, 30, 64, 0, 2, 'wet-target');
    assert.match(bot.output, /In water — swimming up before walking/, 'a wet bot must swim FIRST, before walk/waypoint/tunnel rungs');
    assert.equal(typeof ok, 'boolean', 'must settle boolean');
});

test('goToPosition funnels through the ladder: blocked straight leg still arrives via waypoints', async () => {
    let n = 0;
    const bot = mockBot({ plan: async () => (++n <= 2 ? { status: 'no-path' } : { status: 'success', cost: 10, path: [] }) });
    const ok = await skills.goToPosition(bot, 40, 64, 0, 2, 'walk');
    assert.equal(ok, true, 'goToPosition must climb the ladder, not quit at the first no-path');
    assert.match(bot.output, /You have reached/, 'must log arrival');
});

test('goToBlockAdjacent funnels through the ladder and reports honestly', async () => {
    const bot = mockBot({ plan: okPlan });
    const ok = await skills.goToBlockAdjacent(bot, { name: 'chest', position: new Vec3(5, 64, 0) }, 2);
    assert.equal(ok, true, 'adjacent walk on open ground must succeed');
    const bot2 = mockBot({ plan: failPlan });
    const ok2 = await skills.goToBlockAdjacent(bot2, { name: 'chest', position: new Vec3(60, 64, 0) }, 2);
    assert.equal(ok2, false, 'impossible walk must be an honest false');
});

test('bad coordinates refuse fast, never hang', async () => {
    const bot = mockBot({ plan: okPlan });
    const ok = await skills.reachPosition(bot, NaN, 64, 0, 2, 'bad-target');
    assert.equal(ok, false, 'NaN target must refuse');
    assert.equal(bot._state.planCalls.length, 0, 'no planning work for garbage input');
});

test('interrupt aborts the ladder promptly', async () => {
    const bot = mockBot({ plan: failPlan });
    bot.interrupt_code = true;
    const t0 = Date.now();
    const ok = await skills.reachPosition(bot, 40, 64, 0, 2, 'interrupt-target');
    assert.ok(Date.now() - t0 < 15000, `interrupted ladder must abort fast, took ${Date.now() - t0}ms`);
    assert.equal(ok, false, 'interrupted climb is not arrival');
});
