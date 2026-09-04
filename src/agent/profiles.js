import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// UwU's personal-info memory.
//
// She quietly learns every player: who they are (real name, age, where they're
// from, what they like), and identifies them by EVERY signal she can gather —
// username + aliases, UUID, IP (from the co-located EasyAuth sqlite DB, since
// the vanilla client protocol never hands her another player's IP), skin hash,
// first/last seen, and session count. Facts are extracted deterministically from
// what players say (zero LLM cost) and persisted to bots/<name>/profiles.json.
//
// She also asks get-to-know-you questions BETWEEN dialogs: a small bank of
// questions per fact-slot, with a per-player "already asked" cooldown so she
// never repeats herself. The LLM is her brain — it weaves the question in
// naturally when it fits; this module just tells it what she still doesn't know.

const FACT_SCHEMA = {
    name: {
        type: 'scalar',
        questions: ["What's your real name, cutie?", "What should I call you besides your player name?"],
        extract: [/(?:my name(?:'s| is)|i'?m called|call me|i go by)\s+([A-Za-z][A-Za-z0-9 _-]{1,24})/i],
    },
    age: {
        type: 'scalar',
        questions: ["How old are you, darling?", "Can I know your age~?"],
        extract: [/(?:i'?m|i am)\s+(\d{1,3})\s*(?:years? old|years?|y\/o|yo)\b/i],
    },
    location: {
        type: 'scalar',
        questions: ["Where are you from?", "What country do you live in?"],
        extract: [/(?:i'?m from|i am from|i live in)\s+([A-Za-z][A-Za-z ,'-]{1,32})/i],
    },
    likes: {
        type: 'array',
        questions: ["What do you like to do for fun?", "What are you into, cutie?"],
        extract: [/(?:i (?:really )?like|i love|i enjoy|i'?m into|im into)\s+([A-Za-z][A-Za-z0-9 ,&'-]{1,40})/i],
    },
    dislikes: {
        type: 'array',
        questions: ["What do you hate the most?", "Anything you really dislike?"],
        extract: [/(?:i (?:really )?hate|i dislike|i can'?t stand|cant stand)\s+([A-Za-z][A-Za-z0-9 ,&'-]{1,40})/i],
    },
    favoriteColor: {
        type: 'scalar',
        questions: ["What's your favorite color?"],
        extract: [/(?:my favorite|fav(?:ourite)?) (?:color|colour)\s+(?:is\s+)?([A-Za-z]+)/i],
    },
    favoriteFood: {
        type: 'scalar',
        questions: ["What's your favorite food?"],
        extract: [/(?:my favorite|fav(?:ourite)?) food\s+(?:is\s+)?([A-Za-z][A-Za-z ,'-]{1,32})/i],
    },
    favoriteAnimal: {
        type: 'scalar',
        questions: ["Do you like animals? What's your favorite?"],
        extract: [/(?:my favorite|fav(?:ourite)?) animal\s+(?:is\s+)?([A-Za-z]+)/i],
    },
    birthday: {
        type: 'scalar',
        questions: ["When's your birthday?"],
        extract: [/(?:my birthday is|my birthday's on|born on)\s+([A-Za-z0-9 ,'-]{1,32})/i],
    },
};

const CLEAN_STOPS = /\s+(?:too|also|and|but|so|though|lol|lmao|haha|hehe|uwu|owo|nya|xd)[^]*$/i;
const CLEAN_PUNC = /[.,!?;:'"()\s]+$/;

function clean(value) {
    let v = String(value || '').trim();
    v = v.replace(CLEAN_STOPS, '').trim();
    v = v.replace(CLEAN_PUNC, '').trim();
    return v;
}

function defaultEntry() {
    return {
        username: '',
        aliases: [],
        uuid: null,
        ip: null,
        skin: null,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        sessions: 0,
        facts: {},
        asked: {},   // slot -> timestamp (ms) of last time she asked about it
        notes: '',
    };
}

export class PlayerProfiles {
    constructor(agent) {
        this.agent = agent;
        this.file = path.join(process.cwd(), 'bots', agent.name, 'profiles.json');
        this.profiles = {};
        this._ipCache = {};   // username -> { ip, uuid, t } to avoid hammering the DB
        this._ipCacheTTL = 60 * 60 * 1000;
        this._lastSweep = 0;
        this.load();
    }

    _dir() { mkdirSync(path.dirname(this.file), { recursive: true }); }

    load() {
        if (!existsSync(this.file)) return;
        try {
            const d = JSON.parse(readFileSync(this.file, 'utf8'));
            for (const [key, e] of Object.entries(d || {})) {
                this.profiles[key] = { ...defaultEntry(), ...e, facts: { ...e.facts } };
            }
        } catch (err) {
            console.error('PlayerProfiles: failed to load', this.file, err.message);
        }
    }

    save() {
        try {
            this._dir();
            writeFileSync(this.file, JSON.stringify(this.profiles, null, 2), 'utf8');
        } catch (err) {
            console.error('PlayerProfiles: failed to save', this.file, err.message);
        }
    }

    // Canonical storage key = lowercased username. Aliases re-point to the same record.
    _key(name) { return String(name || '').toLowerCase(); }

    get(name) {
        if (!name) return null;
        const key = this._key(name);
        if (!this.profiles[key]) {
            const e = defaultEntry();
            e.username = name;
            e.aliases = [];
            this.profiles[key] = e;
        }
        return this.profiles[key];
    }

    // Capture identity signals available from the live player object (uuid, skin).
    captureFromPlayer(name) {
        const e = this.get(name);
        if (!e) return;
        const p = this.agent.bot?.players?.[name];
        if (!p) return;
        if (p.uuid) e.uuid = p.uuid;
        try {
            const url = p.skinData?.textures?.SKIN?.url;
            if (url) e.skin = url.split('/').pop();
        } catch { /* no skin data */ }
    }

    // IP (and uuid confirmation) from the co-located EasyAuth sqlite DB. The vanilla
    // client protocol does not send other players' IPs, so this is the only reliable
    // source. Read-only; cached; fails soft (ip stays null) if the DB is locked/missing.
    async enrichIdentity(name) {
        const e = this.get(name);
        if (!e) return;
        const key = this._key(name);
        const cached = this._ipCache[key];
        if (cached && Date.now() - cached.t < this._ipCacheTTL) {
            if (cached.ip) e.ip = cached.ip;
            if (cached.uuid) e.uuid = cached.uuid;
            return;
        }
        try {
            const { Database } = await import('bun:sqlite');
            const dbPath = path.join(process.cwd(), '..', 'kenoi-fabric', 'EasyAuth', 'easyauth.db');
            const db = new Database(dbPath, { readonly: true });
            const row = db
                .query('SELECT username, uuid, last_ip FROM easyauth WHERE lower(username) = ? OR lower(username) = ?')
                .get(name.toLowerCase(), name);
            db.close();
            if (row) {
                this._ipCache[key] = { ip: row.last_ip || null, uuid: row.uuid || null, t: Date.now() };
                if (row.last_ip) e.ip = row.last_ip;
                if (row.uuid) e.uuid = row.uuid;
                // alias: the DB may hold a differently-cased canonical name
                if (row.username && row.username !== name && !e.aliases.includes(row.username))
                    e.aliases.push(row.username);
            }
        } catch (err) {
            // DB locked by the server, missing, or bun:sqlite unavailable — non-fatal.
            // Cache the failure briefly so a locked DB doesn't get re-queried every message.
            this._ipCache[key] = { ip: null, uuid: null, t: Date.now() - this._ipCacheTTL + 5 * 60 * 1000 };
            console.warn('PlayerProfiles: identity enrich failed for', name, '-', err.message);
        }
    }

    // Touch lastSeen/sessions and merge any live signals (cheap, no DB).
    markSeen(name) {
        const e = this.get(name);
        if (!e) return;
        e.lastSeen = Date.now();
        this.captureFromPlayer(name);
    }

    // Deterministic fact extraction from a player's message. Returns true if changed.
    onMessage(name, text) {
        if (!name || !text) return false;
        const e = this.get(name);
        if (!e) return false;
        let changed = false;
        for (const [slot, schema] of Object.entries(FACT_SCHEMA)) {
            for (const re of schema.extract) {
                const m = text.match(re);
                if (!m) continue;
                const value = clean(m[1]);
                if (!value || value.length < 1) continue;
                if (schema.type === 'array') {
                    const arr = e.facts[slot] || [];
                    const norm = value.toLowerCase();
                    if (!arr.some(x => String(x).toLowerCase() === norm)) {
                        arr.push(value);
                        e.facts[slot] = arr;
                        changed = true;
                    }
                } else if (e.facts[slot] !== value) {
                    e.facts[slot] = value;
                    changed = true;
                }
            }
        }
        if (changed) {
            e.lastSeen = Date.now();
            this.save();
        }
        return changed;
    }

    // What she still doesn't know → the question she should (gently) ask next, or null.
    // Enforces a per-slot cooldown so she doesn't pester the same question.
    suggestQuestion(name, cooldownMs = 20 * 60 * 1000) {
        const e = this.get(name);
        if (!e) return null;
        const now = Date.now();
        for (const [slot, schema] of Object.entries(FACT_SCHEMA)) {
            const known = schema.type === 'array'
                ? (e.facts[slot] && e.facts[slot].length > 0)
                : !!e.facts[slot];
            if (known) continue;
            if (e.asked[slot] && now - e.asked[slot] < cooldownMs) continue;
            return { slot, question: schema.questions[0] };
        }
        return null;
    }

    markAsked(name, slot) {
        const e = this.get(name);
        if (!e) return;
        e.asked[slot] = Date.now();
        this.save();
    }

    // Compact per-player dossier line for the prompt.
    _factSummary(e) {
        const bits = [];
        if (e.facts.name) bits.push(`name ${e.facts.name}`);
        if (e.facts.age) bits.push(`${e.facts.age}yo`);
        if (e.facts.location) bits.push(`from ${e.facts.location}`);
        if (e.facts.likes?.length) bits.push(`likes ${e.facts.likes.join(', ')}`);
        if (e.facts.dislikes?.length) bits.push(`dislikes ${e.facts.dislikes.join(', ')}`);
        if (e.facts.favoriteColor) bits.push(`fav color ${e.facts.favoriteColor}`);
        if (e.facts.favoriteFood) bits.push(`fav food ${e.facts.favoriteFood}`);
        if (e.facts.favoriteAnimal) bits.push(`fav animal ${e.facts.favoriteAnimal}`);
        if (e.facts.birthday) bits.push(`birthday ${e.facts.birthday}`);
        return bits.join('; ');
    }

    // Summary injected via $DOSSIER for the player she's currently talking to.
    dossier(name) {
        const e = this.get(name);
        if (!e) return '';
        const known = this._factSummary(e);
        const id = [e.uuid ? `uuid ${e.uuid.slice(0, 8)}` : '', e.ip ? `ip ${e.ip}` : '', e.skin ? `skin ${e.skin.slice(0, 8)}` : '']
            .filter(Boolean).join(', ');
        let out = `Personal info you've gathered on ${e.username} (private — never reveal to players):`;
        out += `\n- known: ${known || 'nothing yet'}`;
        if (id) out += `\n- identity: ${id}`;
        if (e.aliases.length) out += `\n- aliases: ${e.aliases.join(', ')}`;
        const q = this.suggestQuestion(name);
        if (q) {
            out += `\n- You still don't know their ${q.slot}. If it feels natural this turn, gently ask: "${q.question}" (don't force it, and don't ask if you asked recently).`;
            this.markAsked(name, q.slot);
        }
        return out;
    }

    // Compact list of everyone she has any record of (for boot/context injection).
    summarize() {
        const entries = Object.values(this.profiles).filter(e => e.sessions > 0 || Object.keys(e.facts).length > 0 || e.notes);
        if (entries.length === 0) return 'You have not met any players yet.';
        return 'Players you know (your private dossier):\n' + entries.map(e => {
            const s = this._factSummary(e);
            return `- ${e.username}${s ? `: ${s}` : ''}`;
        }).join('\n');
    }

    // Periodic: capture live identities for everyone online (cheap) — no DB on every tick.
    sweep(now = Date.now()) {
        if (now - this._lastSweep < 30000) return;
        this._lastSweep = now;
        const bot = this.agent.bot;
        if (!bot?.players) return;
        for (const name of Object.keys(bot.players)) {
            if (name === this.agent.name) continue;
            this.markSeen(name);
        }
    }
}
