// She was in constant motion, and being talked to made it worse.
//
// The owner, two messages that turned out to be the same bug:
//   "i talk to her she doesnt respond at all.. also we need t remove idle
//    things she does, a normal player wont jump around 24/7 for example"
//
// The causal chain, and it is worth stating because the two complaints looked
// unrelated:
//   1. `unstuck` triggered on "has not moved for ~40 ticks".
//   2. Standing still to talk to someone is the most normal thing a player does.
//   3. So talking to her read as BEING STUCK.
//   4. She would then dig blocks out from under whoever was talking to her.
//
// Fixing the reply path (see tests/reply_trigger.test.mjs) stopped the silence.
// The gate below is the second half: stillness is only "stuck" when she actually
// intended to go somewhere.
//
// Measured basis for bounding action at all:
//   Gilmartin et al. 2019 (Teams Corpus, 47h): median 33.4% of floor time is
//     silence, 33.4% one speaker.
//   Herring ch.10: ~35% of initiations receive no response.
//   Suznjevic et al. 2009 (NetGames): player activity is "in general, bursty".

import { IdleBudget, SETTLE_AFTER_ACTION_MS, MAX_ACTIONS_PER_5MIN } from '../src/utils/idle_budget.js';
import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const GOAL = { has_goal: true, threat: false, human_present: false };

// ── no goal, no motion. This is the main gate. ─────────────────────────
{
    const b = new IdleBudget();
    const v = b.canAct({ now: 100000, has_goal: false, threat: false, human_present: false });
    check(!v.ok && v.why === 'no_goal', 'no objective means no movement',
        `moved with no goal: ${v.why}`);
}

// ── a goal is necessary but not sufficient: she settles after acting ────
{
    const b = new IdleBudget();
    const t = 1000000;
    check(b.canAct({ now: t, ...GOAL }).ok, 'a goal after a long wait permits action',
        'blocked forever with a goal');
    b.note(t);
    const soon = b.canAct({ now: t + 5000, ...GOAL });
    check(!soon.ok, 'she settles after acting rather than acting again immediately',
        `acted again after 5s: ${soon.why}`);
    const later = b.canAct({ now: t + SETTLE_AFTER_ACTION_MS + 1000, ...GOAL });
    check(later.ok, 'she acts again once settled', 'never acts again');
}

// ── a real threat overrides the budget. Fleeing is not fidgeting. ──────
{
    const b = new IdleBudget();
    b.note(1000000);
    const v = b.canAct({ now: 1005000, has_goal: false, threat: true, human_present: false });
    check(v.ok, 'a threat overrides the idle budget', 'she sat still while threatened');
}

// ── a human being present lengthens the settle, it does not shorten it ──
{
    // "a normal player wont jump around 24/7" - and definitely not while
    // somebody is standing there.
    const alone = new IdleBudget();
    const withHuman = new IdleBudget();
    const t = 1000000;
    alone.note(t); withHuman.note(t);
    const a = alone.canAct({ now: t + 60000, has_goal: true, threat: false, human_present: false });
    const h = withHuman.canAct({ now: t + 60000, has_goal: true, threat: false, human_present: true });
    check(a.ok, 'alone with a goal she moves again after 60s', 'blocked too long when alone');
    check(!h.ok, 'with a human present she stays put', 'she fidgeted while someone was there');
}

// ── talking to her is a reason to be STILL ─────────────────────────────
{
    // The direct inverse of the bug that started this.
    const b = new IdleBudget();
    const t = 1000000;
    b.note(t);
    b.humanEngaged();
    const v = b.canAct({ now: t + 1000, ...GOAL });
    check(!v.ok, 'talking to her makes her stay put', 'she moved straight after being spoken to');
}

// ── and there is a ceiling even with a goal ───────────────────────────
{
    const b = new IdleBudget();
    let t = 0;
    let allowed = 0;
    // Step INSIDE the 5-minute window, otherwise it always drains and the
    // ceiling can never be reached - my first version stepped 60s per
    // iteration, which is 5 per 5 minutes and already inside the cap.
    for (let i = 0; i < 40; i++) {
        if (b.canAct({ now: t, ...GOAL }).ok) { allowed++; b.note(t); }
        t += 5000;
    }
    check(allowed <= MAX_ACTIONS_PER_5MIN,
        `capped at ${MAX_ACTIONS_PER_5MIN} actions per 5 minutes (allowed ${allowed})`,
        `no ceiling: ${allowed} actions in 200s`);
    // and the window really does drain
    check(b.canAct({ now: t + 5 * 60 * 1000 + 1000, ...GOAL }).ok,
        'the ceiling releases after 5 minutes', 'the ceiling never releases');
}

// ── the unstuck fix: stillness only counts with a goal ────────────────
{
    const modes = readFileSync('src/agent/modes.js', 'utf8');
    const i = modes.indexOf("name: 'unstuck'");
    // Wide enough to reach the _tracking gate past its explanatory comment.
    const block = modes.slice(i, i + 3000);
    check(/_goalActive/.test(block), 'unstuck requires an active goal to consider itself stuck',
        'unstuck still fires on plain stillness');
    // The gate used to be `isIdle() && !_goalActive`, which made "not stuck" mean
    // "standing still with no goal" - the opposite of stuck, and it pinned
    // _idleStill at 0 forever. Instrumented live: 53 update ticks, 0 rescues,
    // while she narrated "still stuck?". The guard is now that stillness requires
    // at least ONE of idle-or-goal; what it must never do is fire on a plain
    // stillness with neither.
    check(/const _tracking = agent\.isIdle\(\) \|\| _goalActive;/.test(block),
        'the idle-still rescue tracks stillness while idle OR goal-active',
        'the rescue is not gated');
    check(!/if \(agent\.isIdle\(\) && !_goalActive\)/.test(block),
        'the rescue no longer requires the ABSENCE of a goal, which made it unreachable',
        'the old unreachable gate is back');
}

// ── wired at the single choke point, and it must not latch ────────────
{
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    check(/IdleBudget/.test(agent), 'the agent uses IdleBudget', 'IdleBudget is dead code');
    const i = agent.indexOf('new IdleBudget(');
    const m = agent.indexOf('await this.bot.modes.update()');
    check(i > 0 && i < m, 'the budget is consulted before modes run', 'modes run before the budget');
    check(!/_modeBudgetChecked/.test(agent),
        'no latch flag - the check runs every tick',
        'a latch flag is back, which would freeze her after one "settling" verdict');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} idle-budget assertions green`);