// "she should be able to understand if someone talks to her"
//
//   "maybe server has 5 ppl but noone talks except her and someone else"
//   "maybe someone just stares to her"
//   "or fucks her up she responds"
//
// Headcount is the wrong variable, and the live bug was that headcount was the
// ONLY variable: five players online made an ordinary line look like group
// chatter and she stayed silent, when in fact one person was talking to her.
//
// This is selective participation. Duplex-MPE (arXiv 2609.31948) tests
// selective participation in 3-4 party chat precisely because getting this wrong
// is the failure mode; Clark's common-ground model (1996) is the classic
// statement that participation is about common ground, not volume.
//
// NO PHRASE TABLES. Nothing here matches wording - that was the defect fixed in
// the dyad case, where matching "can you"/"help me" stood in for a judgement. Every
// input here is a RELATIONSHIP: is he looking at her, did he just hit her, is
// anyone else talking.

import { assessEngagement, applyEngagement, ENGAGEMENT } from '../src/utils/engagement.js';
import { shouldReplyTo } from '../src/utils/reply_trigger.js';
import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the headline case: 5 players, 1 talking to her = a dyad ─────────────
{
    const five = assessEngagement({ visible_humans: 5, speaker_targeted_her: true });
    check(five.with_her, 'five players online but one is talking to her -> with_her',
        `5 players + addressed gave ${five.engagement}`);
    check(five.dyad_like, 'and it counts as a two-person situation', 'it did not collapse to a dyad');

    // same room, nobody engaging her
    const busy = assessEngagement({ visible_humans: 5 });
    check(!busy.with_her && !busy.dyad_like, 'five players, none engaging her -> not with_her',
        `5 idle players gave ${busy.engagement}`);

    // and the routing actually differs for identical text
    const msg = 'im going to the mines';
    const withHer = shouldReplyTo({ message: msg, visible_humans: 1, has_real_sender: true });
    const inBusyRoom = shouldReplyTo({ message: msg, visible_humans: 5, has_real_sender: true });
    check(withHer.mode === 'ignore' && !inBusyRoom.reply,
        'the same narration is silent either way, but the room case is silent for a different reason',
        `dyad=${withHer.mode} room=${inBusyRoom.why}`);
}

// ── "someone just stares to her" ────────────────────────────────────────
{
    const stared = assessEngagement({ visible_humans: 4, someone_addressing: true });
    check(stared.engagement === ENGAGEMENT.STARING,
        'being looked at in a 4-player room registers as staring', `got ${stared.engagement}`);
    check(!stared.with_her, 'staring is NOT the same as being spoken to',
        'staring was treated as engagement');
    check(!stared.dyad_like, 'staring is not a dyad - nothing has been said',
        'staring was treated as a dyad');

    // she may open ONCE, and only through the gate
    const opened = applyEngagement({ visible_humans: 4, may_start: true }, null);
    check(opened.reply && opened.why === 'someone_is_looking_at_me',
        'with may_start she opens the conversation', `got ${JSON.stringify(opened)}`);
    const held = applyEngagement({ visible_humans: 4, may_start: false }, null);
    check(!held.reply, 'and she says nothing when the gate says no',
        `the gate was ignored: ${JSON.stringify(held)}`);

    // the gate is a probability, not a timer - she must not open every time
    check(!/setInterval|setTimeout/.test(readFileSync('src/utils/engagement.js', 'utf8')),
        'no timer drives the staring case', 'a timer drives engagement');
}

// ── "or fucks her up she responds" ──────────────────────────────────────
{
    const griefed = assessEngagement({ visible_humans: 5, bothered_recently: true });
    check(griefed.with_her, 'being hit counts as interaction, even with 5 online',
        `damage in a crowd gave ${griefed.engagement}`);
    check(griefed.dyad_like, 'and collapses the room to a dyad', 'damage did not collapse the room');

    // being hit is engagement even when he is NOT looking at her
    const hitNotLooking = assessEngagement({ visible_humans: 3, bothered_recently: true, someone_addressing: false });
    check(hitNotLooking.with_her, 'damage counts without eye contact', 'damage needed eye contact');

    // and the reply is allowed through even if the text looks like room chatter
    const v = applyEngagement(
        { visible_humans: 5, has_real_sender: true, bothered_recently: true },
        { reply: false, why: 'group_not_addressed' },
    );
    check(!v.reply, 'damage alone does not force a reply to unrelated text',
        `damage forced a reply: ${JSON.stringify(v)}`);
    const addressedHit = applyEngagement(
        { visible_humans: 5, has_real_sender: true, bothered_recently: true, addressed: true },
        { reply: false, why: 'group_not_addressed' },
    );
    check(addressedHit.reply && addressedHit.why === 'with_her+addressed',
        'but addressed-while-being-hit does get through', `got ${JSON.stringify(addressedHit)}`);
}

// ── proximity alone must never manufacture engagement ───────────────────
{
    // Someone standing nearby is not an invitation to talk. This is the bias that
    // matters: the failure being fixed is a bot that talks when nobody addressed
    // her, so every default must resolve to silence.
    const nearby = applyEngagement({ visible_humans: 2, has_real_sender: true }, { reply: false, why: 'group_not_addressed' });
    check(!nearby.reply, 'people merely being present does not open her up',
        `proximity forced a reply: ${JSON.stringify(nearby)}`);

    // a missing reading must default to silence, never to engagement
    const empty = assessEngagement({});
    check(!empty.with_her && empty.engagement === ENGAGEMENT.NONE,
        'no data at all reads as nobody', `no data gave ${empty.engagement}`);
    const onlyCount = assessEngagement({ visible_humans: 4 });
    check(!onlyCount.with_her, 'a headcount alone never means engagement',
        'headcount alone implied engagement');
}

// ── with_her rescues a message the room would have dropped ──────────────
{
    const textOnly = shouldReplyTo({ message: 'ur so bad at this', visible_humans: 5, has_real_sender: true });
    check(!textOnly.reply, 'in a 5-player room that line is dropped on text alone', 'unexpected');
    const rescued = applyEngagement(
        { visible_humans: 5, has_real_sender: true, addressed_physically: true },
        textOnly,
    );
    check(rescued.reply, 'but someone is facing her, so she answers', `still dropped: ${JSON.stringify(rescued)}`);
}

// ── nobody_here is still about the ROOM, not authorship ─────────────────
{
    const empty = applyEngagement({ visible_humans: 0 }, null);
    check(!empty.reply && empty.why === 'nobody_here', 'an empty room is nobody_here',
        `got ${JSON.stringify(empty)}`);
    const viaSender = applyEngagement({ visible_humans: 0, has_real_sender: true }, null);
    check(!viaSender.reply, 'a real sender with nobody visible is not rescued by this layer',
        `a distant sender was rescued here: ${JSON.stringify(viaSender)}`);
    // authorship is handled upstream in shouldReplyTo - assert we did not shadow it
    const up = shouldReplyTo({ message: 'uwu', visible_humans: 0, has_real_sender: true });
    check(up.reply, 'shouldReplyTo still honours a real distant sender', `upstream dropped it: ${up.why}`);
}

// ── no phrase tables crept in ───────────────────────────────────────────
{
    const src = readFileSync('src/utils/engagement.js', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    // no alternation of chat phrases; only identifiers and comparisons
    check(!/'(can you|help me|come here|hey|yo|gm|brb)'/i.test(src),
        'no chat phrase list in engagement.js',
        'a chat phrase list crept into engagement.js');
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    check(/assessEngagement/.test(agent), 'the agent computes engagement', 'engagement is dead code');
    check(/applyEngagement/.test(agent), 'and applies it', 'applyEngagement is never called');
    // the override must actually be consumed, not computed and dropped
    const n = (agent.match(/_final\./g) || []).length;
    check(n >= 4, `_final is read ${n} times, so the room verdict decides`, `only ${n} reads of _final`);
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} engagement assertions green`);