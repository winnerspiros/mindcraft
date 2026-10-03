// Regression: the drowning rescue must not declare success on a rescue that
// did nothing.
//
// Measured live: she sat in a 2-deep water pocket (y=48 dirt, y=49 water at her
// feet, y=50 water at her head, y=51 air) and the rescue ran 124 times in 10
// minutes with zero effect, because the post-scoop check queried the world with
// a RELATIVE-offset helper using ABSOLUTE coordinates. That landed in unloaded
// void, returned {name:'air'}, so `breathed` was true on every pass and the
// branch returned before ever calling swimUp.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
// The next sibling mode after self_preservation.
const body = src.slice(src.indexOf("name: 'self_preservation'"), src.indexOf("name: 'unstuck'"));

test('the drowning rescue verifies the world with an ABSOLUTE block lookup', () => {
    const scoops = body.slice(body.indexOf('const feet = bot.entity.position.floored()'), body.indexOf('const ok = await skills.swimUp'));
    // Strip comments: the fix explains the old helper by name, and the point of
    // the test is that no CALL to it survives.
    const code = scoops.replace(/\/\/[^\n]*/g, '');

    assert.doesNotMatch(code, /getBlockAtPosition\s*\(/,
        'getBlockAtPosition is RELATIVE (position.offset(x,y,z)); passing feet.x/y/z queries unloaded void and always reads "air"');
    assert.match(code, /bot\.blockAt\(feet\)/,
        'the scoop result must be read with bot.blockAt on the absolute position');
});

test('a scoop that did not remove water falls through to swimUp', () => {
    const after = body.slice(body.indexOf('if (breathed)'));
    assert.match(after, /const ok = await skills\.swimUp\(bot, 8000\)/,
        'when breathed is false she must still try to swim up, not give up');
    assert.match(body.replace(/\/\/[^\n]*/g, ''), /breathed = name != null && name !== 'water'/,
        'water under her feet must NOT count as having breathed');
});

// Holding jump cannot clear a 1x1 shaft - she rises then sinks straight back.
// Measured: y oscillated 49 -> 51.6 -> 49.6 -> 49.0 over 12 min, 124 rescues,
// zero escapes. The empty-bucket scoop cannot save her either, because she is
// kitted water_bucket and findInventoryItem('bucket') does not match it.
test('when swimUp fails she digs the wall instead of only complaining', () => {
    const after = body.replace(/\/\/[^\n]*/g, '');
    const dig = after.slice(after.indexOf('const ok = await skills.swimUp(bot, 8000)'));
    assert.match(dig, /const ok = await skills\.swimUp\(bot, 8000\);\s*if \(ok\) return;/,
        'a successful swimUp must end the rescue, not fall through to digging');
    assert.match(dig, /skills\.breakBlockAt/,
        'a failed swimUp must break an adjacent block - that is the only escape from a 1-wide column');
    assert.match(dig, /freed >= 2/,
        'the dig must be bounded; she should not strip the whole pocket');
});