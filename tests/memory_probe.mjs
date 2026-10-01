// Reproduces UwU's REAL recall() ranking from reflective_memory.js:
//   score = rel*3 + importance*2 + recency*0.5
//   rel    = max(0, cosine(qEmb, mem.embedding))   (embeddings exist here)
//   rec    = exp(-(now - created) / 7d)
// Runs her ranking over her REAL on-disk memories with a REAL query embedding,
// so this is the actual order she would retrieve, not an estimate.
// Read-only: nothing written.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import settings from '../settings.js';
import { selectAPI, createModel } from '../src/models/_model_map.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const HALF = 7 * 24 * 60 * 60 * 1000;
const read = (p) => readFileSync(p, 'utf8');

function cosine(a, b) {
    let s = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const mem = JSON.parse(read('bots/UwU/reflections.json')).memories;

// real embedding backend
const profile = JSON.parse(read('uwu.json'));
const raw = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(raw);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const chatModel = createModel(sel);

// Real embedding backend. NOTE: prompter.js falls back to
// createModel({api: chat_api}) when profile.embedding is unset, and that
// object DOES have a working .embed() (dim 1536, matching her stored
// vectors). My first probe tried to build a `{model: "api/..."}` object
// instead and wrongly concluded embedding was unavailable.
const embedder = createModel({ api: sel.api });
console.log('embedder from api:', sel.api, '| has embed():', typeof embedder.embed === 'function');
console.log('stored embedding dim:', mem[0].embedding.length);

const CASES = [
    ['single fact (should be easy)', 'what does she like to collect?'],
    ['EVENT across turns', 'what happened when we built the thing together'],
    ['multi-session event', 'the last time we went mining what did we do'],
    ['episodic', 'the time she got upset about a player'],
    ['change over time', 'how has her attitude to me changed'],
];

const now = Date.now();
for (const [label, q] of CASES) {
    let qEmb = null;
    if (embedder) { try { qEmb = await embedder.embed(q); } catch (e) { console.log('embed failed:', e.message); } }
    const scored = mem.map(m => {
        const rel = (qEmb && m.embedding) ? Math.max(0, cosine(qEmb, m.embedding)) : 0;
        const imp = m.importance ?? 0.4;
        const rec = Math.exp(-(now - (m.created ?? now)) / HALF);
        return { m, rel, imp, rec, s: rel * 3 + imp * 2 + rec * 0.5 };
    });
    scored.sort((a, b) => b.s - a.s);
    console.log(`\n[${label}] "${q}"`);
    for (const t of scored.slice(0, 3)) {
        console.log(`   ${t.s.toFixed(2)} = rel ${t.rel.toFixed(2)}*3 + imp ${t.imp.toFixed(2)}*2 + rec ${t.rec.toFixed(2)}*0.5  | ${t.m.text.slice(0, 74)}`);
    }
    // how much of the top score is relevance vs the constant bias?
    const top = scored[0];
    console.log(`   -> relevance share of winner: ${((top.rel * 3 / top.s) * 100).toFixed(0)}%`);
}