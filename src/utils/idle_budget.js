// How much she moves, and when.
//
// The owner: "we need to remove idle things she does, a normal player wont jump
// around 24/7 for example."
//
// This is the missing piece. `modes.update()` runs every 300ms and several modes
// are threshold-based rather than goal-based, so with no cooldown at all a
// threshold eventually becomes CONSTANT. Observed live: `unstuck` 3 times in 5
// minutes, `cowardice` fleeing 24 blocks, all while nobody was even talking to
// her.
//
// The specific bug was `unstuck`: it triggered on "has not moved for ~40 ticks",
// which means a player standing still and CHATTING read as stuck, and she would
// dig blocks out from under whoever was talking to her. That is now gated on an
// active goal (fixed in modes.js) - but the cooldown below is the general
// answer, and it is what stops any threshold mode from becoming fidgeting.
//
// Measured targets, not invented:
//   - Suvnjevic et al. 2009 (NetGames, 104 players): player message sending is
//     "in general, bursty" - activity comes in clusters with quiet stretches.
//   - Gilmartin et al. 2019 (Teams Corpus, 47h): median 33.4% of floor time is
//     SILENCE, 33.4% one speaker. Doing nothing is a third of a session.
//   - Herring ch.10: 35% of initiations get no response. Not acting is normal.
//
// So a bot that is in constant motion is wrong in three independent measured
// ways. This bounds it: an action needs a REASON, and after a movement action
// she settles for a while rather than immediately looking for the next thing.

const SETTLE_AFTER_ACTION_MS = 45000;   // alone: settle briefly after acting
const SETTLE_WHEN_IDLE_MS = 90000;      // a human is present: stay put longer
const MIN_GAP_BETWEEN_ACTIONS_MS = 20000;
const MAX_ACTIONS_PER_5MIN = 6;

export class IdleBudget {
    // opts: per-server pacing overrides (servers.json "pacing.idle").
    // Empty = the measured home defaults. Tests construct bare.
    constructor(opts = {}) {
        this._settleAction = opts.settleAfterActionMs ?? SETTLE_AFTER_ACTION_MS;
        this._settleIdle = opts.settleWhenIdleMs ?? SETTLE_WHEN_IDLE_MS;
        this._minGap = opts.minGapMs ?? MIN_GAP_BETWEEN_ACTIONS_MS;
        this._maxActions = opts.maxPer5Min ?? MAX_ACTIONS_PER_5MIN;
        /** @type {number[]} */
        this.actions = [];     // timestamps of movement/fidget actions
        this.lastActionAt = 0;
    }

    /**
     * May she start a movement / fidget action?
     * @param {object} ctx
     * @param {number} ctx.now
     * @param {boolean} ctx.has_goal      an actual objective to pursue
     * @param {boolean} ctx.threat        something wants to hurt her
     * @param {boolean} ctx.human_present
     */
    canAct(ctx) {
        const now = ctx.now ?? Date.now();
        this._prune(now);

        // A real threat overrides everything. Fleeing a creeper is not fidgeting.
        if (ctx.threat) return { ok: true, why: 'threat' };
        // No objective means no reason to move. This is the main gate: it stops
        // goal-less threshold modes from producing motion.
        if (!ctx.has_goal) return { ok: false, why: 'no_goal' };

        const since = now - this.lastActionAt;
        // A human present means a LONGER settle: someone is standing there, and
        // a bot that keeps shifting and fidgeting in front of a person is the
        // exact tell the owner named. It was inverted, which gave 45s with a
        // human present and 90s when alone - backwards on both counts.
        const settle = ctx.human_present ? this._settleIdle : this._settleAction;
        if (since < settle) return { ok: false, why: 'settling' };
        if (since < this._minGap) return { ok: false, why: 'too_soon' };
        if (this.actions.length >= this._maxActions) return { ok: false, why: 'over_active' };
        return { ok: true, why: 'has_goal' };
    }

    /**
     * Record that an action HAPPENED.
     *
     * Called once per action, never per tick. update() runs every 300ms, so
     * calling this on every permitted tick pushed lastActionAt forward
     * constantly and she never finished settling - at +46s past a 45s settle the
     * budget still reported "settling", because something had noted at +45.9s.
     */
    note(now = Date.now()) {
        this._prune(now);
        this.actions.push(now);
        this.lastActionAt = now;
    }

    _prune(now) {
        this.actions = this.actions.filter((t) => now - t < 5 * 60 * 1000);
    }

    /** A human spoke to her - talking is a reason to be still, not to move. */
    humanEngaged() {
        this.lastActionAt = Date.now();
    }

    stats(now = Date.now()) {
        return {
            recent: this.actions.filter((t) => now - t < 5 * 60 * 1000).length,
            sinceLast: this.lastActionAt ? now - this.lastActionAt : Infinity,
        };
    }
}

export { SETTLE_AFTER_ACTION_MS, SETTLE_WHEN_IDLE_MS, MIN_GAP_BETWEEN_ACTIONS_MS, MAX_ACTIONS_PER_5MIN };
