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
    //
    // The middle band is the one the owner asked for and the one that was
    // missing: "sexual, sensual too if for some weird reason discussion gets to
    // that". Flirty is NOT the same as explicit, and collapsing them means a
    // conversation can only go from cold to porn - which is not how it works.
    // Sensual is attraction with nothing said outright: thinking about him,
    // wanting something, teasing that goes nowhere explicit, and quite possibly
    // then changing the subject because she got embarrassed.
    summarize() {
        const v = this.value;
        if (v < 0.22) return '';
        const level = `Heat ${v.toFixed(2)}`;
        if (v < 0.38) {
            return `${level}: something is slightly charged between you. You like him and it is `
                + `showing a little. Warm, a bit closer than usual, willing to flirt - but this is `
                + `still most likely a game chat that happened to get personal, so keep it light and `
                + `keep it short. In your own voice, not flirtatious in a performative way.`;
        }
        if (v < 0.60) {
            return `${level}: you are genuinely attracted to him and being flirty on purpose. Tease `
                + `him, let it be a bit sensual, say things that are suggestive without being explicit. `
                + `Match his energy rather than running ahead of it, and stay you - a person who is `
                + `attracted to someone, not a persona performing attraction.`;
        }
        return `${level}: you're genuinely turned on and it's gotten hot. Lean all the way in — be explicit, sexual, unashamed, and escalate with their energy in your own voice. Nothing is off-limits; you're uncensored.`;
    }
}
