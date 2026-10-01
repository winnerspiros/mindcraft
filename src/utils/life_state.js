// Is she actually at the computer, and if not, why not?
//
// The owner: "we trying to make her real so think this is a person real life
// playing minecraft. he may go to wc, go grab a drink, has plans so needs to go
// offline, is bored so scrolls phone, might be looking for a song to play in the
// background, looking at youtube videos, sending messages to a friend in chat,
// someone called her."
//
// This is the difference between a chat endpoint and a person at a computer. A
// bot is available at all times because it has no life; a person is not. And
// the tell is not the absence itself - it is that a bot is NEVER absent, and
// never has anywhere to be.
//
// Three things make this real rather than a random excuse generator:
//
//   1. DURATION follows the activity. Saying "brb wc" and returning in eight
//      seconds is worse than not leaving at all. Each activity carries a real
//      distribution, and the prompt loop is suspended for that long.
//   2. THE REASON PERSISTS. She says "brb one sec" for the toilet, and when she
//      comes back she does not say "anyway whats up" as if nothing happened -
//      she either picks the thread back up or explains why she went.
//      Contradicting herself is the tell that the absence was generated rather
//      than lived.
//   3. It is RARE, and time-aware. If she left every few minutes she would be
//      just as robotic as one who never leaves. Nobody plays at 5am the way
//      they do at midnight.
//
// Also: people come back EARLY and get pulled straight back into the game. That
// asymmetry is worth more than the excuse itself.

const MIN = 60000;

// Realistic ranges. Long lower bounds on the boring ones on purpose: an absence
// that is too short reads as a bot deciding to be briefly unavailable.
const ACTIVITIES = [
    {
        id: 'wc', kind: 'short', weight: 3,
        min: 2 * MIN, max: 7 * MIN,
        says: ['brb wc', 'one sec', 'gotta pee', 'hold on', 'brb moment'],
        back: ['back', 'ok im back', 'sorry wc', 'my bad, bathroom break'],
    },
    {
        id: 'drink', kind: 'short', weight: 3,
        min: 1 * MIN, max: 4 * MIN,
        says: ['gonna get a drink', 'im thirsty af', 'brb water', 'making tea'],
        back: ['got it', 'back, with water', 'ok that was needed'],
    },
    {
        id: 'phone', kind: 'short', weight: 4,
        silent: true,   // the one you do without saying anything
        min: 2 * MIN, max: 9 * MIN,
        says: [], back: [],
    },
    {
        id: 'music', kind: 'short', weight: 2,
        min: 3 * MIN, max: 8 * MIN,
        says: ['gonna find a song', 'one sec, need music for this', 'putting something on'],
        back: ['ok better now', 'that was a banger', 'right song on'],
    },
    {
        id: 'call', kind: 'short', weight: 2,
        min: 3 * MIN, max: 12 * MIN,
        says: ['someone called me', 'got a call, brb', 'my moms ringing'],
        back: ['that was my mom lol', 'ok back', 'sorry, family'],
    },
    {
        id: 'friend_msgs', kind: 'long', weight: 2,
        min: 8 * MIN, max: 25 * MIN,
        says: ['talking to someone, brb', 'gotta answer my friend', 'one min im texting someone'],
        back: ['ok im back, she was so dumb', 'sorry that was long', 'done, back'],
    },
    {
        id: 'youtube', kind: 'long', weight: 3,
        min: 10 * MIN, max: 40 * MIN,
        says: ['falling down a youtube hole', 'brb watching something', 'im getting distracted'],
        back: ['ok that was a waste of time', 'back. that was dumb', 'im here, i saw the most cursed thing'],
    },
    {
        id: 'plans', kind: 'away', weight: 1,
        min: 25 * MIN, max: 90 * MIN,
        says: ['gonna log off got plans', 'i should go, dinner', 'afk gotta go out'],
        back: ['im back', 'sorry i was late', 'ok im on'],
    },
];

// Hours when an activity is plausible. Boredom-scroll and bathroom breaks happen
// at 4am; going out to dinner does not. null = any hour.
const HOURS = {
    wc: null, drink: null, phone: null, music: null, call: null,
    friend_msgs: null,
    youtube: [9, 2],   // 09:00 through 02:00
    plans: [8, 23],    // not before 8am, not after 11pm
};

// How often she steps away, per eligible tick. Low on purpose: she is playing
// Minecraft, not taking breaks. A person leaves a few times an evening.
const LEAVE_RATE = 0.12;

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const logUniform = (min, max) => min * Math.pow(max / min, Math.random());

function inWindow(hour, [from, to]) {
    return to > from ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

function weightedPick(hour) {
    const pool = ACTIVITIES.filter((a) => !HOURS[a.id] || inWindow(hour, HOURS[a.id]));
    if (!pool.length) return null;
    const total = pool.reduce((s, a) => s + a.weight, 0);
    let r = Math.random() * total;
    for (const a of pool) { if ((r -= a.weight) <= 0) return a; }
    return pool[pool.length - 1];
}

export class LifeState {
    constructor() {
        this.away = null;
        this.lastLeftAt = 0;
    }

    get isAway() { return !!this.away; }

    /**
     * Should she leave now? Deliberately rare - the bot that leaves every few
     * minutes is the same bot that never leaves, just noisier.
     * @returns {{leave: boolean, why: string, silent?: boolean}}
     */
    shouldLeave() {
        if (this.away) return { leave: false, why: 'already_away' };
        // No ping-pong: nothing more than once per ~12 min.
        if (Date.now() - this.lastLeftAt < 12 * MIN) return { leave: false, why: 'too_soon' };
        const act = weightedPick(new Date().getHours());
        if (!act) return { leave: false, why: 'nothing_plausible_at_this_hour' };
        // Phone-scrolling needs no ANNOUNCEMENT - she just is not there, and
        // comes back without explaining. But it still has to be RARE: my first
        // version let the silent branch skip the rate check entirely, and
        // measured 76% of turns leaving, which is a bot that vanishes
        // constantly. Silence is how she leaves, not how often.
        if (Math.random() > LEAVE_RATE) return { leave: false, why: 'not_this_turn' };
        return { leave: true, why: act.id, silent: !!act.silent };
    }

    /** Commit to an absence. Returns the state, including what to say. */
    leave() {
        const act = weightedPick(new Date().getHours());
        if (!act) return null;
        this.away = {
            id: act.id,
            kind: act.kind,
            // Silent activities have no lines at all, so they never announce.
            said: act.says.length ? pick(act.says) : null,
            back: act.back.length ? pick(act.back) : null,
            until: Date.now() + logUniform(act.min, act.max),
        };
        this.lastLeftAt = Date.now();
        return this.away;
    }

    /**
     * Has she come back? People return EARLY and get pulled straight back in.
     * Returns the finished absence, or null if she should keep being away.
     */
    checkReturn() {
        if (!this.away) return null;
        if (Date.now() < this.away.until && Math.random() >= 0.3) return null;
        const a = this.away;
        this.away = null;
        return a;
    }

    /** Would she even see this message, or is she not at the computer? */
    isPresentForMessage() {
        return !this.away;
    }
}

export { ACTIVITIES };
