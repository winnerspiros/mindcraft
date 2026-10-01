// Reply latency must match the measured shape of human response latency.
//
// Kalman, Ravid, Raban & Rafaeli, "Are you still waiting for an answer? The
// Chronemics of Asynchronous Written CMC": 170,000+ responses, three corpora
// (Enron email n=..., university forum, Google Answers), 7+ years. Fitted
// power-law exponents -1.74 to -2.04 with R2 0.947-0.958, and the two shape
// facts that matter:
//
//   - 70-80% of pauses are SHORTER THAN THE MEAN
//   - at least 96% fall within 10x the mean
//   - per-user too: 70% within that user's mean, 96% within 10x it
//
// The previous log-uniform sampler put only 60% of draws below the mean, so it
// under-served short replies and over-spread the tail. This pins the shape so
// it cannot drift back to something merely plausible-looking.
//
// Also pinned from Stivers et al. 2009 (PNAS 106(26):10587-10592, 10
// languages): the cross-language mean turn-transition gap is +208 ms, and
// DISCONFIRMATIONS are systematically SLOWER than confirmations. That is
// spoken conversation, not chat - it is cited here only as the reason a
// disagreement should not be answered faster than an agreement.

import { SelfPrompter } from '../src/agent/self_prompter.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const sp = new SelfPrompter({ name: 'UwU', bot: null });

const draw = (n, solo) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(sp._jitteredGear(solo));
    return out.sort((a, b) => a - b);
};
const N = 200000;

// ── the measured shape, for both gears ───────────────────────────────────
for (const [label, solo] of [['chatty', false], ['solo', true]]) {
    const d = draw(N, solo);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const fracBelow = d.filter((x) => x <= mean).length / d.length;
    const frac10 = d.filter((x) => x <= 10 * mean).length / d.length;

    check(fracBelow >= 0.65 && fracBelow <= 0.85,
        `${label}: ${(fracBelow * 100).toFixed(0)}% of gaps are below the mean (paper: 70-80%)`,
        `${label}: only ${(fracBelow * 100).toFixed(0)}% below the mean, paper says 70-80%`);
    check(frac10 >= 0.96,
        `${label}: ${(frac10 * 100).toFixed(0)}% within 10x the mean (paper: >=96%)`,
        `${label}: only ${(frac10 * 100).toFixed(0)}% within 10x the mean`);

    // The tail must exist. A bot that answers at a constant pace is the tell.
    const p50 = d[Math.floor(N * 0.5)];
    const p95 = d[Math.floor(N * 0.95)];
    check(p95 > 2 * p50,
        `${label}: p95 (${(p95 / 1000).toFixed(0)}s) is well above p50 (${(p50 / 1000).toFixed(0)}s)`,
        `${label}: distribution too flat - p95 ${p95 / 1000}s vs p50 ${p50 / 1000}s`);

    // Consecutive gaps must not be near-identical.
    const cv = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length) / mean;
    check(cv > 0.5, `${label}: coefficient of variation ${cv.toFixed(2)}`,
        `${label}: CV ${cv.toFixed(2)} - too regular to be human`);
}

// ── bounded: a power law is unbounded, but she cannot go silent for an hour ─
{
    // Read the cap from the instance rather than hardcoding 95000 - when I
    // widened the ceiling to 400s to let the power law breathe, this assertion
    // failed against a stale literal and was measuring nothing real.
    const d = draw(N, false);
    check(d[d.length - 1] <= sp.gear_chatty_max + 1,
        `chatty gear is capped at its max (${(d[d.length - 1] / 1000).toFixed(0)}s, cap ${sp.gear_chatty_max / 1000}s)`,
        `chatty gear exceeded its cap: ${d[d.length - 1]}ms > ${sp.gear_chatty_max}ms`);
    check(d[0] > 0, 'no zero or negative gaps', 'produced a non-positive gap');
    check(d.every((x) => Number.isInteger(x) && x > 0), 'all gaps are positive integers',
        'produced a non-integer or non-positive gap');
}

// ── the exponent is the paper's, not a tuned guess ──────────────────────
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/agent/self_prompter.js', 'utf8');
    check(/TURN_TAKING_ALPHA = 1\.74/.test(src),
        'uses the fitted exponent 1.74 from the paper', 'exponent is not the published value');
    check(/Kalman/.test(src) && /Chronemics/.test(src),
        'the source cites the paper it was calibrated from', 'no citation in the source');
    // A uniform spread would be the fallback if someone reverted to flat timing.
    check(/Math\.random\(\)/.test(src) && /1 - Math\.random\(\)/.test(src),
        'sampling is a power-law inverse CDF, not a flat or linear spread',
        'sampling no longer looks like a power law');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} response-latency distribution assertions green`);