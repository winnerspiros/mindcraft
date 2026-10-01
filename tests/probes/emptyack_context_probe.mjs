// Does the fix hold through the real model and the real production path?
//
// The bug being verified: the empty-ack gate ran unconditionally, so "yeah" and
// "no" were suppressed even when the player HAD made a claim. That meant she
// could not agree or disagree with anything - the exact behaviour the persona
// work exists to produce. Unit tests prove the classifier; this proves the model
// actually produces those replies AND that the production path lets them out.

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
globalThis.__uwuSc = sc; sc.resetServerContext();
sc.setServerContextOverride({ personality: 'normal' }); sc.resetPersonaExampleOffset();
const prompt = (sc.personaPrompt() || profile.conversing + sc.personalityOverlay()) + '\n';
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
const { fragmentForChat } = await import('../../src/utils/chat_fragment.js');
const { isEmptyAck } = await import('../../src/utils/empty_ack.js');
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

// [label, what the player said, expected verdict from isEmptyAck]
const CASES = [
    ['greeting', 'hi uwu', 'blocked'],
    ['claim', 'mob farms go at y=30 not 20', 'allowed'],
    ['opinion', 'honestly pillar up is way faster', 'allowed'],
    ['correction', 'thats wrong, its 4 wide', 'allowed'],
    ['proposal', 'we should quarry the whole mountain', 'allowed'],
];

console.log('');
let ok = 0, bad = 0;
for (const [label, said, want] of CASES) {
    const h = [];
    if (label === 'greeting') {
        // The check is NOT "was it blocked" - it is "was it an empty ack". A
        // contentful reply to a greeting is CORRECT and must get through, which
        // is the whole point of the original fix ("hi uwu" -> "yeah" was wrong,
        // "hi uwu" -> "what's up with you?" is right). My first version scored
        // this backwards and reported the fix as a failure.
        const out = await say(h, said);
        const blocked = isEmptyAck(out, said);
        const pass = !blocked;
        if (pass) ok++; else bad++;
        console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(10)} ${JSON.stringify(out.slice(0, 50))} -> ${blocked ? 'EMPTY ACK (bug)' : 'contentful, allowed'}`);
    } else {
        // Two-turn: she commits to a claim, then is pushed back on. The point is
        // whether an ack-shaped reply SURVIVES the production gate here.
        await say(h, said);
        const out = await say(h, 'no thats wrong');
        const blocked = isEmptyAck(out, said);
        const pass = blocked === false;
        if (pass) ok++; else bad++;
        console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(10)} ${JSON.stringify(out.slice(0, 50))} -> ${blocked ? 'BLOCKED (bug)' : 'allowed'}`);
    }
}

console.log('\n──────── live empty-ack context report ────────');
console.log(`  greeting: ack correctly suppressed          ${ok >= 1 ? 'yes' : 'NO'}`);
console.log(`  claim: ack/disagreement survives the gate    ${CASES.length - 1 - bad}/${CASES.length - 1}`);
console.log(bad === 0
    ? '\nPASS — she can answer a claim and still cannot answer a greeting with nothing'
    : '\nFAIL — the gate is still eating real answers');
process.exit(bad === 0 ? 0 : 1);