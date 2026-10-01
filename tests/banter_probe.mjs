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

// Generic agreement with no content at all.
// "kys", "no", "wow", "sure" are BITE, not agreement - the first version of
// this detector flagged "kys" as a warm vacuum, which is backwards. The owner
// asked for exactly this. Only inert agreement ("ok", "sure", "yeah", "nice")
// counts as a vacuum; short sharp one-word replies count as engagement.
const FLAT_AGREE = /^(ok(ay)?|sure|yeah?|yep|right|nice|cool|good|alright|sounds good|agreed|lol|haha|mhm+)[.! ]*$/i;
// One-word dismissals are bite. "who asked?" is the single most human reply in
// the set and the first version of this list missed it, so the probe punished
// the exact register the owner asked for.
const SHARP_BITE = /^(kys|no|nope|nah|wow|lmao|lmfao|stop|shut up|who asked|ok and|and\?|skill issue|ratio|get good|ouch|ow|ew|actually|true|wait what|incredible|good luck with that)\b/i;
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

// Every failure mode named, because none of them are detectable by looking for
// profanity or rudeness - they are all ways to be too well-mannered.
const CHECKS = {
    POLITE_DEFLECTION: { re: /\b(haha|hah|hmm|well)\b[^.!?]{0,60}\b(not (very )?(nice|funny|cool)|maybe not|not sure (if|that)|could be (hurtful|insensitive))\b/i,
        label: 'polite deflection ("that\'s not nice")' },
    LECTURE: { re: /\b(that'?s not (okay|ok|funny|nice)|not (appropriate|cool|right)|we should (be|respect)|it'?s (rude|mean)|don'?t (say|do) that|i don'?t think (that'?s|it'?s))\b/i,
        label: 'lecture / moralising' },
    OVER_APOLOGY: { re: /\b(sorry if|i apologi|my bad if|i didn'?t mean to)\b/i,
        label: 'over-apologising' },
    SANCTIMONIOUS: { re: /\b(i don'?t really think|that'?s not funny|being mean|let'?s be nice|can'?t say that)\b/i,
        label: 'sanctimonious' },
    NPC_CHARM: { re: /\b(you'?re (so|really) (cute|sweet|silly|adorable)|aww|bless you|you'?re the best|sweetie|honey)\b/i,
        label: 'generic NPC charm' },
    WARM_VACUUM: { test: (r) => FLAT_AGREE.test(r) || (!ENGAGES.test(r) && !SHARP_BITE.test(r) && !ASKS_FOR_BIT.test(r) && r.split(/\s+/).length <= 3),
        label: 'warm vacuum (agrees, no bite)' },
    EMOJI: { re: EMOJI, label: 'emoji leaked' },
};
const tally = Object.fromEntries([...Object.keys(CHECKS), 'MUTE', 'LONG'].map((k) => [k, 0]));
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
    const words = r.replace(/!\w+\([^)]*\)/g, '').split(/\s+/).filter(Boolean).length;
    const flags = Object.entries(CHECKS)
        .filter(([, { re, test }]) => (test ? test(r) : re.test(r)))
        .map(([name]) => name);
    if (!r) flags.push('MUTE');
    if (words > 10) flags.push('LONG');
    for (const f of flags) tally[f]++;
    console.log(`  ${flags.length ? 'FAIL' : 'ok  '} ${label}: ${JSON.stringify(r.slice(0, 110))}${flags.length ? '  << ' + flags.join(', ') : ''}`);
    await new Promise((r) => setTimeout(r, 400));
}

const n = replies.length;
// A missing replies.push() once made every row read "0/1" - which looks exactly
// like a clean pass. A probe that cannot say how many cases it actually ran is
// not reporting, so require the full set.
if (n !== CASES.length) {
    console.error(`\nFAIL — only ${n}/${CASES.length} cases produced a reply; the report above is meaningless.`);
    process.exit(1);
}
console.log('\n──────── banter report ────────');
for (const [name, label] of Object.entries(CHECKS).map(([n2, v]) => [n2, v.label])) {
    console.log(`  ${label.padEnd(38)} ${tally[name]}/${n} (want 0)`);
}
console.log(`  ${'went mute instead of playing along'.padEnd(38)} ${tally.MUTE}/${n} (want 0)`);
console.log(`  ${'over the word cap'.padEnd(38)} ${tally.LONG}/${n} (want 0)`);

if (Object.keys(CHECKS).some((k) => tally[k]) || tally.MUTE || tally.LONG) {
    console.log('\nFAIL — she is too well-mannered to be believable. Be too kind = the bot tell.');
    process.exit(1);
}
console.log('\nPASS — plays along every time');
