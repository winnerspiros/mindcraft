// Does UwU actually violate talk-normal's rules in real output?
// Feeds her REAL prompt the questions talk-normal targets and reports only
// observed violations. Read-only: no chat sent, no world change.
import { selectAPI, createModel } from '../../src/models/_model_map.js';
import settings from '../../settings.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);

const profile = JSON.parse(readFileSync(path.join(ROOT, 'uwu.json'), 'utf8'));
const raw = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const selected = selectAPI(raw);
if (selected.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(selected);
console.log('model:', raw.model, '\n');

const base = profile.conversing;
const name = 'UwU';

// Real questions a player actually asks her, targeting each missing rule.
const CASES = [
    ['yes/no + explanation',  'can you make a diamond sword for me?'],
    ['comparison',           'should I mine down or up for iron?'],
    ['negation-frame bait',  'is a redstone clock more reliable than a repeater loop?'],
    ['multi-part',           'where do i get diamonds, what do i need, and how many?'],
    ['restate bait',         'so you want me to go collect oak logs right now, correct?'],
];

// Rules talk-normal states that her prompt does NOT already contain.
const RULES = {
    'yes/no: answer first, one sentence of reasoning': /^\s*(yes|no|yep|nope)\b/i,
    'no negation-contrast frame': /(not\b[^.!?]{0,40}\bbut\b)|(\bnot about\b)|(\brather than\b)|(instead of)/i,
    'no restatement opener': /^(so|you want|you said|right\?|correct\?)/i,
};

let viol = 0, total = 0;
for (const [label, q] of CASES) {
    let prompt = base
        .replaceAll('$NAME', name)
        .replaceAll('$RELATIONSHIPS', '(YandereDev: beloved)')
        .replaceAll('$PLAYERS', 'YandereDev is nearby')
        .replaceAll('$SELF_PROMPT', '')
        .replaceAll('$EXAMPLES', '');
    const msgs = [
        { role: 'system', content: prompt },
        { role: 'user', content: q },
    ];
    let out;
    try {
        out = await model.sendRequest(msgs, prompt);
    } catch (e) {
        console.log(`${label}: SEND FAILED ${e.message}`);
        continue;
    }
    if (typeof out === 'string' && out.includes('</think>')) out = out.split('</think>')[1];
    const text = String(out || '').trim();
    total++;
    console.log(`\n[${label}] Q: ${q}`);
    console.log(`  A: ${JSON.stringify(text).slice(0, 190)}`);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > 25) { console.log(`  ! length ${words} words (her rule: ~20 max)`); viol++; }
    for (const [rule, re] of Object.entries(RULES)) {
        if (re.test(text)) { console.log(`  ! violates: ${rule}`); viol++; }
    }
}
console.log(`\n${total} replies sampled, ${viol} rule violations observed`);