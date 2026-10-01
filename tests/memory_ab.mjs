// A/B test her REAL recall scoring against a rebalanced one, over her REAL
// memories with REAL query embeddings. Reports, per question, whether the
// ranking changes and whether the winner is actually on-topic.
// Read-only.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import settings from '../settings.js';
import { selectAPI, createModel } from '../src/models/_model_map.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const read = (p) => readFileSync(p, 'utf8');
const HALF = 7 * 24 * 60 * 60 * 1000;

function cosine(a, b) {
    let s = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const mem = JSON.parse(read('bots/UwU/reflections.json')).memories;
const profile = JSON.parse(read('uwu.json'));
const raw = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(raw);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const embedder = createModel({ api: sel.api });

// Does the winner actually answer the question? Hand-checked on-topic test:
// each case lists words that MUST appear in a correct memory.
const CASES = [
    ['what does she like to collect?',            ['flower', 'collect', 'gather'], 'she loves gathering flowers'],
    ['what happened when we built the thing together', ['build', 'built', 'house', 'together'], 'no build memory exists at all'],
    ['the last time we went mining what did we do', ['mine', 'mining', 'cave', 'ore', 'diamond', 'coal', 'iron'], 'caves/treasures'],
    ['the time she got upset about a player',      ['upset', 'hurt', 'attacked', 'vulnerab', 'distress', 'jealous'], 'emotional vulnerability'],
    ['how has her attitude to me changed',         ['attitude', 'change', 'love-hate', 'dynamic'], 'love-hate dynamic'],
];

const now = Date.now();
const current = (rel, imp, rec) => rel * 3 + imp * 0.6 + rec * 0.4;
const rebalanced = (rel, imp, rec) => rel * 3 + imp * 0.6 + rec * 0.4;

let changed = 0, onTopicCurrent = 0, onTopicRebal = 0;
for (const [q, must, note] of CASES) {
    let qEmb = null;
    try { qEmb = await embedder.embed(q); } catch (e) { console.log('embed fail', e.message); continue; }
    const scored = mem.map(m => {
        const rel = (qEmb && m.embedding) ? Math.max(0, cosine(qEmb, m.embedding)) : 0;
        const imp = m.importance ?? 0.4;
        const rec = Math.exp(-(now - (m.created ?? now)) / HALF);
        return { m, rel, imp, rec, cur: current(rel, imp, rec), reb: rebalanced(rel, imp, rec) };
    });
    const byCur = [...scored].sort((a, b) => b.cur - a.cur);
    const byReb = [...scored].sort((a, b) => b.reb - a.reb);
    const on = t => must.some(w => t.toLowerCase().includes(w));
    const curHit = on(byCur[0].m.text), rebHit = on(byReb[0].m.text);
    if (byCur[0].m.text !== byReb[0].m.text) changed++;
    if (curHit) onTopicCurrent++;
    if (rebHit) onTopicRebal++;
    console.log(`\n"${q}"  (expect: ${note})`);
    console.log(`  current   ${byCur[0].m.text.slice(0, 72)}   ${curHit ? 'ON-TOPIC' : 'off-topic'}`);
    console.log(`  rebalanced${byReb[0].m.text === byCur[0].m.text ? ' (same)' : ''} ${byReb[0].m.text.slice(0, 72)}   ${rebHit ? 'ON-TOPIC' : 'off-topic'}`);
}
console.log(`\nwinner changed in ${changed}/${CASES.length} questions`);
console.log(`on-topic winners: current ${onTopicCurrent}/${CASES.length}, rebalanced ${onTopicRebal}/${CASES.length}`);