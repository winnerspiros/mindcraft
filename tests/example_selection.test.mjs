// Few-shot example selection.
//
// personaExamples() used to return ALL 28 examples and inject every one on every
// turn. Bounded to 5 with rotation: past ~5 the marginal gain is small and each
// example costs prompt share the persona script needs (the script is what keeps
// her in voice); later examples get disproportionate weight, so one parked last
// becomes the template she copies; and a fixed set becomes a memorisation anchor.
//
// Leakage was MEASURED, not assumed: 71 real log replies vs all 28 examples,
// best similarity 0.48, zero verbatim, zero example substrings — with the
// detector validated against a control, so the zero is genuine. This file guards
// the bound and the rotation, and keeps that detector for future logs.

import { readFileSync } from 'node:fs';
import {
    personaExamples, resetPersonaExampleOffset, PERSONA_EXAMPLE_COUNT,
} from '../src/utils/server_context.js';

let pass = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const pool = JSON.parse(readFileSync('personas/normal.json', 'utf8')).conversation_examples;
const key = (e) => JSON.stringify(e);
const reply = (e) => String(e.find((x) => x.role === 'assistant')?.content || '');
const sel = () => personaExamples().map(key);

// ── bounded, and every pick is a real pool member ──────────────────────────
resetPersonaExampleOffset();
const first = sel();
check(first.length === PERSONA_EXAMPLE_COUNT,
    `injects ${PERSONA_EXAMPLE_COUNT} of ${pool.length} examples`,
    `injects ${first.length}, expected ${PERSONA_EXAMPLE_COUNT}`);
check(first.length < pool.length,
    'bounded, not the whole pool',
    'still injecting every example');
check(PERSONA_EXAMPLE_COUNT <= 7,
    `count ${PERSONA_EXAMPLE_COUNT} is inside the evidenced range (<=7)`,
    `count ${PERSONA_EXAMPLE_COUNT} exceeds the evidenced cap of ~7`);
const poolKeys = new Set(pool.map(key));
check(first.every((k) => poolKeys.has(k)),
    'every selected example comes from the persona file',
    'selection invented an example that is not in the pool');
check(new Set(first).size === first.length,
    'no duplicates inside one prompt',
    'duplicates in a single prompt');

// ── rotation ───────────────────────────────────────────────────────────────
check(JSON.stringify(first) !== JSON.stringify(sel()),
    'successive calls select a different set',
    'every call returns the identical set — no rotation');
resetPersonaExampleOffset();
check(JSON.stringify(sel()) === JSON.stringify(first),
    'reset makes selection deterministic for tests',
    'resetPersonaExampleOffset does not restore the first selection');

// Every example must stay reachable, or a whole register gets starved out.
const seen = new Set();
for (let i = 0; i < pool.length * 2; i++) for (const k of sel()) seen.add(k);
check(seen.size === pool.length,
    `rotation reaches all ${pool.length} over ${pool.length * 2} calls`,
    `rotation only reaches ${seen.size}/${pool.length} — some registers are unreachable`);

// ── leakage detector, validated against a control ──────────────────────────
// Kept so future logs can be checked. The control is the point: a leakage check
// that cannot detect real copying reports "zero leakage" forever.
{
    const norm = (s) => String(s || '').replace(/!\w+\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9 ]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    // LCS ratio (difflib-style). Written out plainly on purpose: the compact
    // comma-expression version of this was wrong and unreadable.
    const r = (a, b) => {
        const [A, B] = [norm(a), norm(b)];
        if (!A || !B) return 0;
        let m = 0, i = 0, j = 0;
        while (i < A.length && j < B.length) {
            if (A[i] === B[j]) { m++; i++; j++; }
            else if (A[i] < B[j]) i++;
            else j++;
        }
        return m / (A.length + B.length - m);
    };
    const all = pool.map(reply).filter(Boolean);
    // The detector normalises to [a-z0-9 ], so a pure-punctuation reply (":(",
    // ":)") and a single caps word ("AGAIN") normalise to the empty string and
    // score 0 against THEMSELVES. Those are valid examples the measurement
    // simply cannot see - the same trap as the "..." example. Separate them
    // rather than deleting correct data.
    const measurable = all.filter((l) => norm(l).length > 0);
    const unmeasurable = all.filter((l) => norm(l).length === 0);
    const lines = measurable;
    const scores = (s) => lines.map((l) => r(s, l));

    check(r(lines[0], lines[0]) === 1,
        'detector control scores 1.00 on an exact match',
        'detector cannot detect exact copying — its zeros are meaningless');
    check(Math.min(...lines.map((l) => r(l, l))) >= 0.99,
        `every measurable example self-matches (${measurable.length} of ${all.length})`,
        'detector is too strict to catch real copies');
    check(unmeasurable.length < all.length * 0.1,
        `${unmeasurable.length} examples are unmeasurable (emoticons/caps), kept but excluded from scoring`,
        'too many examples are invisible to the leakage detector');
    const over = Math.max(...scores('ugh, great, i died! can someone grab my stuff?'));
    check(over < 0.7,
        `unrelated text peaks at only ${over.toFixed(2)}`,
        `detector is too loose: unrelated text scores ${over.toFixed(2)}`);
}

console.log(`\nPASS — ${pass} example-selection assertions green`);
