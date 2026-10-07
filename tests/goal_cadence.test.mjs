// Regression: pacing must not set how often she acts on a live goal.
//
// Measured over 11 minutes, alone, holding the goal "explore the nearby forest",
// with open air on every side and 2 blocks of headroom - never stuck, never
// needing rescue:
//
//     Awaiting openrouter api response...   x22
//     advanced to new goal                   x1
//     commands executed                      x3
//
// with gaps of 62s and 146s between consecutive LLM calls. The cadence log said
// why: solo TURNS are paced at ACTION_GEAR 4-22s, but the gear that RESTARTS the
// loop after a turn ends is the solo idle gear, drawn from 30s to 600s. So the
// quick pacing applied only while a turn was already running, and between turns
// she waited up to 10 minutes. Movement soak in that window: 1.0 blocks
// horizontal, 2.0 vertical, 19 of 23 samples byte-identical.
//
// The 600s ceiling is deliberate and correct for genuine idling - "going silent
// for many minutes alone is correct and she has nobody to keep company". It is
// simply wrong when she is holding an unfinished objective and is only waiting to
// be permitted to act on it.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const sp = readFileSync(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');
const code = sp.replace(/\/\/[^\n]*/g, '');

const update = code.slice(code.indexOf('    update(delta) {'), code.indexOf('    async stopLoop('));

test('the update() body was located', () => {
    assert.ok(update.length > 0, 'could not slice update()');
});

test('a live goal caps the solo idle wait', () => {
    assert.match(update, /Math\.min\(gear, this\.gear_solo_goal_max\)/,
        'the solo idle restart gear must be capped while she is holding a goal');
});

test('the cap applies only when she is alone AND holding a goal', () => {
    // With a player present the conversation gear stands - a real turn in a real
    // conversation is still paced like one.
    assert.match(update, /this\._otherPlayersOnline\(\) \|\| !holdingGoal/,
        'the cap must not apply when players are online or when she has no goal');
});

test('"holding a goal" reads the real live-goal field', () => {
    assert.match(update, /holdingGoal = !!this\.prompt/,
        'this.prompt is the live goal; an invented field would silently always be falsy and the cap would never apply');
});

test('the cap is bounded near the turn gear, not merely smaller than 600s', () => {
    const m = sp.match(/this\.gear_solo_goal_max\s*=\s*(\d+)/);
    assert.ok(m, 'gear_solo_goal_max is not set');
    const cap = +m[1];
    assert.ok(cap <= 30000,
        `cap is ${cap}ms; solo turns are paced at 4000-22000ms, so a longer cap still lets pacing dominate`);
    assert.ok(cap >= 4000, `cap is ${cap}ms, below the 4000ms turn gear - she would act faster than she can think`);
});

test('the solo idle gears themselves are untouched', () => {
    // The genuine-idle behaviour must survive: with no goal she may still go
    // quiet for minutes, which is intentional.
    // 2026-10-07 §token-save: solo-idle floor deliberately raised 30s->60s so
    // idle-with-no-goal turns (which fire a full-context call to decide "do
    // nothing") happen half as often. The intent the test protects still holds:
    // solo idle can still stretch to minutes (max 600s); only the FLOOR moved.
    assert.match(sp, /this\.gear_solo_min = 60000;/);
    assert.match(sp, /this\.gear_solo_max = 600000;/,
        'the long solo silence is deliberate for real idling - do not shrink it as a side effect');
});

test('the restart condition actually uses the capped wait', () => {
    assert.match(update, /if \(this\.idle_time >= wait\)/,
        'the cap is computed but the original gear must not still gate the restart');
});
