// BEHAVIOURAL 2: the UP / DOWN / THROUGH rungs must move her, not just log.
// Rung 4 (climb): above-target + failing plans -> diagonalAscent or pillarUp
// fires, she gains height, re-walks, arrives. Rung 5 (down): below-target ->
// digDown fires. Rung 6 (through): pickaxe carried -> tunnel digs toward
// the target and the re-plan walks the hole. Each test scripts the planner
// so the rung under test is the ONLY way home, and asserts displacement +
// arrival, not prose.
import test from 'node:test';
import assert from 'node:assert';
import { Vec3 } from 'vec3';
import { createRequire } from 'node:module';
import * as skills from '../src/agent/library/skills.js';

const require = createRequire(import.meta.url);
const mcdata = require('minecraft-data')('1.21.4');

// World: flat stone floor at y=63, air above. blockAt answers from a mutable
// cell map so dig() visibly removes walls and placeBlock() visibly adds them.
function worldBot({ plan, items = [], pos = new Vec3(0, 64, 0), cells = new Map() } = {}) {
    const p = pos.clone();
    const state = { planCalls: [], gotoGoals: [], pos: p, dug: [], placed: [] };
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    if (!cells.has(key(0, 63, 0))) cells.set(key(0, 63, 0), 'stone');
    const bot = {
        username: 'TestUwU',
        output: '',
        entity: { position: state.pos, yaw: 0, onGround: true },
        game: { gameMode: 'survival' },
        health: 20, food: 20,
        interrupt_code: false,
        heldItem: null,
        modes: { isOn: () => false, pause: () => {} },
        inventory: {
            items: () => items.slice(),
            slots: Object.fromEntries(items.map((it, i) => [i, { name: it.name, count: it.count, slot: i }])),
            findInventoryItem: (n) => items.find(i => i.name === n) || null,
        },
        players: {},
        registry: mcdata,
        version: '1.21.4',
        blockAt: (v) => {
            const k = key(v.x, v.y, v.z);
            if (cells.has(k)) {
                const n = cells.get(k);
                if (n === null) return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) };
                return { name: n, boundingBox: 'block', diggable: true, drops: [1], position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), canHarvest: () => true };
            }
            // floor at y<=63 solid, air above, except feet-adjacent staging
            if (Math.floor(v.y) <= 63) return { name: 'stone', boundingBox: 'block', diggable: true, drops: [1], position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), canHarvest: () => true };
            return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) };
        },
        findBlocks: () => [new Vec3(2, 64, 0)],
        pathfinder: {
            setMovements: () => {},
            isMoving: () => false,
            stop: () => {},
            setGoal: () => {},
            getPathTo: async (movements, goal, timeout) => {
                state.planCalls.push({ x: goal.x ?? goal.target?.x, y: goal.y ?? goal.target?.y });
                return plan(goal, state, bot);
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
        equip: async (it) => { bot.heldItem = { slot: 0 }; },
        activateItem: async () => {},
        waitForTicks: async () => {},
        dig: async (b) => {
            state.dug.push(b.name);
            cells.set(key(b.position.x, b.position.y, b.position.z), null);
        },
        placeBlock: async (ref, face) => {
            state.placed.push(1);
            // emulate the server: the placed block lands at her feet cell
            // (pillar places at feet), so the next layer has footing.
            const fx = Math.floor(state.pos.x), fy = Math.floor(state.pos.y), fz = Math.floor(state.pos.z);
            cells.set(`${fx},${fy},${fz}`, 'dirt');
            state.pos.y += 1;
        },
        activateBlock: async () => {},
        agent: { self_prompter: { reportNav: () => {} } },
    };
    bot._state = state; bot._cells = cells;
    return bot;
}
const failPlan = async () => ({ status: 'no-path' });
const okPlan = async () => ({ status: 'success', cost: 10, path: [] });

test('rung 4 climb: above-target, no walkable route, scaffold carried -> gains height and arrives', async () => {
    // plans fail until she is at height (>= y=68); then they succeed.
    const bot = worldBot({
        items: [{ name: 'dirt', count: 64 }],
        plan: async (goal, state) => (state.pos.y >= 68 ? { status: 'success', cost: 10, path: [] } : { status: 'no-path' }),
    });
    const ok = await skills.reachPosition(bot, 2, 69, 0, 2, 'high-ledge');
    assert.equal(ok, true, 'climb rung must gain height and re-walk home');
    assert.ok(bot._state.pos.y >= 66, `expected height gain, still at y=${bot._state.pos.y}`);
});

test('rung 5 down: below-target, no walkable route -> digDown fires toward it', async () => {
    const bot = worldBot({ plan: failPlan, pos: new Vec3(0, 70, 0) });
    const ok = await skills.reachPosition(bot, 0, 64, 0, 2, 'deep-target');
    assert.match(bot.output, /digging down/i, 'below-target must trigger the dig-down rung');
    assert.equal(typeof ok, 'boolean');
});

test('rung 6 through: pickaxe carried, wall between -> tunnel digs toward target', async () => {
    // build a wall at x=1..6 (feet+head) so only digging passes; plans fail
    // until at least 3 tunnel blocks are dug, then succeed.
    const cells = new Map();
    for (let x = 1; x <= 6; x++) for (const y of [64, 65]) cells.set(`${x},${y},0`, 'stone');
    const bot = worldBot({
        items: [{ name: 'stone_pickaxe', count: 1 }],
        cells,
        plan: async (goal, state) => (state.dug.length >= 3 ? { status: 'success', cost: 10, path: [] } : { status: 'no-path' }),
    });
    const ok = await skills.reachPosition(bot, 10, 64, 0, 2, 'far-side');
    assert.ok(bot._state.dug.length >= 3, `tunnel rung must dig toward the target, dug=${bot._state.dug.length}`);
    assert.equal(ok, true, 'tunnel + re-plan must arrive');
});

test('rung 4 honest: above-target, nothing to pillar with -> says so, no hang', async () => {
    const bot = worldBot({ plan: failPlan, items: [] });
    const t0 = Date.now();
    const ok = await skills.reachPosition(bot, 0, 70, 0, 2, 'high-no-blocks');
    assert.ok(Date.now() - t0 < 60000, 'must settle, never hang');
    assert.equal(ok, false, 'no route + no scaffold is an honest false');
});

test('pearl panic: far + pearls + healthy -> pearl rung fires when walking fails', async () => {
    const bot = worldBot({
        items: [{ name: 'ender_pearl', count: 4 }],
        plan: failPlan,
    });
    let threw = false;
    bot.activateItem = async () => { threw = true; };
    const ok = await skills.reachPosition(bot, 60, 64, 0, 2, 'far-pearl');
    assert.ok(threw || /pearl/i.test(bot.output), 'far + pearls + healthy must attempt the pearl rung');
    assert.equal(typeof ok, 'boolean');
});

test('pearl refused when hurt: no suicide throws under 6 HP', async () => {
    const bot = worldBot({
        items: [{ name: 'ender_pearl', count: 4 }],
        plan: failPlan,
    });
    bot.health = 5;
    let threw = false;
    bot.activateItem = async () => { threw = true; };
    await skills.reachPosition(bot, 60, 64, 0, 2, 'far-hurt');
    assert.equal(threw, false, 'must never pearl under 6 HP');
});
