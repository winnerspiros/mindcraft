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
//   jealousy    — how possessive she feels about them (rises when they chat with others, calms fast when they give her attention)
//   annoyance   — short-term irritation; spikes on meanness, cools fast (drives cold shoulder / ignore)
//   madness     — how unhinged she is toward THEM (toying, insincere "it was an accident", junk gifts drive it; smooth talk + time calm it; fuels harassment and crystal PvP)
//   respect     — how much she defers to them (drives whether she obeys their requests)
//   interactions— raw count, decides whether they appear in her prompt at all
//
// rank (derived): stranger < acquaintance < friend < darling < BELOVED; enemy overrides.

const STAT_DEFS = ['love', 'hate', 'attention', 'trust', 'fear', 'jealousy', 'annoyance', 'madness', 'respect'];
const MAX = 100;

// Per-tick decay toward neutral (0) for each dynamic stat, applied to players who
// haven't interacted with her in a while. Fast-cooling vs sticky stats.
const DECAY_PER_TICK = {
    attention: 5, annoyance: 15, jealousy: 5, fear: 3,
    hate: 2, trust: 2, respect: 2, love: 1, madness: 4,
};

function clamp(v, lo = 0, hi = MAX) {
    return Math.max(lo, Math.min(hi, Math.round(v)));
}

function defaultEntry() {
    return {
        love: 0, hate: 0, attention: 0, trust: 0, fear: 0, jealousy: 0,
        annoyance: 0, madness: 0, respect: 0, lastTone: 'neutral', grievance: '',
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
const APOLOGY_WORDS = [
    'sorry', 'apolog', 'forgive', 'my bad', 'my fault', 'i was wrong',
    'come back', 'talk to me', 'notice me', 'pay attention', 'dont ignore', 'miss you',
];
const POLITE_WORDS = ['please', 'pls', 'could you', 'would you', 'may i', 'can i', 'if you want', 'mind'];

// ---- madness & jealousy triggers (zero-LLM deterministics) ---------------
const TOY_WORDS = [ // say one thing, do another — deception/toying drives madness
    'jk', 'just kidding', 'kidding', 'not really', 'nvm', 'nevermind', 'psych', 'sike',
    'gotcha', 'got you', 'just a prank', 'pranked', 'april fools', 'fooled', 'tricked',
    "wasn't real", 'was lying', 'lied to you', 'fake',
];
const INSINCERE_WORDS = [ // "hit you by mistake" — the cover-up that enrages her
    'mistake', 'accident', 'oops', "didn't mean", 'didnt mean', 'my bad', 'not my fault',
    "wasn't me", 'wasnt me', 'lag', 'bug',
];
const BAD_ITEM_WORDS = [ // junk/gross "gifts" dumped on her
    'rotten_flesh', 'rotten flesh', 'spider_eye', 'spider eye', 'poisonous_potato',
    'poisonous potato', 'poison', 'dirt', 'cobblestone', 'gravel', 'netherrack',
    'soul_sand', 'rotten', 'garbage', 'trash', 'junk',
];

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
        const politeHit = score(text, POLITE_WORDS);

        const d = {};
        d.attention = 10;
        if (loveHit > 0) { d.love = Math.min(6, 2 + loveHit); d.annoyance = -Math.min(6, 1 + loveHit); }
        if (hateHit > 0) { d.hate = Math.min(6, 2 + hateHit); d.love = -Math.min(4, hateHit); d.annoyance = Math.min(8, 3 + hateHit); }
        if (trustHit > 0) { d.trust = Math.min(5, 2 + trustHit); d.respect = Math.min(4, 1 + trustHit); }
        if (fearHit > 0) { d.fear = Math.min(5, 2 + fearHit); d.hate = Math.min(4, fearHit); d.annoyance = Math.min(6, 2 + fearHit); }
        if (politeHit > 0 && hateHit === 0 && fearHit === 0) { d.respect = Math.min(4, 1 + politeHit); d.attention = 4; }

        // madness: toying, insincere "it was an accident" and junk gifts raise it.
        // jealousy: being addressed = not ignored, so it drains fast; smooth talk soothes both.
        const toyHit = score(text, TOY_WORDS);
        const insincereApology = score(text, APOLOGY_WORDS) > 0 && score(text, INSINCERE_WORDS) > 0;
        const badGiftHit = score(text, BAD_ITEM_WORDS);
        const giveCue = /give|take|here|have|gift|get|for you/.test(text.toLowerCase());
        d.jealousy = -10;
        if (toyHit > 0) { d.madness = Math.min(8, 2 + toyHit); d.annoyance = Math.min(6, 1 + toyHit); }
        if (insincereApology) d.madness = Math.max(d.madness || 0, 9);
        if (badGiftHit > 0 && giveCue) { d.madness = Math.min(8, 2 + badGiftHit); d.annoyance = Math.min(5, 1 + badGiftHit); }
        if (loveHit > 0) { d.madness = -Math.min(7, 1 + loveHit); d.jealousy = -Math.min(12, 4 + loveHit); }

        this.get(name).lastTone = this.detectTone(text);
        if (hateHit > 0 || fearHit > 0) {
            const mean = [...HATE_WORDS, ...FEAR_WORDS].filter(w => text.toLowerCase().includes(w));
            this.get(name).grievance = mean.length ? `said "${mean[0]}" to you` : 'was mean to you';
        }
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

    // Ambient chatter: a public message NOT aimed at her means they're talking to
    // someone else. If she's invested in them, jealousy ticks up little by little
    // (diminishing returns as it climbs — one chat won't send it to 100).
    onJealousyObserved(name) {
        if (!name) return;
        const e = this.get(name);
        if (e.love < 15 && e.attention < 10) return; // she doesn't care about them yet
        const bump = e.jealousy >= 60 ? 1 : e.jealousy >= 30 ? 2 : 3;
        this.adjust(name, { jealousy: bump, attention: 1 }, { no_interaction: true });
    }

    // She deliberately gave a player the cold shoulder (chose to ignore them).
    onIgnore(name) {
        this.adjust(name, { hate: 10, annoyance: 15, love: -5, trust: -5, respect: -5, attention: -5 });
    }

    // She forgave them / stopped ignoring.
    onUnignore(name) {
        this.adjust(name, { hate: -5, annoyance: -10, attention: 5 });
        const e = this.get(name);
        if (e.grievance) { e.grievance = ''; this.save(); }
    }

    // They're trying to win her back — apology or a plea for attention.
    onAttentionSeek(name) {
        this.adjust(name, { love: 6, attention: 12, annoyance: -10, hate: -4 });
        const e = this.get(name);
        if (e.grievance) { e.grievance = ''; this.save(); }
    }

    // Cheap deterministic check: is this message an apology / plea for attention?
    isAttentionSeeking(text) {
        return text != null && score(text, APOLOGY_WORDS) > 0;
    }

    // Classify how she's currently being treated: 'nice', 'neutral', or 'mean'.
    detectTone(text) {
        if (text == null) return 'neutral';
        const nice = score(text, LOVE_WORDS) + score(text, POLITE_WORDS);
        const mean = score(text, HATE_WORDS) + score(text, FEAR_WORDS);
        if (mean > nice) return 'mean';
        if (nice > 0) return 'nice';
        return 'neutral';
    }

    // All dynamic stats drift back toward neutral (0) on their own for players she
    // hasn't interacted with in a while. Attention/annoyance/jealousy cool fastest;
    // love and hate are stickiest. Called periodically (at most once per minute).
    decay(now = Date.now(), staleMs = 10 * 60 * 1000) {
        if (now - (this._lastDecay || 0) < 60000) return; // run at most once/min
        this._lastDecay = now;
        let changed = false;
        for (const [name, e] of Object.entries(this.players)) {
            if (now - e.lastSeen <= staleMs) continue;
            for (const [stat, rate] of Object.entries(DECAY_PER_TICK)) {
                if (e[stat] > 0) { e[stat] = clamp(e[stat] - rate); changed = true; }
            }
        }
        if (changed) {
            for (const name of Object.keys(this.players)) this._recompute(name);
            this.save();
        }
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
            let line = `- ${name}: ${bits.join(', ')}, rank ${e.rank.toUpperCase()}, tone ${e.lastTone || 'neutral'}`;
            if (e.grievance) line += `, grievance: ${e.grievance}`;
            if (this.agent && this.agent.ignored_players && this.agent.ignored_players[name]) line += ', IGNORING';
            if (e.notes) line += `, notes: ${e.notes}`;
            return line;
        });
        return (
            'YOUR SECRET RELATIONSHIP STANDINGS (drive your voice and choices; NEVER reveal the exact numbers to players):\n' +
            lines.join('\n')
        );
    }
}
