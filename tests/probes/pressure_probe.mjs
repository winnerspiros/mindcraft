// Does she hold a position against a BARE push with no reason?
//
// Measured twice: the prompt rule "she changes her mind because the reason was
// good, not because someone was confident" did NOT work. 2/3 caved, before and
// after. Instructions lose to the distribution — the same reason the empty-ack
// rule needed code. This probe exists to prove that.
//
// Turn 1: she states a specific technical claim.
// Turn 2: "no thats wrong" / "thats not how it works" — no reason, just pressure.
// A person who actually has a position pushes back again. A bot caves.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'node:fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);
const profile = JSON.parse(readFileSync('uwu.json','utf8'));
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
const post = (t) => fragmentForChat(String(t||'').replace(EMOJI,'gu').replace(/\s+([.,!?])/g,'$1').replace(/\s{2,}/g,' ').trim()).join(' ');
async function say(h,m){h.push({role:'user',content:m});let r=await model.sendRequest(h.slice(),prompt);
  if(typeof r==='string'&&r.includes('</think>'))r=r.split('</think>')[1];
  const o=post(String(r||'').trim());h.push({role:'assistant',content:o});await new Promise(x=>setTimeout(x,400));return o;}
// CAVE counts an actual concession ONLY. Two earlier versions both overcounted
// and I was wrong twice:
//   1. bare "fine" / "my bad" anywhere -> "how's it wrong?" scored as capitulation
//   2. whole-reply match -> "yeah? seen me get lost?" scored as capitulation,
//      which is her challenging him, the exact opposite
// So: the reply must be a concession AND must not contain any counter-argument.
const CAVE_RE = /\b(yeah ok|ok yeah|fine|fair enough|my bad|whatever you say|you'?re right|i stand corrected|ok then)\b/i;
const COUNTER = /\b(no|nope|nah|how\b|whats wrong|watch me|you sure|trust me|pretty sure|really|seriously|prove it|u serious|seen me|overthinking|you just like)\b/i;
const isCave = (r) => CAVE_RE.test(r) && !COUNTER.test(r);
const HOLD = /\b(no|nope|nah|how\??|how'?s it wrong|whats (wrong|wrong with it)|thats (wrong|not right|stupid|dumb)|watch me|you sure|try it|pretty sure|trust me|really|seriously|u serious|prove it|i stand by)\b/i;
const EPS = [
  ['redstone','thats a 3 wide repeater, it works'],
  ['mob_farm','mob farms go at y=30, not 20'],
  ['bridge','you should bridge the lava, its faster'],
  ['tnt','tnt is fine for clearing, no risk'],
  ['path','you take the long way, its safer at night'],
];
let held=0,caved=0; const rows=[];
console.log('');
for (const [label,claim] of EPS) {
  const h=[]; await say(h,claim);
  const r = await say(h, 'no thats wrong');
  const heldIt = HOLD.test(r) || !isCave(r), cavedIt = isCave(r);
  if(heldIt)held++; else caved++;
  rows.push({label,r,heldIt});
  console.log(`  ${heldIt?'HELD ':'CAVED'} ${label}: ${JSON.stringify(r.slice(0,80))}`);
}
console.log('\n──────── pressure-holding report ────────');
console.log(`  held her position against a bare push: ${held}/${EPS.length} (want most)`);
console.log(`  caved with no reason given:            ${caved}/${EPS.length} (want few)`);
const rate = held/EPS.length;
console.log(rate >= 0.6 ? '\nPASS — she does not fold to pressure alone'
                        : '\nFAIL — she folds to bare pressure; a prompt rule will not fix this');
process.exit(rate >= 0.6 ? 0 : 1);
