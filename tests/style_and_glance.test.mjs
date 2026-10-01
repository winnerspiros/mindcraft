// Two things the owner reported, both measured rather than guessed:
//
//  "who says facepalm mid sentece.."
//  "no stare or interactions with players too. just stares to nothingness"
//
// The asterisk one is unambiguous: over 21,822 real player lines, '*' appears in
// 59 (0.270%), and ALL 59 are stray single characters - "chegg *", "like *",
// "*mirrored". Not one is a *bracketed emoticon*. So `*facepalm*` has zero
// precedent and is stripped in code, beside the existing tilde strip and before
// the length and empty-ack gates.
//
// The stare one is subtler. The glance cycle (glance, look away, look back) was
// already correct in SHAPE, so it was still staring - with breaks, and at
// whatever happened to be in range, which is what "to nothingness" means. A
// glance needs a CEILING as well as a shape.

import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (c, good, bad) => {
    if (!c) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const agent = readFileSync('src/agent/agent.js', 'utf8');
const modes = readFileSync('src/agent/modes.js', 'utf8');
// Read the persona as parsed JSON, not raw text: a newline in the value is a
// literal backslash-n in the file, so every phrase-spanning regex silently
// failed. That is what made four assertions report missing text that was
// demonstrably there.
const persona = (() => {
    const d = JSON.parse(readFileSync('personas/normal.json', 'utf8'));
    return JSON.stringify(d);          // escapes newlines again
})();
const personaFlat = JSON.parse(readFileSync('personas/normal.json', 'utf8')).conversing
    .replace(/\s+/g, ' ');

// ── asterisks ──────────────────────────────────────────────────────────
{
    const i = agent.indexOf("replace(/\\*[^*\\n]{1,24}\\*/g, ' ')");
    check(i > 0, 'bracketed asterisks (*facepalm*) are stripped', 'no bracketed-asterisk strip');

    // A single star run cannot survive either - the 59 real cases are all stray
    // single characters, so leaving them would keep the actual tic.
    const after = agent.slice(i, i + 400);
    check(/replace\(\/\\\*\+\/g, ' '\)/.test(after), 'stray asterisks are stripped too',
        'stray asterisks survive');

    // It must be beside the tilde strip, which is already proven, and BEFORE the
    // length gate - otherwise a message padded with *emoticon* would pass the
    // emptiness check as content.
    const stripAt = agent.indexOf("replace(/~+/g, '')");
    const lenAt = agent.indexOf('let len = checkLength(message)');
    check(i > 0 && stripAt > i && i < lenAt,
        'stripped before the length/empty-ack gates, beside the tilde strip',
        'the strip runs after the gates that judge emptiness');

    // the corpus justification is recorded, so nobody "fixes" it back
    // Search back to the start of the enclosing comment block rather than a fixed
    // 700 chars - the justification comment is longer than that, and a guessed
    // distance reported a missing measurement that is present.
    const before = agent.slice(0, i);
    const commentStart = before.lastIndexOf('//', before.lastIndexOf('\n\n', i) - 1);
    const ctx = agent.slice(Math.max(0, commentStart), i);
    check(ctx.includes('0.270%') && ctx.includes('21,822'),
        'the corpus measurement is recorded next to the strip', 'no measurement recorded');
}

// ── the glance budget ──────────────────────────────────────────────────
{
    check(/GLANCE_BUDGET_MAX/.test(modes), 'a glance budget exists', 'no glance budget');
    const m = Number(/const GLANCE_BUDGET_MAX = (\d+)/.exec(modes)?.[1]);
    check(Number.isFinite(m) && m > 0 && m <= 6,
        `the budget is ${m} glances per target - small on purpose`,
        `the budget is ${m}, which is not a ceiling`);

    // a small window with a small max, and a cooldown that outlasts the window,
    // so she genuinely stops rather than pausing
    const win = Number(/const GLANCE_BUDGET_WINDOW_MS = (\d+)/.exec(modes)?.[1]);
    const cool = Number(/const GLANCE_BUDGET_COOLDOWN_MS = (\d+)/.exec(modes)?.[1]);
    check(Number.isFinite(win) && Number.isFinite(cool) && cool >= win / 2,
        `window ${win}ms, cooldown ${cool}ms`, 'the cooldown is shorter than the window');

    // exceeding the budget must clear the target, or the re-arm refills it
    const bi = modes.indexOf('GLANCE_BUDGET_MAX) {');
    check(bi > 0 && /this\.last_entity = null/.test(modes.slice(bi, bi + 400)),
        'over budget she drops the target instead of re-acquiring it',
        'over budget she keeps the target and keeps looking');

    // and the map must be pruned or it grows all session
    check(/_glanceLog\.delete/.test(modes), 'the glance log is pruned', 'the glance log grows forever');
}

// ── shortening: the corpus says the OPPOSITE of "shorten more" ──────────
{
    check(/SHORTENING - MEASURED/.test(persona),
        'the persona states the measured shortening rates', 'no shortening guidance');
    const c = personaFlat;   // whitespace-flattened, so phrases that wrap still match
    check(/4\.5%/.test(c) && /0\.90%/.test(c) && /0\.19%/.test(c),
        'and gives the real numbers (4.5% any, 0.90% dropped-g, 0.19% gonna)',
        'the numbers are missing or wrong');
    // the instruction must be the INVERSE of the naive one, or a later reader
    // will "fix" it into making her spell words wrong
    check(/NOT\s+a\s+teenager\s+texting/i.test(c),
        'and says contract normally rather than spell words wrong',
        'the guidance still pushes toward mangled spelling');
    check(/SHAPE, not spelling/i.test(c),
        'and points at sentence shape, which is the real problem',
        'the guidance does not name the actual failure');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} style/glance assertions green`);
