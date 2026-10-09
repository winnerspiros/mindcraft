// HONEST HAUL: collectBlock must count pocketed drops, never breaks.
// 2026-10-09: live logs showed "Collected 1/2 deepslate_coal_ore" with ZERO
// coal server-side — the count incremented on a landed swing while the drops
// sat on the ground. Breaks are not hauls; unverified reads are named, not
// folded into the count. Alongside: the self-prompt must forbid filler prose
// and phantom claims ("checking inventory again" with no !inventory attached).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as skills from '../src/agent/library/skills.js';
import { setCountAllOverride } from '../src/utils/rcon.js';

const SRC = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const SP = readFileSync(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');

test('drop map: ores map to their drops, stone to cobble, logs to themselves', () => {
    assert.deepEqual(skills.dropNamesForBlock('deepslate_coal_ore'), ['coal']);
    assert.deepEqual(skills.dropNamesForBlock('coal_ore'), ['coal']);
    assert.deepEqual(skills.dropNamesForBlock('diamond_ore'), ['diamond']);
    assert.deepEqual(skills.dropNamesForBlock('deepslate_iron_ore'), ['raw_iron']);
    assert.deepEqual(skills.dropNamesForBlock('stone'), ['cobblestone']);
    assert.deepEqual(skills.dropNamesForBlock('grass_block'), ['dirt']);
    assert.deepEqual(skills.dropNamesForBlock('oak_log'), ['oak_log']);
    assert.deepEqual(skills.dropNamesForBlock('sand'), ['sand']);
});

test('countLandedDrops: only a rising server count is a haul; failed reads are unverified, never zero', async () => {
    let gear = { coal: 0 };
    setCountAllOverride((_safe, want) => ({ total: gear[want] ?? 0, inv: gear[want] ?? 0, worn: 0, offhand: 0 }));
    try {
        // drops land: 0 -> 2 coal = verified gain of 2
        let r = await skills.countLandedDrops('TestUwU', ['coal'], { coal: 0 });
        assert.equal(r.verified, true);
        assert.equal(r.gained, 0, 'same totals, nothing gained yet');
        gear.coal = 2;
        r = await skills.countLandedDrops('TestUwU', ['coal'], { coal: 0 });
        assert.equal(r.verified, true);
        assert.equal(r.gained, 2, 'rising pockets are the haul');
        // drops on the ground: pockets provably unchanged
        r = await skills.countLandedDrops('TestUwU', ['coal'], { coal: 2 });
        assert.equal(r.verified, true);
        assert.equal(r.gained, 0, 'unchanged pockets = drops still on the ground, not a haul');
    } finally { setCountAllOverride(null); }
});

test('the final report never folds unverified breaks into the count', () => {
    assert.match(SRC, /unverifiedBreaks/, 'an unverified-break counter must exist');
    assert.match(SRC, /Collected 0 \$\{blockType\} \(\$\{unverifiedBreaks\} break\(s\) landed but pockets unreadable/,
        'zero-verified must report the unverified breaks, not a bare zero');
    assert.doesNotMatch(SRC.replace(/unverifiedBreaks[\s\S]*$/, ''), /if \(success\)\s*\n\s*collected\+\+;/,
        'the old break-counting line must be gone');
});

test('the self-prompt forbids filler prose and phantom claims', () => {
    assert.match(SP, /Never reply with status prose alone/, 'filler rule must be in the goal prompt');
    assert.match(SP, /unless that same turn runs the command that proves it/, 'verify-or-dont-claim rule must be in the goal prompt');
});
