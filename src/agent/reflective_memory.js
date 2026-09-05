import { writeFileSync, readFileSync, existsSync } from 'fs';
import { cosineSimilarity } from '../utils/math.js';
import { wordOverlapScore } from '../utils/text.js';
import settings from './settings.js';

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
                const mem = { id: this._id(), text };
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

    // Rank memories by relevance to the query; fall back to word overlap when the
    // embedding model is unavailable (mirrors SkillLibrary's degradation).
    async recall(query, k = this.recall_count) {
        if (!this.enabled || this.memories.length === 0) return '';
        const q = String(query || '').trim();
        k = Math.min(k, this.memories.length);

        let ranked = this.memories.map(m => ({ m, s: wordOverlapScore(q, m.text) }));
        if (q) {
            const qEmb = await this._embed(q);
            if (qEmb) {
                ranked = this.memories.map(m => ({
                    m,
                    s: m.embedding ? cosineSimilarity(qEmb, m.embedding) : wordOverlapScore(q, m.text),
                }));
            }
        }
        ranked.sort((a, b) => b.s - a.s);
        return ranked.slice(0, k).map(x => x.m.text).join('\n');
    }
}
