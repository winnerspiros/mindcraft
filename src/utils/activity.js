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

    // ── SHE IS SELF-CENTERED, AND THAT IS CORRECT ───────────────────────
    // The owner: "she can interacr like that, not like its nessasary to do,
    // humans are self centered so i guees her goals and priorities are more
    // important."
    //
    // The previous order made her the MORE RESPONSIVE of the two: she dropped
    // whatever she was doing the moment a person engaged her, so she was the one
    // waiting, available and attentive. A player has their own agenda. Someone
    // walks up, they look over, they say something if it is worth it, and then
    // they go back to what THEY were doing.
    //
    // So a person is a REASON TO CONSIDER engaging, never a reason to abandon her
    // own work - and interrupting yourself for someone is a cost she pays, which
    // she does not pay every time. The owner's "if nothing intresting continue"
    // now covers the interesting case too: sometimes it just is not worth
    // stopping.
    //
    // She is never rude about it - noticing someone and then going back to work is
    // ordinary, and it is what the owner is asking for.
    // ── SURVIVAL FIRST, PEOPLE SECOND ─────────────────────────────────
    // Self-centered does not mean suicidal. This gate used to sit BELOW the
    // hunger and health checks, so an interesting person outranked survival:
    // measured at hunger 2/20 she returned look_around ("noted_them_carried_on")
    // instead of eating - she would starve rather than deal with someone.
    //
    // A starving player eats. So hunger and health are settled BEFORE anyone else
    // gets a vote:
    //     survive  >  a person  >  her own project
    // She stays choosy about WHICH survival act (eat now, or get clear and patch
    // up), which the fuller checks further down still decide.
    //
    // Reads w.* directly rather than the destructured locals, because this sits
    // above their destructuring - using the names here is a TDZ ReferenceError.
    const _h = Number.isFinite(w.hunger) ? w.hunger : null;
    if (_h !== null && _h <= NEED_HUNGER_CUTOFF) {
        return { activity: ACTIVITY.EAT, why: `hungry (${_h}/20)` };
    }
    const _hp = Number.isFinite(w.hp) ? w.hp : null;
    if (_hp !== null && _hp <= NEED_HP_CUTOFF) {
        return { activity: ACTIVITY.ANSWER_ATTENTION, why: `hurt (${_hp}/20) - get clear` };
    }

    if (w.attention && w.attention_interesting) {
        const r = w.rand || Math.random;
        if (r() < ENGAGE_INTERRUPT_RATE) {
            return { activity: ACTIVITY.ANSWER_ATTENTION, why: 'worth_interrupting_what_im_doing' };
        }
        // Noted, and carried on. Keep doing what she was doing if it is still a
        // live thing, rather than inventing a substitute.
        if (w.current_activity && w.current_activity !== ACTIVITY.ANSWER_ATTENTION) {
            return { activity: w.current_activity, why: 'noted_them_back_to_it' };
        }
        return { activity: ACTIVITY.LOOK_AROUND, why: 'noted_them_carried_on' };
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

// How often she actually stops what she is doing for a person who has caught her
// attention. Low on purpose.
//
// The owner asked for her goals and priorities to matter more than interaction,
// which means the DEFAULT is her own work. She is not waiting for someone: she is
// doing a thing, and occasionally a person is worth breaking off for. A high rate
// here reintroduces the attentive-bot shape the owner is explicitly rejecting, so
// this is a minority case by design rather than a tunable that drifted upward.
const ENGAGE_INTERRUPT_RATE = 0.35;

// ── BIDS: ASKING, OFFERING, UNPROMPTED ─────────────────────────────────
//
// The owner: "she can ask ppl to help or ask if they want help or maybe an item
// she doesnt need, . a lot of options there too"
//
// Everything above is her RESPONDING - to being spoken to, looked at, hit or
// griefed. This is her OPENING, and it is the half that was missing. It is also
// what stops her reading as a helpdesk: a player asks for things, offers things,
// and asks whether anyone wants what they are carrying.
//
// The self-centered constraint still binds, and it is what makes a bid believable
// rather than annoying: she does not offer help because somebody is idle. She
// offers because SHE is building something and wants it finished. A bid is an
// expression of her own goal, so a player who is deep in their own project can
// decline one and that is unremarkable - which is most of the time.
//
// Not a phrase table. A bid is a SHAPE with a slot for what she actually needs; the
// wording is hers, chosen by the same model that chooses all her other speech.

export const BID = {
    /** "can you help me with this" - she is stuck or working */
    ASK_FOR_HELP: 'ask_for_help',
    /** "do you want any of this" - she is carrying something spare */
    OFFER_SPARE: 'offer_spare',
    /** "do you need anything" - she is between tasks and someone is around */
    ASK_IF_THEY_NEED: 'ask_if_they_need',
    /** "can you spare an X" - she wants something she does not have */
    ASK_FOR_ITEM: 'ask_for_item',
    /** reacting to what someone is doing nearby */
    COMMENT_ON_THEIR_WORK: 'comment_on_their_work',
};

// How often she opens toward someone at all. Lower than the interrupt rate on
// purpose: she is self-centered, so unsolicited bids are rarer than replies.
const BID_RATE = 0.22;

/**
 * Decide whether to make a bid, and of what kind.
 *
 * @param {object} w
 * @param {number}  [w.humans_present]  someone to bid to
 * @param {boolean} [w.blocked]         she is genuinely stuck on something
 * @param {boolean} [w.has_spare]       carrying something she does not need
 * @param {boolean} [w.needs_item]      wants something she lacks
 * @param {string}  [w.current_activity] what she is doing
 * @param {boolean} [w.spoke_recently]  she has just spoken; bids stack up
 * @param {() => number} [w.rand]
 * @returns {{bid: string|null, why: string}}
 */
export function chooseBid(w = {}) {
    const rand = w.rand || Math.random;
    // Nobody to bid to. A bid into an empty room is the "(AUTO) You feel chatty"
    // loop that the jittered cadence work removed; do not bring it back.
    if ((w.humans_present || 0) < 1) return { bid: null, why: 'nobody_to_bid_to' };
    // She has just spoken. Two messages in a row of her own is a monologue, and
    // 15.07% of real turns are 3rd-or-later in a run - not the norm.
    if (w.spoke_recently) return { bid: null, why: 'already_talking' };
    // Rate, and the same self-centered discipline as everywhere else.
    if (rand() >= BID_RATE) return { bid: null, why: 'not_this_moment' };

    // Ordered by how much SHE wants it. A bid is her agenda, so the strongest
    // reason goes first: being stuck is the most pressing thing that can happen to
    // a player mid-task.
    if (w.blocked) return { bid: BID.ASK_FOR_HELP, why: 'stuck_on_what_im_doing' };
    if (w.needs_item) return { bid: BID.ASK_FOR_ITEM, why: 'need_something_i_dont_have' };
    // Spare items go before the idle "do you need anything", because a concrete
    // offer is a better opener than a vague one and it costs her nothing.
    if (w.has_spare) return { bid: BID.OFFER_SPARE, why: 'carrying_something_spare' };
    // Last, and only if someone is actually working on something nearby: asking
    // "do you need anything" out of nowhere is the emptiest of the five and reads
    // as filler.
    if (w.nearby_work) return { bid: BID.ASK_IF_THEY_NEED, why: 'theyre_building_something' };
    if (w.current_activity === ACTIVITY.BUILD) {
        return { bid: BID.COMMENT_ON_THEIR_WORK, why: 'im_building_and_theyre_here' };
    }

    // Nobody to bid to in any meaningful sense: someone is logged in but not
    // doing anything worth bidding to.
    return { bid: null, why: 'nothing_worth_asking_about' };
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
    ENGAGE_INTERRUPT_RATE,
    BID_RATE,
    NEED_PRIORITY,
    NEED_HUNGER_CUTOFF,
    NEED_HP_CUTOFF,
    FAILURE_BREAK_CUTOFF,
    ENOUGH,
};
