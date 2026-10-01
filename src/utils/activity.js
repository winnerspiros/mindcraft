// She stood still for 30 minutes with nobody talking.
//
// The owner: "game wise she is too idle. a player normally does stuf, build, get
// resouce, explore, if she notices someone look at them if nothing intresting
// continue etc."
//
// That last clause is the whole design. A player is never idle without purpose,
// and what they do next comes from their SITUATION, not from a schedule:
//
//   - low on anything they need        -> go get it
//   - standing next to a half-built thing -> finish it
//   - nothing pressing                 -> look around, wander, explore
//   - someone is looking at them       -> look back, and if nothing is
//                                        interesting, carry on with what they
//                                        were doing
//
// This module picks WHAT, not HOW. It never emits an action, never names a
// command, and holds no phrase table - it returns a goal description that goes
// into the self-prompter exactly as a conversational goal would. The bot, its
// skills and the model decide how to carry it out, same as for any other goal.
//
// ── WHY NOT A TIMER ─────────────────────────────────────────────────────
//
// The fidgeting bug was a threshold mode firing on a timer: 15 mode firings per
// 10 minutes with nobody present. This is the opposite failure and must not
// reintroduce that one, so the cadence here is state-driven rather than
// periodic: a goal is chosen when the current one is done or absent, and the
// choice is a function of the world. Sitting still is never the output unless
// she is at her computer (utils/life_state.js) or the server is empty.
//
// ── WHY NOT A HARD-CODED TASK LIST ──────────────────────────────────────
//
// The owner has rejected phrase tables and fixed scripts repeatedly. A task list
// would be the same mistake in game form: "always mine first, then build". What
// varies is the WORLD - her inventory, what is near her, who is present - so the
// ranking reads those and nothing else.

const ACTIVITY = {
    GET_RESOURCE: 'get_resource',
    BUILD: 'build',
    EXPLORE: 'explore',
    LOOK_AROUND: 'look_around',
    ANSWER_ATTENTION: 'answer_attention',
    EAT: 'eat',
};

/**
 * What she is short of, in the order a player would notice it.
 *
 * Deliberately NOT thresholds in the source. These are the orderings a player
 * uses; the actual "am I short" test comes from her inventory at call time, so
 * this is a preference order and not a rule set.
 */
const NEED_PRIORITY = ['food', 'torch', 'tool', 'block', 'ore'];

/**
 * Choose the next thing to do, from her situation.
 *
 * Every field is optional and every unknown resolves toward something she can
 * usefully do - never toward standing still, which is the failure being fixed.
 *
 * @param {object} w
 * @param {number}  [w.hunger]              0-20, 20 is full
 * @param {number}  [w.hp]                  0-20
 * @param {object}  [w.inventory]           item name -> count
 * @param {boolean} [w.has_torch]
 * @param {boolean} [w.nearby_build]        an incomplete structure within reach
 * @param {boolean} [w.attention]           someone is looking at her
 * @param {boolean} [w.attention_interesting] that person is worth engaging
 * @param {number}  [w.humans_present]
 * @param {boolean} [w.at_computer]         life_state: she has stepped away
 * @param {number}  [w.recent_failures]     actions that just failed
 * @returns {{activity: string, why: string}}
 */
export function chooseActivity(w = {}) {
    // She has left the computer. A person who is not there does not act. This is
    // the ONE case where doing nothing is right.
    if (w.at_computer === false) return { activity: null, why: 'not_at_computer' };

    // Someone is looking at her. The owner's example, in order:
    //   "if she notices someone look at them if nothing intresting continue"
    // So look back FIRST, and only stay for it if there is something there worth
    // staying for. Otherwise fall through to whatever she was doing.
    if (w.attention) {
        if (w.attention_interesting) return { activity: ACTIVITY.ANSWER_ATTENTION, why: 'someone_is_looking_and_worth_it' };
    }

    // Starving outranks everything except answering a person.
    const hunger = Number.isFinite(w.hunger) ? w.hunger : null;
    if (hunger !== null && hunger <= NEED_HUNGER_CUTOFF) {
        return { activity: ACTIVITY.EAT, why: `hungry (${hunger}/20)` };
    }

    // Standing next to your own half-built thing, you finish it. Nobody walks
    // away from a roof they started.
    if (w.nearby_build) return { activity: ACTIVITY.BUILD, why: 'something_half_built_here' };

    // Short of something, go and get it. Ordered by NEED_PRIORITY rather than
    // checked as fixed thresholds, so it reflects what she is actually missing.
    const inv = w.inventory || {};
    const missing = firstShortage(inv, w);
    if (missing) return { activity: ACTIVITY.GET_RESOURCE, why: `out of ${missing}` };

    // Hurt with no enemy in sight: tend to it the way a player does, by getting
    // clear and patching up.
    const hp = Number.isFinite(w.hp) ? w.hp : null;
    if (hp !== null && hp <= NEED_HP_CUTOFF) {
        return { activity: ACTIVITY.ANSWER_ATTENTION, why: `hurt (${hp}/20) - get clear` };
    }

    // Repeated failures mean stop repeating. Break out of the loop by changing
    // what she is doing rather than trying the same thing a fifth time.
    if ((w.recent_failures || 0) >= FAILURE_BREAK_CUTOFF) {
        return { activity: ACTIVITY.EXPLORE, why: 'same thing keeps failing - go elsewhere' };
    }

    // Company, if any, without treating anyone as a task.
    if ((w.humans_present || 0) > 0) return { activity: ACTIVITY.LOOK_AROUND, why: 'company_about' };

    // Nothing pressing at all. A player with a full inventory, a fed hunger bar
    // and nobody around goes and looks at the map. This is the case that used to
    // resolve to standing still.
    return { activity: ACTIVITY.EXPLORE, why: 'nothing_pressing' };
}

// Cutoffs are Minecraft's own UI thresholds, not invented numbers: the hunger
// bar empties at 0 and the natural-regeneration line sits at 18, so she acts
// before she is actually hungry rather than at the moment she starts losing
// health. HP half is where a player stops pretending to be fine.
const NEED_HUNGER_CUTOFF = 17;
const NEED_HP_CUTOFF = 10;
const FAILURE_BREAK_CUTOFF = 3;

// A stack a player would call "enough of that to stop worrying".
const ENOUGH = {
    food: 16,
    torch: 24,
    tool: 1,
    block: 64,
    ore: 8,
};

function firstShortage(inv, w) {
    for (const need of NEED_PRIORITY) {
        if (w.has_torch && need === 'torch') continue;   // already carrying light
        const have = Number(inv[need] ?? inv[`minecraft:${need}`] ?? 0) || 0;
        if (have < ENOUGH[need]) return need;
    }
    return null;
}

export {
    ACTIVITY,
    NEED_PRIORITY,
    NEED_HUNGER_CUTOFF,
    NEED_HP_CUTOFF,
    FAILURE_BREAK_CUTOFF,
    ENOUGH,
};
