// REGRESSION: mining in place is not "stuck" — the unstuck idle-still watch
// must not fire while the pick is swinging, or with no goal at all.
// 2026-10-09: she stood at (15,64,15) mining gravel; idleStill accrued on
// byte-identical positions and every 60s the rescue preempted the dig for
// ±3 probe walks (18,65,15)/(12,65,15)/(15,65,12) — visible as jerky
// stop-start "on cocaine" movement. Stillness with no goal (idle chat)
// must not rescue either.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');

test('mid-swing dig never accrues stillness', () => {
    const i = src.indexOf('MINING IS NOT STUCK');
    assert.ok(i > 0, 'the mining guard comment must exist');
    const seg = src.slice(i, i + 1400);
    assert.match(seg, /targetDigBlock/, 'must check the live dig state');
    assert.match(seg, /_idleStill = 0/, 'must reset the stillness counter');
    assert.match(seg, /return/, 'must skip the rescue while swinging');
});

test('no-goal idle never triggers the stillness rescue', () => {
    const i = src.indexOf('NO-GOAL IDLE IS NOT STUCK');
    assert.ok(i > 0, 'the no-goal guard comment must exist');
    const seg = src.slice(i, i + 700);
    assert.match(seg, /isIdle\(\) && !_goalActive/, 'must require a live goal');
});

test('unstuck rescue still fires for a real wedge (live goal, no dig)', () => {
    // the rescue body (swim/dig/walk-out) must still exist below the guards
    const i = src.indexOf('NO-GOAL IDLE IS NOT STUCK');
    const rest = src.slice(i);
    assert.match(rest, /swimToNearestAir/, 'water rescue must remain');
    assert.match(rest, /breakBlockAt/, 'dig-out rescue must remain');
    assert.match(rest, /Found my way out/, 'walk-out rescue must remain');
});
