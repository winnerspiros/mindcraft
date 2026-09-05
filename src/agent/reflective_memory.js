import { writeFileSync, readFileSync, existsSync } from 'fs';
import { cosineSimilarity } from '../utils/math.js';
import { wordOverlapScore } from '../utils/text.js';
import settings from './settings.js';

// Generative-Agents "poignancy" scoring: not every memory is equal. A fact about
// a promise, betrayal, secret or strong feeling should outrank mundane chatter.
// Cheap deterministic stand-in for the original's LLM-rated 1-10 importance.
const SIGNIFICANT_WORDS = [
    'promise', 'secret', 'trust', 'betray', 'lied', 'lie', 'love', 'hate',
    'kill', 'hurt', 'forgive', 'sorry', 'marry', 'friend', 'enemy', 'favorite',
    'favourite', 'never', 'always', 'remember',
];
const RECENCY_HALF_LIFE = 7 * 24 * 60 * 60 * 1000; // 7 days — recency weight halves

function _importance(text) {
    const t = String(text || '').toLowerCase();
    let s = 0.3;
    for (const w of SIGNIFICANT_WORDS) if (t.includes(w)) s += 0.15;
    if (t.length > 60) s += 0.1; // more specific = more meaningful
    return Math.min(1, s);
}

// Durable, semantically-searchable long-term memory (Generative-Agents style
// "reflection" + RAG recall), inspired by kimjammer/Neuro's memory module.
// Distinct from History.memory (a single rolling 500-char summary): this stores
// many discrete facts and retrieves only the top-k most relevant each turn, so
// "you never forget a single detail" has real backing across restarts.
export class ReflectiveMemory {
    constructor(agent) {
        this.agent = agent;
        this.enabled = settings.reflection_memory !== false;
        this.interval = settings.reflection_interval || 15;
        this.recall_count = settings.reflection_recall_count || 5;
        this.max_memories = 200;
        this.fp = `./bots/${agent.name}/reflections.json`;

        this.memories = [];   // [{ id, text, embedding? }]
        this._buffer = [];    // unreflected {role, content} turns
        this._reflecting = false;

        this._load();
    }

    _load() {
        try {
            if (existsSync(this.fp)) {
                const data = JSON.parse(readFileSync(this.fp, 'utf8'));
                this.memories = Array.isArray(data.memories) ? data.memories : [];
                for (const m of this.memories) {
                    if (!m.created) m.created = Date.now();
                    if (m.importance == null) m.importance = _importance(m.text);
                }
            }
        } catch (e) {
            console.warn('Failed to load reflections:', e.message);
            this.memories = [];
        }
    }

    _save() {
        try {
            writeFileSync(this.fp, JSON.stringify({ memories: this.memories }, null, 2));
        } catch (e) {
            console.warn('Failed to save reflections:', e.message);
        }
    }

    // Called from History.add for every conversational turn. Fire-and-forget so it
    // never stalls the message loop.
    pushTurn(turn) {
        if (!this.enabled) return;
        this._buffer.push(turn);
        if (this._buffer.length >= this.interval && !this._reflecting) {
            this._reflecting = true;
            this._reflect().finally(() => { this._reflecting = false; });
        }
    }

    async _reflect() {
        const turns = this._buffer.splice(0, this.interval);
        try {
            const raw = await this.agent.prompter.promptReflection(turns);
            const facts = this._parse(raw);
            for (const text of facts) {
                const mem = { id: this._id(), text, created: Date.now(), importance: _importance(text) };
                const embedding = await this._embed(text);
                if (embedding) mem.embedding = embedding;
                this.memories.push(mem);
            }
            while (this.memories.length > this.max_memories) this.memories.shift();
            this._save();
            if (facts.length) console.log(`[reflection] stored ${facts.length} memories (total ${this.memories.length})`);
        } catch (e) {
            console.warn('reflection failed (non-fatal):', e.message);
        }
    }

    // Parse a bulleted/numbered list of facts out of the model's raw text.
    _parse(raw) {
        const out = [];
        if (typeof raw !== 'string') return out;
        for (const line of raw.split('\n')) {
            let t = line.trim();
            t = t.replace(/^[-*•\d.)\s]+/, '').trim();  // strip bullets / list numbers
            if (t && t.length >= 3 && t.length <= 300) out.push(t);
        }
        return out.slice(0, 5);
    }

    async _embed(text) {
        try {
            const model = this.agent.prompter && this.agent.prompter.embedding_model;
            if (model && typeof model.embed === 'function') return await model.embed(text);
        } catch (e) { /* fall through to no-embedding path */ }
        return null;
    }

    _id() {
        return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // Rank memories by a weighted blend of relevance × importance × recency
    // (Generative-Agents "poignancy" retrieval): relevance dominates, importance
    // keeps meaningful facts (promises, betrayals) above mundane chatter, and a
    // gentle recency decay favours fresher memories. Falls back to word overlap
    // when the embedding model is unavailable.
    async recall(query, k = this.recall_count) {
        if (!this.enabled || this.memories.length === 0) return '';
        const q = String(query || '').trim();
        k = Math.min(k, this.memories.length);
        const now = Date.now();

        let qEmb = null;
        if (q) qEmb = await this._embed(q);

        const scored = this.memories.map(m => {
            let rel = 0;
            if (q && qEmb && m.embedding) rel = Math.max(0, cosineSimilarity(qEmb, m.embedding));
            else if (q) rel = wordOverlapScore(q, m.text);
            const imp = m.importance ?? _importance(m.text);
            const rec = Math.exp(-(now - (m.created ?? now)) / RECENCY_HALF_LIFE);
            return { m, s: rel * 3 + imp * 2 + rec * 0.5 };
        });
        scored.sort((a, b) => b.s - a.s);
        return scored.slice(0, k).map(x => x.m.text).join('\n');
    }
}
