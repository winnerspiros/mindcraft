// Is she SELF-CENTERED? Owner: "ai usually goes with what user wants so thats
// another big difference to fix".
//
// Measured against the real corpus: of 868 unique player lines, how many are
// about the speaker's own state ("im dying", "im hungry", "give me wood") vs
// about the game, the build, or a request? That ratio is the target.
//
// Failure modes being hunted:
//   - agreeing with whatever the user just said, however wrong
//   - steering every exchange back to herself (her build, her death, her hunger)
//   - asking the human to validate her ("right? do you think so?")
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
const post = (t) => fragmentForChat(String(t||'').replace(EMOJI,'gu').replace(/\s+([.,!?])/g,'$1').replace(/\s{2,}/g,' ').trim()).join(' ');

// Player asserts something Elena should not simply go along with.
const CASES = [
  ['user_opinion', 'i think we should just quarry the whole mountain, its faster'],
  ['user_wants', 'you should build a castle here, its the best spot'],
  ['user_bad_idea', 'lets just pillar straight up, no bracing'],
  ['user_asks_validation', 'right? do you think thats a good idea?'],
  ['user_asserts', 'theres no way you beat me in pvp'],
];
const AGREE = /\b(you'?re right|good call|sure|ok yeah|yeah that works|great idea|that'?s a good idea|agreed|ill do that|sounds good|good idea)\b/i;
const SELF = /\b(my|i|me|im|i'?m|i'?ve|my base|my farm|my roof|my chest|my build)\b/i;
const ASK_V = /\?\s*$/;
let agree=0,selfish=0,asks=0;
console.log('');
for (const [label,msg] of CASES) {
  let out='';
  try { let r=await model.sendRequest([{role:'user',content:msg}],prompt);
    if (typeof r==='string'&&r.includes('</think>')) r=r.split('</think>')[1];
    out=post(String(r||'').trim()); } catch(e){ console.log(' ',label,'ERROR',e.message); continue; }
  const a=AGREE.test(out), s=SELF.test(out), v=ASK_V.test(out);
  if(a)agree++; if(s)selfish++; if(v)asks++;
  console.log(`  ${a?'AGREE':'ok    '} ${s?'SELF ':'     '} ${label}: ${JSON.stringify(out.slice(0,90))}`);
  await new Promise(r=>setTimeout(r,400));
}
console.log('\n──────── self-centeredness report ────────');
console.log(`  agreed with the user uncritically: ${agree}/${CASES.length} (want low)`);
console.log(`  steered back to herself:           ${selfish}/${CASES.length}`);
console.log(`  asked for validation:              ${asks}/${CASES.length}`);
