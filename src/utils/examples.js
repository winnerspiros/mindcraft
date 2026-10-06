import { cosineSimilarity } from './math.js';
import { stringifyTurns, wordOverlapScore } from './text.js';
import { loadEmbedCache, saveEmbedCache } from './embed_cache.js';

export class Examples {
    constructor(model, select_num=2, opts={}) {
        this.examples = [];
        this.model = model;
        this.select_num = select_num;
        this.embeddings = {};
        // opts: { cacheDir, modelTag, kind } — when cacheDir+modelTag present,
        // static embeddings are persisted (keyed on hash of texts + model) so
        // they are computed once, not re-billed every boot. `kind` separates
        // DIFFERENT static sets (convo vs coding vs persona) into distinct
        // cache files so they don't overwrite each other. Behavior identical.
        this.cacheDir = opts && opts.cacheDir;
        this.modelTag = opts && opts.modelTag;
        this.cacheKind = (opts && opts.kind) || 'examples';
    }

    turnsToText(turns) {
        let messages = '';
        for (let turn of turns) {
            if (turn.role !== 'assistant')
                messages += turn.content.substring(turn.content.indexOf(':')+1).trim() + '\n';
        }
        return messages.trim();
    }

    async load(examples) {
        this.examples = examples;
        if (!this.model) return; // Early return if no embedding model
        
        if (this.select_num === 0)
            return;

        try {
            const texts = examples.map(e => this.turnsToText(e));

            // Disk-cache hit: reuse previously-computed vectors (same static text,
            // same model). Removes ~194 paid embedding calls on every restart.
            let cached = null;
            if (this.cacheDir && this.modelTag) {
                cached = loadEmbedCache(this.cacheDir, this.cacheKind, this.modelTag, texts);
                if (cached) {
                    for (const t of texts) {
                        if (cached.embeddings[t] !== undefined)
                            this.embeddings[t] = cached.embeddings[t];
                    }
                }
            }

            const missed = texts.filter(t => this.embeddings[t] === undefined);

            // Only bill the model for the texts the cache did not already hold.
            const embeddingPromises = missed.map(turn_text => {
                return this.model.embed(turn_text)
                    .then(embedding => {
                        this.embeddings[turn_text] = embedding;
                    });
            });

            // Wait for all embeddings to complete
            await Promise.all(embeddingPromises);

            // Persist the full set when we filled any gap (cache is keyed on the
            // whole text list, so write once with the complete map).
            if (this.cacheDir && this.modelTag) {
                const complete = {};
                for (const t of texts) {
                    if (this.embeddings[t] !== undefined) complete[t] = this.embeddings[t];
                }
                if (Object.keys(complete).length === texts.length)
                    saveEmbedCache(this.cacheDir, this.cacheKind, this.modelTag, texts, complete);
            }
        } catch (err) {
            console.warn('Error with embedding model, using word-overlap instead.');
            this.model = null;
        }
    }

    async getRelevant(turns) {
        if (this.select_num === 0)
            return [];

        let turn_text = this.turnsToText(turns);
        if (this.model !== null) {
            let embedding = await this.model.embed(turn_text);
            this.examples.sort((a, b) => 
                cosineSimilarity(embedding, this.embeddings[this.turnsToText(b)]) -
                cosineSimilarity(embedding, this.embeddings[this.turnsToText(a)])
            );
        }
        else {
            this.examples.sort((a, b) => 
                wordOverlapScore(turn_text, this.turnsToText(b)) -
                wordOverlapScore(turn_text, this.turnsToText(a))
            );
        }
        let selected = this.examples.slice(0, this.select_num);
        return JSON.parse(JSON.stringify(selected)); // deep copy
    }

    async createExampleMessage(turns) {
        let selected_examples = await this.getRelevant(turns);

        console.log('selected examples:');
        for (let example of selected_examples) {
            console.log('Example:', example[0].content)
        }

        let msg = 'Examples of how to respond:\n';
        for (let i=0; i<selected_examples.length; i++) {
            let example = selected_examples[i];
            msg += `Example ${i+1}:\n${stringifyTurns(example)}\n\n`;
        }
        return msg;
    }
}