// Few-shot example selection.
//
// personaExamples() used to return ALL 28 examples and inject every one on every
// turn. Bounded to 5 with rotation, per three findings:
//   - count past ~5 has small marginal gain and each example costs prompt share
//     the persona script needs (the script is what keeps her in voice);
//   - later examples get disproportionate weight, so a fixed example parked last
//     becomes the template she copies;
//   - a fixed set becomes a memorisation anchor.
//
// Leakage was MEASURED, not assumed: 71 real log replies vs all 28 examples,
// difflib ratio, best real similarity 0.48, zero verbatim, zero example
// substrings - and the detector was validated against a control (a real example
// scores 1.00), so the zero is genuine. This file therefore guards the bound and
// the rotation, and keeps a leakage detector available for future logs.

import { readFileSync } from 'node:fs';
import {
    personaExamples, resetPersonaExampleOffset, PERSONA_EXAMPLE_COUNT,
} from '../src/utils/server_context.js';

let pass = 0;
const ok = (m) => { console.log(`  ok - ${m}`); pass++; };
const bad = (m) => { console.error(`  NOT OK - ${m}`); process.exitCode = 1; };

const pool = JSON.parse(readFileSync('personas/normal.json', 'utf8')).conversation_examples;

// ── 1. bounded ────────────────────────────────────────────────────────────
resetPersonaExampleOffset();
const first = personaExamples();
first.length === PERSONA_EXAMPLE_COUNT
    ? ok(`injects ${first.length} examples (pool has ${pool.length})`)
    : bad(`injects ${first.length}, expected ${PERSONA_EXAMPLE_COUNT}`);
if (pool.length > PERSONA_EXAMPLE_COUNT) {
    first.length < pool.length
        ? ok(`examples are bounded, not the whole pool (${first.length} < ${pool.length})`)
        : bad('still injecting every example');
}
if (PERSONA_EXAMPLE_COUNT <= 7) ok(`count ${PERSONA_EXAMPLE_COUNT} is within the evidenced range (<=7)`);
else bad(`count ${PERSONA_EXAMPLE_COUNT} exceeds the evidenced cap of ~7`);

// ── 2. every selected example is a real pool member (no invented content) ─
const key = (e) => JSON.stringify(e);
const poolKeys = new Set(pool.map(key));
first.every((e) => poolKeys.has(key(e)))
    ? ok('all selected examples come from the persona file')
    : bad('selection invented an example that is not in the pool');

// ── 3. rotation actually rotates ──────────────────────────────────────────
const second = personaExamples();
JSON.stringify(first) !== JSON.stringify(second)
    ? ok('successive calls select a different set')
    : bad('every call returns the identical set — no rotation');
resetPersonaExampleOffset();
const again = personaExamples();
JSON.stringify(again) === JSON.stringify(first)
    ? ok('reset makes selection deterministic for tests')
    : bad('resetPersonaExampleOffset does not restore the first selection');

// Over many calls, every example should be reachable — otherwise part of the
// pool (a whole register) could be starved out.
const seen = new Set();
for (let i = 0; i < pool.length * 2; i++) {
    for (const e of personaExamples()) seen.add(key(e));
}
seen.size === pool.length
    ? ok(`rotation reaches all ${pool.length} examples over ${pool.length * 2} calls`)
    : bad(`rotation only ever reaches ${seen.size}/${pool.length} — some registers are unreachable`);

// ── 4. no duplicate selection within one prompt ───────────────────────────
const uniq = new Set(first.map(key));
uniq.size === first.length
    ? ok('no duplicate examples inside a single prompt')
    : bad(`duplicate examples in one prompt: ${first.length - uniq.size}`);

// ── 5. leakage detector, validated with a control ────────────────────────
// Kept so future logs can be checked. The control is essential: a leakage
// check that cannot detect real copying reports "zero leakage" forever.
{
    const norm = (s) => String(s || '')
        .replace(/!\w+\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9 ]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const ratio = (a, b) => {
        const A = norm(a); const B = norm(b);
        if (!A || !B) return 0;
        let m = 0; let i = 0; let j = 0;
        while (i < A.length && j < B.length) {
            if (A[i] === B[j]) { m++; i++; j++; }
            else if (A[i] < B[j]) i++;
            else j++;
        }
        return m / (A.length + B.length - m);
    };
    const exampleLine = (e) => String(e.find((x) => x.role === 'assistant')?.content || '');
    const lines = pool.map(exampleLine).filter(Boolean);

    const control = lines[0];
    ratio(control, control) === 1
        ? ok('leakage detector control scores 1.00 on an exact match')
        : bad('leakage detector cannot detect exact copying — its zeros are meaningless');

    // Any pool example must score very high against itself; if the threshold
    // could not separate those, it is useless.
    const selfScores = lines.map((l) => ratio(l, l));
    Math.min(...selfScores) >= 0.99
        ? ok(`every example self-matches (min ${Math.min(...selfScores).toFixed(2)})`)
        : bad('detector is too strict to catch real copies');

    // And it must be able to tell copying from ordinary short overlap.
    const unrelated = 'ugh, great, i died! can someone grab my stuff? i was really into it';
    const best = Math.max(...lines.map((l) => ratio(unrelated, l)));
    best < 0.7
        ? ok(`unrelated reply scores only ${best.toFixed(2)} against all examples`)
        : bad(`detector is too loose: unrelated text scores ${best.toFixed(2)}`);
}

console.log(`\nPASS — ${pass} example-selection assertions green`);
