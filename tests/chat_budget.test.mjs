// She talks too much and writes too long. Both measured, both pinned here.
//
// The owner: "i see an 'issue' isually ppl dont spam chat as muxh as i see her
// and ppl shorten words. who likes to type paraphs noone."
//
// Measured on 21,822 real player messages (Minecraft Dialogue Corpus, ACL 2019):
//   p50 5 | p75 10 | p90 16 | p95 30 | p99 70 words
//   2+ sentences: 0.12%   |  20+ words: 9.4%  |  40+ words: 3.7%
//   15.07% of turns are the 3rd+ consecutive message from one speaker
//   the chattiest person averages 60% of a conversation

import { ChatBudget, MAX_CONSECUTIVE, MIN_GAP_MS, MAX_MESSAGES_PER_WINDOW, RUN_EXPIRES_MS, SHARE_CEILING } from '../src/utils/chat_budget.js';
import { checkLength, countSentences, P50, P90, HARD_WORD_LIMIT, SOFT_WORD_LIMIT } from '../src/utils/length_rule.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── LENGTH: the shape of a real message ────────────────────────────────
{
    // the median real message must sail through, unremarkably
    for (const m of ['yeah', 'im coming', 'wait what', 'give me a sec', 'lmao same',
        'im at the mine rn', 'k', 'ok yeah', 'do you have spare stone', 'not again']) {
        const v = checkLength(m);
        check(v.ok, `typical message allowed: ${JSON.stringify(m)} (${v.words}w, ${v.sentences}s)`,
            `blocked a normal message: ${JSON.stringify(m)}`);
    }
}
{
    // paragraphs are the actual complaint. 0.12% of real messages have 2 sentences.
    for (const m of [
        'Ok so I was thinking that we should probably go to the mines later today because we need more iron for the build that we were talking about earlier and also I need to fix my roof',
        'I mean honestly its fine. I just think it would be faster if you did it that way instead. Whatever though, you decide.',
        'yeah i know. thats the thing. its always that thing. every single time its that thing and i am so tired of it.',
    ]) {
        const v = checkLength(m);
        check(!v.ok, `paragraph caught: ${v.words}w/${v.sentences}s`, `missed a paragraph: ${JSON.stringify(m.slice(0, 40))}`);
    }
}
{
    // sentence counting must not be fooled by abbreviations / no terminators
    check(countSentences('im going to the mines rn') === 1, 'no terminator = one sentence', 'split on nothing');
    check(countSentences('wait what') === 1, '"wait what" is one sentence', 'counted wrong');
    check(countSentences('ok. fine. do it') === 2, 'two terminators = two sentences', 'undercounted');
    check(countSentences('its fine, im coming') === 1, 'comma is not a sentence break', 'split on a comma');
    // p99 is 70 words, so long messages EXIST - but she is one of 2-3 players
    // and p90 is 16. A 20-word message is the tail; a 30+ word one is a wall of
    // text with no stop in it, which is the complaint either way.
    const tail = 'im going to go down to the mines and get some iron and then come back up';
    check(checkLength(tail).ok, 'a 16-word message is normal', 'blocked a normal-length message');
    // 26 words, not 25 - my first string landed exactly on the limit and
    // `words > 25` correctly allowed it. The rule was right, the test was one
    // word short.
    const wall = 'im going to go down to the mines and get some iron and then come back up and fix the roof because it started raining again today';
    check(!checkLength(wall).ok, `a ${wall.split(/\s+/).length}-word run-on with no stop in it is a wall of text`,
        'allowed a run-on wall of text');
    // commands and actions are not prose
    check(checkLength('*UwU digs dirt*').ok, 'action messages are exempt', 'action message blocked');
}

// ── the limit IS the acceptance rate ───────────────────────────────────
//
// Measured acceptance on 21,822 real player messages:
//   5w -> 54.3% | 8w -> 69.4% | 10w -> 79.7% | 12w -> 83.6% | 16w -> 90.0%
//   20w -> 93.0% | 25w -> 94.3% (the old value) | 30w -> 95.8%
//
// 25 let 94% of real messages through, which permits her to be LONGER than an
// average player while still feeling long. She is 1 of 2-3 people in a channel,
// so her share of the tail should be smaller than a solo player's.
{
    // the limit stays at 25, and the reason it is NOT lower is recorded
    const fs2 = await import('node:fs');
    const src = fs2.readFileSync('src/utils/length_rule.js', 'utf8');
    check(/0% of them contain a second sentence|ordinary build instructions/i.test(src),
        'the source records WHY the word limit is not lower',
        'the word limit has no recorded justification');
    check(/0\.12%/.test(src), 'the paragraph basis is cited', 'the paragraph basis is missing');
    // and the ordinary must all survive - a limit that drops real messages is wrong
    for (const m of ['im coming', 'ok', 'yeah', 'brb', 'wait what', 'do you have stone',
        'you are so bad at this', 'again?? these phantoms are relentless, wtf!',
        'can you help me with this farm real quick', 'not again bruh']) {
        check(checkLength(m).ok, `real message survives: ${JSON.stringify(m)}`,
            `dropped a real message: ${JSON.stringify(m)}`);
    }
    // the paragraph tail is cut
    for (const m of ['Ok so I was thinking that we should probably go to the mines later today because we need more iron for the build that we were talking about earlier and also I need to fix my roof',
        'im going to go down to the mines and get some iron and then come back up and fix the roof because it started raining again today']) {
        check(!checkLength(m).ok, 'the tail is cut', `a ${checkLength(m).words}-word message survived`);
    }
}

// ── A RUN EXPIRES ─────────────────────────────────────────────────────
// Live evidence: a wall of "[gate:too_many_in_a_row] not generating" with the solo
// cadence running every 7-94s and ZERO commands executed. `consecutive` only went up
// (delivered) or reset when a human spoke (humanSpoke), so a bot on her own hit 2
// within a minute and was then muted permanently. She was locked out of speaking,
// not choosing silence.
{
    const b2 = new ChatBudget();
    const t = 1_000_000;
    b2.delivered(t); b2.delivered(t + 1000);
    const blocked = b2.canSpeak({ now: t + 2000, human_msgs_since_her_last: 0 });
    check(blocked.ok === false && blocked.why === 'too_many_in_a_row',
        'a back-to-back burst of 2 is still blocked', 'the burst cap no longer holds');
    check(b2.canSpeak({ now: t + 5000, human_msgs_since_her_last: 0 }).ok === false,
        'still blocked while the burst is fresh', 'the burst expired too early');

    // The live bug: she kept ATTEMPTING, so if the run is keyed to the last
    // attempt the quiet period never happens and she stays muted forever. Only the
    // room hearing nothing for long enough ends a run.
    //
    // These reservations are all BLOCKED attempts, inside the 90s window, so
    // blocking here is correct - and they must not push the expiry out.
    for (let k = 0; k < 3; k++) b2.reserve(t + 5000 + k * 1000);
    check(b2.canSpeak({ now: t + 20_000, human_msgs_since_her_last: 0 }).ok === false,
        'still blocked 20s in, and blocked attempts have not refreshed the run',
        'a blocked attempt refreshed the run - she can never go quiet');

    // Now ask PAST the window measured from the last delivery (t+1000).
    const after = b2.canSpeak({
        now: t + 1000 + RUN_EXPIRES_MS + 5000, human_msgs_since_her_last: 0,
    });
    check(after.ok === true,
        `she can speak again after ${Math.round(RUN_EXPIRES_MS / 1000)}s of quiet (got ${after.why})`,
        'she is still muted after a long silence - the counter is one-way');

    // ── DISCARDED DRAFTS DO NOT CONSUME HER VISIBLE BUDGET ──────────
    // Twelve attempts whose text was thrown away must not silence her for ten
    // minutes while the room saw nothing. Reserving still costs her - otherwise
    // she would compose forever - but the ceiling is measured on deliveries.
    {
        const b4 = new ChatBudget();
        const s = 9_000_000;
        for (let k = 0; k < 20; k++) b4.reserve(s + k * 1000);   // none delivered
        const v = b4.canSpeak({ now: s + 30_000, human_msgs_since_her_last: 3 });
        check(v.ok === true,
            `20 discarded drafts do not exhaust her window (got ${v.why})`,
            'discarded drafts exhaust the visible budget');
    }

    // and the monologue ceiling is a window, not a lifetime ban
    // 3 messages, then look PAST the 10-minute window: inside the window blocking
    // is correct, the point is that the ceiling does not last forever.
    const b3 = new ChatBudget();
    const u = 5_000_000;
    for (let k = 0; k < 3; k++) b3.delivered(u + k * 60_000);
    check(b3.canSpeak({ now: u + 4 * 60_000, human_msgs_since_her_last: 0 }).ok === false,
        'a 3-message monologue inside the window is still blocked',
        'the monologue ceiling does not hold inside the window');
    const past = b3.canSpeak({ now: u + 11 * 60_000, human_msgs_since_her_last: 0 });
    check(past.ok === true,
        `the monologue ceiling expires with the window (got ${past.why})`,
        'the monologue ceiling is a lifetime ban');
}

// ── and the numbers in the source are the measured ones ────────────────
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/utils/length_rule.js', 'utf8');
    check(new RegExp(`P50 = ${P50}`).test(src), `p50 pinned at ${P50}`, 'p50 not pinned to the measurement');
    check(new RegExp(`P90 = ${P90}`).test(src), `p90 pinned at ${P90}`, 'p90 not pinned');
    check(/0\.12%/.test(src), 'the 0.12% multi-sentence figure is cited', 'the paragraph evidence is missing');
}

// ── RATE: a budget, not a timer. Bursts stay possible. ─────────────────
{
    const b = new ChatBudget();
    // a burst of 2 in a row is normal and allowed (corpus runs are 2-4)
    let t = 100000;
    check(b.canSpeak({ now: t, human_msgs_since_her_last: 0 }).ok, 'first message allowed', 'blocked immediately');
    b.reserve(t); b.delivered(t);
    t += MIN_GAP_MS + 10;
    check(b.canSpeak({ now: t, human_msgs_since_her_last: 0 }).ok, 'a 2nd in a row is allowed', 'no bursts at all');
    b.reserve(t); b.delivered(t); b.note('yo', t);   // reserved, then actually sent
    t += MIN_GAP_MS + 10;
    check(!b.canSpeak({ now: t, human_msgs_since_her_last: 0 }).ok,
        'a 3rd in a row with nothing from a human is stopped', 'she monologues');
}
{
    // a human speaking resets the run
    const b = new ChatBudget();
    let t = 0;
    for (let i = 0; i < 4; i++) { b.reserve(t); b.delivered(t); t += MIN_GAP_MS + 10; }
    check(!b.canSpeak({ now: t, human_msgs_since_her_last: 0 }).ok, 'she is capped', 'not capped');
    b.humanSpoke();
    check(b.canSpeak({ now: t, human_msgs_since_her_last: 1 }).ok,
        'a human talking lets her back in', 'a human reply did not reset her');
}
{
    // too fast is too fast
    const b = new ChatBudget();
    b.reserve(50000); b.delivered(50000);   // note() only records text now; reserve() is the gate
    check(!b.canSpeak({ now: 50000 + 100, human_msgs_since_her_last: 1 }).ok,
        'cannot send twice in the same instant', 'no minimum gap');
}

// ── REGRESSION: fragments bypassed every gate (the real spam) ──────────
//
// fragmentForChat() splits a long message and the extra lines were sent with a
// direct this.bot.chat(rest[i]) - skipping the chat budget, checkLength, the
// speak gate, the dyad routing AND delivered(). One reply became three
// un-budgeted lines, so no rate limit could ever see them. That is the "more
// spammy like someone would" report, and tuning MAX_MESSAGES_PER_WINDOW would
// never have fixed it.
{
    const fs3 = await import('node:fs');
    const agent = fs3.readFileSync('src/agent/agent.js', 'utf8');
    const i = agent.indexOf('for (let i = 0; i < rest.length; i++)');
    check(i > 0, 'the fragment send loop exists', 'the fragment loop is gone');
    const loop = agent.slice(i, i + 1400);
    // every bot.chat in the loop must be preceded by accounting
    const chatAt = loop.indexOf('this.bot.chat(');
    const chargeAt = loop.indexOf('this._budget?.delivered()');
    check(chargeAt > 0 && chargeAt < chatAt,
        'each extra fragment is charged before it is sent',
        'a fragment is sent without being charged');
    const checkAt = loop.indexOf('checkLength');
    check(checkAt > 0 && checkAt < chatAt,
        'each extra fragment passes the length check',
        'a fragment is sent without a length check');
    check(/if \(!_extra\) continue;/.test(loop), 'empty fragments are skipped',
        'empty fragments are sent');
}

// ── and a paragraph is SPLIT, not dropped ──────────────────────────────
//
// The ordering bug: the length gate judged the whole message and dropped
// paragraphs, while fragmentation happened later in the send path. But a
// paragraph is exactly what a real player splits into 2-3 short lines - 0.12% of
// real messages have a second sentence, while 15% of turns are the 3rd+ message
// in a row from one speaker.
{
    const frag = await import('../src/utils/chat_fragment.js');
    // A paragraph with REAL clause boundaries does get split, and each line then
    // passes on its own - which is what a player does instead of one long line.
    // Sentence boundaries, not commas: the splitter deliberately never cuts a
    // comma-list in half, which would lose the structure of the thought.
    const splittable = 'i finished the roof. now im doing the walls. then the floor after that';
    const parts = frag.fragmentForChat(splittable);
    check(parts.length > 1, `a paragraph with clause boundaries splits into ${parts.length} lines`,
        'a splittable paragraph did not split');
    for (const p of parts) {
        check(checkLength(p).ok, `each line passes on its own: ${JSON.stringify(p.slice(0, 45))}`,
            `a split line would be dropped: ${JSON.stringify(p)}`);
    }
    // A single unsplittable run-on is NOT split - the splitter is clause
    // preserving and refusing to cut mid-thought is correct. That one is dropped,
    // and dropping it is right: it is the wall of text the owner dislikes.
    const wall = 'Ok so I was thinking that we should probably go to the mines later today because we need more iron for the build that we were talking about earlier and also I need to fix my roof';
    check(frag.fragmentForChat(wall).length === 1,
        'an unsplittable run-on is left whole rather than cut mid-thought',
        'the splitter cut a thought in half');
    check(!checkLength(wall).ok, 'and that wall of text is then dropped',
        'the wall of text was allowed through');
    const _fs = await import('node:fs');
    const _agent = _fs.readFileSync('src/agent/agent.js', 'utf8');
    check(/length:split/.test(_agent), 'a splittable paragraph is let through, not dropped',
        'a splittable paragraph is still dropped');
}

// ── and the word limit stays where the MEASUREMENT put it ──────────────
//
// I tightened HARD_WORD_LIMIT to 12 and then sampled the real messages that
// would drop: 0% of them contain a second sentence. They are ordinary build
// instructions ('pick red 2 1 -3, pick red -2 1 -4, place red -2 1 -4'). A hard
// word drop destroys real speech, so it went back to 25.
{
    check(HARD_WORD_LIMIT >= 20, `HARD_WORD_LIMIT is ${HARD_WORD_LIMIT} - long build instructions survive`,
        `HARD_WORD_LIMIT is ${HARD_WORD_LIMIT}, which drops ordinary build instructions`);
}

// ── REGRESSION: the live bug ───────────────────────────────────────────
//
// Deployed and observed: 8 x "[budget:too_many_in_a_row] holding back" and ZERO
// actual sends. She composed 8 messages, sent none, and had exhausted her burst
// allowance on attempts that were discarded.
//
// Two separate causes, both fixed:
//   1. canSpeak() was called AGAIN on the output after reserve() had already
//      charged the turn - a double charge. Fixed with ctx.checked.
//   2. reserve() advanced `consecutive`, so messages that were composed and
//      thrown away counted as turns to the room. reserve() now takes a budget
//      slot only; delivered() advances the run.
{
    const b = new ChatBudget();
    let t = 0;
    // 8 attempts, every one discarded (too long) - the room sees nothing.
    for (let i = 0; i < 8; i++) {
        const gate = b.canSpeak({ now: t, human_msgs_since_her_last: 0 });
        if (!gate.ok) { check(false, '8 discarded attempts never blocked', `blocked at attempt ${i}: ${gate.why}`); break; }
        b.reserve(t);
        b.note('a very long discarded message that never goes out');
        t += MIN_GAP_MS + 10;
    }
    check(b.consecutive === 0, '8 discarded attempts advanced the run 0 times',
        `discarded text advanced the run ${b.consecutive} times`);
    // and the output path must not re-charge a turn
    const before = b.sent.length;
    const out = b.canSpeak({ now: t, human_msgs_since_her_last: 0, checked: true });
    check(out.ok, 'the output path does not re-apply the rate limits', 'output path re-charged the turn');
    check(b.sent.length === before, 'the output check does not consume budget',
        'the output check consumed a budget slot');
    // a real send still advances the run
    b.delivered(t);
    check(b.consecutive === 1, 'a delivered message advances the run once',
        `consecutive is ${b.consecutive} after one real send`);
}

// ── and the window budget ──────────────────────────────────────────────
{
    const b = new ChatBudget();
    let t = 0;
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) {
        b.reserve(t); b.delivered(t);
        b.humanSpoke();            // so the consecutive cap is not what stops her
        t += MIN_GAP_MS + 10;
    }
    check(!b.canSpeak({ now: t, human_msgs_since_her_last: 5 }).ok,
        `capped at ${MAX_MESSAGES_PER_WINDOW} per 10 minutes`, 'no window budget');
    // the window slides: old messages age out
    const later = t + 11 * 60 * 1000;
    check(b.canSpeak({ now: later, human_msgs_since_her_last: 20 }).ok,
        'the budget refills after 10 minutes', 'budget never refills');
}
{
    // A monologue: three of hers and not one human word in the window.
    //
    // Reachable only by spacing the deliveries PAST the run expiry. The
    // consecutive cap is the outer guard and fires first on anything tighter -
    // three messages back to back is blocked as too_many_in_a_row, which is
    // correct but is not this rule. Note the shape this needs: the previous
    // version of this test interleaved humanSpoke() to reset consecutive, which
    // is self-contradictory - a human speaking is exactly what makes it NOT a
    // monologue, and it also stamps the human side of the window, so the guard
    // could never see an empty one. Deliveries 100s apart expire the run each
    // time (90s) while all three stay inside the 10-minute window.
    const b = new ChatBudget();
    let t = 0;
    for (let i = 0; i < 3; i++) { b.reserve(t); b.delivered(t); t += RUN_EXPIRES_MS + 10_000; }
    const v = b.canSpeak({ now: t });
    check(v.why === 'monologue', `blocked by the monologue rule (got ${v.why})`,
        `wrong reason: ${v.why}`);

    // and the same shape, window slid: the ceiling is not a lifetime ban.
    const past = b.canSpeak({ now: t + 11 * 60_000 });
    check(past.ok, `monologue ceiling expires with the window (got ${past.why})`,
        'the monologue ceiling is a lifetime ban');
}

// ── the share must be BELOW a real chattiest person's 60% ──────────────
{
    check(SHARE_CEILING <= 0.6, `share ceiling ${SHARE_CEILING} is at or under the measured 60%`,
        `share ceiling ${SHARE_CEILING} exceeds the chattiest real player (60%)`);
    check(MAX_CONSECUTIVE <= 3, `max ${MAX_CONSECUTIVE} consecutive, corpus runs are 2-4`,
        `max consecutive ${MAX_CONSECUTIVE} exceeds the measured run length`);
}

// ── wired into production ──────────────────────────────────────────────
{
    const fs = await import('node:fs');
    const agent = fs.readFileSync('src/agent/agent.js', 'utf8');
    check(/ChatBudget/.test(agent), 'agent.js uses ChatBudget', 'the budget is dead code');
    check(/checkLength/.test(agent), 'agent.js checks length', 'length_rule is dead code');
    // the budget must be consulted BEFORE the message goes out
    const i = agent.indexOf('ChatBudget');
    const send = agent.indexOf('if (settings.chat_ingame) this.bot.chat(');
    check(i > 0 && i < send, 'budget checked before sending', 'budget checked after sending');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} budget/length assertions green`);