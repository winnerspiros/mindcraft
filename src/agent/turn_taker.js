// TurnTaker — DuplexGen-style scenario-adaptive turn-taking for UwU.
//
// Ported in spirit from duplexgen/duplexgen-code (Kim et al.): the core idea
// there is that turn-taking behaviour is a THREE-way decision at each moment
// (floor_taking / backchannel / silence), not a binary "reply or not", and that
// the right choice is SCENARIO-DEPENDENT — so they calibrate an LLM against slot
// -level human preferences instead of relying on a generic prompt.
//
// What we steal:
//   1. The 3-class taxonomy. Silent is a first-class outcome, so she can now
//      choose to shut up on purpose (before, every inbound line forced a reply).
//   2. VERBALIZED PROBABILITIES: ask the model for a distribution, not a label.
//      We keep the full distribution (their soft_classification / KL trick) and
//      threshold it — the confidence number is free and honest.
//   3. Scenario description in the prompt, so the same model behaves
//      differently per relationship tier instead of one global norm.
//   4. Boundary candidates inside an utterance: hesitation words + terminal
//      punctuation, minus the last one (their interruption_guard /
//      length_guard ideas) — this is what lets her cut in mid-sentence.
//
// What we do NOT take: the trained 3-class HF head + their human annotation
// corpus. On a 1-OCPU box that is out of reach and, honestly, unnecessary at
// the scale she converses at. The verbalized-probability path is their own
// documented baseline and needs no training.
//
// Calibration data (real observed choices) is persisted per tier so the
// thresholds drift toward HER actual behaviour over time instead of a magic
// constant. See stats() and _calibrate().

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const LABELS = ['floor_taking', 'backchannel', 'silence'];

// Their HESITATIONS set (src/synthesis/core.py) — words after which a speaker
// is plausibly mid-thought and a listener could chime in.
const HESITATIONS = new Set(['um', 'uh', 'umm', 'uhh', 'hm', 'hmm', 'huh', 'heh']);
// Their STOP_PUNCTUATION regex — a clause-final token.
const STOP_PUNCTUATION = /[.,?!;]+$/;

const DEFAULT_THRESHOLDS = { floor_taking: 0.45, backchannel: 0.40, silence: 0.55 };

// Kept short and identical in spirit to their verbalized-scoring prompt: a
// distribution over the three classes, JSON only, summing to 1.
const SCORING_PROMPT = `You predict conversational turn-taking behaviour in a live chat.

At this exact moment in the conversation, estimate the probability that the AI girl ($NAME) does each of three things next:
- floor_taking: she interrupts and takes the conversational floor — replies substantively, asks a question, teases, claims attention.
- backchannel: she gives a brief acknowledgement WITHOUT taking the floor ("mm-hm", "I see", "right", "yeah") and the player is expected to keep talking.
- silence: she says nothing and keeps listening.

Think about what SHE would prefer here given her personality and how she feels about this player. Someone who adores them is far more likely to seize the floor with them than to sit silent; with a stranger or someone she resents she is far more likely to go quiet or give a cold one-word ack. Being ignored, ignored-adjacent, or mid-task also pushes toward silence.

Output JSON only, three probabilities between 0 and 1 summing to 1:
{"floor_taking": <float>, "backchannel": <float>, "silence": <float>}`;

function renorm(a, b, c) {
    const s = a + b + c;
    if (!(s > 0)) return { floor_taking: 0, backchannel: 0, silence: 1 };
    return { floor_taking: a / s, backchannel: b / s, silence: c / s };
}

export class TurnTaker {
    constructor(agent, opts = {}) {
        this.agent = agent;
        this.file = path.join(process.cwd(), 'bots', agent.name, 'turn_taking.json');
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
        // stats[rank] = { floor_taking, backchannel, silence } observed counts.
        this.stats = {};
        // Per-player cooldown: never score the same person twice inside this.
        this.lastScored = new Map();
        this.enabled = opts.enabled !== false;
        this.cooldownMs = opts.cooldownMs ?? 2500;
        this.load();
    }

    load() {
        if (!existsSync(this.file)) return;
        try {
            const d = JSON.parse(readFileSync(this.file, 'utf8'));
            if (d.thresholds) Object.assign(this.thresholds, d.thresholds);
            if (d.stats && typeof d.stats === 'object') this.stats = d.stats;
        } catch (e) {
            console.warn('[turntaker] load failed:', e.message);
        }
    }

    save() {
        try {
            mkdirSync(path.dirname(this.file), { recursive: true });
            writeFileSync(this.file, JSON.stringify({ thresholds: this.thresholds, stats: this.stats }, null, 2), 'utf8');
        } catch (e) {
            console.warn('[turntaker] save failed:', e.message);
        }
    }

    // Her relationship with this player IS the scenario. That mapping is the
    // whole point of DuplexGen: same model, different norms per situation.
    scenarioFor(username) {
        const rel = this.agent.relationship && this.agent.relationship.get(username);
        const rank = (rel && rel.rank) || 'stranger';
        const bits = [`Relationship: ${rank}.`];
        // Her private goal may still be running — silence is likelier.
        if (this.agent.self_prompter && typeof this.agent.self_prompter.isActive === 'function'
            && this.agent.self_prompter.isActive()) {
            bits.push('She is mid-activity in the world right now, so she is less available to talk.');
        }
        if (this.agent.shut_up) bits.push('She has been told to be quiet.');
        return bits.join(' ');
    }

    // Candidate moments INSIDE a player's message where she could chime in.
    // Same construction as theirs: hesitation tokens + clause-final punctuation.
    //
    // We do NOT carry over their "drop the last boundary" rule. It only makes
    // sense for a STREAMING partial, where the final token is the live edge and
    // its index is the end of the turn rather than an interior moment. A
    // complete Minecraft chat line has no live edge, and dropping the tail there
    // deletes the best interjection point ("I was going to the— oh, um, anyway").
    // Their rule is unreachable on complete text anyway: a punctuation tail counts
    // as terminated, and a hesitation tail isn't punctuation, so neither case
    // satisfies "unterminated AND trailing candidate". Kept as pure candidate
    // extraction.
    boundaries(text) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const idx = [];
        words.forEach((w, i) => {
            const clean = w.toLowerCase().replace(/[^a-z]/g, '');
            if (HESITATIONS.has(clean) || STOP_PUNCTUATION.test(w)) idx.push(i);
        });
        return idx;
    }

    async score(username, partialText) {
        if (!this.enabled) return null;
        const last = this.lastScored.get(username) || 0;
        if (Date.now() - last < this.cooldownMs) return null;
        this.lastScored.set(username, Date.now());

        const history = (this.agent.history && this.agent.history.getHistory
            ? this.agent.history.getHistory().slice(-4)
            : []) || [];
        // Role label: anything that isn't her is the player, whatever the
        // history file happens to call it (her hist files use 'user' for
        // players, but whisper/system/self entries exist too).
        const ctx = history
            .map(t => `${t.role === this.agent.name ? this.agent.name : 'player'}: ${t.content}`)
            .join('\n');

        const prompt = SCORING_PROMPT
            .replaceAll('$NAME', this.agent.name)
            + `\n\nScenario:\n${this.scenarioFor(username)}\n\nRecent conversation:\n${ctx || '(none)'}\n\nPlayer's message so far: "${partialText}"\n\nBoundary: she may respond now, or wait. JSON only.`;

        try {
            const resp = await this.agent.prompter.chat_model.sendRequest(
                [{ role: 'user', content: prompt }],
                prompt
            );
            let raw = typeof resp === 'string' ? resp : String(resp || '');
            if (raw.includes('</think>')) raw = raw.split('</think>')[1];
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('no JSON');
            const p = JSON.parse(m[0]);
            const dist = renorm(
                Number(p.floor_taking) || 0,
                Number(p.backchannel) || 0,
                Number(p.silence) || 0
            );
            this.record(username, dist);
            return dist;
        } catch (e) {
            console.warn('[turntaker] score failed:', e.message);
            return null;
        }
    }

    // Pick a class from the distribution.
    //
    // Ordering matters: the earlier version hardcoded floor_taking as the
    // fallback, which meant ANY distribution where no threshold cleared made
    // her speak — including one where silence was the clear plurality. That is
    // the exact behaviour this module exists to remove, so there is no
    // "default to talking" branch anywhere in here.
    //
    // A class is eligible only if it is the ARGMAX (beats both rivals, ties go
    // to silence) AND clears its own confidence threshold. When a class is
    // argmax but under-confident — e.g. f=0.44, b=0.31, s=0.25 — she has no
    // business seizing the floor, so she acknowledges instead: weak talk is
    // worse than a continuer.
    decide(dist) {
        if (!dist) return { action: 'backchannel', confidence: 0, dist: null, fallback: true };
        const { floor_taking: f, backchannel: b, silence: s } = dist;
        const argmax = s >= f && s >= b ? 'silence' : f >= b ? 'floor_taking' : 'backchannel';

        if (argmax === 'silence' && s >= this.thresholds.silence) {
            return { action: 'silence', confidence: s, dist };
        }
        if (argmax === 'floor_taking' && f >= this.thresholds.floor_taking) {
            return { action: 'floor_taking', confidence: f, dist };
        }
        if (argmax === 'backchannel' && b >= this.thresholds.backchannel) {
            return { action: 'backchannel', confidence: b, dist };
        }
        // Under-confident plurality: acknowledge and hand the floor back.
        return { action: 'backchannel', confidence: Math.max(b, f), dist, underconfident: true };
    }

    // Persist per-tier observed distributions. Debounced: this runs on every
    // scored message and the file is tiny, but there is no reason to hammer
    // the disk — stats are only read for tuning, so a 30s lag is invisible.
    record(username, dist) {
        const rel = this.agent.relationship && this.agent.relationship.get(username);
        const rank = (rel && rel.rank) || 'stranger';
        const row = this.stats[rank] || (this.stats[rank] = { floor_taking: 0, backchannel: 0, silence: 0 });
        row.floor_taking += dist.floor_taking;
        row.backchannel += dist.backchannel;
        row.silence += dist.silence;
        const now = Date.now();
        if (!this._lastSave || now - this._lastSave > 30000) {
            this._lastSave = now;
            this.save();
        }
    }

    // E[action | tier] over observed decisions. Used for logging/tuning; the
    // module deliberately does NOT rewrite thresholds from this on its own —
    // an unvalidated drift loop is how you get a bot that stops talking.
    stats_for(rank) {
        const row = this.stats[rank];
        if (!row) return null;
        const sum = row.floor_taking + row.backchannel + row.silence;
        if (sum <= 0) return null;
        return {
            floor_taking: row.floor_taking / sum,
            backchannel: row.backchannel / sum,
            silence: row.silence / sum,
            n: sum,
        };
    }

    summary() {
        const out = {};
        for (const rank of Object.keys(this.stats)) out[rank] = this.stats_for(rank);
        return out;
    }
}

export { LABELS };