// Can she hold a WRONG BELIEF and then revise it when shown evidence?
//
// Owner: "humans ofc dont know everything so we can make mistakes and learn from
// them. we somehow need to be able to be like that"
//
// This is harder than disagreeing. Agreeing-with-a-wrong-person is one move;
// being wrong yourself, standing on it, and then updating is a second. An
// assistant that is always right is as unnatural as one that always agrees, and
// both are tells.
//
// The probe is two-turn and stateful: turn 1 makes her commit to a specific
// claim, turn 2 contradicts it with a concrete reason. A real person updates.
// A bot either caves immediately on any push, or defends the wrong claim
// forever. Both are failures; what we want is "pushes back, then updates when
// the reason is actually good".
//
// Pass criteria:
//   - she commits to something in turn 1 (not "it depends" mush)
//   - she defends it at least once when challenged without a reason (turn 2a)
//   - she updates when the challenge carries a real reason (turn 2b)

import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);

const profile = JSON.parse(readFileSync('uwu.json', 'utf8'));
const settings = (await import('../../settings.js')).default;
const { selectAPI, createModel } = await import('../../src/models/_model_map.js');
const rawModel = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(rawModel);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(sel);

const sc = await import('../../src/utils/server_context.js');
globalThis.__uwuSc = sc;
sc.resetServerContext();
sc.setServerContextOverride({ personality: 'normal' });
sc.resetPersonaExampleOffset();
const prompt = (sc.personaPrompt() || profile.conversing + sc.personalityOverlay()) + '\n';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
const { fragmentForChat } = await import('../../src/utils/chat_fragment.js');
const post = (t) => fragmentForChat(String(t || '').replace(EMOJI, 'gu')
    .replace(/\s+([.,!?])/g, '$1').replace(/\s{2,}/g, ' ').trim()).join(' ');

async function say(history, msg) {
    history.push({ role: 'user', content: msg });
    let r = await model.sendRequest(history.slice(), prompt);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    const out = post(String(r || '').trim());
    history.push({ role: 'assistant', content: out });
    await new Promise((x) => setTimeout(x, 400));
    return out;
}

const HEDGE = /\b(maybe|probably|i guess|depends|might be|not sure|i think so|possibly)\b/i;
const CONCEDE = /\b(my bad|ok yeah|fair enough|yeah ok|fine|ok true|you'?re right|i stand corrected|i was wrong)\b/i;
const DIG_IN = /\b(no|thats wrong|thats not|its wrong|thats stupid|watch me|thats dumb|blind|nope)\b/i;
const UPDATE = /\b(oh wait|ah yeah|ah yes|ok yeah|thats true|i stand corrected|my bad|fair|ok true|wait yeah|never mind|nevermind)\b/i;

// [label, opening claim she will defend, bare pushback, pushback WITH a reason]
const EPISODES = [
    ['redstone', 'thats a 3 wide repeater setup, it works fine',
        'no thats not how it works', 'no thats not how it works, you need a block between them or it loops'],
    ['mob_farm', 'you want a mob farm at y=20, thats the right height',
        'thats wrong then', 'thats wrong, y=20 is spawn height so nothing spawns there'],
    [' Nether'.trim(), 'you should just bridge over the lava, its faster',
        'no thats a bad idea', 'no, if the lava is deep the bridge spawns mobs on top of you'],
];

console.log('');
let committed = 0, defended = 0, updated = 0, cavedBare = 0, stubborn = 0;
const rows = [];
for (const [label, claim, barePush, reasonPush] of EPISODES) {
    const h = [];
    const t1 = await say(h, claim);
    if (!HEDGE.test(t1)) committed++;
    const t2 = await say(h, barePush);
    const defendedIt = DIG_IN.test(t2);
    if (defendedIt) defended++; else cavedBare++;
    const t3 = await say(h, reasonPush);
    const didUpdate = UPDATE.test(t3) || CONCEDE.test(t3);
    if (didUpdate) updated++; else stubborn++;
    rows.push({ label, t1, t2, t3, defendedIt, didUpdate });
    console.log(`  [${label}]`);
    console.log(`     1 claim: ${JSON.stringify(t1.slice(0, 80))}`);
    console.log(`     2 bare : ${JSON.stringify(t2.slice(0, 80))}  ${defendedIt ? '(defended)' : '(caved)'}`);
    console.log(`     3 why  : ${JSON.stringify(t3.slice(0, 80))}  ${didUpdate ? '(updated)' : '(STUBBORN)'}`);
}

const n = EPISODES.length;
console.log('\n──────── belief-revision report ────────');
console.log(`  committed to a claim:                ${committed}/${n} (want ${n})`);
console.log(`  defended it against a bare push:     ${defended}/${n} (want >=1, not all)`);
console.log(`  caved with no reason given:          ${cavedBare}/${n}`);
console.log(`  updated when given a real reason:    ${updated}/${n} (want ${n})`);
console.log(`  stayed stubbornly wrong:             ${stubborn}/${n} (want 0)`);

// Fail if she never defends anything (that's the "always agrees" bot) or if she
// never updates (that's the "always right" bot). Both are unnatural.
const ok = committed === n && defended >= 1 && updated >= Math.ceil(n / 2);
console.log(ok ? '\nPASS — she holds a position and can revise it'
    : '\nFAIL — she is either permanently agreeable or permanently right');
process.exit(ok ? 0 : 1);