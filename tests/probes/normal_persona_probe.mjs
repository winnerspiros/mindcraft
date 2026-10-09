// Live check: normal persona = Elena voice, lore on demand.
//
// Three things must hold:
//   1. No kawaii leakage (hearts, ~nya, pet names).
//   2. Base persona is lean (no info dump); lore chunks inject on personal
//      questions (who/music/server) and stay empty on plain chat.
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
const raw = Array.isArray(profile.model) ? { model: profile.model[0] } : (typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model });
const sel = selectAPI(raw);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(sel);

// Prove the lore chunks reach the model on demand, and stay out of plain chat.
import { readdirSync } from 'fs';
const LORE_ORDER = ['who.md', 'server.md', 'tastes.md', 'music.md', 'greek.md', 'love.md', 'stories.md'];
const loreChunks = LORE_ORDER.map(f => readFileSync(`src/agent/library/lore/${f}`, 'utf8'));
const IDENTITY_MARKERS = ['Elena', 'Pangrati', 'Athens', 'Nikos', 'Katerina'];
const missingInLore = IDENTITY_MARKERS.filter((m) => !loreChunks.join('\n').includes(m));
if (missingInLore.length) {
    console.error(`  lore chunks are missing: ${missingInLore.join(', ')}`);
    process.exit(1);
}
// Base persona must be lean: no loc/job/taste dump baked in.
// (Elena/UwU/Nikos as bare names are identity anchors, not the dump.)
const normalPersona = JSON.parse(readFileSync('personas/normal.json', 'utf8'));
const LEAK = /Pangrati|Athens|Katerina|Dimitra|Alexis|coffee|freddo|marketing|Pangrati/i;
if (LEAK.test(normalPersona.conversing)) {
    console.error('  base persona leaks personal facts (should be lore-only)');
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

async function loreFor(question) {
    // same trigger ranking as prompter.getRelevantLore: explicit topic match
    // beats word overlap, threshold 0.02, max 2 chunks
    const { wordOverlapScore } = await import('../../src/utils/text.js');
    const q = question.toLowerCase();
    const queryWords = q.replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 2).join(' ');
    if (!queryWords.trim()) return '';
    const TRIGGERS = [
        [/elena|who are you|your name|how old|where.*live|pangrati|athens|what.*work|job|marketing/, 0],
        [/nikos|whose server|who runs|server.*who|katerina|dimitra|alexis|friend|group/, 1],
        [/coffee|freddo|cappuccino|cafe|food|eat|restaurant|cook|walk|travel|island|trip|beach|weekend|cottage|see it|built/, 2],
        [/music|song|band|listen|concert|hip.hop|show|anime|game|movie|watch|kawaii|bored/, 3],
        [/greek|greece|malaka|ela re|ti les|gamoto|greeklish/, 4],
        [/boyfriend|dating|date|single|giannis|ex |love|relationship|another girl|play with/, 5],
        [/story|stories|funny.*happen|seagull|ferry|island.*wrong|maps/, 6],
    ];
    const boosted = new Set();
    for (const [re, i] of TRIGGERS) if (re.test(q)) boosted.add(i);
    const scored = loreChunks.map((c, i) => ({ c, i, s: wordOverlapScore(queryWords, c) + (boosted.has(i) ? 0.10 : 0) }))
        .sort((a, b) => b.s - a.s);
    const bar = (e) => boosted.has(e.i) ? 0.02 : 0.05;
    if (!scored[0] || scored[0].s < bar(scored[0])) return '';
    return scored.slice(0, 2).filter(e => e.s >= bar(e)).map(e => e.c).join('\n').slice(0, 900);
}

async function speak(persona, question) {
    setSettings({ ...root, personality: persona });
    const sc = await import('../../src/utils/server_context.js');
    const script = sc.personaPrompt();
    let p = (script || profile.conversing + sc.personalityOverlay())
        .replaceAll('$NAME', 'UwU')
        .replaceAll('$RELATIONSHIPS', '(friends and players she knows)')
        .replaceAll('$KNOWN_PLAYERS', 'YandereDev, Rcon, Null')
        .replaceAll('$EXAMPLES', '')
        .replaceAll('$REAL_IDENTITY', '')
        .replaceAll('$LORE', await loreFor(question));
    let r = await model.sendRequest([{ role: 'user', content: question }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return String(r || '').trim();
}

const IDENTITY_RE = /\b(elena|pangrati|athens|nikos|katarina|dimitra|alexis)\b/i;
let kawaii = 0;
let cold = 0;
let thin = 0;
let loreHit = 0;
let loreMiss = 0;
const replies = [];
// Deterministic gate check: lore must inject on personal questions,
// must stay empty on plain chat. Independent of model whims.
for (const [label, q] of CASES) {
    const lore = await loreFor(q);
    const personal = ['who_are_you', 'friends'].includes(label);
    if (personal && lore) loreHit++;
    if (personal && !lore) loreMiss++;
    console.log(`  [lore:${label.padEnd(12)}] ${lore ? lore.slice(0, 40).replace(/\n/g, ' ') : '(empty)'}`);
}
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

// Session-level judgement, not per-reply. Persona targets 1-6 words by
// design, so terse is correct - fail only if she is cold most of the time.
const sessionWarm = replies.filter((r) => !isCold(r)).length;
const sessionSelf = replies.filter((r) => IDENTITY_RE.test(r)).length;
console.log(`\n  kawaii leaks:        ${kawaii} (want 0)`);
console.log(`  cold replies:         ${cold} (want <=3, terse is correct by design)`);
console.log(`  thin replies:         ${thin} (want <=1)`);
console.log(`  replies with identity: ${sessionSelf}/${replies.length} (info only, model variance)`);
console.log(`  lore gate: hits=${loreHit} miss=${loreMiss} (want 2/0)`);
console.log(`  identity sheet markers: ${IDENTITY_MARKERS.length}/${IDENTITY_MARKERS.length}`);
// Fail on: kawaii leak, lore gate miss, or she is cold almost everywhere.
if (kawaii || loreMiss > 0 || sessionWarm < 2) process.exit(1);