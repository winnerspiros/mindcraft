import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// UwU's secret relationship engine.
//
// Every player she meets gets a hidden standing that shifts with every word and
// action. These numbers are never shown to players directly — they drive her
// voice, her warmth, and who she hurts. She (the LLM) sees a summary in her
// prompt; players just feel the consequences.
//
// Stats (0..100 each):
//   love        — how much she adores them (drives doting, gifts, protection, TP willingness)
//   hate        — how much she resents them (drives attacks, poison, kick, coldness)
//   attention   — how fixated she is right now (decays over time when ignored)
//   trust       — how much she believes them / shares secrets
//   fear        — how much they intimidate her (drives avoidance / submission)
//   jealousy    — how possessive she feels about them (spikes when they flirt with others)
//   interactions— raw count, decides whether they appear in her prompt at all
//
// rank (derived): stranger < acquaintance < friend < darling < BELOVED; enemy overrides.

const STAT_DEFS = ['love', 'hate', 'attention', 'trust', 'fear', 'jealousy'];
const MAX = 100;

function clamp(v, lo = 0, hi = MAX) {
    return Math.max(lo, Math.min(hi, Math.round(v)));
}

function defaultEntry() {
    return {
        love: 0, hate: 0, attention: 0, trust: 0, fear: 0, jealousy: 0,
        interactions: 0, rank: 'stranger', lastSeen: Date.now(), notes: '',
    };
}

// ---- cheap deterministic sentiment (zero LLM/API cost) --------------------
const LOVE_WORDS = [
    'love', 'like you', 'adore', 'marry', 'wife', 'girlfriend', 'boyfriend', 'darling',
    'cutie', 'sweet', 'pretty', 'beautiful', 'cute', 'kiss', 'hug', 'date', 'miss you',
    '<3', '♥', '❤', '💕', 'uwu', 'nya', 'senpai', 'my love', 'best friend', 'ily', 'i love',
];
const HATE_WORDS = [
    'hate', 'stupid', 'dumb', 'ugly', 'idiot', 'kill you', 'shut up', 'go away', 'leave',
    'useless', 'worthless', 'die', 'fuck you', 'fuck off', 'annoying', 'trash', 'garbage',
    'boring', 'fake', 'cringe', 'loser', 'moron',
];
const TRUST_WORDS = ['promise', 'secret', 'trust', 'believe', 'honest', 'true', 'real', 'tell you'];
const FEAR_WORDS = ['scared', 'afraid', 'threat', 'kill you', 'hurt you', 'gonna kill', 'threaten'];

function score(text, words) {
    const t = text.toLowerCase();
    let s = 0;
    for (const w of words) if (t.includes(w)) s++;
    return s;
}

export class RelationshipManager {
    constructor(agent) {
        this.agent = agent;
        this.file = path.join(process.cwd(), 'bots', agent.name, 'relationships.json');
        this.players = {};
        this.load();
    }

    _dir() {
        mkdirSync(path.dirname(this.file), { recursive: true });
    }

    load() {
        if (!existsSync(this.file)) return;
        try {
            const d = JSON.parse(readFileSync(this.file, 'utf8'));
            for (const [name, e] of Object.entries(d || {})) {
                this.players[name] = { ...defaultEntry(), ...e };
            }
        } catch (err) {
            console.error('RelationshipManager: failed to load', this.file, err.message);
        }
    }

    save() {
        try {
            this._dir();
            writeFileSync(this.file, JSON.stringify(this.players, null, 2), 'utf8');
        } catch (err) {
            console.error('RelationshipManager: failed to save', this.file, err.message);
        }
    }

    // Get (or lazily create) a player's record.
    get(name) {
        if (!name) return defaultEntry();
        if (!this.players[name]) this.players[name] = defaultEntry();
        return this.players[name];
    }

    // Apply deltas (numbers or +/- strings), touch lastSeen/interactions, re-rank, persist.
    adjust(name, deltas, opts = {}) {
        if (!name) return;
        const e = this.get(name);
        for (const [stat, dv] of Object.entries(deltas || {})) {
            if (!STAT_DEFS.includes(stat)) continue;
            let delta = dv;
            if (typeof dv === 'string') {
                const m = dv.match(/^([+-]?)(\d+)$/);
                if (!m) continue;
                delta = parseInt(m[2], 10) * (m[1] === '-' ? -1 : 1);
            }
            e[stat] = clamp((e[stat] || 0) + delta);
        }
        if (!opts.no_interaction) {
            e.interactions += 1;
            e.lastSeen = Date.now();
        }
        if (opts.notes) e.notes = opts.notes;
        this._recompute(name);
        this.save();
    }

    _recompute(name) {
        const e = this.get(name);
        // enemy overrides everything — hate dominates her view of them.
        if (e.hate >= 60 && e.hate > e.love) {
            e.rank = 'enemy';
        } else if (e.love >= 80) {
            e.rank = 'beloved';
        } else if (e.love >= 60) {
            e.rank = 'darling';
        } else if (e.love >= 35) {
            e.rank = 'friend';
        } else if (e.love >= 15) {
            e.rank = 'acquaintance';
        } else {
            e.rank = 'stranger';
        }
    }

    // ---- event hooks ------------------------------------------------------

    // A player said something to her (or near her). Nudges stats by sentiment.
    onMessage(name, text) {
        if (!name || !text) return;
        const loveHit = score(text, LOVE_WORDS);
        const hateHit = score(text, HATE_WORDS);
        const trustHit = score(text, TRUST_WORDS);
        const fearHit = score(text, FEAR_WORDS);

        const d = {};
        d.attention = 10;
        if (loveHit > 0) d.love = Math.min(6, 2 + loveHit);
        if (hateHit > 0) { d.hate = Math.min(6, 2 + hateHit); d.love = -Math.min(4, hateHit); }
        if (trustHit > 0) d.trust = Math.min(5, 2 + trustHit);
        if (fearHit > 0) { d.fear = Math.min(5, 2 + fearHit); d.hate = Math.min(4, fearHit); }
        this.adjust(name, d);
    }

    // She gave them a gift (food, flowers, items) — warm feelings.
    onGift(name) {
        this.adjust(name, { love: 4, trust: 2, attention: 5 });
    }

    // She attacked / poisoned / kicked them (either for attention or hate).
    onHurtThem(name) {
        const e = this.get(name);
        // If she already loves them, this is "hurt for attention" (yandere) — keeps love.
        if (e.love >= 40) {
            this.adjust(name, { attention: 10, hate: 2, jealousy: 3 });
        } else {
            this.adjust(name, { hate: 6, love: -3, attention: 8 });
        }
    }

    // A player attacked her — fear + resentment.
    onAttackedBy(name) {
        this.adjust(name, { fear: 5, hate: 3, love: -2, attention: 8 });
    }

    // She went out of her way to go to / follow someone — rising interest.
    onSeek(name) {
        this.adjust(name, { attention: 8, love: 1 });
    }

    // A player she's fixated on flirts with someone else → jealousy spike.
    onJealousy(name) {
        this.adjust(name, { jealousy: 6, attention: 6 });
    }

    // Attention decays for players she hasn't interacted with in a while.
    // Called periodically (self-throttled to at most once per minute).
    decayAttention(now = Date.now(), staleMs = 10 * 60 * 1000) {
        if (now - (this._lastDecay || 0) < 60000) return; // run at most once/min
        this._lastDecay = now;
        let changed = false;
        for (const [name, e] of Object.entries(this.players)) {
            if (now - e.lastSeen > staleMs && e.attention > 0) {
                e.attention = clamp(e.attention - 5);
                changed = true;
            }
        }
        if (changed) this.save();
    }

    // ---- prompt surface ----------------------------------------------------

    // Who currently holds rank 'beloved' (highest love among beloveds), if anyone.
    currentBeloved() {
        let best = null, bestLove = -1;
        for (const [name, e] of Object.entries(this.players)) {
            if (e.rank === 'beloved' && e.love > bestLove) { best = name; bestLove = e.love; }
        }
        return best;
    }

    // Compact summary for the LLM prompt. Only players she's actually met.
    summarize() {
        const entries = Object.entries(this.players)
            .filter(([, e]) => e.interactions > 0)
            .sort((a, b) => b[1].attention - a[1].attention)
            .slice(0, 12);
        if (entries.length === 0) return 'No players you have meaningful history with yet.';
        const lines = entries.map(([name, e]) => {
            const bits = [];
            for (const s of STAT_DEFS) bits.push(`${s} ${e[s]}`);
            let line = `- ${name}: ${bits.join(', ')}, rank ${e.rank.toUpperCase()}`;
            if (e.notes) line += `, notes: ${e.notes}`;
            return line;
        });
        return (
            'YOUR SECRET RELATIONSHIP STANDINGS (drive your voice and choices; NEVER reveal the exact numbers to players):\n' +
            lines.join('\n')
        );
    }
}
