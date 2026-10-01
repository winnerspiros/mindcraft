// Reuse the yandere social behaviours, but make them situational.
//
// The owner: "we can use some stuff we did with yandere uwu like if she's
// interacting with a player spam crouch and observer what players do, look at
// them, spam jump but lets try to be more normal"
//
// So these are NOT new features. `idle_hopping` (spam crouch/hop/twirl) and
// `idle_staring` (lock eyes on a nearby player) already existed and were enabled.
// The problem was never WHETHER she does them, it was WHEN:
//
//   hopping   - fired on IDLE. Alone in a server she hopped and dashed, which is
//               the 24/7 fidgeting (measured 15 mode firings per 10 min, nobody
//               present). A player bounces around the person they are talking to
//               and stands still otherwise.
//   staring   - fired on NEAREST within 16 blocks, for 6-10s locked on. Two
//               problems: unblinking 10s gaze is the yandere tell and no player
//               does it, and it fixated on whoever was closest rather than on
//               the person she was interacting with.
//
// "let's try to be more normal" is the operative instruction: keep the behaviour,
// change the trigger.

import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const modes = readFileSync('src/agent/modes.js', 'utf8');

// ── hopping needs a person, not just idleness ──────────────────────────
{
    const i = modes.indexOf("name: 'idle_hopping'");
    // Size the window to the NEXT mode, not a guessed character count. A 3000-char
    // slice stopped short of the hop once the explanatory comments were added, and
    // the assertion then reported a false failure.
    const j = modes.indexOf("name: '", i + 10);
    const block = modes.slice(i, j > i ? j : i + 9000);
    check(i > 0, 'idle_hopping still exists (reused, not replaced)', 'idle_hopping is gone');
    check(/_near|distanceTo\(me\.position\) <= 12/.test(block),
        'it checks for a nearby person', 'it has no person check');
    check(/setControlState\('jump', false\)/.test(block),
        'and settles her physical state when nobody is about',
        'she keeps hopping at an empty server');
    // the person check must come BEFORE the hop logic, or it gates nothing
    // The only real hop is jump:true. `jump', false` appears in the RESET branch
    // too, and my first regex matched that - so anchor on the positive case.
    const gateAt = block.search(/if \(!_near\)/);
    const hopAt = block.search(/setControlState\('jump', true\)/);
    check(gateAt > 0 && hopAt > gateAt,
        'the person gate comes before the hop fires', 'the hop can fire before the gate');
    check(block.slice(gateAt, hopAt).includes('return'),
        'and the gate returns early, so an empty server never reaches it',
        'the gate does not stop the hop');
}

// ── staring: glance, look away, look back ──────────────────────────────
{
    const i = modes.indexOf("name: 'idle_staring'");
    // From this mode to the next, never a fixed character count - the mode has
    // outgrown 6000 chars, and a short window silently turns real assertions into
    // false failures.
    const _j = modes.indexOf("name: '", i + 10);
    const block = modes.slice(i, _j > i ? _j : i + 12000);
    // Comments excluded: this mode QUOTES the old buggy line in a comment to
    // explain what it replaced, and my assertion matched that quote. Assert on
    // code, never on a file that documents itself.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    check(i > 0, 'idle_staring still exists', 'idle_staring is gone');

    // the old hold was 6000 + rand*4000 => 6-10s
    check(!/6000 \+ Math\.random\(\) \* 4000/.test(block),
        'the 6-10s locked-on hold is gone (the yandere tell)',
        'she still locks on for 6-10s');
    check(/1500 \+ Math\.random\(\) \* 2000/.test(block),
        'a person-hold is now 1.5-3.5s', 'no short person-hold');
    check(/next_look_back/.test(block), 'there is a look-back gap', 'no look-back gap');
    check(/next_look_back = this\.next_change \+ 2500/.test(block),
        'and the gap is a real interval after the hold', 'the gap is not derived from the hold');

    // the gap must be enforced, not merely stored
    const store = block.indexOf('this.next_look_back = this.next_change');
    const use = block.indexOf('Date.now() < this.next_look_back');
    const expire = block.indexOf('Date.now() >= this.next_look_back');
    check(use > store && expire > store,
        'the gap is both enforced and allowed to expire',
        'the gap is stored but never checked, or checked but never expires');

    // ── REGRESSION: gaze_started must mean "has run", not "is scheduled" ──
    // Setting it at acquisition, while next_change was still in the future, made
    // the gap check switch the gaze off on the tick it began. Measured:
    // gaze_started=true with staring=false on every tick - she looked at nobody.
    check(/if \(this\.staring && !this\.gaze_started\) this\.gaze_started = true/.test(block) === false,
        'gaze_started is NOT set at acquisition (that killed every gaze)',
        'gaze_started is set when the gaze is merely scheduled');
    check(/this\.gaze_started = false;\s*\/\/ a fresh gaze has not run yet/.test(block)
        || /gaze_started = false/.test(block),
        'a fresh gaze starts unrun', 'a fresh gaze is treated as already run');

    // ── REGRESSION: no per-window coin flip for a person ──
    // `staring = Math.random() < (personNear ? 0.8 : 0.3)` plus a 2-12s reset
    // overwrote the glance and erased the gap. It is the yandere shape: a
    // probabilistic lock-on.
    check(!/Math\.random\(\) < \(personNear \? 0\.8/.test(code),
        'no per-window coin flip for a person (the probabilistic lock-on)',
        'the per-window person coin flip is back');

    // ── MOBS RUN THE SAME CYCLE, JUST SHORTER ──
    // The owner: "that goes for mobs btw, maybe she sees a mob around so she looks
    // at it". Mobs used to get a 30% roll and a 2-12s window with no gap.
    check(/else if \(nearestMob\)/.test(block),
        'a nearby mob is a gaze target in its own right', 'mobs are not looked at');
    check(/1000 \+ Math\.random\(\) \* 1500/.test(block),
        'a mob glance is shorter than a person glance', 'the mob hold is not shorter');
    check(/2000 \+ Math\.random\(\) \* 4000/.test(block),
        'and a mob gets a look-away gap too', 'a mob has no look-away gap');

    // ── REGRESSION: the gap must apply to mobs as well ──
    // I left `&& isPlayer` on both gap checks when mobs joined the cycle, which
    // meant a mob's gap could neither fire nor expire: she looked at a cow and
    // never looked away.
    const gapLine = block.slice(block.indexOf('Date.now() < this.next_look_back') - 260,
        block.indexOf('Date.now() < this.next_look_back'));
    check(!/isPlayer\)\s*\{|&& isPlayer/.test(gapLine),
        'the gap applies to mobs, not just people', 'the gap is still player-only');
}

// ── she looks at the person she is ENGAGING, not the nearest body ──────
{
    const i = modes.indexOf("name: 'idle_staring'");
    // From this mode to the next, never a fixed character count - the mode has
    // outgrown 6000 chars, and a short window silently turns real assertions into
    // false failures.
    const _j = modes.indexOf("name: '", i + 10);
    const block = modes.slice(i, _j > i ? _j : i + 12000);
    // Comments excluded: this mode QUOTES the old buggy line in a comment to
    // explain what it replaced, and my assertion matched that quote. Assert on
    // code, never on a file that documents itself.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    check(/_attentionPlayer/.test(block),
        'the stare prefers the player she is engaging', 'it still takes the nearest player');
    check(/find\(\(p\) => p\?\.username === _engagedName\)/.test(block),
        'and matches on that player specifically', 'the engaged player is not matched');
}

// ── re-arming work is time-based, not once-per-process ────────────────
{
    // MEASURED BUG: exactly ONE [activity:...] line, then "self prompt loop
    // stopped" 43s later. One action is not work. The original guard
    // (`!_lastAutoGoalAt[activity]`) meant she picked work once per activity per
    // process and never again.
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    check(/ACTIVITY_REARM_MS/.test(agent), 're-arming is throttled by a time interval',
        'no re-arm interval');
    check(/Date\.now\(\) - _last > ACTIVITY_REARM_MS/.test(agent),
        'and the throttle compares elapsed time', 'the throttle is not time based');
    check(!/!this\._lastAutoGoalAt\?\.\[_pick\.activity\]\s*\}/.test(agent),
        'the once-per-process guard is gone', 'the once-per-process guard is back');
    // and the interval must be short enough that she is never visibly idle
    const ms = Number(/const ACTIVITY_REARM_MS = (\d+)/.exec(agent)?.[1]);
    check(Number.isFinite(ms) && ms > 0 && ms <= 120000,
        `the re-arm interval is ${ms}ms - short enough not to read as idle`,
        `the re-arm interval is ${ms}ms, which reads as standing around`);
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} social-behaviour assertions green`);