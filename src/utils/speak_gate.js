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
    if (ctx.self_prompt && !ctx.human_replied) {
        return { ok: false, why: 'unprompted_self_narration' };
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
    if (/\b(anyone (want|got|here)|is anyone (there|online))\b/i.test(msg)) {
        return { ok: false, why: 'hollow_audience_check' };
    }

    return { ok: true, why: 'ok' };
}
