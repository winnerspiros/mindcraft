// REPLY TRIGGER — who is this message for?
//
// The gap this fills, from the owner: "right now im just me and her so most
// probably if i send anything in chat it probably is for her. same for her, she
// can start a conversation, no forced. if many ppl are on server they might
// talk to themselves so no need to interfere."
//
// That is a statement about GROUP SIZE, and it is the right variable. The
// existing gates all ask a different question - "is this turn invented?" (speak
// gate), "is it addressed to nobody?" (empty ack) - and none of them ask "is
// anyone even talking TO each other".
//
// The logic, which follows from what a channel IS rather than from a persona:
//
//   DYAD (she + exactly one human): almost everything is for her. There is
//   nobody else to be talking to. A message in a two-person channel that does
//   not name her is still very likely for her, because the alternative is that
//   her only conversational partner is talking to himself. So the bar to
//   answer drops to near zero, and staying silent becomes the rarer choice.
//
//   GROUP (3+ humans): the default assumption flips. People are talking to each
//   other, and a message that does not name her is most likely NOT for her.
//   Answering it is intrusion. So she answers when named, and otherwise only
//   when the message clearly needs her - a direct request for the thing she is
//   the only one doing, or a question nobody else can answer.
//
// This is deliberately NOT a persona instruction. A prompt cannot count players
// or decide that a message was meant for someone else; and a model asked
// "should you reply to this?" will say yes, because the turn is in its context
// and every turn in context looks like a turn owed an answer. The same reason
// the Koala study (arXiv 2501.17258) needed external control logic to restrict
// replies to mentions: the base model was "unreliable in identifying intended
// target for a chat utterance".
//
// Silence is a real outcome here, not a failure. Measured on this server's own
// chat, 3 of 33 bare greetings got no reply at all, and that is normal
// behaviour, not rudeness.

/**
 * Count the humans currently visible to her, excluding herself.
 * Callers pass this in because they already have the entity list; recomputing
 * it here would duplicate the 26.3 tablist/stale-entry handling that
 * _otherPlayersOnline() already gets right (the tablist carries stale entries,
 * so "any player online" is not the same as "someone is actually here").
 */
function visibleHumans(humans) {
    return Math.max(0, Number(humans) || 0);
}

// A message that plainly needs a specific person even without naming them.
// Deliberately narrow: these are the cases where staying silent is worse than
// possibly intruding.
const DIRECT_NEED = [
    // A direct question. "where did you put the wood" is addressed to whoever
    // put the wood there, and in a channel where she is the one who put it,
    // that is her. My first DIRECT_NEED only matched when a wh-word sat within
    // 60 characters of the "?", which missed the common shape of an ordinary
    // question entirely.
    /\?\s*$/,
    // an explicit request for help/attention
    /\b(can you|could you|help|need (help|a hand)|stuck|anyone (got|have|know)|who (has|got))\b/i,
    // naming an object only she is dealing with
    /\b(uwu'?s?|your) (roof|base|farm|house|build|chest|portal|bed)\b/i,
];
// Small talk that is clearly social, and in a group is usually aimed at whoever
// is nearby rather than at a bot.
const CASUAL_NOISE = /^\s*(lol|lmao|haha|xd|kk|ok(ay)?|nice|cool|wow|ah|oh|hm+|mhm+|nice one|gg|ty|thanks?|np|brb|afk)\b[\s!.]*$/i;

/**
 * Decide whether a player message is plausibly for her.
 *
 * @param {object} ctx
 * @param {string}  ctx.message        the player's text
 * @param {number}  ctx.visible_humans humans near her, excluding her
 * @param {boolean} ctx.addressed      message names her
 * @param {boolean} ctx.human_exchange two or more humans are mid-conversation
 * @param {boolean} ctx.same_speaker_recently the last message was from this same player
 * @returns {{reply: boolean, why: string}}
 */
export function shouldReplyTo(ctx) {
    const msg = String(ctx?.message ?? '').trim();
    if (!msg) return { reply: false, why: 'empty' };

    const humans = visibleHumans(ctx.visible_humans);
    const addressed = !!ctx.addressed;

    // Nobody here at all. A message cannot be for her when there is nobody to
    // have sent it - visible_humans 0 means an empty server, and it fell through
    // to the dyad branch (humans <= 1) which answered anyway. That is the
    // void-talking failure this whole file exists to prevent.
    if (humans === 0) return { reply: false, why: 'nobody_here' };

    // Named directly. This overrides everything except an active exchange
    // between two other people - being called by name mid-argument still gets
    // answered by real people, so it outranks the group rule.
    if (addressed) {
        return { reply: true, why: humans <= 1 ? 'addressed_in_dyad' : 'addressed_by_name' };
    }

    // Two humans are talking to each other. Not hers, whatever she feels like
    // saying. This is the intrusion the owner described.
    if (ctx.human_exchange && humans > 1) {
        return { reply: false, why: 'others_mid_conversation' };
    }

    // ── DYAD: her only conversational partner ────────────────────────────
    // Nobody else is here. A message that does not name her is still most
    // likely for her, because the alternative is that he is talking to himself.
    if (humans <= 1) {
        if (CASUAL_NOISE.test(msg)) return { reply: true, why: 'dyad_short_reply' };
        return { reply: true, why: 'dyad_default_open' };
    }

    // ── GROUP: 3+ humans, not addressed ──────────────────────────────────
    if (CASUAL_NOISE.test(msg)) return { reply: false, why: 'group_low_content' };
    for (const rx of DIRECT_NEED) {
        if (rx.test(msg)) return { reply: true, why: 'group_explicit_need' };
    }
    return { reply: false, why: 'group_not_addressed' };
}

// ── Should SHE start something, unprompted? ───────────────────────────────
// The owner: "she can start a conversation, no forced". So this is allowed, and
// it is deliberately rare. Two conditions, both required:
//   1. she is not interrupting anyone (no active human exchange)
//   2. there is someone to talk to
// Rate is a probability per eligible turn, not a timer - a timer is what
// produced the old 45s "(AUTO) You feel clingy" loop.
const UNPROMPTED_BASE_RATE = 0.12;   // ~1 in 8 eligible turns
const UNPROMPTED_DYAD_RATE = 0.28;   // alone with one person, she chattier

export function shouldStartConversation(ctx, rand = Math.random) {
    const humans = visibleHumans(ctx.visible_humans);
    if (humans < 1) return { start: false, why: 'nobody_here' };
    if (ctx.human_exchange && humans > 1) return { start: false, why: 'others_mid_conversation' };
    // She just spoke, or just went quiet after being answered - do not pile on.
    if (ctx.spoke_recently) return { start: false, why: 'spoke_recently' };
    const rate = humans <= 1 ? UNPROMPTED_DYAD_RATE : UNPROMPTED_BASE_RATE;
    if (rand() < rate) return { start: true, why: humans <= 1 ? 'dyad_initiative' : 'group_initiative' };
    return { start: false, why: 'not_this_turn' };
}