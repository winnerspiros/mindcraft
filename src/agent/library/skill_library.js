import { cosineSimilarity } from '../../utils/math.js';
import { getSkillDocs } from './index.js';
import { wordOverlapScore } from '../../utils/text.js';
import { loadEmbedCache, saveEmbedCache } from '../../utils/embed_cache.js';

export class SkillLibrary {
    constructor(agent,embedding_model) {
        this.agent = agent;
        this.embedding_model = embedding_model;
        this.skill_docs_embeddings = {};
        this.skill_docs = null;
        this.always_show_skills = ['skills.placeBlock', 'skills.wait', 'skills.breakBlockAt']
    }
    async initSkillLibrary() {
        const skillDocs = getSkillDocs();
        this.skill_docs = skillDocs;
        if (this.embedding_model) {
            try {
                // Static skill headers are re-embedded (paid) on every boot even
                // though the text never changes. Persist them keyed on the header
                // text contents + model so the vectors are computed once and reused.
                // Behavior identical (same vectors, same cosine ranking).
                const headers = skillDocs.map(doc => doc.split('\n').slice(0, 2).join(''));
                const cacheDir = `bots/${this.agent?.name || 'UwU'}/embed_cache`;
                let modelTag = 'default';
                try { if (this.agent?.prompter?.profile?.embedding) modelTag = String(this.agent.prompter.profile.embedding); }
                catch (_) {}
                const cached = loadEmbedCache(cacheDir, 'skills', modelTag, headers);

                const missed = [];
                for (let i = 0; i < skillDocs.length; i++) {
                    const doc = skillDocs[i];
                    const header = headers[i];
                    if (cached && cached.embeddings[header] !== undefined) {
                        this.skill_docs_embeddings[doc] = cached.embeddings[header];
                    } else {
                        missed.push({ doc, header });
                    }
                }

                if (missed.length) {
                    const embeddingPromises = missed.map(({ doc, header }) => {
                        return this.embedding_model.embed(header)
                            .then(embedding => { this.skill_docs_embeddings[doc] = embedding; });
                    });
                    await Promise.all(embeddingPromises);
                    // persist only when the whole set is present
                    const complete = {};
                    let ok = true;
                    for (let i = 0; i < skillDocs.length; i++) {
                        const emb = this.skill_docs_embeddings[skillDocs[i]];
                        if (emb === undefined) { ok = false; break; }
                        complete[headers[i]] = emb;
                    }
                    if (ok) saveEmbedCache(cacheDir, 'skills', modelTag, headers, complete);
                }
            } catch (error) {
                console.warn('Error with embedding model, using word-overlap instead.');
                this.embedding_model = null;
            }
        }
        this.always_show_skills_docs = {};
        for (const skillName of this.always_show_skills) {
            this.always_show_skills_docs[skillName] = this.skill_docs.find(doc => doc.includes(skillName));
        }
    }

    async getAllSkillDocs() {
        return this.skill_docs;
    }

    // Discovery's skill-summary tool (ported): one line per skill so the
    // reviewer can scan the whole portfolio without bulky doc bodies.
    // First line is `skills.name`, second line is the short description.
    getAllSkillSummaries() {
        if (!this.skill_docs) return [];
        return this.skill_docs.map(doc => {
            const lines = String(doc).split('\n');
            return { name: (lines[0] || '').trim(), description: (lines[1] || '').trim() };
        });
    }

    async getRelevantSkillDocs(message, select_num) {
        if(!message) // use filler message if none is provided
            message = '(no message)';
        let skill_doc_similarities = [];

        const has_embeddings = this.embedding_model !== null;
        if (has_embeddings && select_num === -1) {
            // return all docs with neutral score (embedding model present)
            skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
            .map(doc_key => ({
                doc_key,
                similarity_score: 0
            }));
        }
        else if (has_embeddings) {
            try {
                let latest_message_embedding = await this.embedding_model.embed(message);
                skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
                .map(doc_key => ({
                    doc_key,
                    similarity_score: cosineSimilarity(latest_message_embedding, this.skill_docs_embeddings[doc_key])
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
            } catch (e) {
                // Query-time embed failure (e.g. provider with no embeddings API):
                // degrade to word-overlap over the raw doc text and remember the
                // model is unusable so we don't re-throw on every request.
                console.warn('Embedding failed at query time, falling back to word-overlap:', e.message);
                this.embedding_model = null;
                skill_doc_similarities = this.skill_docs.map(doc => ({
                    doc_key: doc,
                    similarity_score: wordOverlapScore(message, doc)
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
            }
        }
        else {
            // No embedding model (OpenRouter etc): rank raw docs by word overlap.
            // NOTE: previously this iterated skill_docs_embeddings (empty after a
            // failed init) and passed an embedding VECTOR as the "text2" arg —
            // so it selected nothing and !newAction effectively had no skill docs.
            skill_doc_similarities = this.skill_docs.map(doc => ({
                doc_key: doc,
                similarity_score: wordOverlapScore(message, doc)
            }))
            .sort((a, b) => b.similarity_score - a.similarity_score);
        }

        let length = skill_doc_similarities.length;
        if (select_num === -1 || select_num > length) {
            select_num = length;
        }
        // Get initial docs from similarity scores
        let selected_docs = new Set(skill_doc_similarities.slice(0, select_num).map(doc => doc.doc_key));
        
        // Add always show docs
        Object.values(this.always_show_skills_docs).forEach(doc => {
            if (doc) {
                selected_docs.add(doc);
            }
        });
        
        let relevant_skill_docs = '#### RELEVANT CODE DOCS ###\nThe following functions are available to use:\n';
        relevant_skill_docs += Array.from(selected_docs).join('\n### ');

        console.log('Selected skill docs:', Array.from(selected_docs).map(doc => {
            const first_line_break = doc.indexOf('\n');
            return first_line_break > 0 ? doc.substring(0, first_line_break) : doc;
        }));
        return relevant_skill_docs;
    }
}
