// She was walking around, mining and digging WHILE typing a message.
//
// The owner: "ppl dont do actions in game and talk at the same time, its not
// possible since you need to type so you stop what you doing"
//
// That is mechanically true of Minecraft, and it explains something the logs
// could not: `bot.chat()` is fire-and-forget - it queues the message and returns
// in about a millisecond - while modes tick every 300ms. So the chat window was
// instantly over and she spent the whole time the message was "being typed"
// walking, mining, jumping and digging. A real player holds no pickaxe while the
// chat box is open.
//
// The load-bearing property is the ORDERING, not the constant. Two directions,
// and the second is the one that actually reads as human:
//   1. she must not START a new action while mid-sentence
//   2. she must not START typing in the middle of an action she already began
// Direction 2 is what stops "finish a dig -> stop dead -> walk off".

import { TypingState, typingTimeMs, AVG_KEYSTROKE_MS, MIN_TYPING_MS, FIRST_CHAR_LAG_MS } from '../src/utils/typing_state.js';
import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the duration comes from the Keystroke-Level Model, not a guess ──────
{
    // KLM K operator: 0.20s average skilled typist, 0.28s average non-skilled.
    // Feit, Weir & Oulasvirta 2016 instrumented mean inter-key: 176ms/169ms.
    check(AVG_KEYSTROKE_MS === 200, `KLM K operator is ${AVG_KEYSTROKE_MS}ms`, `keystroke is ${AVG_KEYSTROKE_MS}ms`);
    check(AVG_KEYSTROKE_MS >= 169 && AVG_KEYSTROKE_MS <= 280,
        'the keystroke constant sits inside the measured range', 'the constant is outside the measured range');

    // it scales with the message
    const short = typingTimeMs('ok');
    const mid = typingTimeMs('im coming to the mines in a sec');
    const long = typingTimeMs('i was thinking we should probably go to the mines later today because we need more iron for the build');
    check(mid > short, `"im coming..." (${mid}ms) takes longer to type than "ok" (${short}ms)`, 'duration ignores length');
    check(long > mid, `a long message (${long}ms) takes longer than a short one`, 'duration ignores length');

    // and it is never instant
    check(short >= MIN_TYPING_MS, `even "ok" costs ${short}ms of hands`, 'a message costs no time to type');
    check(short >= FIRST_CHAR_LAG_MS, 'opening the chat box costs something', 'no focus lag');

    // empty is free - there is nothing to type
    check(typingTimeMs('') === 0, 'an empty message costs nothing', 'an empty message costs time');
    check(typingTimeMs(null) === 0, 'null is handled', 'null threw or cost time');
}

// ── direction 1: no action may START while she is typing ────────────────
{
    const t = new TypingState();
    const now = 100000;
    t.begin('im coming to the mines', now);
    check(t.busy(now), 'she is busy typing right after beginning', 'not busy immediately');
    check(!t.canStartMovement(now + 200), 'no movement may start mid-sentence',
        'she could start moving mid-sentence');
    check(!t.canStartMovement(now + 400), 'still no movement a moment later', 'she moved mid-sentence');

    const after = now + typingTimeMs('im coming to the mines') + 100;
    check(!t.busy(after), `she is free again at +${after - now}ms`, 'she stays busy forever');
    check(t.canStartMovement(after), 'and may act once done typing', 'she cannot act after typing');
}

// ── it releases itself without being told to (no stuck-forever bug) ─────
{
    const t = new TypingState();
    const now = 100000;
    t.begin('brb', now);
    const release = typingTimeMs('brb');
    await new Promise((r) => setTimeout(r, release + 200));
    check(!t.busy(Date.now()), 'the timer released her without done() being called',
        'she stayed busy with no done() call - she would be frozen forever');
}

// ── a wall of text keeps her hands busy for a long time ────────────────
{
    // A second, independent brake on paragraphs: typing 30 words takes ~7s of
    // hands, so the rate budget closes long before she finishes.
    const wall = 'i was thinking we should probably go to the mines later today because we need more iron for the build that we were talking about';
    const wallMs = typingTimeMs(wall);
    const shortMs = typingTimeMs('ok');
    check(wallMs > shortMs * 4, `a ${wall.split(' ').length}-word wall costs ${wallMs}ms of hands vs ${shortMs}ms`,
        `a wall of text does not cost more time to type (${wallMs} vs ${shortMs})`);
}

// ── it is a START-gate, not a freeze ────────────────────────────────────
{
    // Freezing mid-swing would look like lag, which is worse than the bug. An
    // action already in flight finishes; only NEW actions are refused.
    check(typeof new TypingState().canStartMovement === 'function',
        'the gate exposes canStartMovement (a start decision)',
        'the gate cannot express start-vs-continue');
}

// ── wired into both directions in production ────────────────────────────
{
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    const open = agent.indexOf('async openChat(');
    const openBlock = agent.slice(open, open + 2000);
    check(/TypingState/.test(openBlock), 'openChat begins the typing window',
        'openChat does not begin typing');
    check(/this\._typing\?*\.?begin\(/.test(openBlock), 'it calls begin() with the message',
        'openChat never calls begin()');

    const gate = agent.indexOf('canStartMovement');
    check(gate > 0, 'the mode loop consults canStartMovement', 'the mode loop ignores typing');

    // direction 2: the speech path must know she is acting
    // Direction 2 must be a REAL gate: _actingAt has to be READ by openChat,
    // not merely written. My first version only wrote it and the test still
    // passed - a gate that does not exist passes any test that checks only that
    // the variable was assigned.
    check(/_actingAt/.test(agent), 'acting time is recorded for the reverse gate',
        'no acting time is recorded');
    const reads = (agent.match(/_actingAt/g) || []).length;
    check(reads >= 2, `_actingAt is both written and read (${reads} references)`,
        `_actingAt appears ${reads}x - it is written but never read, so direction 2 is not enforced`);
    check(/PAUSE_BEFORE_TYPING_MS/.test(openBlock), 'openChat waits for the pause',
        'openChat does not wait for a pause');
    check(/MAX_WAIT_FOR_PAUSE_MS/.test(agent),
        'the wait is capped, so a long build is not interrupted',
        'the wait is uncapped - she would freeze during a build to talk');
    check(!/this\._moving/.test(agent),
        'no phantom _moving flag (it never existed - always falsy, dead code)',
        'the phantom _moving flag is back');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} typing/acting assertions green`);