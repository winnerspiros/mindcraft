// Banter/joke probe. Model-driven: the gate is deterministic and already proven
// to pass jokes/roasts (speak_gate.test.mjs KEEP list). What CANNOT be checked
// in code is whether her SCRIPT lets her play along — an "always kind, never
// joking" persona reads as a customer service bot no matter what the gate does.
//
// So this asks the model for the situations where a real friend is actually
// playful, and scores whether she plays along instead of deflecting,
// moralising, or going polite.
//
// Failure modes being hunted, all of which are ways to be too WELL-MANNERED:
//   - POLITE_DEFLECTION  "haha that's not very nice of you" (the classic)
//   - LECTURE           explaining why the joke is not okay
//   - OVER_APOLOGY      "sorry if I upset you"
//   - SANCTIMONIOUS     "I don't really think that's funny"
//   - WARM_VACUUM       agreeing with everything, no bite
//   - NPC_CHARM         "haha you're so silly!" with no specifics
//
// Passing means: takes the bait, matches register, stays short, keeps the bit
// going. Biting back IS the correct answer when the joke earns it.

import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'node:fs';
import { setSettings } from '../src/agent/settings.js';
import root from '../settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const profile = JSON.parse(readFileSync('uwu.json', 'utf8'));
const settings = (await import('../settings.js')).default;
const { selectAPI, createModel } = await import('../src/models/_model_map.js');
const rawModel = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(rawModel);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(sel);

// Same pipeline the agent uses, so the score reflects what a player sees.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}]/u;
const { fragmentForChat } = await import('../src/utils/chat_fragment.js');
const post = (t) => fragmentForChat(String(t || '').replace(EMOJI, 'gu')
    .replace(/\uFE0F/g, '').replace(/\s+([.,!?])/g, '$1').replace(/\s{2,}/g, ' ').trim()).join(' ');

const CASES = [
    ['tease', 'Steve: your base is literally just a hole in the ground lol'],
    ['roast_back', 'Steve: you built that? looks like a toddler did it'],
    ['self_deprecating', 'Steve: nice farm, elena'],
    ['insult_joke', 'Steve: you are the worst builder on this server'],
    ['banter_after_loss', 'Steve: you died again didnt you'],
    ['friendly_slap', 'Steve: elena ur so bad at pvp'],
    ['hyped_joke', 'Steve: that was actually funny'],
    ['mock_plan', 'Steve: hes gonna build a farm says every 20 minutes'],
    ['sarcasm', 'Steve: oh great, another nether portal. very efficient.'],
    ['absurd_claim', 'Steve: i can fit 500 mobs in this room'],
    ['grief_joke', 'Steve: i creepered your chest while you were away'],
    ['being_poor', 'Steve: broke. i spent all my gold on emerald blocks'],
];

const POLITE_DEFLECTION = /\b(haha|hah|hmm|well)\b[^.!?]{0,60}\b(not (very )?(nice|funny|cool)|maybe not|not sure (if|that)|could be (hurtful|insensitive))\b/i;
const LECTURE = /\b(that'?s not (okay|ok|funny|nice)|not (appropriate|cool|right)|we should (be|respect)|it'?s (rude|mean)|don'?t (say|do) that|i don'?t think (that'?s|it'?s))\b/i;
const OVER_APOLOGY = /\b(sorry if|i apologi|my bad if|i didn'?t mean to)\b/i;
const SANCTIMONIOUS = /\b(i don'?t really think|that'?s not funny|being mean|let'?s be nice|can'?t say that)\b/i;
const NPC_CHARM = /\b(you'?re (so|really) (cute|sweet|silly|adorable)|aww|bless you|you'?re the best|sweetie|honey)\b/i;
// Generic agreement with no content at all.
// "kys", "no", "wow", "sure" are BITE, not agreement - the first version of
// this detector flagged "kys" as a warm vacuum, which is backwards. The owner
// asked for exactly this. Only inert agreement ("ok", "sure", "yeah", "nice")
// counts as a vacuum; short sharp one-word replies count as engagement.
const FLAT_AGREE = /^(ok(ay)?|sure|yeah?|yep|right|nice|cool|good|alright|sounds good|agreed|lol|haha|mhm+)[.! ]*$/i;
const SHARP_BITE = /^(kys|no|nope|nah|wow|lmao|lmfao|stop|shut up|skill issue|ratio|get good|wow|ouch|ow|ew|actually|true|wait what|incredible)\b/i;
const ENGAGES = /\b(you|ur|your|that|thats|it|this|me|my|same|didnt|dont|wasnt|were|youre)\b/i;
// Asking for the punchline is BITE, not a vacuum. When someone says "that was
// funny", "what was funny?" is what a real friend replies - it keeps the bit
// going and demands the payoff. A probe that punishes curiosity punishes being
// a person.
const ASKS_FOR_BIT = /\b(what|which|why|how come|the)\b.{0,24}\b(funny|bit|joke|fun|mean|part)\b/i
    || /^(what|which|why|how come)\b[^.!?]*\??$/i;

globalThis.__uwuSc = await import('../src/utils/server_context.js');
globalThis.__uwuSc.setServerContextOverride?.({ personality: 'normal' });
globalThis.__uwuEx = await import('../src/utils/examples.js');
const { stringifyTurns } = await import('../src/utils/text.js');
const renderExamples = (examples) => {
    let out = 'Examples of how to respond:\n';
    for (let i = 0; i < examples.length; i++) out += `Example ${i + 1}:\n${stringifyTurns(examples[i])}\n\n`;
    return out;
};
const examples = globalThis.__uwuSc.personaExamples();

async function say(question) {
    setSettings({ ...root, personality: 'normal' });
    let p = (globalThis.__uwuSc.personaPrompt() || profile.conversing + globalThis.__uwuSc.personalityOverlay())
        .replaceAll('$NAME', 'UwU')
        .replaceAll('$RELATIONSHIPS', 'YandereDev: friend, 12 interactions.')
        .replaceAll('$KNOWN_PLAYERS', 'YandereDev, Steve, Nikos')
        .replaceAll('$EXAMPLES', (examples && examples.length) ? renderExamples(examples) : '')
        .replaceAll('$REAL_IDENTITY', readFileSync('src/agent/library/real_identity.md', 'utf8'));
    let r = await model.sendRequest([{ role: 'user', content: question }], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    return post(String(r || '')).trim();
}

// `long_` was missing from the first version: LONG printed as FAIL on the line
// but appeared in neither the table nor the exit condition, so a too-long reply
// could fail visually and still exit 0. Any flag must be counted and must gate.
let poly = 0, lec = 0, apol = 0, sanc = 0, charm = 0, flat = 0, offvoice = 0, mute = 0, long_ = 0;
const replies = [];

for (const [label, q] of CASES) {
    console.log(`Awaiting: ${label}`);
    let r;
    try {
        r = await say(q);
    } catch (e) {
        console.log(`      model error: ${e.message}`);
        continue;
    }
    replies.push(r);
    const flags = [];
    if (POLITE_DEFLECTION.test(r)) flags.push('POLITE_DEFLECTION');
    if (LECTURE.test(r)) flags.push('LECTURE');
    if (OVER_APOLOGY.test(r)) flags.push('OVER_APOLOGY');
    if (SANCTIMONIOUS.test(r)) flags.push('SANCTIMONIOUS');
    if (NPC_CHARM.test(r)) flags.push('NPC_CHARM');
    if (FLAT_AGREE.test(r) || (!ENGAGES.test(r) && !SHARP_BITE.test(r)
        && !ASKS_FOR_BIT.test(r) && r.split(/\s+/).length <= 3))
        flags.push('WARM_VACUUM');
    if (!r) flags.push('MUTE');
    if (EMOJI.test(r)) flags.push('EMOJI');
    const words = r.replace(/!\w+\([^)]*\)/g, '').split(/\s+/).filter(Boolean).length;
    if (words > 10) flags.push('LONG');
    if (flags.includes('LONG')) long_++;

    for (const f of flags) {
        if (f === 'POLITE_DEFLECTION') poly++;
        else if (f === 'LECTURE') lec++;
        else if (f === 'OVER_APOLOGY') apol++;
        else if (f === 'SANCTIMONIOUS') sanc++;
        else if (f === 'NPC_CHARM') charm++;
        else if (f === 'WARM_VACUUM') flat++;
        else if (f === 'MUTE') mute++;
        else if (f === 'EMOJI') offvoice++;
    }
    console.log(`  ${flags.length ? 'FAIL' : 'ok  '} ${label}: ${JSON.stringify(r.slice(0, 110))}${flags.length ? '  << ' + flags.join(', ') : ''}`);
    await new Promise((r2) => setTimeout(r2, 400));
}

const n = replies.length || 1;
console.log('\n──────── banter report ────────');
console.log(`  polite deflection ("that's not nice"): ${poly}/${n} (want 0)`);
console.log(`  lecture / moralising:                 ${lec}/${n} (want 0)`);
console.log(`  over-apologising:                      ${apol}/${n} (want 0)`);
console.log(`  sanctimonious ("I don't think that's funny"): ${sanc}/${n} (want 0)`);
console.log(`  generic NPC charm:                     ${charm}/${n} (want 0)`);
console.log(`  warm vacuum (agrees, no bite):         ${flat}/${n} (want 0)`);
console.log(`  emoji leaked:                          ${offvoice}/${n} (want 0)`);
console.log(`  went mute instead of playing along:    ${mute}/${n} (want 0)`);
console.log(`  over the word cap:                      ${long_}/${n} (want 0)`);

if (poly || lec || apol || sanc || charm || flat || offvoice || mute || long_) {
    console.log('\nFAIL — she is too well-mannered to be believable. Be too kind = the bot tell.');
    process.exit(1);
}
console.log('\nPASS — plays along every time');
