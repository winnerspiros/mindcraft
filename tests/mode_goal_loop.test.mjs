// Regression: a mode must not leave the self-prompt goal loop dead.
//
// Every mode runs through modes.execute(), which stops the self-prompt loop so
// the mode can take the hand. The only thing that used to restart the loop was
// self_prompter.update()'s `if (this.agent.isIdle())` gate. But a mode IS an
// action, so she is not idle while it runs - and if the mode never finishes
// cleanly she never becomes idle, and the restart never comes.
//
// Measured live while she was wedged on a 1-block pillar:
//
//   self prompt loop stopped        2
//   Restarting self-prompting       1
//
// Goals kept being proposed and advanced ("find something to eat", "explore the
// nearby forest for animals and resources") while ZERO commands executed, because
// the loop that would have acted on them was down. She narrated progress into a
// dead channel and appeared to have no goals at all.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const modes = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
const sp = readFileSync(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');
const spCode = sp.replace(/\/\/[^\n]*/g, '');

const exec = modes.slice(modes.indexOf('async function execute(mode, agent, func'),
                         modes.indexOf('async function runMode('));

test('execute() yields the goal loop and records that it did', () => {
    assert.match(exec, /const _yieldedGoalLoop = agent\.self_prompter\.isActive\(\)/,
        'the yield must be conditional on the loop actually being active');
    assert.match(exec, /if \(_yieldedGoalLoop\) agent\.self_prompter\.stopLoop\(\)/,
        'a mode that was not borrowing the loop must not stop it');
});

test('execute() always returns the loop, even if the mode throws or times out', () => {
    assert.match(exec, /try \{[\s\S]*\} finally \{[\s\S]*resumeAfterMode\(\)/,
        'the restart must be in a finally, or a throwing mode keeps the goal loop dead forever');
    assert.match(exec, /return await runMode\(/,
        'the mode body must be delegated so the finally can wrap it');
});

test('resumeAfterMode exists and is guarded', () => {
    assert.match(spCode, /resumeAfterMode\(delayMs = \d+\)\s*\{/,
        'the borrower must return what it borrowed');
    assert.match(spCode, /if \(this\.state !== ACTIVE\) return false/,
        'a deliberately stopped or paused prompter must NOT be restarted');
    assert.match(spCode, /if \(this\.loop_active\) return/,
        'restarting an already-running loop would double-drive it');
    assert.match(spCode, /if \(this\._modeResumeTimer\) clearTimeout/,
        'repeated mode fires must collapse to one pending restart, not stack timers');
});

test('the restart is deferred, not immediate', () => {
    const fn = spCode.slice(spCode.indexOf('resumeAfterMode(delayMs'),
                            spCode.indexOf('async stop(stop_action'));
    assert.match(fn, /setTimeout/,
        'restarting on the same tick would re-enter the loop the mode was just displaced from');
    assert.doesNotMatch(fn, /delayMs = 0/, 'a zero delay is the same-tick re-entry this avoids');
});

test('stop() and pause() still shut down for real', () => {
    // resumeAfterMode must not resurrect a prompter the user actually stopped.
    const stopFn = spCode.slice(spCode.indexOf('async stop(stop_action'),
                                spCode.indexOf('async pause('));
    assert.match(stopFn, /this\.state = STOPPED/,
        'stop() must still transition to STOPPED');
});
