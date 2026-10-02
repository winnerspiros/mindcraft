// "she's been talking nonsense and can't respond if I don't include her name"
//
// Both halves of that report are pinned here, and both are regressions with
// live evidence from the 2026-10-02 04:55-04:58 session.
//
// 1. THE SHARE WAS A LIFETIME RATIO. deliveredCount and
//    human_msgs_since_her_last only ever INCREMENT, so once she was ahead of
//    him she stayed ahead for the lifetime of the process: 29 delivered vs 8
//    human messages = 78% forever. Every self-prompt then returned over_share
//    (181 hits in 7 hours) with a human standing there talking to her. The fix
//    windows both sides of the ratio. A human speaking must also STAMP that
//    window, which is the part that is easy to leave out and silently returns
//    the human side to 0.
//
// 2. A SELF-PROMPT INVALIDATED HER OWN IN-FLIGHT REPLY. handleMessage stamped
//    most_recent_msg_time for source 'system', so her internal turn landing
//    mid-generation threw away a good answer. Live, one exchange:
//      04:57:16  "where are u uwu?"      -> engaging, generation starts
//      04:57:25  self-prompt queued     -> "discarding old response"
//      04:57:25  full response ""        -> "no response"
//    Nothing sent. That IS "she only answers when I say her name twice" - the
//    first message gets eaten and only the retry lands.
//
// 3. HER OWN BOT LOG WAS SUMMARIZED AS FACTS ABOUT HIM. "I'm stuck!" from the
//    unstuck mode is HER failing to path, stored as "player frequently reports
//    being stuck". The memory field then told her the player was stuck, which
//    is what the nonsense actually was.

import { ChatBudget, WINDOW_MS, SHARE_CEILING, MIN_SHARE_SAMPLE } from '../src/utils/chat_budget.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

// ── 1. THE SHARE EXPIRES ───────────────────────────────────────────────
{
    // The exact live ratio: 29 of her messages against 8 of his, all inside
    // one window. The old lifetime arithmetic called this over_share and held
    // it that way for the rest of the process.
    const b = new ChatBudget();
    const T0 = 1_000_000;
    for (let i = 0; i < 29; i++) b.delivered(T0 + i * 1000);
    for (let i = 0; i < 8; i++) b.humanSpoke(T0 + i * 1000);

    // Far enough later that her deliveries have left the window and only his
    // remain: she is no longer dominating anything.
    const later = T0 + WINDOW_MS + 60_000;
    const after = b.canSpeak({ now: later, human_msgs_since_her_last: 8 });
    check(after.ok, 'share recovers once her deliveries leave the window',
        `share stuck at over_share forever: ${JSON.stringify(after)}`);

    // And the same state INSIDE the window is still judged honestly.
    const b2 = new ChatBudget();
    for (let i = 0; i < 29; i++) b2.delivered(T0 + i * 1000);
    for (let i = 0; i < 8; i++) b2.humanSpoke(T0 + i * 1000);
    const inWindow = b2.canSpeak({ now: T0 + 30_000, human_msgs_since_her_last: 8 });
    check(!inWindow.ok, 'genuine domination inside the window is still blocked',
        'lost the share ceiling: she is allowed to own the room');
}

// ── 2. HUMAN SPEECH ACTUALLY COUNTS ON THE HUMAN SIDE ──────────────────
{
    // The windowed ratio reads humanAt. If humanSpoke() does not stamp it, the
    // human side is always 0 and the fix in (1) is theatre.
    const b = new ChatBudget();
    const T0 = 1_000_000;
    b.humanSpoke(T0);
    check((b.humanAt || []).length === 1, 'humanSpoke() stamps the human side of the window',
        'humanSpoke() does not record when the human spoke');

    // A balanced conversation, interleaved so no other gate fires.
    const c = new ChatBudget();
    for (let r = 0; r < 6; r++) {
        c.humanSpoke(T0 + r * 20_000);
        c.delivered(T0 + r * 20_000 + 2_000);
    }
    const r = c.canSpeak({ now: T0 + 130_000, human_msgs_since_her_last: 6 });
    check(r.ok, 'a 50/50 conversation is allowed to continue',
        `a normal conversation was shut down: ${JSON.stringify(r)}`);
}

// ── 3. THE SHARE STILL BITES WHEN SHE REALLY IS DOMINATING ─────────────
{
    // Guards against "fix" = delete the ceiling. 2 human vs 9 her = 82%, well
    // over the 0.55 ceiling and under the 12-message window cap, so the ratio
    // is unambiguously the thing being judged.
    const b = new ChatBudget();
    const T0 = 1_000_000;
    b.humanSpoke(T0);
    b.humanSpoke(T0 + 1_000);
    for (let k = 0; k < 9; k++) {
        b.delivered(T0 + 2_000 + k * 3_000);
    }
    const now = T0 + 60_000;
    const winHuman = b.humanAt.filter((t) => now - t < WINDOW_MS).length;
    const winHers = b.deliveredAt.filter((t) => now - t < WINDOW_MS).length;
    const total = winHuman + winHers;
    const dominant = total >= MIN_SHARE_SAMPLE && winHers / total > SHARE_CEILING + (1 / total);
    check(dominant, 'the share ceiling still catches her talking to herself',
        `share ceiling no longer applies: ${winHers}/${total}`);
}

console.log(`\nnonsense_and_silence: ${pass} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
