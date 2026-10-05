// "I could not read the server" and "I am holding none" must not be the same
// answer. That conflation is what made her announce "Don't have any dirt to
// place" while the server held 320 of it: a failed or truncated read became 0,
// and 0 is indistinguishable from an empty inventory.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseInventoryText } from '../src/utils/rcon.js';

// The counting rule placeBlock now uses: null for unknown, a number for known.
function countFrom(invResult) {
    if (!invResult) return null;                 // failed or truncated read
    let n = 0;
    for (const e of invResult) if (e.name === 'dirt') n += e.count;
    return n;
}

test('a complete read yields a real count', () => {
    const reply = 'X has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 10b, id: "minecraft:dirt", count: 64}]';
    const { inv, complete } = parseInventoryText(reply);
    assert.equal(complete, true);
    assert.equal(countFrom(complete ? inv : null), 128);
});

test('a truncated read is UNKNOWN (null), not zero', () => {
    const truncated = 'X has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 10b, id: "minecraft:di';
    const { inv, complete } = parseInventoryText(truncated);
    const count = countFrom(complete ? inv : null);
    assert.equal(count, null,
        'a partial read must not become 0 -- 0 is a claim about the world');
    assert.notEqual(count, 0, 'this is the exact conflation that caused the bug');
});

test('a genuinely empty inventory is 0, and is distinguishable from unknown', () => {
    const empty = 'X has the following entity data: []';
    const { inv, complete } = parseInventoryText(empty);
    const count = countFrom(complete ? inv : null);
    assert.equal(complete, true);
    assert.equal(count, 0, 'truly holding nothing is a real, known zero');
});

test('unknown and zero never collide', () => {
    // The whole point: a caller must be able to tell these apart.
    const unknown = countFrom(null);
    const zero = countFrom([]);
    assert.equal(zero, 0);
    assert.equal(unknown, null);
    assert.notEqual(unknown, zero);
});

test('an inventory holding no dirt at all is a known zero', () => {
    const reply = 'X has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:oak_planks", count: 64}]';
    const { inv, complete } = parseInventoryText(reply);
    assert.equal(countFrom(complete ? inv : null), 0,
        'no dirt in a complete read is a real zero, not unknown');
});
