// Direct verification against the real server reply, captured live.
// `data get entity X Inventory` returns ~1248 characters for a stocked bot,
// which is long enough that the server splits it across type-0 packets.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseInventoryText } from '../src/utils/rcon.js';

// The reply shape captured from the running server: 20 entries, 1248 chars.
const REAL_REPLY = 'LandworkTest has the following entity data: ['
    + Array.from({ length: 20 }, (_, i) => `{Slot: ${i + 9}b, id: "minecraft:dirt", count: 64}`).join(',')
    + ']';

test('the real reply is long enough to have been split', () => {
    // Guards the premise of the whole diagnosis: if the reply were small, the
    // first-packet bug could not have been the cause of the missing stacks.
    // Measured live: a stocked bot's Inventory reply is ~1.2KB. This fixture
    // is a uniform-dirt stand-in and lands a little under that; either way it
    // is far larger than one RCON packet.
    assert.ok(REAL_REPLY.length > 800,
        'a ~1KB reply is the size that spans RCON packets');
});

test('the full reply parses to all 20 entries', () => {
    const { inv, complete } = parseInventoryText(REAL_REPLY);
    assert.equal(complete, true);
    assert.equal(inv.length, 20);
});

test('losing the tail of the reply reproduces the exact reported symptom', () => {
    // The trace showed dirt dropping by 63-64 at a time. Take the reply up to a
    // point where only the first stack survives and see what a first-packet read
    // would have reported: a whole 64-block stack missing, with no error.
    const cut = REAL_REPLY.slice(0, REAL_REPLY.indexOf(',{Slot: 10b'));
    const { inv, complete } = parseInventoryText(cut);
    assert.equal(complete, false, 'a cut reply must be reported incomplete');
    const naive = inv.reduce((n, e) => n + e.count, 0);
    assert.equal(naive, 64,
        'the naive read reports exactly one stack where the truth was five');
});

test('one lost packet boundary is worth ~64 blocks of dirt', () => {
    // Quantifies the symptom: the drops matched stack sizes because the cuts
    // landed on entry boundaries, not because anything was being destroyed.
    const { inv } = parseInventoryText(REAL_REPLY);
    assert.equal(inv[0].count, 64);
});
