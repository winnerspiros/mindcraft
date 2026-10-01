// Reply trigger: is this message even for her?
//
// Owner's requirement: "right now im just me and her so most probably if i send
// anything in chat it probably is for her. same for her, she can start a
// conversation, no forced. if many ppl are on server they might talk to
// themselves so no need to interfere."
//
// So: group size is the governing variable. In a dyad almost everything is for
// her. In a group, the default flips - unaddressed messages are most likely
// between other people, and answering is intrusion.
//
// Silence has to be a real outcome here, or the whole thing is decoration.
// Measured on this server: 3 of 33 bare greetings got no reply, and that is
// normal behaviour rather than rudeness.

import { shouldReplyTo, shouldStartConversation } from '../src/utils/reply_trigger.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── DYAD: him and her alone. Almost everything is for her. ───────────────
{
    const dyad = { visible_humans: 1, addressed: false, human_exchange: false };
    for (const m of ['im coming', 'wait what', 'the roof is broken', 'im at the base',
        'kys', 'ok', 'look at this seed farm', 'sup']) {
        check(shouldReplyTo({ ...dyad, message: m }).reply,
            `dyad: replies to ${JSON.stringify(m)}`,
            `dyad: ignored ${JSON.stringify(m)} - he is talking to nobody else`);
    }
}
// Being named in a dyad, obviously.
check(shouldReplyTo({ visible_humans: 1, addressed: true, human_exchange: false, message: 'hey uwu' }).why === 'addressed_in_dyad',
    'dyad: naming her is the strongest cue', 'dyad: wrong reason');

// ── GROUP: 3+ humans, message not addressed. Stay out. ───────────────────
{
    const grp = { visible_humans: 3, addressed: false, human_exchange: false };
    for (const m of ['im coming', 'wait what', 'look at this seed farm', 'sup',
        'has anyone seen the ender chest', 'i found a dungeon']) {
        check(!shouldReplyTo({ ...grp, message: m }).reply,
            `group: does not butt into ${JSON.stringify(m)}`,
            `group: intruded on ${JSON.stringify(m)}`);
    }
}
// ...unless it plainly needs her.
{
    const grp = { visible_humans: 3, addressed: false, human_exchange: false };
    // Note the question marks. My first version of this list had
    // "where did you put the wood" with no "?", so the function was right to
    // ignore it and the test was asserting on my own typo. 19% of real player
    // lines in this corpus end in "?", which is the signal DIRECT_NEED uses.
    for (const m of ['uwu can you help', 'who has spare stone?', 'im stuck in a hole',
        'anyone got a bow?', 'where did you put the wood?']) {
        check(shouldReplyTo({ ...grp, message: m }).reply,
            `group: answers a genuine request ${JSON.stringify(m)}`,
            `group: stayed silent on a real request ${JSON.stringify(m)}`);
    }
}
// Naming her beats the group rule.
check(shouldReplyTo({ visible_humans: 4, addressed: true, human_exchange: false, message: 'uwu what do you think' }).reply,
    'group: answers when named', 'group: ignored being named');

// ── two humans mid-conversation: never intrude, even unaddressed ─────────
{
    const ex = { visible_humans: 3, addressed: false, human_exchange: true };
    for (const m of ['im coming', 'who has spare stone']) {
        check(!shouldReplyTo({ ...ex, message: m }).reply,
            `mid-exchange: stays out of ${JSON.stringify(m)}`, 'mid-exchange: intruded');
    }
    // Being called by name mid-argument still gets answered by real people. My
    // first version passed addressed:false for a message that literally starts
    // with her name, so the function was right and the test was wrong.
    check(shouldReplyTo({ ...ex, addressed: true, message: 'uwu can you help' }).reply,
        'mid-exchange: still answers when named', 'mid-exchange: ignored a direct call');
}
// In a dyad, "human_exchange" cannot be true (nobody else to trade with) - make
// sure a stale flag does not silence her.
check(shouldReplyTo({ visible_humans: 1, addressed: false, human_exchange: true, message: 'im coming' }).reply,
    'dyad: a stale exchange flag does not mute her', 'dyad: stale flag silenced her');

// ── low-content noise in a group is not an invitation ───────────────────
for (const m of ['lol', 'lmao', 'gg', 'brb', 'ok', 'nice one', 'haha']) {
    check(!shouldReplyTo({ visible_humans: 3, addressed: false, human_exchange: false, message: m }).reply,
        `group: ignores noise ${JSON.stringify(m)}`, `group: replied to noise ${JSON.stringify(m)}`);
}

// ── alone: nothing to reply to ───────────────────────────────────────────
{
    const v = shouldReplyTo({ visible_humans: 0, addressed: false, human_exchange: false, message: 'im coming' });
    check(!v.reply, 'nobody here: no reply to broadcast', 'she replied into an empty server');
}
check(!shouldReplyTo({ message: '' }).reply, 'empty message: no reply', 'empty message got a reply');

// ── she may start a conversation, but not forced ────────────────────────
{
    // Deterministic: rand() below the rate starts it, above does not.
    const dyadYes = shouldStartConversation({ visible_humans: 1 }, () => 0.0);
    const dyadNo = shouldStartConversation({ visible_humans: 1 }, () => 0.99);
    check(dyadYes.start, 'dyad: she can start a conversation', 'dyad: she can never start one');
    check(!dyadNo.start, 'dyad: not every eligible turn starts one', 'she starts one every turn');
    const grpYes = shouldStartConversation({ visible_humans: 3 }, () => 0.0);
    check(grpYes.start, 'group: she can start one too', 'group: she can never start one');

    // Never when interrupting, never when alone, never right after speaking.
    check(!shouldStartConversation({ visible_humans: 3, human_exchange: true }, () => 0).start,
        'group: never interrupts an active exchange', 'she interrupts people');
    check(!shouldStartConversation({ visible_humans: 0 }, () => 0).start,
        'never starts a conversation with nobody there', 'she talks to an empty server');
    check(!shouldStartConversation({ visible_humans: 1, spoke_recently: true }, () => 0).start,
        'does not pile on right after speaking', 'she spoke twice in a row');

    // Rate must be rare in a group - a bot that chats constantly is a bot.
    let starts = 0;
    for (let i = 0; i < 1000; i++) if (shouldStartConversation({ visible_humans: 3 }).start) starts++;
    check(starts > 20 && starts < 200,
        `group initiative fires ~${starts}/1000 eligible turns`, `group initiative rate is ${starts}/1000`);
    let dyadStarts = 0;
    for (let i = 0; i < 1000; i++) if (shouldStartConversation({ visible_humans: 1 }).start) dyadStarts++;
    check(dyadStarts > starts, 'she is chattier alone than in a group',
        'no difference between dyad and group initiative');
}

// ── it is wired where it can actually gate something ────────────────────
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/agent/agent.js', 'utf8');
    check(/shouldReplyTo/.test(src), 'agent.js consults shouldReplyTo', 'the trigger is dead code');
    check(src.indexOf('shouldReplyTo') < src.indexOf('turn_taker.score'),
        'the trigger runs BEFORE the turn-taker (no model call either way)',
        'the turn-taker runs first, so a model call is made before deciding');
    check(/_visibleHumanCount/.test(src), 'visible humans are counted', 'no human count');
    check(/not addressed to you; you heard it/.test(src),
        'an ignored message is still remembered so she can refer to it later',
        'ignored messages vanish, so she cannot recall them');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} reply-trigger assertions green`);