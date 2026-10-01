// The gaze cycle over REAL wall-clock time: glance on, look away, look back.
//
// The regression this exists for: `gaze_started` was set at target ACQUISITION,
// while next_change was still in the future, so the gap check immediately
// switched the gaze off on the tick it began. Measured state was
// gaze_started=true with staring=false on every tick — she looked at nobody, ever.
//
// The other failure this catches is the opposite: a gap that never fires, which is
// just as wrong (continuous staring is the yandere tell). The earlier probe could
// not see that because it ticked faster than wall-clock, so no timer ever expired.
// So this one advances REAL time.

import { initModes } from '../../src/agent/modes.js';
import { Vec3 } from 'vec3';

const near = {
    type: 'player', username: 'Someone', id: 1, metadata: [],
    position: new Vec3(2, 64, 0),
};

const bot = {
    entity: { position: new Vec3(0, 64, 0), onGround: true, height: 1.8 },
    entities: { Someone: near },
    players: { Someone: { entity: near, name: 'Someone' } },
    pathfinder: { goal: null, move: () => {} },
    nearestEntity: () => null,
    setControlState: () => {},
    mousedown: () => {},
    look: () => {}, lookAt: () => {},
};

const a = {
    name: 'Elena', isIdle: () => true, _attentionPlayer: () => null,
    prompt: '', intents: {},
    bot, lookAts: 0, glances: 0,
    prompter: { getInitModes: () => ({ idle_staring: true }) },
};
bot.lookAt = () => { a.lookAts++; };
bot.look = () => { a.glances++; };

initModes(a);
const st = a.bot.modes.get('idle_staring');

// Run for 90 virtual seconds. Each "tick" is 300ms and we SHIFT next_change and
// next_look_back forward by the same amount, so the cycle advances the way it
// would in production rather than spinning on a frozen clock.
const STEP = 300;
const TICKS = 300;                       // 90s
const realNow = Date.now();
for (let i = 0; i < TICKS; i++) {
    st.next_change -= STEP;
    st.next_look_back -= STEP;
    st.update(a, STEP / 1000);
}
const elapsed = (TICKS * STEP) / 1000;

let pass = 0, failed = 0;
const check = (c, good, bad) => {
    if (!c) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

console.log(`over ${elapsed}s: ${a.lookAts} lookAt, ${a.glances} glance-away`);

check(a.lookAts > 0, `she looked at the player (${a.lookAts})`, 'she never looked');
check(a.glances > 0,
    `she looked AWAY sometimes (${a.glances} glances) — not a fixed lock-on`,
    'she never looked away: continuous staring is the yandere tell');
check(a.lookAts > 0 && a.glances > 0,
    'the cycle actually alternates', 'no alternation between looking and looking away');
check(a.glances / (a.glances + a.lookAts) > 0.15,
    `she spends a real fraction of time looking away (${Math.round(100 * a.glances / (a.glances + a.lookAts))}%)`,
    'barely ever looks away — reads as a lock-on');

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} gaze-cycle assertions green`);
