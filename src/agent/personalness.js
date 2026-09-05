// UwU's "personalness" meter — how private / intimate / secret the *current*
// conversation thread has gotten. When it's high AND other players are online,
// her replies to that player go by whisper (/msg) instead of public chat, so the
// intimate or private stuff stays between the two of them.
//
// Deterministic and zero-LLM (like realness/psyche/relationship), but IN-MEMORY
// ONLY: it describes the live thread, so it resets on restart and decays once
// the conversation drifts back to casual. The meter only flags the *signal*; her
// words stay entirely hers.

const PERSONAL_PATTERNS = [
    // explicitly private / secret
    /(secret|between us|just (us|you and me|between us)|don'?t tell (anyone|anybody)|keep (this|it) (quiet|private|between us))/i,
    /(can i (tell|ask) you (something|something personal)|i need to (tell|ask) you something|promise me|trust me)/i,
    /(privately|in private|private chat|dm me|msg me|whisper (me|to me)|talk (privately|in private))/i,
    // contact details / getting off-server
    /(my (number|phone|discord|snap|snapchat|insta|instagram|socials|address|email)|what'?s your (number|phone|discord|snap|insta|address|email))/i,
    // romance / intimacy
    /(kiss|make ?out|slept with|hooked up|boyfriend|girlfriend|my ex|break ?up|broke up|single|crush|into you|crazy about you)/i,
    /(i (really )?(like|love) you|do you (like|love) me|will you be my (gf|girlfriend|bf|boyfriend)|date me)/i,
];

const WHISPER_THRESHOLD = 0.40;
const BUMP = 0.40;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export class PersonalnessTracker {
    constructor(agent) {
        this.agent = agent;
        this.value = 0;        // 0 = casual public chat, 1 = deeply private
        this._lastSpeaker = null;
    }

    onMessage(text, username) {
        if (!text) return;
        // a new speaker = a new thread; don't carry intimacy across people
        if (username && this._lastSpeaker && username !== this._lastSpeaker) {
            this.value = 0;
        }
        if (username) this._lastSpeaker = username;

        if (PERSONAL_PATTERNS.some((re) => re.test(String(text)))) {
            this.value = clamp(this.value + BUMP);
        }
    }

    // Decay toward 0 with a ~4-minute half-life — tracks the *live* thread.
    update(delta) {
        if (this.value <= 0) return;
        const k = 1 - Math.exp(-delta / 240000);
        this.value = clamp(this.value * (1 - k));
    }

    otherPlayersOnline() {
        const bot = this.agent.bot;
        if (!bot || !bot.players) return false;
        for (const name of Object.keys(bot.players)) {
            if (name !== this.agent.name) return true;
        }
        return false;
    }

    // Should a reply to a specific player go by whisper instead of public chat?
    shouldWhisper() {
        return this.value >= WHISPER_THRESHOLD && this.otherPlayersOnline();
    }

    // Prompt surface for $PERSONAL. Empty while the thread is still casual.
    summarize() {
        if (this.value < WHISPER_THRESHOLD) return '';
        const others = this.otherPlayersOnline();
        if (!others) {
            return `Personalness ${this.value.toFixed(2)}: this is turning private, but you two are alone on the server — you can keep talking openly.`;
        }
        return `Personalness ${this.value.toFixed(2)}: this conversation is getting personal/private and other players are online. Keep it between the two of you — reply to this player with !whisper("name", "message") instead of public chat for anything intimate, secret or private.`;
    }
}
