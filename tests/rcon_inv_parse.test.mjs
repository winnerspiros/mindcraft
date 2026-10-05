// rconInventory parses `data get entity X Inventory` with one regex and caches
// whatever it matched. Two failure modes hide in there:
//
//  1. A truncated reply loses trailing entries. The regex matches what arrived
//     and the rest is silently missing -- no error, just a smaller inventory.
//     Then placeBlock reads rconItemCount, sees fewer materials than she has,
//     and refuses with "Don't have any dirt to place" while visibly holding it.
//  2. A failed read returns null, rconItemCount turns that into 0, and 0 is
//     indistinguishable from "genuinely holding none". "No data" becomes
//     "no blocks", which is a confident answer built on a failed measurement --
//     the same shape of bug as the health parser and the plot finder.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseInventoryText } from '../src/utils/rcon.js';

test('a full reply parses every entry, including the last', () => {
    const reply = 'LandworkTest has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 10b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 26b, id: "minecraft:oak_planks", count: 32}]';
    const { inv, complete } = parseInventoryText(reply);
    assert.equal(complete, true, 'a closed reply is complete');
    assert.equal(inv.length, 3, 'all three entries should parse');
    assert.deepEqual(inv.map(e => e.count), [64, 64, 32]);
    assert.equal(inv.at(-1).name, 'oak_planks', 'the last entry must not be dropped');
});

test('a truncated reply is reported as incomplete, not as a short inventory', () => {
    // The server cut the reply off mid-list. Parsing what arrived is not the
    // same as knowing the inventory -- and the difference is exactly what makes
    // her claim she has no dirt.
    const truncated = 'LandworkTest has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 10b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 11b, id: "minecraft:dir';
    const r = parseInventoryText(truncated);
    assert.equal(r.complete, false,
        'an unterminated reply must be flagged incomplete rather than silently short');
});

test('a well-formed reply reports complete', () => {
    const reply = 'X has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:dirt", count: 64}]';
    assert.equal(parseInventoryText(reply).complete, true);
});

test('an entry with no count is not silently dropped', () => {
    const reply = 'X has the following entity data: '
        + '[{Slot: 9b, id: "minecraft:dirt", count: 64},'
        + '{Slot: 10b, id: "minecraft:stone"}]';
    const r = parseInventoryText(reply);
    assert.equal(r.complete, false, 'a malformed entry means the read is not trustworthy');
});
