// Regression: !digDown threw instead of returning when the chunk was not loaded.
//
// bot.blockAt() returns null when the chunk is not loaded yet - a fresh
// teleport, a just-respawned player, or the edge of the view distance. The loop
// inside digDown already guarded for a null block, but the FIRST call did not:
//
//   const start_block_pos = bot.blockAt(bot.entity.position).position;
//
// which took the whole command down. Measured live from a real in-game
// !digDown 2:
//
//   TypeError: null is not an object
//     (evaluating 'bot.blockAt(bot.entity.position).position')
//
// It is null-dereference, not an equip problem - the hand claim is irrelevant
// here - so this is worth pinning separately from the eating work.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { digDown } from '../src/agent/library/skills.js';

const POS = new Vec3(1000.5, 64, 1000.5);

const solid = (pos) => ({
    position: pos, name: 'stone', boundingBox: 'block', id: 1,
    canHarvest: () => true, metadata: null, light: 15,
    getProperties: () => null, destroy: () => {}, adjacent: () => solid(pos),
});

// A bot standing on a loaded chunk, with one solid stone below per depth.
function loadedBot({ loaded = true } = {}) {
    return {
        // log() appends here, so it is the real sink - no interception needed.
        output: '',
        entity: { position: POS },
        interrupt_code: false,
        heldItem: null,
        digCalls: [],
        blockAtCalls: 0,
        blockAt(p) {
            this.blockAtCalls++;
            // Only the starting block depends on `loaded`; the loop's own
            // lookups always resolve, so this isolates the one null deref.
            if (Math.abs(p.y - POS.y) < 0.001) return loaded ? solid(POS) : null;
            return solid(p);
        },
        equip: async () => true,
        pathfinder: { stop() {}, moveTo: async () => true },
        game: { gameMode: 'survival' },
        inventory: { slots: [], items: () => [] },
        setControlState() {},
        canDigBlock: () => true,
        console,
        async dig() { this.digCalls.push(1); return true; },
        _log(m) { log.push(m); },
        console,
    };
}

test('!digDown returns cleanly when the chunk is not loaded', async () => {
    const bot = loadedBot({ loaded: false });
    let res, threw = null;
    try {
        // Must not throw: the old code threw a TypeError here.
        res = await digDown(bot, 2);
    } catch (e) {
        threw = e;
    }
    assert.strictEqual(threw, null, `digDown threw on an unloaded chunk: ${threw?.message}`);
    assert.strictEqual(res, false, 'an unloaded chunk should report failure, not success');
    assert.match(bot.output, /not loaded/i,
        'the reason should be logged, not silently swallowed');
});

test('!digDown still digs when the chunk IS loaded', async () => {
    const bot = loadedBot({ loaded: true });
    // The point is that the guard does not short-circuit a normal dig: it must
    // reach breakBlockAt and try. Not throwing IS the regression under test.
    await digDown(bot, 2);
    // This fake cannot complete a real break (no server, no RCON), so the
    // assertion is that the guard did NOT short-circuit: digDown got past it
    // into the per-block loop and tried each depth. Reaching breakBlockAt at
    // all is the regression under test.
    assert.ok(bot.blockAtCalls > 2,
        `a loaded chunk only made ${bot.blockAtCalls} blockAt calls - the null guard short-circuited it`);
    assert.doesNotMatch(bot.output, /not loaded/i,
        'a loaded chunk must not be reported as unloaded');
});

test('the null guard exists in the source, before the dereference', () => {
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const start = src.indexOf('export async function digDown');
    assert.ok(start > -1, 'digDown not found');
    let d = 0, end = start;
    for (; end < src.length; end++) {
        if (src[end] === '{') d++;
        else if (src[end] === '}') { d--; if (d === 0) { end++; break; } }
    }
    const body = src.slice(start, end);

    assert.ok(
        /if \(!startBlock\)/.test(body),
        'no null guard on the starting block - digDown throws on an unloaded chunk'
    );
    // The guard must come BEFORE the .position dereference, and the unguarded
    // one-liner must be gone.
    assert.ok(
        body.indexOf('if (!startBlock)') < body.indexOf('.position;'),
        'the guard runs after the dereference it is meant to protect'
    );
    assert.ok(
        !/bot\.blockAt\(bot\.entity\.position\)\.position/.test(body),
        'the unguarded dereference is still there'
    );
});