// Tilt: she dies, gets frustrated, and it comes out the way it comes out.
//
// The owner: "maybe she dies and she like fuxk, or fuxk this shit game. maybe she
// rages and spams characters like smashing keyboard or leaves and comes back
// later."
//
// Tilt has to be a STATE, not a mood word in a prompt. The reason is that the
// three behaviours above are causally linked - dying raises tilt, high tilt
// changes what she says AND makes her more likely to leave AND makes her more
// likely to come back angrier. Prompting "sometimes be frustrated" produces a
// bot that is cheerful and briefly rude, which is worse than a bot that is
// never frustrated, because it is inconsistent rather than calm.
//
// The shape is taken from how anger actually works, and the numbers are chosen
// so the arc reads as a person losing their temper rather than a switch turning
// on:
//
//   - Tilt is 0..1 and RISES on events (death, being mocked, losing, being
//     griefed, a bad build being praised), with diminishing returns - the tenth
//     death in a row does not make her angrier than the fifth, which is why
//     people stop swearing after a while.
//   - It DECAYS on a half-life, so a death matters for a minute and not for an
//     hour. Otherwise one death would put her in a bad mood all evening.
//   - Speech CHANGES with it, and this is the part that matters: the words get
//     shorter and dumber, caps creep in, and she stops being charming. A
//     furious person is not more articulate, they are less.
//   - She leaves WHEN TILT IS HIGH, not randomly - that is what makes the
//     absence read as consequence rather than as a random excuse, and it
//     connects to utils/life_state.js: she does not go "brb wc" while raging.
//
// Everything here is a SUGGESTION to the model, never a filter. Whether a
// message is actually angry is a judgement, and the deterministic side of this
// file only decides whether to SUGGEST it.

const HALF_LIFE_MS = 90000;   // ~90s to lose half your temper, like a person
const MAX_GAIN = 0.34;        // per event, so nothing maxes out from one death

// Weight by how much a real player actually cares. Dying to a creeper you
// personally walked into is barely worth mentioning; dying to someone else's
// grief is a different ten minutes.
const EVENTS = {
    death: 0.30,
    death_repeat: 0.12,   // diminishing: the 6th death is not the 1st
    mocked: 0.26,
    griefed: 0.34,
    lost: 0.22,           // lost something that mattered
    robbed: 0.30,
    bad_build_praised: 0.14,
    lag_or_crash: 0.24,
    interrupted: 0.10,
    provoked: 0.20,       // someone being deliberately a dick
};

export class Tilt {
    constructor() {
        this.level = 0;
        this.lastEvent = null;
        this.deathsInARow = 0;
        this.dead = false;
    }

    /** Raise tilt. Diminishing returns on repeated identical events. */
    note(kind, opts = {}) {
        if (kind === 'death') {
            this.deathsInARow++;
            // 0.30, then 0.12 each time after - the shape of someone who stops
            // being surprised and starts being resigned, then sweary.
            const gain = this.deathsInARow === 1 ? EVENTS.death : EVENTS.death_repeat;
            this.level = Math.min(1, this.level + gain);
        } else {
            let gain = EVENTS[kind] ?? 0.1;
            if (kind === this.lastEvent) gain *= 0.5;   // same thing twice in a row
            this.level = Math.min(1, this.level + gain);
        }
        this.lastEvent = kind;
        if (kind === 'death' || kind === 'griefed') this.dead = true;
        return this.level;
    }

    /** Decay toward calm on a half-life. Called from the tick. */
    decay() {
        if (this.level <= 0) { this.level = 0; return 0; }
        const dt = (this._now ?? Date.now()) - (this._last ?? Date.now());
        this._last = Date.now();
        if (dt > 0) this.level *= Math.pow(0.5, dt / HALF_LIFE_MS);
        return this.level;
    }

    tick() { this._now = Date.now(); this.decay(); return this.level; }

    get isRaging() { return this.level >= 0.5; }
    get isTilted() { return this.level >= 0.2; }
    get isCalm() { return this.level < 0.12; }

    /** How she talks right now, as guidance for the model. */
    styleHint() {
        if (!this.isTilted) return null;
        const l = this.level;
        if (l >= 0.75) {
            return `You are RAGING. Swearing, short, ugly sentences. No jokes, no charm, `
                + `no trying to be funny - a furious person is not witty, they are just loud. `
                + `Caps creep in. "FUCK", "this is fucking broken", "im done", "wtf". `
                + `You might be typing mostly out of anger rather than to say anything.`;
        }
        if (l >= 0.5) {
            return `You are annoyed and it is leaking into how you type. Swearing is normal, `
                + `blunt and dismissive, complaining about the game. Short. `
                + `"this is stupid", "again?", "im so tired of this", "fucking finally".`;
        }
        return `You are a bit fed up. A little more clipped than usual, mild swearing, `
            + `complaining rather than joking. Still yourself, just less patient.`;
    }

    /**
     * Is she the kind to storm off right now? Tilt-driven, and it overlaps with
     * LifeState - the two are separate because she can leave WITHOUT being
     * angry (bathroom) and be angry WITHOUT leaving.
     */
    wantsToLeave() {
        if (!this.isRaging) return false;
        // Roughly: 1 in 3 ticks while raging, and more the angrier she is.
        const p = 0.10 + this.level * 0.25;
        return Math.random() < p;
    }

    /** Coming back from a rage-quit is not the same as coming back from the wc. */
    returnStyle() {
        return this.isRaging
            ? 'back, still pissed, probably blaming something'
            : 'back, calmer, maybe a bit sheepish about storming off';
    }
}

export { EVENTS, HALF_LIFE_MS };
