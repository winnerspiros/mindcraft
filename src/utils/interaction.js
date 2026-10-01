// "interactions can be to help player also, fuck them up, grief them, give them
//  items, help them build, destroy what they doing. whatever.. all these are
//  interactions"
//
// A correction I needed: I had reduced interaction to TALKING. That is too narrow,
// and it quietly turned "she is self-centered" into "she ignores people" - when
// the owner's meaning is "she has her own agenda, and that agenda may well involve
// them".
//
// A player building a wall while another player mines the same block is
// INTERACTING, adversely. Griefing is engagement. Handing someone an item is
// engagement. Knocking their scaffolding down is engagement. None of those need a
// word to be said, so the message router - which only sees chat - cannot detect
// any of them, and until now nothing could.
//
// This reads the world events that ALREADY EXIST (src/agent/player_activity.js
// binds blockBreakProgressEnd, blockUpdate, entitySwingArm, entityHurt,
// playerCollect, itemDrop) and asks one question about each: is this act aimed at
// HER, at her work, or at neither?
//
// Three things it deliberately does not do:
//   - no phrase tables and no item-name allowlist for "griefing". Whether a block
//     break is griefing depends on WHOSE block it was, not on what it was.
//   - no action is emitted. This classifies; the bot and its skills decide what to
//     do about it, exactly as for anything else it observes.
//   - no confidence theatre. An unknown act is UNKNOWN, not negative.

/** How an act relates to her. */
export const RELATION = {
    /** not about her at all */
    NONE: 'none',
    /** touching her, her inventory, or her position directly */
    AT_HER: 'at_her',
    /** on the structure she is working on */
    HER_WORK: 'her_work',
    /** on the same thing she is working on, alongside her */
    SHARED: 'shared',
    /** cannot be placed - not enough information */
    UNKNOWN: 'unknown',
};

/** How far a block act still concerns her, in blocks. */
const AT_HER_BLOCKS = 2.5;      // right where she is standing
const WORK_BLOCKS = 6;          // her build, close enough to be about it
const SHARED_BLOCKS = 10;       // same area, working alongside
const RECENCY_MS = 12000;       // an act this old is history, not interaction

/**
 * Classify one observed act.
 *
 * @param {object} a
 * @param {number[]} [a.blockPos]      where the block act happened
 * @param {number[]} [a.herPos]        where she is
 * @param {number[]} [a.herWorkPos]    what she is building/standing on
 * @param {boolean}  [a.blockRemoved]  true = broken, false = placed
 * @param {boolean}  [a.was_her_block] the block was one SHE placed
 * @param {boolean}  [a.hit_her]       the act was damage to her
 * @param {boolean}  [a.gave_her_item] an item was handed to her
 * @param {boolean}  [a.took_her_item] an item left her inventory
 * @param {number}   [a.now]
 * @returns {{relation: string, valence: number, why: string}}
 */
export function classifyAct(a = {}) {
    const now = a.now ?? Date.now();
    if (a.at && now - a.at > RECENCY_MS) {
        return { relation: RELATION.NONE, valence: 0, why: 'too_old' };
    }

    // Direct bodily / inventory contact. Unambiguous, and the strongest evidence
    // there is, because it involves her person or her things rather than a
    // coordinate.
    if (a.hit_her) return { relation: RELATION.AT_HER, valence: -1, why: 'hit_her' };
    if (a.gave_her_item) return { relation: RELATION.AT_HER, valence: 1, why: 'gave_her_something' };
    if (a.took_her_item) return { relation: RELATION.AT_HER, valence: -1, why: 'took_from_her' };

    // No position at all: say so rather than guessing. The watcher binds events
    // whose payloads vary by version (26.3 differs from 26.2), and a missing
    // position is the common case for some of them.
    if (!Array.isArray(a.blockPos) || !Array.isArray(a.herPos)) {
        return { relation: RELATION.UNKNOWN, valence: 0, why: 'no_position' };
    }

    const d = dist(a.blockPos, a.herPos);

    if (d <= AT_HER_BLOCKS) {
        // A block broken right where she is standing is interference unless it was
        // hers and she is taking it down herself - which the caller cannot be sure
        // of, so it is left as at_her and the valence carries the uncertainty.
        return {
            relation: RELATION.AT_HER,
            valence: a.blockRemoved ? -1 : 1,
            why: `right where she is (${d.toFixed(1)} blocks)`,
        };
    }

    // HER OWN WORK. This is the case that decides griefing, and the reason this
    // module exists: whether a break is griefing depends on WHOSE block it was,
    // not on what it was. Breaking a block she placed is interference; breaking
    // any other block near her is just mining.
    if (a.was_her_block && Array.isArray(a.herWorkPos)) {
        const dw = dist(a.blockPos, a.herWorkPos);
        if (dw <= WORK_BLOCKS) {
            return {
                relation: RELATION.HER_WORK,
                valence: a.blockRemoved ? -1 : 1,
                why: `her own block (${dw.toFixed(1)} blocks from her work)`,
            };
        }
    }

    if (d <= SHARED_BLOCKS) {
        return {
            relation: RELATION.SHARED,
            valence: 1,
            why: `same area, not hers (${d.toFixed(1)} blocks)`,
        };
    }

    return { relation: RELATION.NONE, valence: 0, why: 'elsewhere' };
}

function dist(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.hypot(dx, dy, dz);
}

/**
 * Fold recent acts into the flags assessEngagement() consumes.
 *
 * Deliberately stateful and short-window: this is "what has been happening around
 * her in the last few seconds", not a running tally. Griefing someone once an hour
 * is not a relationship, and a tally would make it one.
 */
export class InteractionTracker {
    constructor() {
        this.recent = [];   // {relation, valence, at}
        this.lastHelp = 0;
        this.lastHarm = 0;
    }

    /** @param {object} act passed straight to classifyAct */
    note(act = {}) {
        const now = act.now ?? Date.now();
        const v = classifyAct({ ...act, now });
        if (v.relation === RELATION.UNKNOWN || v.relation === RELATION.NONE) return v;
        this.recent.push({ relation: v.relation, valence: v.valence, at: now });
        if (v.valence > 0) this.lastHelp = now;
        if (v.valence < 0) this.lastHarm = now;
        this._prune(now);
        return v;
    }

    _prune(now) {
        this.recent = this.recent.filter((r) => now - r.at <= RECENCY_MS);
    }

    /**
     * The flags assessEngagement() wants. Every default is false, so a tracker
     * with no data can never manufacture interaction.
     */
    flags(now = Date.now()) {
        this._prune(now);
        const harm = this.recent.some((r) => r.valence < 0);
        // Positive valence IS helping, including at_her - being handed something
        // is unambiguously helping. My first version filtered every AT_HER act out
        // of `help`, intending to exclude the NEGATIVE at_her acts (hit, item
        // taken) but excluding the gift too, so handing her an item reported
        // helping:false. Filter on the sign, not on the relation.
        const help = this.recent.some((r) => r.valence > 0);
        const shared = this.recent.some((r) => r.relation === RELATION.SHARED);
        return {
            interfering: harm,
            helping: help && !harm,
            coordinating: shared && !harm,
            at_her: this.recent.some((r) => r.relation === RELATION.AT_HER),
            _recent: this.recent.length,
        };
    }
}

export { AT_HER_BLOCKS, WORK_BLOCKS, SHARED_BLOCKS, RECENCY_MS };
