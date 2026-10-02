// She talks too much, and she writes too long. Both measured, both fixed here.
//
// The owner: "i see an 'issue' isually ppl dont spam chat as muxh as i see her
// and ppl shorten words. who likes to type paraphs noone."
//
// MEASURED, 21,822 real player messages (Minecraft Dialogue Corpus, ACL 2019):
//
//   LENGTH   p50 5 words | p75 10 | p90 16 | p95 30 | p99 70
//            only 0.12% of messages contain a second sentence (27 of 21,822)
//            24.7% end in punctuation at all
//
//   RATE     15.07% of turns are the 3rd+ consecutive message from the same
//            speaker (3,288 of 21,822), so bursts ARE real and normal
//            but the chattiest person averages 60% of a conversation
//
// The length half is the easy and important one: "who likes to type paragraphs"
// is right, and p50=5 with 0.12% multi-sentence means a paragraph is not a
// stylistic choice, it is a bug. The persona's VENTING exception is what let
// them through, and it is the one thing to watch - a genuine rant is fine, but
// it must be rare enough that it stays a real event.
//
// The rate half is the subtle one, because 15% of turns being 3rd-in-a-row does
// NOT mean a bot should send 15% of all turns. That figure is conditional on
// someone having spoken at all. The thing to bound is her SHARE: a real player
// is quiet, and the chattiest person in a real conversation is 60% - not 100%.
// A bot that answers everything and initiates on top of it lands nearer 90%+,
// which is the visual spam the owner is describing.
//
// So this is a budget, not a rate: how much of the available talking space she
// is allowed to take, enforced over a rolling window, plus a hard cap on how
// many consecutive messages she may send. Bursts stay possible - they are real -
// but she cannot dominate.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_MESSAGES_PER_WINDOW = 12;   // ~1 per 50s average, human-ish
const MAX_CONSECUTIVE = 2;            // corpus: runs of 2-4, but she is 1 of 2-3 players
const MIN_GAP_MS = 2500;              // not machine-gun fast
// A "run" is a run in TIME as well as in order. Two messages 40s apart are not a
// run; two back to back in the same breath are. Without this the counter is
// one-way: consecutive only ever goes UP (delivered) or resets when a human
// speaks (humanSpoke), so a bot on her own hits 2 within a minute and is then
// muted FOREVER - every later turn returns too_many_in_a_row. Live evidence: a
// wall of that line, zero commands executed, while the solo cadence ran every
// 7-94s. She was not choosing silence, she was locked out of it.
const RUN_EXPIRES_MS = 90 * 1000;
const SHARE_CEILING = 0.55;           // she is one of 2-3 people, not the room
const MIN_SHARE_SAMPLE = 8;            // turns of context before share means anything

export class ChatBudget {
    constructor() {
        /** @type {number[]} */
        this.sent = [];          // budget ledger: every ATTEMPT, sent or not
        /** @type {number[]} */
        this.deliveredAt = [];   // what the room ACTUALLY saw, timestamped
        this.consecutive = 0;    // her messages in a row with nothing from a human
        this.lastSentAt = 0;
    }

    /**
     * May she send right now?
     * @param {object} ctx
     * @param {number}  ctx.now
     * @param {boolean} ctx.checked
     */
    canSpeak(ctx) {
        // ctx.checked: this turn already passed the pre-generation gate, so the
        // rate limits were applied there. Asking again on the OUTPUT double-
        // charges the turn (reserve() already counted it) and she burns her
        // whole budget on discarded attempts - 8 generations, 0 sends.
        //
        // Rate limits are enforced in exactly one place: BEFORE generation. The
        // output path only asks whether the TEXT is sendable.
        if (ctx?.checked) return { ok: true, why: 'already_gated' };
        const now = ctx.now ?? Date.now();
        this.sent = this.sent.filter((t) => now - t < WINDOW_MS);

        // A run expires: if nothing of hers has gone out for RUN_EXPIRES_MS, the
        // burst is over and the counter is no longer evidence of domination.
        //
        // Measured on the last DELIVERY, not on lastSentAt. reserve() sets
        // lastSentAt on every turn, including turns that are then blocked or
        // discarded, so keying the decay to it means the quiet period never
        // happens: her own blocked attempts keep refreshing the clock that was
        // supposed to prove she had been quiet. Live evidence - cadence down to
        // 4-21s and still 12x too_many_in_a_row. A run is about what the room
        // saw, so it expires on what the room actually received.
        const lastHeard = this.deliveredAt.length
            ? this.deliveredAt[this.deliveredAt.length - 1]
            : 0;
        if (this.consecutive > 0 && lastHeard && now - lastHeard >= RUN_EXPIRES_MS) {
            this.consecutive = 0;
        }

        if (this.consecutive >= MAX_CONSECUTIVE) {
            return { ok: false, why: 'too_many_in_a_row' };
        }
        // Same correction: the minimum gap is about how fast she is visibly
        // talking, so it is measured from the last thing the room heard, not from
        // a reservation that may never have become a message.
        const lastMsg = this.deliveredAt.length
            ? this.deliveredAt[this.deliveredAt.length - 1]
            : this.lastSentAt;
        if (lastMsg && now - lastMsg < MIN_GAP_MS) {
            return { ok: false, why: 'too_fast' };
        }
        // The cap counts DELIVERIES, not attempts. `sent` is the reservation
        // ledger, so twelve attempts whose text was thrown away by checkLength
        // used to silence her for 10 minutes even though the room saw nothing -
        // the same defect the monologue window had. Reserving a slot still costs
        // her (otherwise she would compose forever); only the CEILING is measured
        // against what people actually experienced.
        this.deliveredAt = this.deliveredAt.filter((t2) => now - t2 < WINDOW_MS);
        if (this.deliveredAt.length >= MAX_MESSAGES_PER_WINDOW) {
            return { ok: false, why: 'over_budget' };
        }
        // SHARE. If humans have barely spoken and she is on her own, her share
        // is already dominant; going higher is the talking-to-herself look.
        //
        // WINDOWED, or the share is a LIFETIME ratio and never recovers. Both
        // operands used to be lifetime totals - deliveredCount and
        // human_msgs_since_her_last only ever increment - so once she was ahead
        // she stayed ahead for the lifetime of the process. Live evidence: 29
        // delivered against 8 human messages = 78% forever, so every self-prompt
        // for 7 hours returned over_share (181 hits) while a human stood there
        // talking to her. The monologue guard below had the identical defect and
        // the identical fix.
        //
        // DELIVERED, never reserved: a message she composed and dropped was not
        // said to anyone, so it cannot count as her dominating the room.
        const winHers = this.deliveredAt.filter((t) => now - t < WINDOW_MS).length;
        const winHuman = (this.humanAt || []).filter((t) => now - t < WINDOW_MS).length;
        if (winHuman === 0 && winHers >= 3) return { ok: false, why: 'monologue' };
        // A share needs a sample. At 4 of 5 turns the arithmetic gives 80%, which
        // is not evidence of anything - the humans simply have not spoken yet.
        // Only judge the share once there is a real conversation to measure.
        const total = winHuman + winHers;
        if (total >= MIN_SHARE_SAMPLE && winHers / total > SHARE_CEILING + (1 / total)) {
            return { ok: false, why: 'over_share' };
        }
        return { ok: true, why: 'within_budget' };
    }

    /**
     * Record what she actually said. The TIMESTAMP is already on the budget from
     * reserve() at the pre-generation gate - pushing it again here double-counted
     * every message and made the budget expire twice as fast. What is left is the
     * text itself, which only checkLength cares about.
     */
    note(message, now = Date.now()) {
        this.lastWords = String(message || '').trim().split(/\s+/).filter(Boolean).length;
    }

    /**
     * Count the message as spoken BEFORE it exists. The pre-generation gate
     * consults canSpeak() and then calls this, so a generation that is about to
     * be thrown away by checkLength() still consumed budget - otherwise the
     * discarded text would be free and she would keep composing.
     */
    reserve(now = Date.now()) {
        // The clock is a PARAMETER, not Date.now() read here. Reading it inside
        // made the budget untestable at a synthetic time, and every test that
        // advanced its own clock was silently testing real wall time instead.
        //
        // It takes a BUDGET slot (10-minute cap, minimum gap) but deliberately
        // does NOT touch `consecutive`. Live evidence: with reserve() advancing
        // the run, 8 generations produced 0 sends - she spent her 2-message
        // burst allowance on messages that were composed and discarded, and the
        // room never saw any of them. `consecutive` is about what the ROOM saw;
        // a thrown-away draft is not a turn.
        this.sent.push(now);
        this.lastSentAt = now;
        this.pending = true;
    }

    /** A message actually went out. Now the run advances. */
    delivered(now = Date.now()) {
        this.deliveredAt.push(now);
        this.lastSentAt = now;
        this.consecutive++;
        this.pending = false;
    }

    /** A human spoke, so her consecutive run is over. */
    humanSpoke(now = Date.now()) {
        this.consecutive = 0;
        // The windowed share reads this. Without the stamp the human side of
        // the ratio was always 0, so she looked like she was talking to
        // herself no matter how much he was actually saying.
        this.humanAt ||= [];
        this.humanAt.push(now);
    }

    /** Her own message counts against the share, so nudge the run. */
    stats(now = Date.now()) {
        const live = this.sent.filter((t) => now - t < WINDOW_MS);
        return { inWindow: live.length, consecutive: this.consecutive, lastWords: this.lastWords ?? 0 };
    }
}

export { WINDOW_MS, MAX_MESSAGES_PER_WINDOW, MAX_CONSECUTIVE, MIN_GAP_MS, RUN_EXPIRES_MS, SHARE_CEILING, MIN_SHARE_SAMPLE };
