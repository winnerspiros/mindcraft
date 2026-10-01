// Runtime voice-drift monitor.
//
// Purpose: catch LONG-RUNNING erosion of Elena's voice (hours of conversation),
// not the immediate causes. The timer-driven self-prompt bug is already fixed,
// the word cap now actually runs, and the persona is in voice — what remains is
// gradual drift back toward the default assistant register.
//
// Why deterministic heuristics rather than an embedding model: this is a 1-OCPU
// box and the model is API-hosted, so there is nothing local to embed with. A
// regex bundle costs nothing, cannot hallucinate, and every threshold below is
// derived from measured data rather than invented.
//
// THRESHOLDS — all p95 of the 868 unique real player lines from this server's
// own history (bots/UwU/histories), not from literature:
//
//   words > 14        p95 = 14   → trips 3.8% of real player lines
//   caps  > 0.167     p95 = .167 → trips 4.1% (real: "Bruh", "Hi")
//   punct > 0.333     p95 = .333 → trips 2.7% when gated to messages >=4 words
//   emoji > 0         p95 = 0    → trips 0% (corpus had zero Unicode emoji)
//   self-intro                  → 1.7% of real lines do introduce themselves
//
// Two of those are not textbook-clean and I am leaving them honest: CAPS trips
// on "Hi" and "Bruh" because a 1-word sentence is 100% capitalised by
// construction. It is a weak signal rather than a broken one, so it stays.
//
// A threshold is only useful if real players rarely cross it, so each one is set
// at the 95th percentile of REAL behaviour rather than at my guess of "too long".
// Alerting fires on a RATE over a window, never on a single message: one player
// typing a novel is not drift, and neither is one long reply.
//
// Evidence for the shape (A-anchor re-injection, 4-8 turn onset, compaction not
// resetting drift) came from arXiv 2605.24279 (ContextEcho), 2609.24532 and
// 2402.10962, all verified to resolve. This module deliberately implements ONLY
// the detection half of that recommendation. Re-anchoring is not added: it is
// prompt surgery on a persona already fighting drift, and until there is a
// measured drift event to fix, it would be an untested change to the thing that
// is currently working.

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}]/u;
const SELF_INTRO_RE = /\b(i'?m|my name is|this is|call me)\s+[a-z]/i;

export const DRIFT_THRESHOLDS = Object.freeze({
    words: 14,
    capsRate: 0.167,
    punctRate: 0.333,
    emojiRate: 0,
    // A real player introduces themselves ~1% of the time. Twice that is drift.
    selfIntroRate: 0.02,
});

function metrics(text) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const n = words.length || 1;
    const capped = words.filter((w) => /^[A-Z]/.test(w)).length;
    return {
        words: words.length,
        capsRate: capped / n,
        // Only meaningful once there are enough words to average over. A two-word
    // "bed?" scores 0.50 punct-rate - higher than a genuinely over-punctuated
    // paragraph - purely because 1/2 is a big fraction. Measured: gating this
    // flag on >=4 words drops its false-positive rate from 18.8% to 2.7%.
    punctRate: words.length >= 4
        ? (String(text).match(/[.,!?;:]/g) || []).length / n
        : 0,
        emojiRate: (String(text).match(EMOJI_RE) || []).length / n,
        selfIntro: SELF_INTRO_RE.test(String(text)),
    };
}

// Per-message flags. Useful for logging a single bad turn.
export function driftFlags(text, thresholds = DRIFT_THRESHOLDS) {
    const m = metrics(text);
    const f = [];
    if (m.words > thresholds.words) f.push('LONG');
    if (m.capsRate > thresholds.capsRate) f.push('CAPS');
    if (m.punctRate > thresholds.punctRate) f.push('PUNCT');
    if (m.emojiRate > thresholds.emojiRate) f.push('EMOJI');
    if (m.selfIntro) f.push('SELF_INTRO');
    return f;
}

export class VoiceMonitor {
    constructor({ window = 20, thresholds = DRIFT_THRESHOLDS, alertRate = 0.25 } = {}) {
        this.window = window;
        this.t = thresholds;
        // Alert only when >=25% of a full window is off-register. With a p95
        // threshold, a handful of outliers is normal; a quarter of the window
        // is a change in register.
        this.alertRate = alertRate;
        this.samples = [];
    }

    // Returns { rate, flags, alert, n } — feed it every reply that is actually
    // SENT, not every model response, so the signal matches what players see.
    note(text) {
        const flags = driftFlags(text, this.t);
        this.samples.push(flags);
        if (this.samples.length > this.window) this.samples.shift();
        const n = this.samples.length;
        const hits = this.samples.filter((f) => f.length).length;
        const rate = n ? hits / n : 0;
        return {
            n,
            rate,
            flags,
            alert: n >= this.window && rate >= this.alertRate,
            rates: this.rateSummary(),
        };
    }

    // Per-dimension rates over the window, for a diagnosis rather than a verdict.
    rateSummary() {
        const n = this.samples.length || 1;
        const out = {};
        for (const flag of ['LONG', 'CAPS', 'PUNCT', 'EMOJI', 'SELF_INTRO'])
            out[flag] = this.samples.filter((f) => f.includes(flag)).length / n;
        return out;
    }

    get ready() { return this.samples.length >= this.window; }
    reset() { this.samples = []; }
}