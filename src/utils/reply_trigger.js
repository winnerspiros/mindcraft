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
// A REACTION-TO-something. He is reacting, so a reaction back is legitimate.
// Note this list is about the SPEAKER's utterance, not about what she says - it
// never decides her words.
const CASUAL_NOISE = /^\s*(lol|lmao|haha|xd|kk|nice|cool|wow|ah|oh|hm+|mhm+|nice one|gg|ty|thanks?|np|wtf|yikes|lmao)\b[\s!.]*$/i;
// He is LEAVING or going quiet. Not a reaction, and nothing to answer.
const ABSENT_SIGNAL = /^\s*(brb|afk|gtg|bye|later|back soon|one sec|hold on|back)\b[\s!.]*$/i;
// An acknowledgement addressed to nobody in particular. "ok" is not a thing
// you say TO someone.
// "yeah"/"yep" were MISSING here and sat in STATUS_CALL instead, which made them
// match this list's intent and NARRATION's at once - react via one path, ignore
// via the other. They belong here, with the other bare acknowledgements.
const ACK_NO_TARGET = /^\s*(ok(ay)?|k|kk|mm+|mhm+|sure|fine|cool|nice|right|got it|np|ty|yeah|yep|yup|nah|alright|word|true)\b[\s!.]*$/i;

// ── in a dyad, HOW does she engage? ─────────────────────────────────────
//
// Three outcomes, and none of them is "answer the question":
//
//   ignore  he is talking to the room / to himself / narrating what he is
//           doing. She reads it and says nothing. This is the COMMON case and it
//           has to stay common, or she is a helpdesk.
//   react   something was funny, stupid, or worth a noise. A reaction IS the
//           whole reply - no sentence, no content, just a laugh or a "wtf".
//   speak   he actually said something to her or about her, or asked something.
//           A real reply.
//
// The signal is STRUCTURE, not vocabulary. Asking for a laugh is not the way to
// build this: it would mean a list of joke words, and it would fire on a message
// that is not a joke at all. What actually predicts the outcome is whether the
// message is addressed, whether it proposes something, whether it is a reaction
// to the game, and whether it is a statement or a question.
//
// Drawn from the corpus: 0.4% of real messages carry a reaction token, 21.1% are
// a single word, and 0.12% contain a second sentence. So a reaction is rare as
// an explicit choice but a one-word reply is completely ordinary - the two are
// the same shape.
const QUESTION = /\?\s*$/;
// Cast at the room rather than at her. Note that "does anyone know" and "can
// you help" are different speech acts: one is a line in the water, the other is
// addressed. Only the unaddressed plural goes here.
// The question mark is OPTIONAL: 24.7% of real messages end in punctuation at
// all, and "has anyone seen the cows" with no mark is the normal way to say it.
const ROOM_QUESTION = /\b(anyone|any1|anybody|somebody|someone|everybody|people|guys)\b.*|^(?:has|is|are|who|what|can|do) (?:any|every|some)\w*/i;
// A DIRECT ASK. Every one of these has to be a real request with a referent -
// "wait" on its own is a status call to the room, "wait for me" is asking her.
const DIRECT_NEED_DYAD = /\b(can you|could you|would you|help me|need (help|a hand|stone|iron|food)|im stuck|stuck|come here|wait for me|wait here|look at (this|that|here)|listen|do you|did you|have you|where are you|what are you doing)\b/i;
// Talking about the game / narrating. This is what the server hears most of the
// time and it is not addressed to anyone.
//
// The first version anchored the whole message with \b\s*$, so it only matched
// when the message WAS the status call. "there you go" and "im going to the
// mines" are the same speech act and both fell through to react. Anchoring at
// the end is right; the START anchor is what was missing.
// NARRATION, built from parts rather than one big alternation: I got the
// precedence wrong twice in one sitting (writing ^(?:A|B)|\bC\b binds ^ to A
// only, so every branch after the top-level | was unanchored and "brb" and
// "ok" still fell through). Three independent tests, each obviously correct:
//
//   1. a pure status call - the whole message IS the status
//   2. first-person narration about where she/he is going or what he is doing
//   3. an action in asterisks
//
// Anything matching is said to the room, not to her.
// The action branch (*does a thing*) has to sit OUTSIDE the \b-terminated
// group: a word boundary after a "*" can never match, which is why
// "*builds a wall*" was slipping through as react.
const ACTION = /^\s*\*[^*]+\*\s*$/;
// GENUINE STATUS CALLS ONLY. This list used to also carry the bare
// acknowledgements "ok", "yeah", "sure", "right", "nah", "k", "alright", which
// are NOT status calls - they are a response to what somebody just said, and in a
// dyad that somebody is her. Because NARRATION is checked inside pickDyadMode and
// this ran first, "yeah" matched BOTH this and ACK_NO_TARGET: react via one path,
// ignore via the other, and ignore won. So "yeah" was dropped while "damn" and
// "no" spoke - the same speech act with opposite outcomes, decided by a word list.
//
// The bare acks are handled by the dyad ack rule instead, which is where the
// reasoning belongs.
const STATUS_CALL = /^\s*(?:here|there|now|go on|one sec|hold on|wait|back|done|there you go|never ?mind|thats (?:it|done)|thats fine|coming|on my way|almost)\b[\s!.]*$/i;
const NARRATES = /\b(?:im (?:going|coming|building|moving|mining|crafting|heading|walking|heading back|on my way|over there)|on my way|one sec|hold on|coming now|give me a sec|let me)\b/i;
const NARRATION = (m) => ACTION.test(m) || STATUS_CALL.test(m) || NARRATES.test(m);

function pickDyadMode(msg, ctx = {}) {
    const m = String(msg || '').trim();

    // A QUESTION or a real REQUEST is a reply, always. There is no ambiguity here
    // and no need for a phrase list: asking something wants an answer.
    if (QUESTION.test(m)) return 'speak';

    // NAMED OR PHYSICALLY ADDRESSED: an explicit request for her attention.
    if (ctx.addressed || ctx.addressed_physically) return 'speak';

    // THIRD-PERSON NARRATION about the game ("im off to the mines", "theres a
    // creeper at the base") is the one shape that genuinely is not for her, even
    // in a dyad - it is a status call, and a player who says it is not asking
    // for a reply. Sentences ending in a full stop lean here too, since a full
    // stop is a completed thought rather than an opening.
    if (NARRATION(m)) return 'ignore';
    if (m.endsWith('.')) return 'ignore';

    // A question cast at the room is not a question for her, in a dyad or not.
    if (ROOM_QUESTION.test(m)) return 'ignore';

    // ── WHY THIS IS NOT A PHRASE TABLE ──────────────────────────────────
    // This used to return 'react' for anything not matching a hand-written list
    // ("can you", "help me", "come here"), so "yo", "gm", "you there" and "yo
    // bitch" all produced silence. The owner was right: matching phrases is not
    // the same as judging intent, and it is exactly the hardcoding to avoid.
    //
    // In a DYAD there is one other person. "yo", "gm", "you there", "im heading
    // to the mines", "that was close" are addressed to her BY POSITION - there is
    // nobody else to address them to. Measured against the research this is the
    // right call: Herring ch.10 reports ~35% of initiations go unanswered, but
    // that is over real conversations with a real audience, not a one-to-one.
    // Her dyad no-response rate now sits near the 33.5% current-speaker-selects-
    // next figure only because the SILENCE cases above (narration, room question)
    // are checked FIRST - the base rate is deliberately higher here.
    //
    // The variation that matters in a dyad is not WHETHER she engages but WHICH
    // SHAPE it takes, so this still has three outcomes rather than one.
    return 'speak';
}

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
 * @param {boolean} [ctx.addressed_physically] a nearby player is close AND
 *        looking towards her - the physical form of addressing someone
 * @returns {{reply: boolean, why: string}}
 */
export function shouldReplyTo(ctx) {
    const msg = String(ctx?.message ?? '').trim();
    if (!msg) return { reply: false, why: 'empty' };

    // Callers pass the count because they already have the entity list;
    // recomputing it here would duplicate the 26.3 stale-tablist handling.
    // let, not const: a real sender with nobody else nearby is coerced to a dyad
    // of one below. `const` here was a runtime TypeError, and a parse check
    // cannot see that class of bug.
    let humans = Math.max(0, Number(ctx?.visible_humans) || 0);

    // She is at the toilet / dinner / watching youtube. A person who has left
    // the computer does not answer, and that is the single most human thing a
    // bot can do - see utils/life_state.js.
    if (ctx?.present === false) return { reply: false, why: 'not_at_computer' };

    // A message cannot be for her when nobody is here to have sent it. Without
    // this, 0 fell through to the dyad branch below and she replied into an
    // empty server.
    //
    // But "nobody is here" is a statement about the ROOM, and it must not
    // override the fact that somebody just spoke. A real sender is a human
    // present, by definition - the live bug was a player messaging her from
    // across the map (>16 blocks) and getting silence, because proximity was
    // treated as evidence that no one had sent anything. Only synthetic turns
    // (a system or self prompt) can be nobody-here.
    if (humans === 0 && !ctx?.has_real_sender) return { reply: false, why: 'nobody_here' };
    // A real sender and nobody else nearby IS a dyad of one, not a group. Without
    // this, an unaddressed message from the only player on the server fell to the
    // GROUP branch and came back as group_not_addressed - a different bug from the
    // same root cause (treating the proximity count as the whole story).
    if (humans === 0 && ctx?.has_real_sender) humans = 1;

    if (ctx?.addressed) {
        return { reply: true, why: humans === 1 ? 'addressed_in_dyad' : 'addressed_by_name' };
    }
    if (ctx?.human_exchange && humans > 1) {
        return { reply: false, why: 'others_mid_conversation' };
    }

    // PHYSICAL ADDRESS, which the owner asked for alongside text address:
    // "unless addresses i mean physically or by text". Being stood right in
    // front of her and looking at her is a person addressing her, and it is the
    // physical version of somebody typing her name.
    //
    // The window is deliberately small. Minecraft players collide constantly and
    // most of it means nothing - walking past someone on a corridor is not being
    // spoken to. So this only counts when they are genuinely close AND oriented
    // towards her, which is the pair of cues a real person uses to decide
    // whether someone is trying to talk to them.
    if (humans > 1 && !ctx?.addressed && ctx?.addressed_physically) {
        return { reply: true, why: 'addressed_in_person' };
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
    //
    // "reply: true" does NOT mean "write a sentence back". It means she engages
    // with the channel at all, and HOW is a separate decision: most of what he
    // says deserves a noise, not an answer. The owner: "ppl talk to the server,
    // she doesnt care, no response whatsoever from her, but smn says something
    // funny so she just reacts with lets say xD".
    //
    // So a dyad reply carries a MODE. Silently ignoring most of what he says is
    // correct, and reacting to the funny parts is correct, and neither of those
    // is a conversation she is holding.
    if (humans === 1) {
        if (ABSENT_SIGNAL.test(msg)) return { reply: false, mode: 'ignore', why: 'he_is_leaving' };
        if (CASUAL_NOISE.test(msg)) return { reply: true, mode: 'react', why: 'dyad_short_reply' };
        // In a dyad an ack is said TO her, so it is not silence - but it is not a
        // sentence either. `react` is the right shape (the xD case). Routing it
        // through the picker's speak default instead left "yeah" and "sure"
        // narrated-ignored while "damn" and "no" spoke: the same speech act with
        // opposite outcomes, decided by which list the word matched.
        if (ACK_NO_TARGET.test(msg)) return { reply: true, mode: 'react', why: 'dyad_ack_to_her' };
        // ACK_NO_TARGET IS NOT APPLIED AS SILENCE IN A DYAD. Its premise - "an
        // acknowledgement is not a thing you say TO someone" - holds in a GROUP,
        // where "ok" goes to whoever spoke and may not be aimed at her. In a
        // dyad there is one other person, so "ok", "yeah", "sure" and "right"
        // are said to her by default.
        //
        // It was also producing an absurdity: "damn", "no" and "yes" got a reply
        // while "yeah" and "sure" got silence, decided purely by which list the
        // word matched. Same speech act, opposite outcome.
        //
        // The gate stays for GROUPS, where the reasoning actually applies.
        // ctx is passed so `addressed` / `addressed_physically` reach the mode
        // picker. Without it the picker could only see the text, which is how an
        // explicitly addressed message could still come out as a non-answer.
        return { reply: true, mode: pickDyadMode(msg, ctx), why: 'dyad_default_open' };
    }

    // GROUP — answer only what plainly needs her.
    //
    // ACK_NO_TARGET belongs HERE, not in the dyad branch above. Its premise - an
    // acknowledgement is not a thing you say TO someone - is a GROUP observation:
    // with several people present, "ok" goes to whoever spoke and may not be aimed
    // at her at all. In a one-to-one there is nobody else it could be aimed at.
    if (ACK_NO_TARGET.test(msg)) return { reply: false, why: 'group_ack_to_nobody' };
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