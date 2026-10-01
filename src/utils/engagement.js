// "she should be able to understand if someone talks to her"
//
// The owner's framing is a GROUP case and it is a different judgement from the
// dyad one: the server may hold five players, but headcount is not the number
// that matters. What matters is how many are actually interacting WITH HER.
//
//   "maybe server has 5 ppl but noone talks except her and someone else"
//   "maybe someone just stares to her"
//   "or fucks her up she responds"
//
// So five players online, four of them building a wall in silence, and one
// looking at her, is a DYAD. Treating it as a group is what makes a bot feel
// absent. Conversely five people all talking to each other and none to her is a
// group she should stay out of, however many are online.
//
// This is selective participation, not headcount. The multiparty literature is
// explicit that addressee inference is a distinct problem from "did someone
// speak" - Duplex-MPE (arXiv 2609.31948) tests selective participation in 3-4
// party chat precisely because getting this wrong is the failure mode. Clark's
// common-ground model (1996, "Using GPRs to determine who is talking to whom")
// is the classic statement: participation is about common ground, not volume.
//
// Design constraint, carried from the dyad fix: NO phrase tables. Nothing here
// matches wording. Every input is a RELATIONSHIP between her and another player -
// is he looking at her, has he just acted on her, is he the only one talking,
// how long has it been.

// ── INTERACTION IS A RELATION, NOT A CONVERSATION ─────────────────────
//
// The owner: "interactions can be to help player also, fuck them up, grief them,
// give them items, help them build, destroy what they doing. whatever.. all these
// are interactions"
//
// This is a correction, and an important one. I had reduced interaction to
// TALKING. That is too narrow, and it made "she is self-centered" collapse into
// "she ignores people" - when the owner means "she has her own agenda, and that
// agenda may well involve them".
//
// A player building a wall while another player mines the same block is
// INTERACTING, adversely. Griefing is engagement. Handing someone an item is
// engagement. Knocking their scaffolding down is engagement. None of those need a
// word to be said, and none of them are "not talking to her".
//
// So the signal is a RELATION between them, with a VALENCE. Valence changes HOW
// she responds, never WHETHER she registers it: being sabotaged is at least as
// involving as being helped, and treating it as less would make her oblivious to
// the thing that should annoy her most.

/** How a player is involving himself with her and her work. */
export const INTERACTION = {
    NONE: 'none',
    /** talking to her, or acting on her directly */
    DIRECT: 'direct',
    /** working the same thing she is - shared building, shared digging */
    COORDINATING: 'coordinating',
    /** griefing, breaking, interfering - negative, and very much engaged */
    INTERFERING: 'interfering',
    /** giving, helping, handing over - positive */
    HELPING: 'helping',
};

// Valence only shapes the RESPONSE. Interference is negative and help is
// positive, but both count as engagement, and neither is worth more attention
// than the other purely because of its sign: a player reacting to sabotage is not
// less engaged than one reacting to a gift.
const INTERACTION_VALENCE = {
    [INTERACTION.NONE]: 0,
    [INTERACTION.DIRECT]: 0,
    [INTERACTION.COORDINATING]: 1,
    [INTERACTION.INTERFERING]: -1,
    [INTERACTION.HELPING]: 1,
};

/** How a player is engaging with her. Not what they said. */
export const ENGAGEMENT = {
    /** Nobody is engaging her. Headcount may still be high. */
    NONE: 'none',
    /** Someone near is looking towards her and holding there. */
    STARING: 'staring',
    /** Someone did something to her - hit her, griefed her, moved her. */
    BOTHERED: 'bothered',
    /** Exactly one other person is talking, and it is not to her. Still a dyad. */
    ONE_OTHER_TALKING: 'one_other_talking',
    /** Two or more people are in conversation with each other. She is outside it. */
    OTHERS_TALKING: 'others_talking',
    /** Someone is talking to her, or acting on her. */
    WITH_HER: 'with_her',
};

/**
 * Build the engagement picture from world state.
 *
 * Every field is optional and every default is SILENCE. That bias is deliberate:
 * a missing reading must never manufacture engagement, because the failure mode
 * we are fixing is a bot that talks when nobody addressed her.
 *
 * @param {object} w
 * @param {number} [w.visible_humans]     humans in the room, excluding her
 * @param {boolean} [w.someone_addressing] a player is close AND facing her
 * @param {boolean} [w.bothered_recently] someone acted on her recently
 * @param {boolean} [w.speaker_addressing] THE SPEAKER is close and facing her
 * @param {string}  [w.last_speaker]       who spoke immediately before
 * @param {boolean} [w.same_speaker_as_last] the current speaker is the last speaker
 * @param {boolean} [w.speaker_targeted_her] the last message named her
 * @param {number}  [w.others_in_conversation] other humans talking among themselves
 * @returns {{engagement: string, dyad_like: boolean, with_her: boolean}}
 */
export function assessEngagement(w = {}) {
    const humans = Math.max(0, Number(w.visible_humans) || 0);

    // ── RANKED, NOT OR-ed ───────────────────────────────────────────────
    // These are not the same strength of signal and must not be flattened into
    // one. My first version OR-ed them, which made STARING unreachable: anyone
    // looking at her reported WITH_HER, i.e. already engaged. But looking and
    // speaking are different situations:
    //
    //   someone TALKING to her  -> an exchange is happening, she replies
    //   someone LOOKING at her  -> no exchange yet, she may OPEN
    //
    // Ranked strongest first, so the strongest available signal wins.

    // 1. Speaking to her - named, or the speaker is facing her. This is an
    //    exchange in progress and the strongest possible evidence.
    if (w.speaker_targeted_her || w.speaker_addressing) {
        return { engagement: ENGAGEMENT.WITH_HER, dyad_like: true, with_her: true };
    }

    // 1b. PHYSICAL INTERACTION - griefing, helping, sharing the same work. The
    //     owner: "interactions can be to help player also, fuck them up, grief
    //     them, give them items, help them build, destroy what they doing.
    //     whatever.. all these are interactions"
    //
    //     These need no words, so the message router cannot see them at all. Rank
    //     below being SPOKEN to - being talked to is unambiguous, whereas blocks
    //     moving near her could be anything - but well above merely being nearby,
    //     because someone dismantling her wall is not a bystander.
    if (w.interfering) {
        return { engagement: ENGAGEMENT.WITH_HER, dyad_like: true, with_her: true, interaction: INTERACTION.INTERFERING, valence: -1 };
    }
    if (w.helping) {
        return { engagement: ENGAGEMENT.WITH_HER, dyad_like: true, with_her: true, interaction: INTERACTION.HELPING, valence: 1 };
    }
    if (w.coordinating) {
        return { engagement: ENGAGEMENT.WITH_HER, dyad_like: true, with_her: true, interaction: INTERACTION.COORDINATING, valence: 1 };
    }

    // 2. Griefed recently, by someone who has not addressed her. Interaction -
    //    the owner's "or fucks her up she responds" - but not a conversation, so
    //    it opens her up without pretending an exchange exists.
    if (w.bothered_recently) {
        return { engagement: ENGAGEMENT.BOTHERED, dyad_like: true, with_her: true };
    }

    // 3. Somebody near is oriented at her and holding. The weakest signal, and
    //    deliberately NOT with_her: she may consider speaking, but nothing has
    //    been said to her yet.
    if (w.someone_addressing) {
        return { engagement: ENGAGEMENT.STARING, dyad_like: false, with_her: false };
    }

    // Somebody staring at her is not nothing. It is the weakest form of "this
    // interaction has a participant", and a real player notices and responds -
    // "can i help you" or just a look back. The owner's example, taken seriously.
    if (humans >= 1) {
        return {
            engagement: ENGAGEMENT.STARING,
            // NOT dyad_like: he has not said anything, so there is no exchange to
            // be half of. But he is present and oriented at her, which is more
            // than a room full of people building a wall.
            dyad_like: false,
            with_her: false,
        };
    }

    // Nobody interacting with her. The question is whether the room is busy with
    // EACH OTHER, which is what makes silence correct.
    if (humans > 1) {
        return {
            engagement: ENGAGEMENT.OTHERS_TALKING,
            dyad_like: false,
            with_her: false,
        };
    }

    return { engagement: ENGAGEMENT.NONE, dyad_like: false, with_her: false };
}

/**
 * Combine world engagement with the text-only routing decision.
 *
 * Separated from shouldReplyTo on purpose. That function judges a MESSAGE
 * ("is this line for me"); this judges a ROOM ("is anyone here with me"). The
 * live bug was that the room judgement was missing entirely, so five players
 * online made every ordinary line look like group chatter.
 *
 * @param {object} ctx  the same ctx shouldReplyTo receives, plus engagement fields
 * @param {object} [textVerdict] the result of shouldReplyTo, if already computed
 * @returns {{reply: boolean, mode?: string, why: string}}
 */
export function applyEngagement(ctx = {}, textVerdict = null) {
    const e = assessEngagement(ctx);
    const humans = Math.max(0, Number(ctx.visible_humans) || 0);

    // No humans at all: nothing to say to. (A real sender overrides this upstream,
    // in shouldReplyTo - proximity is a room fact, not evidence about authorship.)
    if (humans === 0 && !ctx.has_real_sender) {
        return { reply: false, why: 'nobody_here' };
    }

    // Someone is engaging her. Then group size does not get a vote: the owner is
    // explicit that one person talking to her among five makes it a two-person
    // conversation. Fall through to the text verdict, which decides the SHAPE.
    if (e.with_her) {
        if (textVerdict?.reply) return { ...textVerdict, why: `${textVerdict.why}+with_her` };
        // The text looked like group chatter, but the world says otherwise. A
        // named or physically-addressed line is answered; anything else is not
        // rescued by proximity alone, because someone merely standing nearby is
        // not an invitation to talk.
        //
        // addressed_physically is the "close AND facing her" reading and it WAS
        // being passed in by the caller but never read here, so a
        // physically-addressed line in a busy room stayed dropped. That is the
        // owner's staring case arriving as actual speech.
        if (ctx.addressed || ctx.addressed_physically || ctx.speaker_targeted_her) {
            return { reply: true, mode: 'speak', why: 'with_her+addressed' };
        }
        return { reply: false, why: 'with_her_but_unaddressed' };
    }

    // Someone is facing her but has not addressed her, and the text was dropped.
    // Physical addressing alone is enough to answer: he is standing there looking
    // at her, so a line dropped as room chatter is being cast at her.
    if (!textVerdict?.reply && ctx.addressed_physically) {
        return { reply: true, mode: 'speak', why: 'facing_me_in_a_busy_room' };
    }

    // Being looked at by someone who has not spoken: she may open, once. Not a
    // reply to anything - she is starting, which is a different act.
    if (e.engagement === ENGAGEMENT.STARING && ctx.may_start) {
        return { reply: true, mode: 'speak', why: 'someone_is_looking_at_me' };
    }

    // Otherwise the text verdict stands. In a busy room that means staying out.
    return textVerdict ?? { reply: false, why: 'no_verdict' };
}

export { assessEngagement as default };
