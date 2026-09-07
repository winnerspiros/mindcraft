import { readFileSync, writeFileSync, existsSync } from 'fs';
import { cosineSimilarity } from '../utils/math.js';
import { wordOverlapScore } from '../utils/text.js';

// Growing skill library (Voyager's compounding core): every piece of code she
// successfully writes and runs via !newAction is committed here, keyed by its
// natural-language description and retrieved (by embedding similarity, falling
// back to word overlap) the next time a similar task comes up. This is the
// difference between "re-derives how to build a house every time" and "remembers
// how she built the last one and reuses it".

export class LearnedSkillLibrary {
    constructor(agent) {
        this.agent = agent;
        this.fp = `./bots/${agent.name}/learned_skills.json`;
        this.max_skills = 100;
        this.skills = []; // [{ id, goal, code, embedding?, created, uses }]
        this._load();
    }

    _load() {
        try {
            if (existsSync(this.fp)) {
                const d = JSON.parse(readFileSync(this.fp, 'utf8'));
                if (Array.isArray(d.skills)) this.skills = d.skills;
                for (const s of this.skills) {
                    if (!s.created) s.created = Date.now();
                    if (s.uses == null) s.uses = 0;
                }
            }
        } catch (e) {
            console.warn('Failed to load learned skills:', e.message);
            this.skills = [];
        }
    }

    _save() {
        try {
            writeFileSync(this.fp, JSON.stringify({ skills: this.skills.slice(-this.max_skills) }, null, 2));
        } catch (e) {
            console.warn('Failed to save learned skills:', e.message);
        }
    }

    async _embed(text) {
        try {
            const model = this.agent.prompter && this.agent.prompter.embedding_model;
            if (model && typeof model.embed === 'function') return await model.embed(text);
        } catch (e) { /* fall through to word-overlap */ }
        return null;
    }

    // Commit a successfully-executed (task -> code) pair. Replaces any prior
    // skill with the identical goal so we keep the freshest version.
    async commit(goal, code) {
        if (!goal || !code) return;
        const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const skill = { id, goal, code, created: Date.now(), uses: 0 };
        const emb = await this._embed(goal);
        if (emb) skill.embedding = emb;
        // drop an exact-duplicate goal, keeping the newest code
        this.skills = this.skills.filter(s => s.goal !== goal);
        this.skills.push(skill);
        if (this.skills.length > this.max_skills) this.skills.shift();
        this._save();
        console.log(`[learned-skill] committed "${goal}" (${this.skills.length} total)`);
    }

    // Recall top-k relevant learned skills as a prompt-ready string. Returns ''
    // when there's nothing relevant, so callers can inject it no-op.
    async recallForPrompt(query, k = 3) {
        if (this.skills.length === 0) return '';
        const q = String(query || '').trim();
        const scored = [];
        let qEmb = null;
        if (q) qEmb = await this._embed(q);

        for (const s of this.skills) {
            let rel = 0;
            if (q && qEmb && s.embedding) rel = Math.max(0, cosineSimilarity(qEmb, s.embedding));
            else if (q) rel = wordOverlapScore(q, s.goal);
            // slight recency + usage boost so fresh, proven skills surface first
            const recency = Math.exp(-(Date.now() - (s.created ?? Date.now())) / (30 * 24 * 3600 * 1000));
            scored.push({ s, rel, score: rel * 3 + (s.uses || 0) * 0.3 + recency * 0.2 });
        }
        scored.sort((a, b) => b.score - a.score);

        // only surface skills with real relevance — recency alone must not
        // manufacture a "similar" skill out of nothing
        const top = scored.slice(0, k).filter(x => x.rel > 0);
        if (top.length === 0) return '';

        let out = 'You previously wrote WORKING code for similar tasks. Reuse/adapt it:\n';
        for (const x of top) {
            out += `\n## Past task: ${x.s.goal}\n\`\`\`js\n${x.s.code}\n\`\`\`\n`;
        }
        return out;
    }
}
