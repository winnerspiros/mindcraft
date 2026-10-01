// She could acquire a target, call bot.lookAt, and still never turn her head.
//
// The owner: "still she doesnt respond to me unless i address her by name. look
// too". The gaze half of that turned out to be THREE separate faults stacked on
// top of each other, none of which was visible from the glance logic itself:
//
//   1. The idle budget. agent.js returns BEFORE modes.update() when the budget
//      says "settling", so no mode of any kind could run. And the budget was
//      permanently settling, because note() - which stamps lastActionAt - was
//      being called on the transition INTO acting. Settling is a steady state,
//      not an edge, so that transition recurred once per settle window and
//      re-armed the very settle it was supposed to be ending. Measured live:
//      [gatedbg] gate.ok=false why=settling isIdle=true on every tick, and modes
//      got exactly one tick per 90s.
//   2. The wire. physics.js stashes a look (_pendingForceLook) when the 2500ms
//      move-hold is active, and the only drain is updatePosition - a POSITION
//      sender. An idle bot sends no position, so a stashed glance was never
//      flushed. Deadlock: the hold waits for movement, and the movement never
//      comes because the hold is active.
//   3. The flag lifetime. bot.lookAt is async (physics.js:711) - it awaits
//      bot.look - so a `try { bot.lookAt(...) } finally { flag = false }` cleared
//      the exemption before the send ever reached the wire. The flag was always
//      false by the time it mattered.
//
// Proof this is a reachability problem and not a gaze-logic problem: the mode
// logged "acquired player YandereDev", and lookAt set entity.yaw to 1.2357,
// while the server's yaw sat at the spawn value across 30 samples over 60s.
//
// What "correct" means here, measured: server-side yaw changing while she is
// idle. Everything below is about the gaze being REACHABLE.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IdleBudget } from '../src/utils/idle_budget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const agent = read('src/agent/agent.js');
const modes = read('src/agent/modes.js');
const physics = read('node_modules/mineflayer/lib/plugins/physics.js');

let pass = 0, fail = 0;
const ok = (name, cond) => {
    if (cond) { pass++; console.log('  ok - ' + name); }
    else { fail++; console.log('  NOT OK - ' + name); }
};

console.log('# gaze reachability');

// ── 1. The settle loop ───────────────────────────────────────────────
// The regression that caused the freeze. note() on the settling edge re-armed
// the settle, so the gate opened for one tick per window and closed again.
ok('budget is NOT noted merely for being allowed to act',
    !/if \(this\._wasSettling\) \{[^}]*this\._idleBudget\.note\(\);/.test(agent));

ok('budget note is guarded on a real executed action',
    /if \(this\._wasSettling\)[^]*?if \(this\._lastRealActionAt\)\s*this\._idleBudget\.note\(/.test(agent));

// The real-action feed, so the 6-per-5min ceiling still means something.
ok('real executed commands feed the budget',
    /_budgetNotedRealAt[\s\S]*?_idleBudget\.note\(this\._lastRealActionAt\)/.test(agent));

// ── 2. The settle must actually expire ───────────────────────────────
// A settle ends because time passed. Feed the budget a real action far enough
// in the past and it must let her act - and repeatedly, not once per window.
{
    const now = Date.now();
    const b = new IdleBudget();
    const lastReal = now - 10 * 60 * 1000;      // she acted 10 minutes ago
    // note() on a stale stamp must not reset the clock to "now"
    b.note(lastReal);
    const first = b.canAct({ now, has_goal: true, human_present: true });
    ok('a stale real action does not re-arm the settle', first.ok === true);
    ok('settle expires on wall-clock age, not on being allowed to act',
        first.why !== 'settling');

    // And it stays open: the bug was a one-tick window, so call it repeatedly
    // exactly as the 300ms tick does, without any intervening note().
    let allOpen = true;
    for (let i = 0; i < 40; i++) {
        if (!b.canAct({ now: now + i * 300, has_goal: true, human_present: true }).ok) {
            allOpen = false;
            break;
        }
    }
    ok('the gate STAYS open across many ticks without re-arming', allOpen);
}

// ── 3. The wire ──────────────────────────────────────────────────────
// The idle flush. Without it the stashed look waits for a position packet that
// an idle bot never sends.
ok('physics has an idle gaze flush (not just a stash)',
    /_gazeArmed/.test(physics) && /'look'/.test(physics));

ok('the idle gaze flush does NOT wait for a position packet',
    /else if \(bot\._gazeArmed\) \{[\s\S]{0,1800}?write\('look'/.test(physics));

// The exemption must not be a bare pass-through: the anti-burst property is
// what stops invalid_player_movement, so the 26.3 jitter has to survive.
ok('idle gaze keeps the look jitter (anti-burst preserved)',
    /else if \(bot\._gazeArmed\) \{[\s\S]{0,1800}?Math\.random\(\)/.test(physics));

// ── 4. The flag lifetime ─────────────────────────────────────────────
// bot.lookAt is async. A synchronous clear loses the race.
ok('the gaze look is awaited before the flag is released',
    /await bot\.lookAt\(/.test(modes));
ok('_gazeArmed is set around the await, not cleared synchronously',
    /bot\._gazeArmed = true;[\s\S]{0,400}?await bot\.lookAt[\s\S]{0,400}?finally\s*\{[^}]*bot\._gazeArmed = false/.test(modes));
ok('mode update is async so the await is legal',
    /update: async function \(agent\)/.test(modes));

// ── 5. The gaze gap must not cancel the look it just started ─────────
// next_look_back used to be computed on ACQUISITION, so it sat 2.5-7s in the
// future while the 1.5-3.5s hold was still running: the gap condition was true
// for the whole hold, so she looked for one tick and looked away. It is armed
// when the gaze starts instead.
ok('the look-away gap is armed when the gaze starts, not on acquisition',
    /_gapArmed/.test(modes));
ok('the gap is re-armed when a gaze ends',
    /!this\.staring\) \{ this\.gaze_started = false; this\._gapArmed = false; \}/.test(modes));
ok('the gap does not reference isPlayer before it is declared (TDZ)',
    !/if \(this\.staring && this\.gaze_started && this\.next_look_back[\s\S]{0,400}?\bisPlayer\b/.test(modes));

// ── 6. The anti-burst throttle we added ──────────────────────────────
// We bypassed the 2500ms move-hold; the property that matters is that two
// head-turns never land in one server tick. physics throttles to 600ms, so we
// enforce the same interval ourselves.
ok('a 600ms look throttle replaces the 2500ms move-hold',
    /_lastLookAt[\s\S]{0,200}?\+ 600/.test(modes));
ok('the throttle stamp applies to every look branch, not just rcon',
    /if \(!_lookThrottled\) this\._lastLookAt = _nowLook;/.test(modes));

console.log(`\n# ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);