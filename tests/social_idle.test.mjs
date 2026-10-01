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
    const block = modes.slice(i, i + 6000);
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
    check(use > store, 'the gap is enforced after it is stored',
        'the gap is stored but never checked');

    // it must not defeat itself: re-arming only happens on target CHANGE, so a
    // cleared stare is not instantly re-acquired
    const gapAt = use;
    const rearm = block.indexOf('this.staring = true');
    check(rearm < gapAt,
        'stare re-arms only when the target changes, so the gap survives',
        'the stare re-arms every tick and the gap cannot hold');

    // and the mob hold stays long - watching a creeper is not a social act
    check(/4000 \+ Math\.random\(\) \* 1000/.test(block),
        'mob-watching keeps its longer hold', 'the mob hold was changed too');
}

// ── she looks at the person she is ENGAGING, not the nearest body ──────
{
    const i = modes.indexOf("name: 'idle_staring'");
    const block = modes.slice(i, i + 6000);
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