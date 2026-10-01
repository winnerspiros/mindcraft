// REPLY TRIGGER — is this message even for her?
//
// The gap, from the owner: alone with her, almost anything he says is for her.
// With several people on, they are probably talking to each other and an
// unnamed line is not for her. The existing gates ask different questions —
// "is this turn invented?" (speak_gate), "is there a proposition to agree
// with?" (empty_ack) — and none of them ask whether anyone is talking to each
// other at all.
//
// GROUP SIZE is the governing variable, because it follows from what a channel
// IS rather than from any persona:
//
//   DYAD   she + one human. Nobody else to be talking to, so the sensible
//          reading of an unnamed line is that it is for her. Silence is rarer.
//   GROUP  3+ humans. The default flips: people are talking to EACH OTHER, an
//          unnamed line is most likely not for her, and answering is intrusion.
//   MID-EXCHANGE  two humans trading — never intrude. Being named still wins,
//          because people answer a direct call even mid-argument.
//
// Not a persona instruction, and not a model call. A model handed a turn in its
// context treats every turn as a turn owed an answer; the Koala study
// (arXiv 2501.17258) needed external control logic for exactly this, reporting
// the base model "unreliable in identifying intended target for a chat
// utterance". We do not need a model to count players.
//
// Silence is a real outcome. Measured here: 3 of 33 bare greetings got no reply,
// which is normal, not rude.

// 19% of real player lines end in "?" — an ordinary question is aimed at whoever
// is relevant, which in a channel where she did the thing is her.
const DIRECT_NEED = [
    /\?\s*$/,
    /\b(can you|could you|help|need (help|a hand)|stuck|anyone (got|have|know)|who (has|got))\b/i,
    /\b(uwu'?s?|your) (roof|base|farm|house|build|chest|portal|bed)\b/i,
];
// Social filler, aimed at whoever is nearby rather than at her.
const CASUAL_NOISE = /^\s*(lol|lmao|haha|xd|kk|ok(ay)?|nice|cool|wow|ah|oh|hm+|mhm+|nice one|gg|ty|thanks?|np|brb|afk)\b[\s!.]*$/i;

const DYAD_RATE = 0.28;   // eligible turns she opens a conversation
const GROUP_RATE = 0.12;

/**
 * @param {object} ctx
 * @param {string}  ctx.message        the player's text
 * @param {number}  ctx.visible_humans humans near her, excluding her
 * @param {boolean} [ctx.addressed]    message names her
 * @param {boolean} [ctx.human_exchange] two or more humans are mid-conversation
 * @param {string}  [ctx.last_speaker]  who spoke immediately before, if anyone
 * @param {string}  [ctx.last_target]  who that message was aimed at ('other' if
 *        it named somebody who is not her, '' if it named nobody)
 * @returns {{reply: boolean, why: string}}
 */
export function shouldReplyTo(ctx) {
    const msg = String(ctx?.message ?? '').trim();
    if (!msg) return { reply: false, why: 'empty' };

    // Callers pass the count because they already have the entity list;
    // recomputing it here would duplicate the 26.3 stale-tablist handling.
    const humans = Math.max(0, Number(ctx?.visible_humans) || 0);

    // A message cannot be for her when nobody is here to have sent it. Without
    // this, 0 fell through to the dyad branch below and she replied into an
    // empty server.
    if (humans === 0) return { reply: false, why: 'nobody_here' };

    if (ctx?.addressed) {
        return { reply: true, why: humans === 1 ? 'addressed_in_dyad' : 'addressed_by_name' };
    }
    if (ctx?.human_exchange && humans > 1) {
        return { reply: false, why: 'others_mid_conversation' };
    }

    // DIRECTIONAL ADDRESSING. Not merely "someone spoke" but "these two are
    // talking to each other": the same speaker continuing straight after a
    // message that named somebody else is almost certainly still talking to
    // that person. Without this, a three-person room where two of them are
    // mid-argument still looked like a general announcement to her.
    if (humans > 1 && ctx?.last_target === 'other' && ctx?.last_speaker
        && String(ctx?.speaker ?? '') === ctx.last_speaker) {
        return { reply: false, why: 'continuing_another_thread' };
    }

    // DYAD — the alternative is that he is talking to himself.
    if (humans === 1) {
        return {
            reply: true,
            why: CASUAL_NOISE.test(msg) ? 'dyad_short_reply' : 'dyad_default_open',
        };
    }

    // GROUP — answer only what plainly needs her.
    if (CASUAL_NOISE.test(msg)) return { reply: false, why: 'group_low_content' };
    return DIRECT_NEED.some((rx) => rx.test(msg))
        ? { reply: true, why: 'group_explicit_need' }
        : { reply: false, why: 'group_not_addressed' };
}

/**
 * May she open a conversation? The owner: "she can start a conversation, no
 * forced". A probability per eligible turn, never a timer — the old 45s gear
 * produced the "(AUTO) You feel chatty" loop, the same failure in new clothes.
 *
 * @param {object} ctx
 * @param {number}  ctx.visible_humans
 * @param {boolean} [ctx.human_exchange]
 * @param {boolean} [ctx.spoke_recently]
 * @param {() => number} [rand]
 * @returns {{start: boolean, why: string}}
 */
export function shouldStartConversation(ctx, rand = Math.random) {
    const humans = Math.max(0, Number(ctx?.visible_humans) || 0);
    if (humans === 0) return { start: false, why: 'nobody_here' };
    if (ctx?.human_exchange && humans > 1) return { start: false, why: 'others_mid_conversation' };
    if (ctx?.spoke_recently) return { start: false, why: 'spoke_recently' };
    const dyad = humans === 1;
    return rand() < (dyad ? DYAD_RATE : GROUP_RATE)
        ? { start: true, why: dyad ? 'dyad_initiative' : 'group_initiative' }
        : { start: false, why: 'not_this_turn' };
}