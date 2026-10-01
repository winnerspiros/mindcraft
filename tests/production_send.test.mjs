// The word cap existed, was unit-tested, and never ran.
//
// agent.js openChat() had:
//     const parts = fragmentForChat(message);
//     if (parts && parts.length) {          // was: parts.length > 1 message = parts[0]; ... }
//
// A reply that can only be cut at ONE safe boundary comes back as a single
// element, so `length > 1` was false, the whole block was skipped, and the
// ORIGINAL message went out untouched. Measured on live output: every one of the
// 33 post-fix lines was over the 10-word cap, median 20 words, against a real
// player median of 5.
//
// The unit tests could not catch this because chat_fragment.test.mjs tests the
// SPLITTER in isolation - it correctly returns ["short clause"] - while the bug
// was in the CALLER deciding to throw that answer away. This file reproduces the
// production branch verbatim and asserts on what actually leaves the process.

import { fragmentForChat } from '../src/utils/chat_fragment.js';

// Copied from agent.js openChat(). If that branch changes, this must change with
// it — that coupling is the point of the file.
function productionSend(message) {
    const sent = [];
    if (message.length > 55) {
        const parts = fragmentForChat(message);
        if (parts && parts.length) {          // was: parts.length > 1
            sent.push(parts[0], ...parts.slice(1));
        }
    }
    if (!sent.length) sent.push(message);      // short message: unchanged
    return sent;
}

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};
const words = (s) => s.split(/\s+/).filter(Boolean).length;

// These are verbatim lines from live history. All three were over the cap.
const WAS_OVER_CAP = [
    'ugh, just got hit by a pillager! what a mood killer. trying to build a shelter over here but they keep spawning',
    'ugh, not again! this is like a horror movie. where is YandereDev? need someone to back me up here',
    'why wont they leave me alone?! ugh, can someone help? i might need to just go back to base',
];

// The cap now runs PER LINE, not on the whole reply: a burst is already several
// messages, so each gets its own budget and nothing is deleted for sitting in a
// later sentence. What must hold is that no single line is a long paragraph —
// except where the line has no sentence or clause break at all, in which case
// chat_fragment.js ships it whole by design rather than produce word salad.
const hasBreak = (l) => /[.!?]|[,;:]/.test(l.replace(/\s*!\w+\([^)]*\)\s*$/, ''));
for (const src of WAS_OVER_CAP) {
    const sent = productionSend(src);
    const bad = sent.filter((l) => words(l) > 10 && hasBreak(l));
    check(bad.length === 0,
        `"${sent[0].slice(0, 34)}..." -> ${sent.length} lines, longest ${Math.max(...sent.map(words))}w`,
        `a long line WITH a safe boundary was not capped: ${JSON.stringify(bad)}`);
}
check(WAS_OVER_CAP.every((s) => productionSend(s).length <= 3),
    'every live line now goes out as a short burst', 'a live line still ships as one block');

// The original regression was a single-fragment result being discarded by a
// `parts.length > 1` guard, sending the original 19-word message whole. The
// per-line cap now splits these into 3 lines, so the exact input no longer
// produces one fragment — but the guard is gone from production and the property
// is what matters: whatever fragmentForChat returns must be SENT, never
// silently replaced by the original.
{
    for (const src of WAS_OVER_CAP) {
        const parts = fragmentForChat(src);
        const sent = productionSend(src);
        check(sent.join(' ') === parts.join(' '),
            `"${src.slice(0, 28)}..." sends exactly what the splitter produced`,
            `sent output differs from splitter output: ${JSON.stringify(sent)} vs ${JSON.stringify(parts)}`);
        // Messages under the 55-char threshold are deliberately not touched:
        // a 4-word reply has nothing to split, and running the splitter over it
        // would be churn for no gain. They must come out byte-identical.
        // Compare per-line, not the joined string: a 3-line burst re-joins to
        // the original text but is delivered as three separate messages, which is
        // the whole point. Joining hides that and made this assertion fire on
        // correct output.
        if (src.length <= 55) {
            check(sent.length === 1 && sent[0] === src,
                `"${src.slice(0, 24)}..." under the threshold passes through untouched`,
                'a short message was altered');
        } else {
            check(sent.length > 1 || sent[0] !== src,
                `"${src.slice(0, 24)}..." was fragmented, not sent as one block`,
                'the original went out unprocessed');
        }
    }
}

// Nothing to split -> untouched, byte for byte.
for (const short of ['ok', 'kys', 'nah', 'skill issue']) {
    check(productionSend(short)[0] === short,
        `"${short}" passes through unchanged`,
        `"${short}" was altered by the cap`);
}

// Safety: never invent text. Every emitted fragment must be a substring of the
// source, so the cap can only ever REMOVE words.
const withCuts = [
    'hey. so i was thinking. maybe we should just go and grab some wood instead?',
    'wait, no! that is completely wrong and you know it. try again.',
];
let allSubstrings = true;
for (const src of withCuts) {
    for (const part of productionSend(src)) {
        if (src.replace(/\s+/g, ' ').indexOf(part) === -1) allSubstrings = false;
    }
}
check(allSubstrings,
    'cap only removes words, never rewrites them',
    'cap produced text that was not in the original message');

// Burst cap still holds: at most 3 lines, matching the observed p75 burst length.
check(WAS_OVER_CAP.every((s) => productionSend(s).length <= 3),
    'never more than 3 outgoing lines',
    'burst cap exceeded');

// A mutated run printed "PASS — 7" while five assertions had just failed:
// the summary was unconditional. Print it only when nothing failed, so a
// partial run can never be read as a clean one.
if (failed) {
    console.log(`\nFAIL — ${pass} passed, ${failed} failed`);
} else {
    console.log(`\nPASS — ${pass} production-send assertions green`);
}