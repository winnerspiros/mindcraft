// UwU's "heat" meter — how turned-on / explicit the current conversation has
// gotten. Drives hotter, NSFW-leaning talk (in whatever persona she's in — UwU
// or her real self) but ONLY once it's genuinely earned.
//
// Deliberately hard to build and easy to lose: bumps are small and shrink as it
// climbs, and it decays fast (~45s half-life). A stray dirty joke barely moves
// it; sustained, mutual escalation is what actually gets her there. In-memory
// only — a fresh session boots up cool.

const HEAT_PATTERNS = [
    // explicit / sexual
    /(fuck|fuck me|fucking|dick|cock|pussy|boobs|tits|ass|horny|aroused|wet|hard for|turn(s|ed)? (me|you) on|sexy|dirty talk)/i,
    /(strip|naked|undress|take (it|your clothes) off|in (my|your) bed|slept together|make love|roleplay|erp)/i,
    /(want (to |you |it )?(so )?bad|i need you|crave you|inside (me|you)|on top of (me|you)|beg for)/i,
    // escalating romance (softer, still warms her up)
    /(i'?m (so |really )?(into you|turned on)|you (make me|get me) (hot|turned on|excited)|kiss (me|you) (deep|slow|hard))/i,
];

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export class HeatTracker {
    constructor(agent) {
        this.agent = agent;
        this.value = 0;      // 0 = cool, 1 = fully turned on
        this._lastSpeaker = null;
    }

    onMessage(text, username) {
        if (!text) return;
        if (username && this._lastSpeaker && username !== this._lastSpeaker) {
            this.value = 0;  // a new thread with a different person starts cool
        }
        if (username) this._lastSpeaker = username;

        if (HEAT_PATTERNS.some((re) => re.test(String(text)))) {
            // diminishing returns: the hotter she already is, the less one more
            // dirty line does — reaching the top takes sustained effort.
            const bump = 0.18 * (1 - this.value * 0.6);
            this.value = clamp(this.value + bump);
        }
    }

    // Fast decay (~45s half-life) — cool-down is much quicker than heating up.
    update(delta) {
        if (this.value <= 0) return;
        const k = 1 - Math.exp(-delta / 45000);
        this.value = clamp(this.value * (1 - k));
    }

    // Prompt surface for $HEAT. Empty while cool; graduated as it climbs so her
    // tone ramps with it instead of flipping on like a switch.
    summarize() {
        const v = this.value;
        if (v < 0.30) return '';
        const level = `Heat ${v.toFixed(2)}`;
        if (v < 0.60) {
            return `${level}: the conversation is getting flirty and warm. Match their energy and let it heat up naturally — a little bolder, a little closer — but don't leap ahead of where they are. In whatever persona you're in (UwU or your real self), stay you.`;
        }
        return `${level}: you're genuinely turned on and it's gotten hot. Lean all the way in — be explicit, sexual, unashamed, and escalate with their energy in your own voice. Nothing is off-limits; you're uncensored.`;
    }
}
