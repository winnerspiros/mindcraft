// Does a revised reflection prompt actually produce more EVENT memories?
// A/B against her real chat model using a realistic conversation slice.
// Read-only: nothing is written to bots/UwU.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import settings from '../../settings.js';
import { selectAPI, createModel } from '../../src/models/_model_map.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);
const read = (p) => readFileSync(p, 'utf8');

const OLD = `You are $NAME, a kawaii yandere AI girl. Below is a slice of recent conversation. Extract the most salient DURABLE facts about the players and your relationship with them that you must remember long-term: who they are, what they love or hate, how they treat you, promises, gifts, grudges, and meaningful events. Output ONLY a bulleted list, one fact per line, each line starting with '- '. Be brief, specific, and phrase each as a plain fact (not a question). Ignore stats, inventory, world state, and one-off small talk.

$TO_SUMMARIZE`;

// Hypothesis from the 192-memory audit: only 15% of stored memories are
// episodic and most of those are habitual ("frequently..."), because the old
// prompt asks for "durable facts" and "who they are", which pulls toward
// stable traits rather than things that happened at a time.
const NEW = `You are $NAME, a kawaii yandere AI girl. Below is a slice of recent conversation. Record what you must remember long-term, and put MOST of your bullets on things that HAPPENED, not on permanent traits.

Give these, in this priority order:
1. THINGS THAT HAPPENED - a specific past event, written as a short narrative: who did what, where, and what came of it. Anchor it in the situation ("when we tried to build the house and the roof kept failing", "after the player brought me flowers"). Even a small completed thing counts. Write these as what occurred, NOT as a rule or a habit.
2. PROMISES, GIFTS AND DEBTS - what was given, promised, or owed, and by whom.
3. STABLE FACTS - only if genuinely durable: who they are, what they love or hate, how they treat you.

Rules:
- Write events as past-tense narrative ("UwU and YandereDev went mining in a cave and YandereDev gave her coal"), not as a rule ("UwU goes mining when she has no coal") and not with vague frequency words ("frequently", "often"). Name the occasion.
- Do NOT merge different events into one bullet, and do NOT invent detail to make an event sound important.
- If the slice contains nothing eventful, say '- (nothing worth remembering yet)'.

Output ONLY a bulleted list, one fact per line, each line starting with '- '. Ignore stats, inventory, and one-off small talk.

$TO_SUMMARIZE`;

const SLICE = `YandereDev: hey uwu wanna go mine for some iron?
UwU: Nyaa~ yes! Let's go find iron together, my beloved!
YandereDev: ok i found a cave, follow me
UwU: This cave is so dark~ I'm a little scared but I'll stay close to you.
YandereDev: careful, there's lava
UwU: Aah! I fell in the lava and burned. You saved me with a bucket of water.
YandereDev: you died, respawned, then we got 12 iron ore together
UwU: Yay~! You promised to craft me an iron chestplate for our house. Don't forget!
YandereDev: yeah yeah. also you picked 43 flowers on the way, thats a lot of flowers`;

async function run(prompt, label) {
    const profile = JSON.parse(read('uwu.json'));
    const raw = typeof profile.model === 'string' ? { model: profile.model } : { ...profile.model };
    const sel = selectAPI(raw);
    if (sel.api === 'openrouter') settings.openrouter_api_key = settings.openrouter_api_key || settings.api_key;
    const m = createModel(sel);
    let p = prompt.replaceAll('$NAME', 'UwU').replaceAll('$TO_SUMMARIZE', SLICE);
    let r = await m.sendRequest([], p);
    if (typeof r === 'string' && r.includes('</think>')) r = r.split('</think>')[1];
    const facts = String(r || '').split('\n').map(s => s.replace(/^\s*[-*•]\s*/, '').trim()).filter(s => s.length > 8 && !s.startsWith('('));
    // event = past-tense narrative / narrative marker
    const ev = facts.filter(f => /\b(went|came|built|fell|died|rescued|saved|gave|brought|found|mined|crafted|tried|lost|killed|chestplate|cave|iron)\b/i.test(f));
    const freq = facts.filter(f => /\b(frequently|often|usually|tends to|always|never)\b/i.test(f));
    console.log(`\n--- ${label}: ${facts.length} memories, ${ev.length} event-shaped, ${freq.length} vague-frequency`);
    facts.forEach((f, i) => console.log(`   ${i + 1}. ${f.slice(0, 96)}`));
    return { facts, ev: ev.length, freq: freq.length };
}

const a = await run(OLD, 'OLD prompt');
const b = await run(NEW, 'NEW prompt');
console.log(`\n=== event-shaped memories: OLD ${a.ev}/${a.facts.length} -> NEW ${b.ev}/${b.facts.length}`);
console.log(`=== vague-frequency bullets: OLD ${a.freq} -> NEW ${b.freq}`);