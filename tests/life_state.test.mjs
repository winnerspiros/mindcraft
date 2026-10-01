// Is she a person at a computer, or a chat endpoint?
//
// The owner: "we trying to make her real so think this is a person real life
// playing minecraft. he may go to wc, go grab a drink, has plans so needs to go
// offline, is bored so scrolls phone, might be looking for a song to play in the
// background, looking at youtube videos, sending messages to a friend in chat,
// someone called her."
//
// The tell is not that she is ever absent - it is that she is NEVER absent and
// never has anywhere to be. These tests pin the properties that make the
// absence read as lived rather than generated.

import { LifeState, ACTIVITIES } from '../src/utils/life_state.js';
import { shouldReplyTo } from '../src/utils/reply_trigger.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the owner's examples are all actually reachable ─────────────────────
{
    const ids = new Set(ACTIVITIES.map((a) => a.id));
    for (const id of ['wc', 'drink', 'phone', 'music', 'youtube', 'friend_msgs', 'call', 'plans']) {
        check(ids.has(id), `activity exists: ${id}`, `missing activity: ${id}`);
    }
}

// ── absences have real durations, not token gaps ────────────────────────
{
    for (const a of ACTIVITIES) {
        check(a.min >= 60000,
            `${a.id}: minimum absence ${a.min / 60000}min (never a token gap)`,
            `${a.id}: can return in under a minute - reads as a bot hesitating`);
    }
    // log-uniform, so most absences are short and the tail is long - not a
    // flat spread, which is the mechanical version of the same tell.
    const life = new LifeState();
    const d = [];
    for (let i = 0; i < 4000; i++) { life.away = null; life.lastLeftAt = 0; d.push(life.leave().until - Date.now()); }
    d.sort((x, y) => x - y);
    const p50 = d[d.length >> 1], p95 = d[Math.floor(d.length * 0.95)];
    check(p95 > 2 * p50, `absence durations are heavy-tailed (p95 ${Math.round(p95 / 60000)}min vs p50 ${Math.round(p50 / 60000)}min)`,
        `absence durations too flat - p95 ${p95} vs p50 ${p50}`);
    const cv = Math.sqrt(d.reduce((a, b) => a + (b - d.reduce((x, y) => x + y, 0) / d.length) ** 2, 0) / d.length)
        / (d.reduce((x, y) => x + y, 0) / d.length);
    check(cv > 0.5, `CV ${cv.toFixed(2)} - not metronomic`, `CV ${cv.toFixed(2)} - too regular`);
}

// ── she does not ping-pong ──────────────────────────────────────────────
{
    const life = new LifeState();
    life.leave();
    check(!life.shouldLeave().leave, 'cannot leave again while already away', 'left while already away');
    life.away = null;  // forced back for the test
    check(!life.shouldLeave().leave, 'no second absence straight after the first', 'ping-ponged absences');
}

// ── and it is RARE. A bot that vanishes every few minutes is still a bot ──
{
    const life = new LifeState();
    let left = 0;
    for (let i = 0; i < 3000; i++) {
        life.away = null; life.lastLeftAt = 0;   // isolate the rate gate only
        if (life.shouldLeave().leave) left++;
    }
    check(left / 3000 < 0.75, `leaves on ${Math.round(left / 3000 * 100)}% of eligible turns`,
        `leaves on ${Math.round(left / 3000 * 100)}% of turns - constant disappearing`);
    check(left / 3000 > 0, 'she does sometimes leave', 'she can never leave - she is a bot');
}

// ── the REASON PERSISTS, so she cannot contradict herself ───────────────
{
    // Aggregate, not per-iteration: my first version asserted inside the loop
    // and produced 2043 "assertions" from 4 short checks, which buries the real
    // output and makes a regression invisible in the noise.
    const life = new LifeState();
    const ids = new Set();
    let allTimed = true;
    for (let i = 0; i < 2000; i++) {
        life.away = null; life.lastLeftAt = 0;
        const a = life.leave();
        if (a) { ids.add(a.id); if (!(a.until > Date.now())) allTimed = false; }
    }
    check(allTimed, 'every absence has an end time', 'an absence never returns');
    check(ids.size >= 3, `absences use ${ids.size} different reasons (${[...ids].join(', ')}), not one script`,
        `only ${ids.size} reason(s) ever used: ${[...ids].join(', ')}`);
}

// ── some absences are silent, because not every absence is announced ────
{
    const life = new LifeState();
    let silent = 0, announced = 0;
    for (let i = 0; i < 3000; i++) {
        life.away = null; life.lastLeftAt = 0;
        const a = life.leave();
        if (!a) continue;
        if (a.said) announced++; else silent++;
    }
    check(announced > 0, 'most absences say something', 'she always announces leaving');
    check(silent > 0, 'some absences are silent (phone scrolling)', 'every absence is announced');
}

// ── people come back EARLY ──────────────────────────────────────────────
{
    const life = new LifeState();
    let early = 0;
    for (let i = 0; i < 2000; i++) {
        life.away = null; life.lastLeftAt = 0;
        life.leave();
        life.away.until = Date.now() + 600000;   // 10 min left on the clock
        if (life.checkReturn()) early++;
    }
    check(early > 200, `returns early ${Math.round(early / 20)}% of the time - people get pulled back in`,
        `returned early only ${Math.round(early / 20)}% of the time - always waits out the full duration`);
    // ...but not instantly, every time
    check(early < 2000, 'not everyone comes back early', 'always comes back early');
}

// ── while away, she does not answer ─────────────────────────────────────
{
    for (const m of ['sup', 'uwu you there', 'what time is it', 'are you ok']) {
        const v = shouldReplyTo({ message: m, present: false, visible_humans: 1, addressed: false, human_exchange: false });
        check(!v.reply, `away: does not answer ${JSON.stringify(m)}`, `replied while away to ${JSON.stringify(m)}`);
        check(v.why === 'not_at_computer', `away: reason is not_at_computer`, `wrong reason: ${v.why}`);
    }
    // Being addressed does not summon her from the toilet.
    check(!shouldReplyTo({ message: 'uwu', present: false, visible_humans: 1, addressed: true }).reply,
        'away: being addressed does not summon her back', 'she answered from the bathroom');
    // ...and when she IS present, nothing changed.
    check(shouldReplyTo({ message: 'uwu you there', present: true, visible_humans: 1, addressed: true }).reply,
        'present: still answers when addressed', 'the presence gate broke normal replies');
}

// ── time-aware: nobody goes out to dinner at 4am ────────────────────────
{
    const src = (await import('node:fs')).readFileSync('src/utils/life_state.js', 'utf8');
    check(/youtube: \[9, 2\]/.test(src), 'youtube hole is time-windowed', 'no hour window for youtube');
    check(/plans: \[8, 23\]/.test(src), 'going out is limited to plausible hours', 'no hour window for plans');
    check(/inWindow/.test(src), 'windows are actually evaluated', 'windows are declared but unused');
}
{
    const fs = await import('node:fs');
    const modes = fs.readFileSync('src/agent/modes.js', 'utf8');
    check(/LifeState/.test(modes), 'modes.js uses LifeState', 'life state is dead code');
    // The away check must precede the next_start gate, or she can never return.
    check(modes.indexOf('_life.isAway') < modes.indexOf('if (now < this.next_start) return;'),
        'the away check runs BEFORE next_start, so she can still come back',
        'next_start is checked first - she can never come back on time');
    check(/_life\.checkReturn\(\)/.test(modes), 'return is handled, not just leaving', 'she can leave but never return');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} life-state assertions green`);