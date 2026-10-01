// Spamming for attention: yo / yo / yo / bitch?
//
// The owner: "human can be spammy for attention like 1st message yo 2nd yo 3rd
// bitch? examples all that plz no hardcode"
//
// "No hardcode" is the whole instruction, and it is the right one. A list of
// "yo", "hello?", "anyone?" in the source would produce a bot that can only
// ever say those words, and it would say them on schedule. What actually makes
// it human is the SHAPE - same speaker, several turns in a row, escalating, and
// only when the first one got nothing back.
//
// So this is a state machine over INTENT, and the words come from the model.
//
//   PERSIST     she said something and got no answer
//   REPEAT      she is saying it again, essentially the same thing
//   ESCALATE    still nothing, so now it is louder/less polite/aimed
//   GIVE UP     enough; back to normal, and she is slightly sheepish
//
// What the measurements say, and they disagree in a way that matters:
//
//   Minecraft Dialogue Corpus, 21,822 messages, 8,974 same-speaker consecutive
//   pairs: verbatim identical repeats are 7 - 0.08%. Runs of 2+ messages are
//   common though (3,517 pairs are runs of 2, 1,280 of 3, 501 of 4).
//   Elongation ("goooood") appears ONCE in 21,822 messages.
//
//   So in a TASK corpus - architect/builder pairs working together - repeating
//   yourself is almost never right, and the 0.08% is a real base rate.
//
//   But that corpus is two people doing a job. This is friends on a server
//   teasing each other, and "yo / yo / yo / bitch?" is a different speech act
//   entirely: it is not re-stating information, it is demanding a response. The
//   measurement does not cover that register, and pretending it does would be
//   the easy mistake here.
//
// So the rates here are deliberately NOT taken from the 0.08%. What IS taken
// from it: the run lengths (she does 2-4 messages in a row, rarely more than 4)
// and the near-total absence of elongation. Repeats escalate by CONTENT, not by
// adding letters, which is the opposite of what "spamming" usually means.
//
// And the trigger is the important part: this only fires when she has ALREADY
// spoken and been ignored. A bot that opens with attention-spam is intolerable;
// a bot that gets no reply and then loses patience is a person.

const MAX_RUN = 4;              // corpus: runs of 2-4, almost never more
const PERSIST_WINDOW_MS = 45000; // no answer for this long = she notices

export class Attention {
    constructor() {
        this.run = 0;            // how many times she has now repeated
        this.lastSaidAt = 0;
        this.lastSaid = '';
        // null, not 0. `if (!this.waitingSince) return false` then treated a
        // genuine start-time-of-epoch as "she never spoke" and shouldPush()
        // returned false forever - so she never pushed, never escalated and
        // never gave up. Falsy zero, in the one field that decides everything.
        this.waitingSince = null;
        this.stage = 'none';     // none | persist | repeat | escalate | gave_up
    }

    /** She said something. Note it, and start the clock on being ignored. */
    spoke(text, now = Date.now()) {
        const t = String(text || '').trim();
        if (t) this.lastSaid = t;
        this.lastSaidAt = now;
        // Already mid-push: another turn of the same attempt. Reaching MAX_RUN
        // does NOT set gave_up here - it sets it once she has actually stopped
        // asking, which is shouldPush()'s job at the patience limit. Setting it
        // here meant the stage flipped to gave_up while she was still pushing,
        // and then the next spoke() saw a non-push stage and reset run to 0, so
        // she never actually gave up.
        // Self-limiting: once she has run out of patience she stops, whatever
        // the caller does. Clamping run here means no caller can drive her into
        // an 11-deep push by calling spoke() in a loop - the class refuses,
        // rather than relying on every call site to check shouldPush() first.
        // GIVING UP IS STICKY. Once she has decided she is not going to beg
        // any more, the next thing she happens to say must NOT restart the
        // whole arc - she was ignoring him, she has moved on, and she is not
        // going to come back to "yo" four messages later. Without this, gaveUp()
        // was undone by the very next spoke() and she cycled forever.
        if (this.stage === 'gave_up') {
            this.waitingSince = now;   // a new, unrelated silence
            return this.stage;
        }
        const pushing = this.stage === 'persist' || this.stage === 'repeat' || this.stage === 'escalate';
        this.run = pushing ? Math.min(this.run + 1, MAX_RUN - 1) : 0;
        this.stage = pushing
            ? (this.run + 1 >= MAX_RUN ? 'escalate' : this.run >= 2 ? 'repeat' : 'persist')
            : 'persist';
        // The clock does NOT reset here. She is not waiting for a reply to her
        // FIRST message any more - she is waiting for a reply to her LAST one,
        // but the whole losing-my-patience arc is measured from when she first
        // went unanswered. Resetting it on every repeat meant shouldPush() never
        // saw enough elapsed time to give up, so run grew without bound (11 in
        // the test) and she never stopped.
        if (!pushing || this.waitingSince === null) this.waitingSince = now;
        return this.stage;
    }

    /** He answered. She is fine, and she is slightly embarrassed if she pushed. */
    answered(now = Date.now()) {
        const wasPushing = this.run > 0;
        this.reset();
        return wasPushing;
    }

    reset() {
        this.run = 0;
        this.lastSaid = '';
        this.waitingSince = null;   // null, never 0 - see the constructor
        this.stage = 'none';
    }

    /**
     * Should she say something again? Only if she spoke, nothing came back, and
     * she is still within a human patience window.
     */
    shouldPush(now = Date.now()) {
        // Silence is the default. The owner's rule, and the one that matters
        // most: if she does not get a response there is no reason to talk.
        // Everything below is the narrow exception.
        if (this.waitingSince === null || this.stage === 'gave_up') return false;
        const waited = now - this.waitingSince;
        if (this.run >= MAX_RUN - 1 || waited > PERSIST_WINDOW_MS * 3) {
            this.gaveUp();
            return false;
        }
        // The gap between repeats SHRINKS as she gets more annoyed - that is
        // the escalation, and it is the opposite of the reply-latency curve.
        const impatient = this.run >= 2;
        return impatient ? waited > 6000 : waited > 12000;
    }

    gaveUp() {
        this.stage = 'gave_up';
        this.run = 0;
        this.waitingSince = 0;
        return true;
    }

    /**
     * Instructions for the model. The WORDS ARE THE MODEL'S - this supplies
     * intent and register only, never a phrase to emit.
     */
    instruction() {
        switch (this.stage) {
            case 'persist':
                return `You just said something and nobody has answered. `
                    + `Do NOT open with "yo" or "hello?" or "anyone?" - that is a bot. `
                    + `You have not been ignored yet, you are just talking.`;
            case 'repeat':
                return `You already said this and got nothing. You are going to say it `
                    + `again because you want an answer, not because you forgot. `
                    + `Same point, your own words, do not word-for-word copy yourself.`;
            case 'escalate':
                return `Still nothing. You are getting impatient and a bit ratty about it. `
                    + `Louder, shorter, less polite, maybe aimed at them specifically. `
                    + `This is what a person does when they are ignored - it is not `
                    + `hostility, it is wanting attention. Do not repeat it verbatim, `
                    + `and do not stretch words ("yooooo") - that barely happens in real `
                    +`chat and reads as a tic.`;
            case 'gave_up':
                return `You gave up getting an answer. Do not bring it up again, and `
                    + `be slightly sheepish about it if it comes up. Carry on as if you `
                    + `were not just doing that.`;
            default:
                return null;
        }
    }
}

export { MAX_RUN, PERSIST_WINDOW_MS };
