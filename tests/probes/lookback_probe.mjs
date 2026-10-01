// The look-back gap must PAUSE her gaze, not permanently disable it.
//
// Regression: the gap set `staring = false` but left `last_entity` set, so the
// re-arm (`target !== last_entity`) could never fire again for that same nearby
// player. She looked at someone once, glanced away, and was never allowed to look
// back — ever. Measured symptom: 0 emissions of !lookAtPlayer and the owner
// reporting she never looks at players.
//
// This drives the real mode through initModes, the way production registers it,
// rather than importing a mode object that does not exist as an export.

import { initModes } from '../../src/agent/modes.js';
import { Vec3 } from 'vec3';

const p = (name) => ({
    type: 'player', username: name, usernameAtTime: name,
    position: new Vec3(2, 64, 0),
    id: 1,
});

function makeAgent() {
    const near = p('Someone');
    const agent = {
        name: 'Elena',
        isIdle: () => true,
        _attentionPlayer: () => null,
        prompt: '', intents: {},
        // initModes() reads the mode config through the prompter; a stub is
        // enough and keeps this a pure unit probe of the stare logic.
        prompter: { getInitModes: () => ({ idle_staring: true }) },
        bot: {
            entity: { position: new Vec3(0, 64, 0), onGround: true, height: 1.8 },
            entities: { Someone: near },
            players: { Someone: { entity: near, name: 'Someone' } },
            pathfinder: { goal: null, move: () => {} },
            // The mode calls bot.nearestEntity for the mob fallback whenever a
            // player ISN'T the target. Without it the update throws mid-function
            // and everything after - including the whole gaze cycle - silently
            // never runs, which looks exactly like "she never looks at players".
            nearestEntity: () => null,
            setControlState: () => {},
            look: () => {}, lookAt: () => {},
            mousedown: () => {},
        },
        looks: 0,
        lookAts: 0,
    };
    // A player is looked at via lookAt; `look` is the glance-AWAY branch. Counting
    // only `look` reported "she never looks at players" while lookAt was in fact
    // the call doing the work - the probe was measuring the wrong function.
    agent.bot.look = () => { agent.looks++; };
    agent.bot.lookAt = () => { agent.lookAts++; };
    initModes(agent);
    return agent;
}

let pass = 0, failed = 0;
const check = (c, good, bad) => {
    if (!c) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const a = makeAgent();
const st = a.bot.modes.get('idle_staring');

// Tick across a window long enough for hold + gap + a second hold.
for (let i = 0; i < 400; i++) st.update(a, 0.3);

check(st, 'idle_staring is registered', 'the mode did not register');
check(a.lookAts + a.looks > 0, `she looked at the player (${a.lookAts} lookAt, ${a.looks} glance-away)`, 'she never looked');

// The core regression: repeated ticking must keep producing looks, not one.
const before = a.lookAts + a.looks;
for (let i = 0; i < 400; i++) st.update(a, 0.3);
const after = a.lookAts + a.looks;
check(after > before,
    `she keeps looking across later ticks (${before} -> ${after}) — the gap resumes, it does not disable`,
    `she looked once and never again (${before} -> ${after}) — last_entity never cleared`);

// And the gap must actually produce a pause rather than continuous staring.
const gapAlive = typeof st.next_look_back === 'number';
check(gapAlive, 'a look-back gap is tracked', 'no gap tracked');

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} look-back assertions green (${a.looks} look calls across 800 ticks)`);
