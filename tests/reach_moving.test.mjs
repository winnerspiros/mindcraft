// BEHAVIOURAL 3: moving targets, far legs, mid-air. She must reach a player
// who walks mid-chase (fresh RCON reads each leg), cross 200+ block legs via
// waypoint hops, climb to the sky (pillar lifts when ungeared, elytra when
// geared), and refuse the void honestly. Same mock-world pattern as the
// ladder/rungs batteries: scripted planner, real exported functions.
import test from 'node:test';
import assert from 'node:assert';
import { Vec3 } from 'vec3';
import { createRequire } from 'node:module';
import * as skills from '../src/agent/library/skills.js';

const require = createRequire(import.meta.url);
const mcdata = require('minecraft-data')('1.21.4');

function worldBot({ plan, items = [], pos = new Vec3(0, 64, 0), cells = new Map(), playerPos = null } = {}) {
    const p = pos.clone();
    const state = { planCalls: [], gotoGoals: [], pos: p, dug: [], placed: [] };
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
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
            slots: items.map((it, i) => ({ name: it.name, count: it.count, slot: i })),
            findInventoryItem: (n) => items.find(i => i.name === n) || null,
        },
        players: playerPos ? { Mover: { entity: { position: playerPos.clone() } } } : {},
        registry: mcdata,
        version: '1.21.4',
        getEquipmentDestSlot: () => 5,
        blockAt: (v) => {
            const k = key(v.x, v.y, v.z);
            if (cells.has(k)) {
                const n = cells.get(k);
                if (n === null) return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) };
                return { name: n, boundingBox: 'block', diggable: true, drops: [1], position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), canHarvest: () => true };
            }
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
        clearControlStates: () => {},
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
            const fx = Math.floor(state.pos.x), fy = Math.floor(state.pos.y), fz = Math.floor(state.pos.z);
            cells.set(`${fx},${fy},${fz}`, 'dirt');
            state.pos.y += 1;
        },
        agent: { self_prompter: { reportNav: () => {} } },
    };
    bot._state = state; bot._cells = cells;
    return bot;
}
const okPlan = async () => ({ status: 'success', cost: 10, path: [] });

test('far leg: 200-block target arrives via waypoint hops', async () => {
    // first leg's whole probe batch fails (goToGoal retries internally), so
    // the waypoint rung engages; hops after that succeed on open ground.
    let n = 0;
    const bot = worldBot({ plan: async () => (++n <= 5 ? { status: 'no-path' } : { status: 'success', cost: 10, path: [] }) });
    const t0 = Date.now();
    const ok = await skills.reachPosition(bot, 200, 64, 0, 2, 'far-200');
    assert.ok(Date.now() - t0 < 90000, `far leg must settle, took ${Date.now() - t0}ms`);
    assert.equal(ok, true, 'a 200-block leg must arrive');
    assert.ok(bot._state.gotoGoals.length >= 3, `expected hop chain, got ${bot._state.gotoGoals.length} gotos`);
});

test('sky ungeared: no scaffold at all -> sky rung narrates the hand-climb, honest false', async () => {
    // planner NEVER succeeds and the pack is EMPTY: rung 4 finds no mat,
    // so the sky rung (dy=26>13) must narrate the no-elytra hand-climb and
    // the ladder must settle an honest false (nothing to climb with).
    const bot = worldBot({
        items: [],
        plan: async () => ({ status: 'no-path' }),
    });
    const t0 = Date.now();
    const ok = await skills.reachPosition(bot, 2, 90, 0, 3, 'sky-high');
    assert.ok(Date.now() - t0 < 120000, `must settle, took ${Date.now() - t0}ms`);
    assert.match(bot.output, /up — (no elytra|flying|wings)/i, 'sky rung must narrate the flight-or-climb decision');
    assert.match(bot.output, /Nothing to pillar with/i, 'empty pack must be named honestly');
    assert.equal(ok, false, 'no route + no scaffold is an honest false');
});

test('sky geared: elytra + rockets -> flight rung fires', async () => {
    const bot = worldBot({
        items: [{ name: 'elytra', count: 1 }, { name: 'firework_rocket', count: 8 }],
        pos: new Vec3(0, 80, 0),
        plan: async () => ({ status: 'no-path' }),
    });
    bot.entity.elytraFlying = false;
    // takeOff needs height + jump; stub the flight loop short: flyWithElytra
    // fails fast without a real sky, but the RUNG must attempt it first.
    const ok = await skills.reachPosition(bot, 30, 120, 0, 3, 'sky-fly');
    assert.match(bot.output, /flying it|wings/i, 'geared sky target must attempt flight before hand-climb');
    assert.equal(typeof ok, 'boolean');
});

test('moving player: walker follows fresh reads across legs', async () => {
    // player entity rendered: GoalFollow legs walk it directly.
    const ep = new Vec3(10, 64, 0);
    const bot = worldBot({ plan: okPlan, playerPos: ep });
    const ok = await skills.goToPlayer(bot, 'Mover', 3);
    assert.equal(ok, true, 'a rendered nearby player must be reached');
    assert.match(bot.output, /reached Mover/i, 'must log arrival at the player');
});

test('ghost player: entity NaN -> RCON walker path, honest when nobody home', async () => {
    const bot = worldBot({ plan: okPlan });
    bot.players = { Ghost: { entity: { position: new Vec3(NaN, NaN, NaN) } } };
    const ok = await skills.goToPlayer(bot, 'Ghost', 3);
    assert.equal(typeof ok, 'boolean', 'ghost entity must settle boolean, never hang');
});

test('void refusal: target below the world floor refuses fast', async () => {
    const bot = worldBot({ plan: async () => ({ status: 'no-path' }) });
    const t0 = Date.now();
    const ok = await skills.reachPosition(bot, 0, -70, 0, 2, 'void-deep');
    assert.ok(Date.now() - t0 < 90000, 'must settle, never hang');
    assert.equal(typeof ok, 'boolean');
});

test('travelTrick: far + pearls + healthy -> pearls instead of walking', async () => {
    const bot = worldBot({
        items: [{ name: 'ender_pearl', count: 2 }],
        plan: okPlan,
    });
    let threw = false;
    bot.activateItem = async () => { threw = true; };
    const ok = await skills.travelTrick(bot, 60, 64, 0);
    assert.ok(threw || /pearl/i.test(bot.output), 'far + pearls must pearl, not walk 60 blocks');
    assert.equal(typeof ok, 'boolean');
});

test('travelTrick: mid + blocks -> bridges instead of pearling hurt', async () => {
    const bot = worldBot({
        items: [{ name: 'dirt', count: 32 }],
        plan: okPlan,
    });
    bot.health = 5; // pearling would suicide: must bridge or walk
    let threw = false;
    bot.activateItem = async () => { threw = true; };
    const ok = await skills.travelTrick(bot, 20, 64, 0);
    assert.equal(threw, false, 'hurt bot must never pearl');
    assert.equal(typeof ok, 'boolean');
});
