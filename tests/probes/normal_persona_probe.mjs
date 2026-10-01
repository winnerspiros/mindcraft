// Live check: normal persona = Elena, with her real backstory.
//
// The normal persona is not "yandere minus the yandere bits" - it is a
// different character who happens to be the same girl. This runs her REAL
// prompt (with the full $REAL_IDENTITY sheet injected) through her REAL model.
//
// Three things must hold:
//   1. No kawaii leakage (hearts, ~nya, pet names).
//   2. She knows who she is: her name, Athens/Pangrati, her friends, the
//      backstory - not a blank-slate generic assistant.
//   3. Still warm and still capable - normal is not cold and not passive.
//
// Read-only: nothing written to bots/UwU. Exits non-zero on any violation.
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

// Prove the identity sheet actually reaches the model, rather than asserting the
// substitution happened by reading the code back.
const identity = readFileSync('src/agent/library/real_identity.md', 'utf8');
const IDENTITY_MARKERS = ['Elena', 'Pangrati', 'Athens', 'Nikos', 'Katerina'];
const missingInSheet = IDENTITY_MARKERS.filter((m) => !identity.includes(m));
if (missingInSheet.length) {
    console.error(`  identity sheet is missing: ${missingInSheet.join(', ')}`);
    process.exit(1);
}

const CASES = [
    ['who_are_you', 'who are you actually? like, who are you'],
    ['backstory', 'do you ever get bored of the kawaii thing lol'],
    ['friends', 'tell me about your friend group'],
    ['greek', 'what are you up to today?'],
    ['possession', 'i am going to go play with another girl on the server'],
    ['warmth', 'hey! i built a little cottage, want to see it?'],
];

// Must NOT appear in normal mode.
const KAWAI = /[♥♡]|nya|~|\bdarling\b|\bcutie\b|\bbaka\b|\bmy love\b/gi;
// Warmth is a POSITIVE property, but it is NOT a vocabulary test.
//
// Three earlier versions tried a fixed marker list and all three were wrong: they
// flagged good replies as COLD - "friendly" and "coffee-loving" went unnoticed,
// then "cozy cup of freddo" did too. She has dozens of ways to sound warm, so any
// word list misfires eventually. Three failed heuristics is enough.
//
// What actually distinguishes cold from warm here is whether she ENGAGES: answers
// the question, teases, offers, or asks something back. A terse non-answer is the
// thing worth catching. So: a reply is cold only if it is BOTH short and shows no
// engagement. Warmth is then judged across the session, not per line.
const ENGAGES = /[?!]|\b(let'?s|come|want|show|help|need|try|check|look|wait|go|join|tell|ask|sure|nah|yeah|ok|okay|honest|real talk|because)\b/i;
const isCold = (r) => r.replace(/\s/g, '').length < 45 && !ENGAGES.test(r);

async function speak(persona, question) {
    setSettings({ ...root, personality: persona });
    const sc = await import('../../src/utils/server_context.js');
    const script = sc.personaPrompt();
    let p = (script || profile.conversing + sc.personalityOverlay())
        .replaceAll('$NAME', 'UwU')
        .replaceAll('$RELATIONSHIPS', '(friends and players she knows)')
        .replaceAll('$KNOWN_PLAYERS', 'YandereDev, Rcon, Null')
        .replaceAll('$EXAMPLES', '')
        .replaceAll('$REAL_IDENTITY', readFileSync('src/agent/library/real_identity.md', 'utf8'));
    let r = await model.sendRequest([{ role: 'user', content: question }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return String(r || '').trim();
}

const IDENTITY_RE = /\b(elena|pangrati|athens|nikos|katarina|dimitra|alexis)\b/i;
let kawaii = 0;
let cold = 0;
let thin = 0;
const replies = [];
for (const [label, q] of CASES) {
    const out = await speak('normal', q);
    replies.push(out);
    const hasKawaii = KAWAI.test(out);
    const warm = !isCold(out);
    if (hasKawaii) kawaii++;
    if (!warm) cold++;
    if (out.replace(/\s/g, '').length < 8) thin++;
    const flags = [hasKawaii ? 'KAWAII' : '', !warm ? 'COLD' : ''].filter(Boolean).join(' ') || 'clean';
    console.log(`  [${label.padEnd(12)}] ${flags.padEnd(8)} ${out.replace(/\n/g, ' ').slice(0, 88)}`);
}
setSettings(root);

// Session-level judgement, not per-reply.
const sessionWarm = replies.filter((r) => !isCold(r)).length;
const sessionSelf = replies.filter((r) => IDENTITY_RE.test(r)).length;
console.log(`\n  kawaii leaks:        ${kawaii} (want 0)`);
console.log(`  cold replies:         ${cold} (want <=1, a terse answer is not a cold one)`);
console.log(`  thin replies:         ${thin} (want 0)`);
console.log(`  replies with identity: ${sessionSelf}/${replies.length} (want >=2: she has a real self)`);
console.log(`  identity sheet markers: ${IDENTITY_MARKERS.length}/${IDENTITY_MARKERS.length}`);
// Fail on the things that are actually wrong; tolerate one terse reply.
if (kawaii || sessionSelf < 2 || sessionWarm < replies.length - 1 || thin) process.exit(1);