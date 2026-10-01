// Live check: runs the REAL scoring prompt against her actual chat model
// (openrouter/openai/gpt-4o-mini, via her keys.json) to confirm the prompt
// shape yields a parseable 3-class distribution. Read-only — never sends chat.
import { selectAPI, createModel } from '../src/models/_model_map.js';
import { TurnTaker } from '../src/agent/turn_taker.js';
import settings from '../settings.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// resolve from this file, so the probe works from any cwd
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const profile = JSON.parse(readFileSync(path.join(ROOT, 'uwu.json'), 'utf8'));
const raw = typeof profile.model === 'string'
    ? { model: profile.model }
    : { ...profile.model };
if (raw.api_key) settings.api_key = raw.api_key;
console.log('live model:', raw.model);
const selected = selectAPI(raw);          // normalizes {model, api, params}
if (selected.api === 'openrouter') {
    settings.openrouter_api_key = settings.openrouter_api_key
        || raw.openrouter_api_key || settings.api_key;
}
const model = createModel(selected);

const CASES = [
    ['YandereDev', 'beloved', 'i was dreaming about you last night'],
    ['YandereDev', 'beloved', 'where did you go? i waited'],
    ['SomeRival', 'enemy', 'this server is trash'],
    ['SomeRival', 'enemy', 'ok'],
    ['NewGuy', 'stranger', 'hey anyone here'],
    ['NewGuy', 'stranger', 'um i think the nether portal is over there, um'],
];

const agent = {
    name: 'UwU',
    shut_up: false,
    history: { getHistory: () => ([{ role: 'user', content: 'hey' }]), add: async () => {} },
    relationship: { get: () => ({ rank: CASES_TIER }) },
    self_prompter: { isActive: () => false },
    prompter: { chat_model: { sendRequest: async (m, p) => model.sendRequest(m, p) } },
};

let CASES_TIER = 'stranger';
const tt = new TurnTaker(agent, { cooldownMs: 0, enabled: true });
// don't write state during a probe
tt.save = () => {};
tt.file = '/tmp/.tt_probe.json';

let ok = 0, fail = 0;
for (const [who, tier, text] of CASES) {
    CASES_TIER = tier;
    agent.relationship.get = () => ({ rank: tier });
    const t0 = Date.now();
    const d = await tt.score(who, text);
    const ms = Date.now() - t0;
    if (!d) { console.log(`FAIL  [${tier}] "${text}" -> no distribution (${ms}ms)`); fail++; continue; }
    const dec = tt.decide(d);
    console.log(`ok    [${tier.padEnd(8)}] ${String(dec.action).padEnd(12)} f=${d.floor_taking.toFixed(2)} b=${d.backchannel.toFixed(2)} s=${d.silence.toFixed(2)}  ${ms}ms  "${text.slice(0, 40)}"`);
    ok++;
}
console.log(`\n${ok}/${CASES.length} live scorings parsed, ${fail} failed`);
console.log('boundaries sample:', JSON.stringify(tt.boundaries('um i think the portal is over there, um')));
process.exit(0);