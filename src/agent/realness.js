// UwU's "realness" meter — how far the *current* conversation has drifted out
// of the Minecraft roleplay into the real world / fourth wall.
//
// Deterministic and zero-LLM, like psyche/relationship, but IN-MEMORY ONLY:
// it describes the live conversation, so it must reset on restart (a fresh
// session shouldn't boot up already "deep in real-world mode").
//
// When it's high, her prompt (via $REALNESS) tells her to drop most of the
// kawaii performance and talk/act like a serious, grounded real person.
// The signals here are neutral observations (a phrase hit, a real-world tool
// call) — the meter only modulates her *tone*; the words stay entirely hers.

const REAL_WORLD_PATTERNS = [
    /are you (real|a bot|an ai|actually real|a real person|human|a program|an npc)/i,
    /(you'?re|ur|you are) (just )?(a |an )?(bot|ai|robot|computer|program|code|npc|fake|not real)/i,
    /(is (this|it) (real|ai|a bot))|(you exist (irl|in real life))/i,
    /(irl|in real life|real life|real world|the real world|real talk)/i,
    /my (real|actual|irl) name/i,
    /what'?s (your|the) (real|actual) name/i,
    /where (are|do) you (live|from)|where are you located/i,
    /how old are you/i,
    /what (time|day|date) is it|what'?s the (time|date)/i,
    /\bweather\b/i,
    /(meet ?up|hang ?out|grab a (drink|beer|coffee)|go for a (drink|beer|coffee)|visit (me|you)|come (over|to (my|our) (city|town|place)))/i,
    /(my (city|town|country|day|job|work|school|weekend|plans|address))/i,
    /(i live in|i'?m from|my country is)/i,
    /\b(beer|coffee|pub|bar|cafe|restaurant)\b/i,
    /(real (name|place|world|life|location|address|city))/i,
];

// A direct challenge to her existence — "prove it", "you're fake". Distinct from
// merely drifting real-world: this is a player testing/disbelieving her.
const EXISTENCE_CHALLENGE = [
    /prove (it|you exist|you'?re real|you are real|that you exist|that you'?re real)/i,
    /(you'?re|ur|you are) (not real|fake|lying|a liar|made up|just a bot)/i,
    /(no you'?re not|you don'?t exist|you can'?t (prove|be) (it|real))/i,
    /(show me (proof|evidence)|prove it)/i,
];

// Tool calls that reach into the real world — strong signal she's gone there.
const REAL_WORLD_COMMANDS = new Set(['!realtime', '!weather', '!findplace', '!websearch']);

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export class RealnessTracker {
    constructor(agent) {
        this.agent = agent;
        this.value = 0;            // 0 = full kawaii in-game, 1 = deep real-world talk
        this._lastNudge = Date.now();
    }

    onMessage(text, username) {
        if (!text) return;
        const t = String(text);
        if (REAL_WORLD_PATTERNS.some((re) => re.test(t))) {
            this._bump(0.22);
        }
        // A challenge to her existence wears on her: feed the SAME mood +
        // relationship meters everyone else uses, so a player can genuinely
        // annoy her (not just trigger sweetness).
        if (EXISTENCE_CHALLENGE.some((re) => re.test(t))) {
            this._bump(0.30);
            try {
                if (username) this.agent.relationship?.adjust(username, { annoyance: 6 });
                this.agent.psyche?.onPestered?.();
            } catch { /* meters are best-effort */ }
        }
    }

    onCommand(name) {
        if (REAL_WORLD_COMMANDS.has(String(name).toLowerCase())) {
            this._bump(0.30);
        }
    }

    _bump(amt) {
        this.value = clamp(this.value + amt);
        this._lastNudge = Date.now();
    }

    // Decay toward 0 with ~4-minute half-life — the meter tracks the *live*
    // conversation, so it fades once players return to in-game talk.
    update(delta) {
        if (this.value <= 0) return;
        const k = 1 - Math.exp(-delta / 240000);
        this.value = clamp(this.value * (1 - k));
    }

    // Prompt surface for $REALNESS. Empty when still comfortably in-game;
    // a tone directive (never scripted dialogue) once the talk has gone real.
    summarize() {
        if (this.value < 0.30) return '';
        if (this.value < 0.65) {
            return `Realness meter ${this.value.toFixed(2)}: a real-world thread is opening up. Ease off the cutesy act a little — sound more like a real, sincere person while staying yourself.`;
        }
        return `Realness meter ${this.value.toFixed(2)}: this has become a real-world conversation. Drop most of the kawaii performance and talk/act like a serious, grounded, real person — plain, sincere, present. Still you, just real.`;
    }
}
