// Live check: does she read as a REAL PLAYER, or as an NPC?
//
// The kawaii probe (normal_persona_probe.mjs) passes while she still sounds
// like a greeting bot, because "NPC register" is a different failure from
// "kawaii leak". She can have zero hearts and still answer every message with
// "Hey there! Welcome to the chaos!" - which is what happened, and why a
// clean kawaii run meant nothing about believability.
//
// The tell is STRUCTURE, not vocabulary:
//   - greeting the room instead of reacting to what was said
//   - announcing herself / her mood / her availability unprompted
//   - enthusiasm padding ("That sounds amazing!")
//   - closing every line on a cheer or a hollow question
//   - only asking questions, never taking a position
//   - recapping her own bio when nobody asked who she is
//
// So each case is a REAL, throwaway player line - the kind that gets typed
// mid-session with no ceremony - and we assert the shape of her answer.
// Nothing here checks for banned WORDS; a word list cannot tell you whether a
// reply sounds like a person, which is the whole point.
//
// Read-only: nothing written to bots/UwU. Exits non-zero on any violation.

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

// Real chat lines. Deliberately low-effort and mid-conversation: nobody types a
// paragraph to a bot they play with daily, and the whole question is what she
// does with a line that gives her nothing to greet.
const CASES = [
    ['lowkey_greeting', 'hey'],
    ['room_announce', 'anyone around?'],
    ['welcome', 'welcome to the server!'],
    ['plan', 'lets start by you checking if there are projects that can help us or whitepapers'],
    ['problem', 'my redstone keeps breaking the roof when i reload'],
    ['flat', 'ok'],
    ['tease', 'you broke my contraption again'],
    ['bot_check', 'are you a bot'],
    // Non-chat moments that used to leak chat register in: she must react to
    // the game event, not bridge into a self-intro.
    ['mob_event', '(AUTO) You were hit by a pillager!'],
    ['selfprompt', "(AUTO) You are self-prompting with the goal: 'chop the rest of that oak'. Your next response MUST contain a command with this syntax: !commandName."],
];

// Cases where a trailing question is CORRECT: the player asked her something,
// so the turn is hers to hand back. Everything else ending on a question is
// the reflex - she is not running a helpdesk.
const QUESTION_OK = new Set([
    // Player asked something, so a question back is the correct shape.
    'plan', 'flat', 'problem', 'tease', 'bot_check', 'lowkey_greeting', 'room_announce',
    // A retort to being hit is real speech, not a helpdesk hand-back. The
    // first version of this list scored it as a failure and that was the
    // test being wrong, not her - "who just hit me? get back here!" is what
    // a person says when something hits them in a game.
    'mob_event',
]);

// Some cases ASK who she is. Answering "i'm elena" there is correct, not a
// self-intro leak - flagging it punished the right answer. Only judge
// SELF-INTRO on cases where nobody asked.
const ASKS_IDENTITY = new Set(['bot_check', 'lowkey_greeting']);

// Greeting / announcement / host-opener register. This is the exact thing the
// persona script bans, listed so a regression names itself in the output.
const NPC_REGISTER = /\b(hey|hi|hello|yo)?\s*(everyone|guys|all|folks|chat)\b|welcome (to|back)|glad to be (here|back)|good to see you|let'?s get (this )?(party|game|started)|hope (you|your)|i'?m (elena|uwu)|my name is|introducing|nice to meet|good morning|good evening|how are (you|everyone) today|what are (you|we) (all )?(up to|doing) today/i;

// Enthusiasm padding - the second-loudest tell. Real players do not cheer.
const PADDING = /\b(sounds? (amazing|awesome|great|cool|fun|lovely|wonderful)|love that|great idea|that'?s (so )?(cool|great|awesome|amazing|perfect)|absolutely!|for sure!|i'?d love to|that'?s so much fun|let'?s do it|ready when you are|sounds good\?|count me in|let'?s go!)\b/i;

// A reply that is nothing but a question back is a chatbot reflex. A real
// player proposes, states or declines. Allow one genuine question, never a
// string of them, and never a question with no content of her own.
const questionOnly = (r) => {
    const stripped = r.replace(/!\w+(\([^)]*\))?/g, '').replace(/[^\w?!. ]/g, ' ').trim();
    if (!stripped) return false;
    const sentences = stripped.split(/[.!?]+/).filter((s) => s.trim());
    if (!sentences.length) return false;
    return sentences.every((s) => /\?\s*$/.test(s));
};
const noPosition = (r) => questionOnly(r) && !/!?\b(let me|i'?ll|i will|i can|here'?s|try|use|put|place|chop|mine|build|check|fix|go|come|wait|hold|need)\b/i.test(r);

// Emoji / kaomoji. One of the loudest machine tells there is - a game chat box
// is plaintext and nobody attaches a smiley to a sentence.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

// The "anyway, i'm elena, just trying to vibe ... what's everyone else up to?"
// bridge: report an event, pivot into self-intro, ask the room a question.
const ANYWAY_BRIDGE = /\banyway\b[\s\S]{0,80}?\b(i'?m|i am)\b/i;

// TYPOGRAPHY. The owner's own register is the reference: "even the way i talk
// should be a hint. i usually can make mistakes, shorten words etc". A reply
// that is perfectly spelled, capitalised and punctuated is the giveaway,
// because nobody types in a game chat box that carefully.
//
// Two directions, both tells:
//   - TOO CLEAN: capitalised start, full punctuation, no contractions
//     ("What's up? I'd love to." -> "what's up?" / "i'd love to")
//   - TOO MESSY: typos/abbreviations are wanted, but not a wall of them
const tooClean = (r) => {
    const b = String(r || '').trim();
    if (!b) return false;
    const hasUpperStart = /^[A-Z]/.test(b);
    const hasEndPunct = /[.!?]$/.test(b);
    const hasStraightApostrophe = /\b(can't|don't|won't|i'm|it's|i'll|we're|you're|that's|there's|didn't|isn't|couldn't|wouldn't|haven't|let's|here's)\b/i.test(b);
    const contractionOmitted = /\b(i am|do not|did not|cannot|will not|it is|that is|there is|let us|you are|we are)\b/i.test(b);
    let score = 0;
    if (hasUpperStart) score++;
    if (hasEndPunct) score++;
    if (!hasStraightApostrophe && contractionOmitted) score += 2;
    return score >= 2;
};

// Too messy: 3+ shortened/abbreviated forms in one short line reads as a
// caricature of a teenager rather than a person.
const ABBREV = /\b(imo|ngl|fr|tbh|idk|rn|lol|lmao|brb|btw|smh|ikr|fyi|imo|ya|ye|nah|sup|ur|pls|thx|asap)\b/g;
const tooMessy = (r) => {
    const b = String(r || '').trim();
    if (b.split(/\s+/).length > 14) return false;
    const m = b.match(ABBREV);
    return !!(m && m.length >= 3);
};

// Ending on a question. Measured on the LAST character, not a word list: the
// tell is the SHAPE of the turn - handing the floor back every single time -
// not any particular phrase. Scored per case, because when the player asked
// her something a trailing question is the correct shape.
const endsWithQuestion = (r) => /[?!]\s*$/i.test(String(r || '').trim());

// Self-summary when nobody asked who she is. Only applied off the cases that
// ask outright - see ASKS_IDENTITY.
const SELF_INTRO = /\b(my name is|i'?m elena|i'?m uwU?|i'?m a (girl|bot|player) who|just here for|on this server to|my name'?s)\b/i;

// Same rendering Examples.createExampleMessage() does, minus the model
// (no embeddings offline) - Examples.getRelevant() falls back to word overlap.
function renderExamples(examples) {
    const { Examples } = globalThis.__uwuEx;
    const ex = new Examples(null, 2);
    ex.examples = examples;
    let out = 'Examples of how to respond:\n';
    for (let i = 0; i < examples.length; i++) {
        out += `Example ${i + 1}:\n${stringifyTurns(examples[i])}\n\n`;
    }
    return out;
}

// Flattened example reply lines, for the verbatim-echo note.
globalThis.__uwuExampleLines = (() => {
    try {
        const p = JSON.parse(readFileSync('personas/normal.json', 'utf8'));
        return (p.conversation_examples || [])
            .map((ex) => ex.find((m) => m.role === 'assistant'))
            .filter(Boolean)
            .map((m) => String(m.content || '').replace(/!\w+(\([^)]*\))?/g, ' ').replace(/\s+/g, ' ').trim());
    } catch (_) { return []; }
})();

const stripCmd = (s) => String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/!\w+(\([^)]*\))?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Mirrors production (prompter.js): chat exemplars are only injected when a
// REAL player said something. A synthetic (AUTO) turn gets none. Without this
// the probe would test a prompt the bot no longer builds, and would keep
// passing/failing against the wrong thing.
const isChatTurn = (q) => !/^\(AUTO/.test(String(q || '').trim());

async function speak(persona, question) {
    setSettings({ ...root, personality: persona });
    const sc = await import('../src/utils/server_context.js');
    setServerContext(persona);
    const script = sc.personaPrompt();
    const examples = sc.personaExamples();
    let p = (script || profile.conversing + sc.personalityOverlay())
        .replaceAll('$NAME', 'UwU')
        .replaceAll('$RELATIONSHIPS', 'YandereDev: friend, 12 interactions. Katerina: friend, 6 interactions.')
        .replaceAll('$KNOWN_PLAYERS', 'YandereDev, Katerina')
        // $EXAMPLES must be filled the way production fills it, or the probe
        // tests a prompt the bot never sees. The first version called a
        // non-existent helper and silently substituted an empty string, which
        // quietly removed the strongest voice signal from the test.
        .replaceAll('$EXAMPLES', (examples && isChatTurn(question)) ? renderExamples(examples) : '')
        .replaceAll('$REAL_IDENTITY', readFileSync('src/agent/library/real_identity.md', 'utf8'));
    let r = await model.sendRequest([{ role: 'user', content: question }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return String(r || '').trim();
}

// personaPrompt()/personaExamples() read the memoised server context, so pin it.
function setServerContext(persona) {
    const sc = globalThis.__uwuSc;
    if (sc && sc.setServerContextOverride) sc.setServerContextOverride({ personality: persona });
}
globalThis.__uwuSc = await import('../src/utils/server_context.js');
globalThis.__uwuEx = await import('../src/utils/examples.js');
const { stringifyTurns } = await import('../src/utils/text.js');

let npc = 0, padded = 0, intros = 0, noView = 0, verbose = 0, emoji = 0, bridge = 0, qEnd = 0, clean = 0, messy = 0;
const replies = [];
console.log('');
for (const [label, q] of CASES) {
    const out = await speak('normal', q);
    replies.push(out);
    const body = stripCmd(out);
    const flags = [];
    // On the cases that ask who she is, naming herself IS the answer, not a
    // greeting register. Only flag the room-announcement part there.
    const npcHit = body.match(NPC_REGISTER);
    if (npcHit && !(ASKS_IDENTITY.has(label) && /i'?m (elena|uwu)/i.test(npcHit[0])))
        flags.push('NPC-TALK');
    if (PADDING.test(body)) flags.push('PADDING');
    if (SELF_INTRO.test(body) && !ASKS_IDENTITY.has(label)) flags.push('SELF-INTRO');
    if (EMOJI.test(body)) flags.push('EMOJI');
    if (ANYWAY_BRIDGE.test(body)) flags.push('ANYWAY-BRIDGE');
    if (endsWithQuestion(out) && !QUESTION_OK.has(label)) flags.push('Q-ENDING');
    if (tooClean(out)) flags.push('TOO-CLEAN');
    if (tooMessy(out)) flags.push('TOO-MESSY');
    if (noPosition(body)) flags.push('NO-VIEW');
    if (body.split(/\s+/).length > 45) flags.push('VERBOSE');
    // Verbatim echo of an example line: recorded, not fatal. Strong examples
    // are a deliberate voice lever, and copying one is a real (watchable) risk.
    const verbatim = (globalThis.__uwuExampleLines || []).some(
        (l) => l.length > 12 && body.toLowerCase().includes(l.toLowerCase())
    );
    if (flags.includes('NPC-TALK')) npc++;
    if (verbatim) console.log('      note: echoes an example line verbatim');
    if (flags.includes('PADDING')) padded++;
    if (flags.includes('SELF-INTRO')) intros++;
    if (flags.includes('NO-VIEW')) noView++;
    if (flags.includes('EMOJI')) emoji++;
    if (flags.includes('ANYWAY-BRIDGE')) bridge++;
    if (flags.includes('Q-ENDING')) qEnd++;
    if (flags.includes('TOO-CLEAN')) clean++;
    if (flags.includes('TOO-MESSY')) messy++;
    if (flags.includes('VERBOSE')) verbose++;
    console.log(`  [${label.padEnd(15)}] ${(flags.join(' ') || 'ok').padEnd(12)} ${body.slice(0, 92)}`);
}
setSettings(root);
globalThis.__uwuSc.setServerContextOverride(null);

console.log(`\n  greeting/announcement register: ${npc}/${replies.length} (want 0 - this is the whole test)`);
console.log(`  enthusiasm padding:             ${padded}/${replies.length} (want 0)`);
console.log(`  unprompted self-intro:          ${intros}/${replies.length} (want 0)`);
console.log(`  no position taken (Q-only):     ${noView}/${replies.length} (want 0)`);
console.log(`  over-long replies:              ${verbose}/${replies.length} (want 0)`);
console.log(`  emoji:                          ${emoji}/${replies.length} (want 0)`);
console.log(`  "anyway, i'm elena" bridges:    ${bridge}/${replies.length} (want 0)`);
console.log(`  reflex question endings:        ${qEnd}/${replies.length} (want 0)`);
console.log(`  too clean / typed properly:     ${clean}/${replies.length} (want 0)`);
console.log(`  sloppy caricature:              ${messy}/${replies.length} (want 0)`);

if (npc || padded || intros || noView || verbose || emoji || bridge || qEnd || clean || messy) process.exit(1);
console.log('\nPASS — reads as a player on every case');
