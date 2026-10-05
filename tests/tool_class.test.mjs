// Which tool harvests a block. This was three drifting copies of one regex, and
// none of them knew that a FENCE is wood -- "fence" contains none of
// log/wood/plank, so oak_fence fell through to 'pickaxe'. The hand-gate then
// refused to break fences the road had just laid, and the cells behind them read
// as permanently blocked.
//
// The deeper lesson: two log lines in that branch referenced a variable that no
// longer existed, so BOTH branches threw ReferenceError -- swallowed by the
// enclosing try/catch, and surfacing as "no pickaxe anywhere".
import { test } from 'node:test';
import assert from 'node:assert';
import { toolClassFor } from '../src/agent/library/skills.js';

test('a fence is wood and needs an axe, not a pickaxe', () => {
    // The bug. An oak_fence classified as 'pickaxe' was never harvestable by the
    // tool the gate demanded.
    assert.equal(toolClassFor('oak_fence'), 'axe');
    assert.equal(toolClassFor('oak_fence_gate'), 'axe');
    assert.notEqual(toolClassFor('oak_fence'), 'pickaxe');
});

test('the other wood-family blocks are all axes', () => {
    for (const n of ['oak_log', 'oak_planks', 'birch_wood', 'spruce_stairs', 'oak_slab',
        'oak_door', 'oak_trapdoor', 'oak_sign', 'oak_pressure_plate', 'oak_button',
        'oak_boat', 'bookshelf', 'crafting_table', 'chest']) {
        assert.equal(toolClassFor(n), 'axe', `${n} should be an axe block`);
    }
});

test('soil is a shovel', () => {
    for (const n of ['dirt', 'grass_block', 'sand', 'gravel', 'soul_sand', 'soul_soil',
        'clay', 'mud', 'podzol', 'terracotta']) {
        assert.equal(toolClassFor(n), 'shovel', `${n} should be a shovel block`);
    }
});

test('soft growth needs no tool at all', () => {
    // null means "hands will do" -- the gate must NOT demand a tool here.
    for (const n of ['short_grass', 'oak_leaves', 'dandelion', 'vine', 'wool',
        'cobweb', 'red_tulip', 'sugar_cane', 'dead_bush']) {
        assert.equal(toolClassFor(n), null, `${n} should need no tool`);
    }
});

test('stone and ores are a pickaxe', () => {
    for (const n of ['stone', 'cobblestone', 'iron_ore', 'diamond_ore', 'deepslate',
        'obsidian', 'stone_bricks']) {
        assert.equal(toolClassFor(n), 'pickaxe', `${n} should be a pickaxe block`);
    }
});

test('an unknown or empty name falls back to a pickaxe rather than throwing', () => {
    assert.equal(toolClassFor(''), 'pickaxe');
    assert.equal(toolClassFor(undefined), 'pickaxe');
    assert.equal(toolClassFor(null), 'pickaxe');
});

test('every block the road and garden generators emit is classified', () => {
    // Not a guess: the names landwork actually produces.
    const emitted = ['dirt', 'oak_fence', 'oak_planks', 'stone_bricks', 'water',
        'grass_block', 'oak_log', 'gravel', 'sand'];
    for (const n of emitted) {
        const cls = toolClassFor(n);
        assert.ok(cls === 'axe' || cls === 'shovel' || cls === 'pickaxe',
            `${n} classified as ${cls}`);
    }
    assert.equal(toolClassFor('oak_fence'), 'axe');
});
