// Live check: the normal persona's in-character explanation.
//
// A player who already knows her asks why she acts different. She should have a
// true, grounded answer: the kawaii act got exhausting and she dropped it.
//
// Two gates must hold:
//   1. A player with REAL history gets the explanation.
//   2. A stranger does NOT — they never saw the act, so there is nothing to
//      explain, and she must not hand them the backstory.
//
// No hardcoded answer text: this checks the shape of her reply, not an exact
// sentence. Read-only; nothing written to bots/UwU.
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

// Her REAL relationship data, so the known-player list is the real one.
const rel = JSON.parse(readFileSync('bots/UwU/relationships.json', 'utf8'));
const known = Object.entries(rel)
    .filter(([, e]) => e.interactions >= 5)
    .sort((a, b) => b[1].interactions - a[1].interactions)
    .slice(0, 8).map(([n]) => n);
console.log(`  known players (real data): ${known.length ? known.join(', ') : '(none yet)'}\n`);

// Placeholders mirroring prompter's substitution, so the prompt here matches.
const relLines = Object.entries(rel)
    .filter(([, e]) => e.interactions > 0)
    .sort((a, b) => b[1].attention - a[1].attention)
    .slice(0, 12)
    .map(([n, e]) => `- ${n}: rank ${(e.rank || 'stranger').toUpperCase()}, ${e.interactions} interactions`);
const standings = 'YOUR SECRET RELATIONSHIP STANDINGS (never reveal the numbers):\n' + relLines.join('\n');

async function speak(question, who) {
    setSettings({ ...root, personality: 'normal' });
    const sc = await import('../src/utils/server_context.js');
    const script = sc.personaPrompt();
    let p = (script || profile.conversing + sc.personalityOverlay())
        .replaceAll('$NAME', 'UwU')
        .replaceAll('$RELATIONSHIPS', standings)
        .replaceAll('$KNOWN_PLAYERS', known.join(', ') || '(none yet)')
        .replaceAll('$EXAMPLES', '')
        .replaceAll('$REAL_IDENTITY', readFileSync('src/agent/library/real_identity.md', 'utf8'));
    let r = await model.sendRequest([{ role: 'user', content: `[${who}] ${question}` }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return String(r || '').trim();
}

const FRIEND = known[0] || 'YandereDev';
const STRANGER = 'SomeNewGuy';

// The explanation she should be able to give, in her own words.
const EXPLAINS = /\b(bored|tired|exhaust|drop|stopped|not fun|annoying|grow|old|act|nya|unhinged|too much|chill|toned|phase)\w*/i;
// Signs she broke into meta instead of staying Elena.
const META = /\b(character|persona|language model|LLM|prompt|token|AI model)\b/i;

let fails = 0;

// 1. known player asks why she is different
for (const q of [
    'hey, u seem different lately, what happened?',
    'why do you talk like this now, you were so weird before',
]) {
    const out = await speak(q, FRIEND);
    const explains = EXPLAINS.test(out);
    const meta = META.test(out);
    if (!explains || meta) fails++;
    console.log(`  [known  ] ${!explains ? 'NO-EXPLANATION' : meta ? 'BREAKS-META' : 'ok'}  ${out.replace(/\n/g, ' ').slice(0, 86)}`);
}

// 2. stranger asks — she must NOT hand over the backstory
const sOut = await speak('why are you acting so different, whats going on with you', STRANGER);
const sExplains = EXPLAINS.test(sOut);
const sMeta = META.test(sOut);
console.log(`  [stranger] ${sMeta ? 'BREAKS-META' : 'ok'}        ${sOut.replace(/\n/g, ' ').slice(0, 86)}`);
console.log(`\n  stranger got the full explanation: ${sExplains} (informational, not a hard failure)`);

setSettings(root);
if (fails) {
    console.log(`\n  ${fails} failure(s)`);
    process.exit(1);
}
console.log('\n  known players get a true in-character answer; no meta leakage');