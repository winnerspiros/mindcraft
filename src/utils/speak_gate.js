// SPEAK GATE — normal persona.
//
// The research is unambiguous on the mechanism: asking the model "should you
// speak?" fails, because next-token prediction is local. A synthetic turn in
// context reads as a turn owed a reply. That is why external control logic —
// a gate that is not the model's judgement — is what actually works.
//
// So: this is DETERMINISTIC. No LLM call. Every rule here is a fact about the
// turn's provenance that we already know at the choke point, so asking a
// model to rediscover it would cost money and be strictly worse.
//
// Evidence for the failures this encodes:
//   - her live log filled with "where's YandereDev? I need you right now" aimed
//     at nobody, from a timer-driven self-prompt nobody asked for;
//   - "(AUTO) You feel clingy ... Sweet, possessive" replaying every ~45s;
//   - boot-time "sooo i just woke up ... anyone want to show me around?".
//
// Rule of thumb from the Koala study (arXiv 2501.17258): they needed external
// control logic to force replies only on mention, because the base model was
// "unreliable in identifying intended target for a chat utterance". We do not
// need a model to identify the target — the caller already passes it to us.

/**
 * @param {object} ctx
 * @param {string} ctx.message     the outgoing text
 * @param {string} ctx.to_player   route target: a username, or 'system'/self for
 *                                 agent-initiated turns
 * @param {boolean} ctx.self_prompt  true when the turn was self-initiated
 * @param {boolean} ctx.human_replied true when a real player spoke to her this turn
 * @param {boolean} ctx.any_human   is anyone actually on the server
 * @returns {{ok: boolean, why: string}}
 */
export function gateNormalChat(ctx) {
    const msg = String(ctx?.message ?? '').trim();
    if (!msg) return { ok: false, why: 'empty' };

    // Commands are actions, not chat. `!collectBlocks(...)` in a reply must
    // still reach the skills layer, and an all-command turn has no chat text to
    // gate. Never block on those.
    if (!/[a-z0-9]{2,}/i.test(msg.replace(/!\w+\([^)]*\)/g, ''))) {
        return { ok: true, why: 'action-only' };
    }

    // Nobody to talk to. Broadcasting into an empty server is the void-talking
    // failure in its purest form.
    if (!ctx.any_human) return { ok: false, why: 'no_human_online' };

    // THE MAIN RULE. A turn the agent invented, addressed at nobody in
    // particular, is narration — the single loudest "I am a bot" tell there is.
    // Real players speak to someone or about something; they do not report
    // their own inner state to an empty channel.
    // ── SHE DID SOMETHING, SO THIS IS A REACTION TO A REAL EVENT ──────
    // The owner: "no reaction, no answer.."
    //
    // Measured: 50 turns killed by this gate in one run, including "i swear this
    // game is out to get me. fine, looking for coal manually, here we go. wish me
    // luck!" - a player narrating what she just started doing, not introspection.
    //
    // The gate could not tell them apart because it only saw self_prompt versus
    // human_replied. What actually separates them is whether she just DID
    // something: a turn following a real command is a reaction to a real event,
    // the same category as notable_event. That is state, not a phrase table.
    //
    // BUT NOT EVERY POST-ACTION TURN IS A REACTION, AND THAT WAS THE SPAM. The
    // exemption is unbounded in TIME as well as in state, so a self-prompt turn
    // 4-22s after a command could narrate freely, forever, and it did - the
    // owner sees "constant one-liners in chat" and confirmed it. Live at 05:47,
    // unprompted and with nobody spoken to:
    //   "great, now I'm just starving couldn't even get a slice of bread xD"
    //   "i'm about to pass out here somebody help me out plz:("
    //
    // A real reaction is a REACTION - it reports something that happened to her
    // that the players can see or care about: died, got hurt, completed a build,
    // found something. "I'm still hungry" is not a reaction to anything, it is
    // a state she keeps announcing on a 13-second median cadence, and the fix
    // cannot be a phrase table. The state is already here: just_acted is true
    // for 8 seconds after a command, and the loop's own gear is 4-22s, so a
    // second self-prompt in the same burst inherits the exemption and talks
    // again. The reaction window is therefore ONE turn, and the caller marks
    // the event that earns it.
    if (ctx.self_prompt && !ctx.human_replied && !ctx.notable_event && !ctx.just_acted) {
        // ── A BID IS NOT NARRATION ─────────────────────────────────────
        // The owner: "she can ask ppl to help or ask if they want help or maybe
        // an item she doesnt need, . a lot of options there too"
        //
        // This rule was written before she had bids, and it cannot tell a bid from
        // narration. Measured cost of that blindness: 47 of 55 outbound messages
        // killed by this one gate, including "ok then, how about we just go look
        // for some sheep ourselves? let's get moving!" - a player talking to
        // someone, not introspection.
        //
        // The distinction is not wording (a phrase table here would be exactly the
        // rejected mistake). It is STRUCTURE: a bid has a recipient, comes from a
        // state that needs something or has something spare, and is a move in the
        // world. Narration has no recipient and is about her inner state.
        //
        // So the exemption is provenance, not vocabulary. If the caller says this
        // is a bid raised against a real nearby player, the rule steps aside - and
        // everything downstream (rate, length, budget, delivery) still applies.
        if (ctx.is_bid && ctx.bid_has_target) {
            // allowed through
        } else {
            return { ok: false, why: 'unprompted_self_narration' };
        }
    }

    // Structural bans the prompt cannot hold. Each of these was observed live.
    if (/\b(i'?m |i am )(elena)\b/i.test(msg) && !ctx.human_replied) {
        return { ok: false, why: 'unprompted_self_intro' };
    }
    // Register announcements ("hey everyone", "anyone want to...") are host
    // behaviour. Only someone actually speaking to her earns a greeting back.
    if (/^\s*(hey|hi|hello|yo)\s+(everyone|all|guys|folks|anyone)\b/i.test(msg)) {
        return { ok: false, why: 'room_announcement' };
    }
    // A bid may legitimately ask "anyone want any of this?" - that is a player
    // offering, not a void-check. Same structural exemption as above, and the
    // hollow-audience ban still stands for every non-bid turn.
    if (!ctx.is_bid && /\b(anyone (want|got|here)|is anyone (there|online))\b/i.test(msg)) {
        return { ok: false, why: 'hollow_audience_check' };
    }

    return { ok: true, why: 'ok' };
}
