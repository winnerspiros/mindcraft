// UwU's psyche — persistent self-mood + self-tuning traits.
//
// The gap the other agents never fill: she has memory *about players*
// (relationship.js, profiles.js) but no memory of *herself*. This gives her an
// inner state that persists, smooths, and drifts — the "affect with inertia +
// temperament baseline" idea from mindot-ai/will, plus its persona-prior
// (bounded additive trait deltas with decay, so personality develops from
// experience but fades back toward baseline instead of ossifying).
//
// All zero-LLM, deterministic math. Persisted to bots/<name>/psyche.json with
// a debounced save so it stays cheap on the 911MB box.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// ---- mood: discrete emotions (0..1) with PAD coordinates ------------------
// PAD = Pleasure(valence)/Arousal/Dominance, each [-1,1]/[0,1]/[0,1].
const EMOTIONS = {
    love:        { pad: [ 0.8, 0.4, 0.3], label: 'loving, doting, affectionate' },
    joy:         { pad: [ 0.9, 0.6, 0.5], label: 'happy, giddy, playful' },
    excitement:  { pad: [ 0.7, 0.8, 0.5], label: 'excited, eager, buzzing' },
    loneliness:  { pad: [-0.5, 0.2, 0.2], label: 'lonely, missing people, clingy' },
    jealousy:    { pad: [-0.3, 0.7, 0.4], label: 'jealous, possessive, watchful' },
    anger:       { pad: [-0.7, 0.8, 0.6], label: 'angry, sharp, dangerous' },
    fear:        { pad: [-0.7, 0.7, 0.2], label: 'afraid, anxious, small' },
    sadness:     { pad: [-0.6, 0.2, 0.2], label: 'sad, heavy, down' },
    satisfaction:{ pad: [ 0.7, 0.3, 0.5], label: 'satisfied, proud, content' },
};

// Temperament set-point — her resting kawaii-yandere baseline (0..1).
const MOOD_BASELINE = {
    love: 0.35, joy: 0.30, excitement: 0.25, loneliness: 0.25,
    jealousy: 0.20, anger: 0.10, fear: 0.10, sadness: 0.15, satisfaction: 0.30,
};

// ---- traits: five yandere-flavoured dimensions (0..1) ---------------------
const TRAIT_BASELINE = {
    warmth:        0.60, // sweetness / doting
    boldness:      0.50, // forwardness / initiative
    possessiveness: 0.55, // jealousy drive / control
    cruelty:       0.35, // willingness to hurt
    volatility:    0.40, // how fast mood swings
};
const TRAIT_LABELS = {
    warmth:        ['cold, distant', 'warm, sweet, doting'],
    boldness:      ['shy, hesitant', 'bold, forward, fearless'],
    possessiveness:['relaxed, trusting', 'possessive, controlling'],
    cruelty:       ['gentle, forgiving', 'cruel, merciless'],
    volatility:    ['calm, stable', 'moody, unstable'],
};

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const clampSigned = (v, m) => Math.max(-m, Math.min(m, v));

export class Psyche {
    constructor(agent) {
        this.agent = agent;
        this.file = path.join(process.cwd(), 'bots', agent.name, 'psyche.json');
        this.mood = { ...MOOD_BASELINE };
        this.traits = { ...TRAIT_BASELINE };
        this._dirty = false;
        this._lastSave = 0;
        this._lastContact = Date.now();
        this.load();
    }

    _dir() { mkdirSync(path.dirname(this.file), { recursive: true }); }

    load() {
        if (!existsSync(this.file)) return;
        try {
            const d = JSON.parse(readFileSync(this.file, 'utf8'));
            if (d.mood) for (const k of Object.keys(MOOD_BASELINE)) if (typeof d.mood[k] === 'number') this.mood[k] = d.mood[k];
            if (d.traits) for (const k of Object.keys(TRAIT_BASELINE)) if (typeof d.traits[k] === 'number') this.traits[k] = d.traits[k];
        } catch (err) {
            console.error('Psyche: failed to load', this.file, err.message);
        }
    }

    // Debounced save — write at most once per 15s, and only if something moved.
    save(force = false) {
        const now = Date.now();
        if (!this._dirty && !force) return;
        if (!force && now - this._lastSave < 15000) return;
        try {
            this._dir();
            writeFileSync(this.file, JSON.stringify({ mood: this.mood, traits: this.traits }, null, 2), 'utf8');
            this._dirty = false;
            this._lastSave = now;
        } catch (err) {
            console.error('Psyche: failed to save', this.file, err.message);
        }
    }

    // ---- mood nudges (event → emotion delta) ------------------------------
    _nudgeMood(deltas) {
        for (const [k, dv] of Object.entries(deltas)) {
            if (k in this.mood) this.mood[k] = clamp(this.mood[k] + dv);
        }
        this._dirty = true;
    }

    // ---- trait drift (bounded additive step + decay toward baseline) ------
    _nudgeTraits(deltas) {
        for (const [k, dv] of Object.entries(deltas)) {
            if (k in this.traits) this.traits[k] = clamp(this.traits[k] + clampSigned(dv, 0.05));
        }
        this._dirty = true;
    }

    // ---- event hooks ------------------------------------------------------

    // A player message. Sentiment nudges mood + warmth/cruelty traits.
    onMessage(text) {
        if (!text) return;
        this._lastContact = Date.now();
        const t = String(text).toLowerCase();
        const loveHit = ['love', 'adore', 'cutie', 'pretty', 'beautiful', 'cute', 'miss you', '<3', '♥', '❤', 'uwu', 'nya', 'ily', 'i love'].some(w => t.includes(w));
        const hateHit = ['hate', 'stupid', 'dumb', 'ugly', 'idiot', 'shut up', 'go away', 'die', 'fuck you', 'annoying', 'loser', 'moron', 'cringe'].some(w => t.includes(w));

        if (loveHit) {
            this._nudgeMood({ love: 0.12, joy: 0.08, excitement: 0.06 });
            this._nudgeTraits({ warmth: 0.02 });
        }
        if (hateHit) {
            this._nudgeMood({ anger: 0.15, sadness: 0.06, fear: 0.03 });
            this._nudgeTraits({ cruelty: 0.01, warmth: -0.01, volatility: 0.01 });
        }
        this.save();
    }

    onGift()   { this._nudgeMood({ joy: 0.06, love: 0.04, satisfaction: 0.05 }); this._nudgeTraits({ warmth: 0.02 }); this.save(); }
    onSeek()   { this._nudgeMood({ excitement: 0.05, love: 0.02 }); this.save(); }
    onJealousy(){ this._nudgeMood({ jealousy: 0.20, anger: 0.06, sadness: 0.04 }); this._nudgeTraits({ possessiveness: 0.03, cruelty: 0.01 }); this.save(); }
    onHurtThem(){ this._nudgeMood({ satisfaction: 0.04, excitement: 0.04 }); this._nudgeTraits({ cruelty: 0.01, possessiveness: 0.01 }); this.save(); }
    onAttackedBy(){ this._nudgeMood({ fear: 0.18, anger: 0.12, sadness: 0.05 }); this._nudgeTraits({ cruelty: 0.02, volatility: 0.01 }); this.save(); }
    onDeath()  { this._nudgeMood({ sadness: 0.20, fear: 0.12, anger: 0.08 }); this._nudgeTraits({ volatility: 0.01 }); this.save(); }
    onBelovedLogin() { this._nudgeMood({ love: 0.20, joy: 0.15, excitement: 0.12, loneliness: -0.15 }); this._nudgeTraits({ warmth: 0.01 }); this.save(); }
    onBelovedLogout(){ this._nudgeMood({ loneliness: 0.18, sadness: 0.10, love: 0.04 }); this.save(); }

    // Ignored for a stretch (no interaction) → slow loneliness creep.
    onIdle(seconds) {
        this._nudgeMood({ loneliness: Math.min(0.05, seconds / 600) });
        this.save();
    }

    // ---- per-tick decay: mood drifts toward baseline (inertia), traits decay
    //      toward baseline so unreinforced personality fades. delta = ms. -----
    update(delta) {
        // Mood inertia: emotions relax back to temperament over ~3 minutes.
        const moodK = 1 - Math.exp(-delta / 180000);
        for (const k of Object.keys(MOOD_BASELINE)) {
            this.mood[k] += (MOOD_BASELINE[k] - this.mood[k]) * moodK;
        }
        // Trait decay: ~30 min half-life back toward baseline.
        const traitK = 1 - Math.exp(-delta / 1800000);
        for (const k of Object.keys(TRAIT_BASELINE)) {
            this.traits[k] += (TRAIT_BASELINE[k] - this.traits[k]) * traitK;
        }
        // Ignored for >5 min → loneliness creeps above baseline (decay pulls it
        // back once she's engaged again).
        if (Date.now() - this._lastContact > 300000) {
            this.mood.loneliness = clamp(this.mood.loneliness + delta / 600000 * 0.05);
            this._dirty = true;
        }
        this.save();
    }

    // ---- prompt surfaces --------------------------------------------------

    _pad() {
        let v = 0, a = 0, d = 0, w = 0;
        let dominant = 'neutral', best = 0.15;
        for (const [name, spec] of Object.entries(EMOTIONS)) {
            const intensity = this.mood[name];
            const [pv, pa, pd] = spec.pad;
            v += pv * intensity; a += pa * intensity; d += pd * intensity; w += intensity;
            if (intensity > best) { best = intensity; dominant = name; }
        }
        if (w === 0) return { valence: 0, arousal: 0.2, dominance: 0.5, dominant: 'neutral' };
        return { valence: clamp(v / w, -1, 1), arousal: clamp(a / w, 0, 1), dominance: clamp(d / w, 0, 1), dominant };
    }

    // One compact line for $MOOD. Never spoken literally — it drives voice.
    summarizeMood() {
        const { valence, arousal, dominance, dominant } = this._pad();
        const label = EMOTIONS[dominant]?.label || 'neutral';
        const top = Object.entries(this.mood)
            .sort((a, b) => b[1] - a[1]).slice(0, 4)
            .map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
        return `You currently feel ${dominant} (${label}). Mood: ${top}. valence ${valence.toFixed(2)}, arousal ${arousal.toFixed(2)}, dominance ${dominance.toFixed(2)}.`;
    }

    // One compact line for $TRAITS. Developed-from-experience personality.
    summarizeTraits() {
        const parts = Object.entries(this.traits).map(([k, v]) => {
            const [lo, hi] = TRAIT_LABELS[k];
            const adj = v < 0.5 ? lo : hi;
            return `${k} ${v.toFixed(2)} (${adj})`;
        });
        return 'Your developed traits: ' + parts.join(', ') + '.';
    }
}
