// She was acting and talking at the same time, which is not a thing a player can do.
//
// The owner's observation: "ppl dont do actions in game and talk at the same
// time, its not possible since you need to type so you stop what you doing".
//
// This is mechanically true of Minecraft and it explains something about the
// logs that was otherwise baffling. `bot.chat()` is fire-and-forget - it queues
// the message and returns immediately - while modes tick every 300ms. So the
// chat window is over in about a millisecond and she spends the entire time the
// message "should" have been typed walking around, mining, jumping and digging.
// A real player holds no pickaxe while the chat box is open.
//
// The typing time is derived from the Keystroke-Level Model rather than invented,
// and it scales with message length - which matters: the word limit, the rate
// budget and typing time all push the same direction, so a paragraph is now
// penalised three independent ways. See AVG_KEYSTROKE_MS below for the source.
//
// The important property is the ORDERING, not the constant: she must be unable
// to start a new action while she is mid-sentence, and she must not start typing
// in the middle of an action she already committed to. Both directions matter,
// because the second one is what makes her look inhuman - she would finish a
// dig, then sit still, then walk off, which no player does.

// Keystroke-Level Model K operator (Card, Moran & Newell), as surveyed by
// Al-Megren et al. 2018: 0.20s for an average skilled typist (55 wpm), 0.28s for
// an average non-skilled typist (40 wpm). Corroborated by instrumented
// measurements: Feit, Weir & Oulasvirta 2016 report mean inter-key intervals of
// 176.39ms (touch typists) and 168.91ms (non-touch), and Dhakal, Feit,
// Kristensson & Oulasvirta 2018 (136.9M keystrokes, 168,960 participants) put
// mean speed at 51.56 wpm.
// Those are FLUENT transcription figures. Short chat with nothing to copy is
// slower per character, so the small-message cost is carried by FIRST_CHAR_LAG
// and MIN_TYPING rather than by inflating this constant.
const AVG_KEYSTROKE_MS = 200;
const MIN_TYPING_MS = 900;         // one short word still takes a moment
const FIRST_CHAR_LAG_MS = 350;     // opening the chat box and focusing it
const PER_CHAR_MS = 0;             // computed from length below

/**
 * How long typing this exact message occupies her hands.
 *
 * @param {string} message
 * @param {number} [now]
 * @returns {number} milliseconds
 */
export function typingTimeMs(message, now = Date.now()) {
    const text = String(message ?? '').trim();
    if (!text) return 0;
    // Count keystrokes, not words: "/" and spaces are keystrokes too.
    const keystrokes = Math.max(1, text.length);
    const duration = FIRST_CHAR_LAG_MS + keystrokes * AVG_KEYSTROKE_MS;
    // A long message is a long time with her hands off the controls. This is
    // also a second, independent brake on paragraphs: typing a wall of text
    // takes so long that the rate budget closes long before she finishes.
    return Math.max(MIN_TYPING_MS, duration);
}

/**
 * Tracks whether she is currently mid-sentence, so movement modes can stand down.
 *
 * Usage at the send path: begin() when she is about to type, done() when the
 * message is out. Usage at the mode loop: busy() to decide whether a mode may
 * start.
 */
export class TypingState {
    constructor() {
        this.startedAt = 0;
        this.until = 0;
        this._timer = null;
        this._onDone = null;
    }

    /** @param {number} [now] */
    busy(now = Date.now()) {
        return now < this.until;
    }

    /**
     * She starts typing. Returns the duration so callers can hold the budget.
     * @param {string} message
     * @param {number} [now]
     */
    begin(message, now = Date.now()) {
        const ms = typingTimeMs(message, now);
        this.startedAt = now;
        this.until = now + ms;
        if (this._timer) clearTimeout(this._timer);
        if (ms > 0) {
            this._timer = setTimeout(() => this._release(), ms);
            if (this._timer.unref) this._timer.unref();
        }
        return ms;
    }

    /** Called once the message is actually out. */
    done() {
        this._release();
    }

    _release() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.until = 0;
        this.startedAt = 0;
    }

    /**
     * Mode gate. A mode that moves her may not START while she is typing.
     *
     * Note this is a start-gate, not a freeze: an action already in flight runs
     * to completion, which is what a real player does - you finish the swing you
     * started. Freezing mid-swing would look like lag.
     */
    canStartMovement(now = Date.now()) {
        return !this.busy(now);
    }

    stats(now = Date.now()) {
        return {
            busy: this.busy(now),
            remaining: Math.max(0, this.until - now),
            lastTypingMs: this.startedAt ? this.until - this.startedAt : 0,
        };
    }
}

export { AVG_KEYSTROKE_MS, MIN_TYPING_MS, FIRST_CHAR_LAG_MS };
