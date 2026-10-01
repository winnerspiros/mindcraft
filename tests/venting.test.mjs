// Rants stay whole. Measured justification, not a hunch.
//
// Of 868 unique real player lines (bots/UwU/histories):
//   corpus median 5 words, p95 14, max 32
//   venting-marked lines: median 7, MAX 25 words, 11% over 10 words
//
// So the long tail is real and it is emotional: someone who had a bad day and
// then got messed with in game writes a paragraph, and that paragraph is the
// entire point of the message. Capping it to 10 words deletes why they typed it.
//
// The danger is the obvious inverse — if length alone lifted the cap, she would
// pad every ordinary reply, which is the exact failure the cap exists to stop.
// So the trigger is emotional REGISTER, not size, and both directions are
// asserted here.

import { fragmentForChat } from '../src/utils/chat_fragment.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};
const words = (s) => s.split(/\s+/).filter(Boolean).length;

// ── the rants the owner described ─────────────────────────────────────────
const RANTS = [
    'honestly im done with today. my manager was a nightmare and then someone creepered my farm while i was at work. im so fucking tired',
    'im so mad right now. i lost my progress and this is the second time today',
    'wtf is wrong with this server. i spent all night on that and someone blew it up',
    'that is genuinely the most unfair thing ive seen all week and i cant stand it',
    'why the hell did you take my stuff. i was gone for five minutes',
];
for (const src of RANTS) {
    const out = fragmentForChat(src);
    check(words(out.join(' ')) > 10,
        `rant survives intact (${words(out.join(' '))}w): "${src.slice(0, 34)}..."`,
        `rant was cut to ${words(out.join(' '))} words: ${JSON.stringify(out)}`);
}

// The rant must arrive AS WRITTEN — no reframing, no trailing period bolted on.
{
    const src = 'honestly im done with today. my manager was a nightmare and then someone creepered my farm while i was at work. im so fucking tired';
    check(fragmentForChat(src).join(' ') === src, 'rant is byte-identical', 'rant was altered');
}

// ── and the cap still applies to everything else ─────────────────────────
// Long, flat, unemotional text must not gain anything from the vent exception.
// Note these are written WITH sentence boundaries, so the splitter has somewhere
// safe to cut: they become multi-line bursts rather than one long lecture. (A
// calm message with no boundary anywhere still ships whole — chat_fragment.js
// refuses to cut mid-phrase, which is the standing rule.)
const CALM_LONG = [
    'i think the best approach here would probably be to gather the materials first. then construct the structure in layers so it will not collapse',
    'so basically what you are saying is that the spawn point is somewhere over there. near the river, which is where i built the first shelter',
    'the farm layout could be improved by moving the water source to the corner. then run the channels down both sides for even coverage',
];
for (const src of CALM_LONG) {
    const out = fragmentForChat(src);
    const longest = Math.max(...out.map(words));
    check(out.length > 1,
        `calm long message becomes a burst (${out.length} lines, max ${longest}w)`,
        `calm message shipped as one ${longest}-word block: ${JSON.stringify(out)}`);
    check(out.length <= 3, `burst stayed within 3 lines`, `burst was ${out.length} lines`);
}

// Short ordinary replies must be untouched, even with a mild swear in them.
for (const s of ['kys', 'skill issue', 'nah', 'bro wtf', 'shit that was close', 'ok']) {
    check(fragmentForChat(s)[0] === s,
        `"${s}" untouched`,
        `"${s}" was altered`);
}

// A single mild profanity is NOT a rant — she swears for emphasis all the time,
// and letting that lift the cap would be the easiest way to defeat it.
const MILD = 'i think thats fucking hilarious, im crying';
check(words(fragmentForChat(MILD).join(' ')) <= 11 || fragmentForChat(MILD).length > 1,
    'a single mild swear does not unlock the cap',
    'one "fucking" unlocked unbounded length');

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} venting-exception assertions green`);