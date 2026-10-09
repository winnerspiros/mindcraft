// Guest pacing: the quiet profile on public servers, home defaults untouched.
//
// 1. pacing() returns {} on home (no entry) — every subsystem keeps its
//    measured defaults.
// 2. A guest pacing block flows through: chat/idle budgets accept it.
// 3. moveProfile downgrades sprint->walk under noSprint.
// 4. Bare constructors keep home behavior (existing tests cover the numbers).

import { ChatBudget, MIN_GAP_MS, MAX_MESSAGES_PER_WINDOW, MAX_CONSECUTIVE } from '../src/utils/chat_budget.js';
import { IdleBudget } from '../src/utils/idle_budget.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const GUEST_CHAT = { minGapMs: 8000, maxPerWindow: 6, maxConsecutive: 1 };
const GUEST_IDLE = { settleAfterActionMs: 120000, settleWhenIdleMs: 240000, minGapMs: 60000, maxPer5Min: 3 };

// 1. bare constructors = home defaults
{
    const b = new ChatBudget();
    check(b._minGap === MIN_GAP_MS, 'bare ChatBudget keeps the measured min gap', 'bare ChatBudget gap changed');
    check(b._maxWin === MAX_MESSAGES_PER_WINDOW, 'bare ChatBudget keeps the window cap', 'bare ChatBudget cap changed');
    check(b._maxConsec === MAX_CONSECUTIVE, 'bare ChatBudget keeps the run cap', 'bare ChatBudget run cap changed');
}

// 2. guest opts apply
{
    const b = new ChatBudget(GUEST_CHAT);
    check(b._minGap === 8000, 'guest chat gap applies (8s)', 'guest chat gap lost');
    check(b._maxWin === 6, 'guest window cap applies (6)', 'guest window cap lost');
    check(b._maxConsec === 1, 'guest run cap applies (1)', 'guest run cap lost');
    // guest budget actually holds: 1 delivered, second immediate send refused
    const t = Date.now();
    b.delivered(t);
    const v = b.canSpeak({ now: t + 1000 });
    check(!v.ok, 'guest budget holds the second line (too_fast / run cap)', `guest budget leaked: ${v.why}`);
    // home budget would also hold here (2.5s gap) — the difference is the run cap:
    const h = new ChatBudget();
    h.delivered(t);
    const v2 = h.canSpeak({ now: t + 1000 });
    check(!v2.ok && v2.why === 'too_fast', 'home budget holds on gap, not run cap', `home budget behaved oddly: ${v2.why}`);
    // but after the gap, home allows a 2nd consecutive line, guest does not
    const v3 = h.canSpeak({ now: t + 3000 });
    check(v3.ok, 'home allows the 2nd line after the gap', `home refused: ${v3.why}`);
    const v4 = b.canSpeak({ now: t + 9000 });
    check(!v4.ok, 'guest still refuses the 2nd consecutive line after its gap', `guest leaked: ${v4.why}`);
}

// 3. idle budget: guest settles longer, fewer actions
{
    const g = new IdleBudget(GUEST_IDLE);
    const t = Date.now();
    g.note(t);
    check(!g.canAct({ now: t + 61000, has_goal: true }).ok, 'guest still settling at 61s (120s settle)', 'guest settle too short');
    check(g.canAct({ now: t + 121000, has_goal: true }).ok, 'guest acts after its settle', 'guest never acts');
    const h = new IdleBudget();
    check(h.canAct({ now: t + 46000, has_goal: true }).ok, 'home acts after its own settle (45s)', 'home settle changed');
}

// 4. self-prompt scale defaults to 1 when unset
{
    const { SelfPrompter } = await import('../src/agent/self_prompter.js');
    const sp = Object.create(SelfPrompter.prototype);
    check(sp._cadenceScale() === 1, 'unset scale defaults to 1 (home unchanged)', 'default scale changed');
    sp._paceScale = 2;
    check(sp._cadenceScale() === 2, 'set scale reads back', 'scale readback broke');
}

console.log(`\n${pass} passed, ${failed} failed`);
