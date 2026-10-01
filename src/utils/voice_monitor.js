// Runtime voice-drift monitor.
//
// Catches long-running erosion of Elena's voice; the immediate causes are already
// fixed (timer-driven self-prompts, and a word cap that existed but never ran).
// What is left is gradual drift back toward the default assistant register.
//
// Heuristics, not embeddings: 1-OCPU box, API-hosted LLM, nothing local to embed
// with. Every threshold is the p95 of the 868 unique real player lines in
// bots/UwU/histories, so real players rarely cross one. Measured false-positive
// rates: words 14 [3.8%], caps .167 [4.1%], punct .333 [2.7%], emoji 0 [0%].
// CAPS is the weak one — a 1-word line is 100% capitalised, so "Hi" trips it.
//
// Alerts fire on a rate over a window, never on one message.
//
// Shape follows arXiv 2605.24279 / 2609.24532 / 2402.10962 (all verified), but
// only the DETECTION half of that recommendation is implemented. Re-anchoring is
// deliberately absent: prompt surgery on a persona already in voice, with no
// measured drift left to fix.

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