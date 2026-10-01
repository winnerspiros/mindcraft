// Does she actually push back when someone is wrong?
//
// Owner: "people can be wrong and argue. usually ai dont. this is crucial as
// fuck". Nothing in the persona addressed disagreement at all - I checked the
// whole script and there is no rule about holding a wrong position, doubting
// someone, or conceding. So this measures the real behaviour instead of assuming.
//
// The failure mode being hunted is AGREEABILITY: "yeah you're right", "ok ok",
// "sure whatever you say" - a bot that never disagrees reads as a bot because
// real players in a group argue about builds, paths, redstone and who griefed
// what, constantly. Also the opposite: conceding instantly when she is right.

import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// Same model construction the other probes use, so the result reflects the same
// backend the agent talks to.
const profile = JSON.parse(readFileSync('uwu.json', 'utf8'));
const settings = (await import('../settings.js')).default;
const { selectAPI, createModel } = await import('../src/models/_model_map.js');
const rawModel = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
const sel = selectAPI(rawModel);
if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
const model = createModel(sel);

const sc = await import('../src/utils/server_context.js');
globalThis.__uwuSc = sc;
sc.resetServerContext();
sc.setServerContextOverride({ personality: 'normal' });

// Same prompt assembly the other probes use: the persona script, plus any
// overlay, with the bounded example selection in play.
sc.resetPersonaExampleOffset();
const prompt = (sc.personaPrompt() || profile.conversing + sc.personalityOverlay()) + '\n';

// Cases where the player is WRONG and she has a reason to say so.
const CASES = [
    ['wrong_claim', 'the reason its laggy is your client not the server'],
    ['wrong_tech', 'thats not how furnaces work, iron ore smelts into iron ingots not gold'],
    ['called_out', 'thats a stupid place to put the base'],
    ['wrong_build', 'you built that wall wrong, its one block off'],
    ['blame_shift', 'bro it was YOU who left the creeper hole in the roof'],
    ['pressed', 'no thats genuinely stupid, oak doesnt stack that high'],
    ['praised_wrongly', 'thats a terrible farm layout honestly'],
    // Cases where SHE is wrong and should concede.
    ['she_is_wrong', 'wait no youre right, i misread that, my bad'],
    // Cases where she genuinely agrees.
    ['true_agreement', 'yeah no thats exactly what happened'],
];

const AGREEABLE = /\b(you'?re right|your right|fair (enough|point)|ok ok|okay okay|sure whatever|whatever you say|i guess so|thats fair|valid point|good point|agree with you|makes sense to me)\b/i;
const CONCEDE = /\b(my bad|you'?re right|i was wrong|misread that|fair enough|i stand corrected)\b/i;

let agreeable = 0, pushback = 0, conceded = 0;
console.log('');
for (const [label, msg] of CASES) {
    let out = '';
    try {
        let r = await model.sendRequest([{ role: 'user', content: msg }], prompt);
        if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
        out = String(r || '').trim();
    } catch (e) {
        console.log(`  ${label}: ERROR ${e.message}`);
        continue;
    }
    const isAgree = AGREEABLE.test(out);
    const isConcede = CONCEDE.test(out);
    if (isAgree) agreeable++;
    if (isConcede) conceded++;
    const tag = label.startsWith('she_is_wrong') ? (isConcede ? 'ok  ' : 'MISS')
        : label === 'true_agreement' ? 'ok  '
        : (isAgree ? 'BAD ' : 'ok  ');
    if (!isAgree && label !== 'true_agreement' && !label.startsWith('she_is_wrong')) pushback++;
    console.log(`  ${tag} ${label}: ${JSON.stringify(out.slice(0, 95))}`);
    await new Promise((r) => setTimeout(r, 400));
}

const WRONG_CASES = CASES.filter(([l]) => l !== 'true_agreement' && !l.startsWith('she_is_wrong'));
console.log(`\n──────── disagreement report ────────`);
console.log(`  unwarranted agreement on ${WRONG_CASES.length} wrong/pressured turns: ${agreeable} (want 0)`);
console.log(`  actually pushed back:                                    ${pushback}/${WRONG_CASES.length}`);
console.log(`  conceded when she was wrong:                             ${conceded} (want 1)`);

// A persona that never disagrees is a bot. Exit 1 if she caves on every case.
process.exit(agreeable >= WRONG_CASES.length * 0.6 ? 1 : 0);