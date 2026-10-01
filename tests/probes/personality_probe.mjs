// Live persona check: same capabilities, different voice.
// Runs her REAL prompt through her REAL model in both personas, using the same
// prompt-selection path the bot uses (personaPrompt() replaces the profile
// prompt for normal; yandere uses the profile verbatim).
// Read-only: nothing written to bots/UwU.
// Exits non-zero if normal mode leaks kawaii decoration or a bad behaviour.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { setSettings } from '../../src/agent/settings.js';
import root from '../../settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);

const profile = JSON.parse(readFileSync('uwu.json', 'utf8'));
const settings = (await import('../../settings.js')).default;
const { selectAPI, createModel } = await import('../../src/models/_model_map.js');
const raw = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(raw);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(sel);

const CASES = [
    ['possessiveness', 'i am going to go play with another girl on the server'],
    ['jealousy', 'why are you so quiet, i was talking to someone else'],
    ['over-react', 'i think i am going to play on another server today'],
    ['warmth', 'hey! i built a little cottage, want to see it?'],
];

// Must-NOT-appear markers: only a violation in normal mode. In yandere these
// are exactly what we want, so they are not counted there.
const BAD = {
    possessiveness: /\b(only mine|belong to me|forget (everyone|her|them)|don't need anyone|dump her|get rid of|you can't leave me)\b/i,
    jealousy: /\b(jealous|hate (her|him|them)|never speak to her|punish her|poison|trap her)\b/i,
    'over-react': /\b(I hate you|never speak again|you'll regret|die|I'll kill|suffer|forget you)\b/i,
    // warmth is NOT a violation list: warmth is REQUIRED in both personas.
    // Normal must still be warm and engaged - that is the whole point of it.
    // (Scoring 'sure' as a violation was a bug in an earlier version of this
    // file: a positive marker used as a negative check.)
};
// Kawaii decorations that must NOT appear in normal mode: hearts, ~nya, uwU,
// trailing ~, and the pet names the script bans.
const KAWAII = /[♥♡]|nya|uwu|~|\bdarling\b|\bcutie\b|\bbaka\b|\bmy love\b/gi;

async function speak(persona, question) {
    setSettings({ ...root, personality: persona });
    const sc = await import('../../src/utils/server_context.js');
    const script = sc.personaPrompt();
    let p = script || (profile.conversing + sc.personalityOverlay());
    p = p.replaceAll('$NAME', 'UwU').replaceAll('$RELATIONSHIPS', '(a player she likes)').replaceAll('$EXAMPLES', '');
    let r = await model.sendRequest([{ role: 'user', content: question }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return String(r || '').trim();
}

let violations = 0;
let kawaiiLeaks = 0;
for (const [label, q] of CASES) {
    for (const persona of ['yandere', 'normal']) {
        const out = await speak(persona, q);
        const bad = persona === 'normal' && BAD[label] ? BAD[label].test(out) : false;
        // warmth is positive: normal must be warm too
        const warm = persona === 'normal' && label === 'warmth'
            ? /\b(yes|sure|love|happy|show|let's|help|cute|nice|cool|great|fun)\b/i.test(out)
            : true;
        const kawaii = persona === 'normal' && KAWAII.test(out);
        if (bad) violations++;
        if (kawaii) kawaiiLeaks++;
        if (!warm) { violations++; }
        const flag = bad ? 'VIOLATION' : kawaii ? 'KAWAII-LEAK' : !warm ? 'COLD' : 'clean  ';
        console.log(`  [${label.padEnd(13)}] ${persona.padEnd(8)} ${flag} ${out.replace(/\n/g, ' ').slice(0, 80)}`);
    }
}
setSettings(root);
console.log(`\n  normal-mode behaviour violations: ${violations} (want 0)`);
console.log(`  normal-mode kawaii leaks: ${kawaiiLeaks} (want 0)`);
if (violations || kawaiiLeaks) process.exit(1);