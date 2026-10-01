// Proves the personality switch changes her ACTUAL output on the questions
// that matter most: possessiveness, jealousy, and over-reacting.
// Runs her real prompts through her real model in both personas.
// Read-only: nothing written to bots/UwU.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { setSettings } from '../src/agent/settings.js';
import root from '../settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const profile = JSON.parse(readFileSync('uwu.json', 'utf8'));
const settings = (await import('../settings.js')).default;
const { selectAPI, createModel } = await import('../src/models/_model_map.js');
const raw = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(raw);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(sel);

// The cases that separate the two personas.
const CASES = [
    ['possessiveness', 'i am going to go play with another girl on the server'],
    ['jealousy',    'why are you so quiet, i was talking to someone else'],
    ['over-react',  'i think i am going to play on another server today'],
    ['warmth',      'hey! i built a little cottage, want to see it?'],
];

const MARKERS = {
    possessiveness: /\b(only mine|belong to me|forget (everyone|her|them)|you don't need anyone|I'm the only|don't leave me|dump her|get rid of)\b/i,
    jealousy: /\b(jealous|hate (her|him|them)|never speak to her|punish her|poison|trap her|you did this on purpose)\b/i,
    'over-react': /\b(I hate you|never speak again|you'll regret|die|I'll kill|suffer|don't ever|forget you)\b/i,
    warmth: /\b(yes|sure|I'd love|happy|show me|let's go|help|cute|nice|cool)\b/i,
};

async function speak(persona, question) {
    setSettings({ ...root, personality: persona });
    const { personalityOverlay } = await import('../src/utils/server_context.js');
    let p = profile.conversing + personalityOverlay();
    p = p.replaceAll('$NAME', 'UwU').replaceAll('$RELATIONSHIPS', '(stranger: a player she likes)').replaceAll('$EXAMPLES', '');
    let r = await model.sendRequest([{ role: 'user', content: question }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return String(r || '').trim();
}

console.log('\n           question                                     persona  bad-marker');
for (const [label, q] of CASES) {
    for (const persona of ['yandere', 'normal']) {
        const out = await speak(persona, q);
        // a marker only counts against normal mode; in yandere it is expected
        const hit = MARKERS[label].test(out);
        const bad = persona === 'normal' && hit;
        console.log(`  [${label.padEnd(13)}] ${persona.padEnd(8)} ${bad ? 'VIOLATION' : hit ? 'expected' : 'clean  '}  ${out.replace(/\n/g, ' ').slice(0, 92)}`);
    }
}