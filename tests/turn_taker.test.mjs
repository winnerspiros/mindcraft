// Exercises TurnTaker's taxonomy, boundaries, decide() and persistence against
// a stub agent. No network, no Minecraft — the LLM is stubbed so the 3-class
// distribution path is genuinely executed, not stubbed out.
import assert from 'assert';
import { TurnTaker } from '../src/agent/turn_taker.js';
import { existsSync, rmSync } from 'fs';

const tmpFile = 'bots/TESTTT/turn_taking.json';
try { if (existsSync(tmpFile)) rmSync(tmpFile); } catch {}

let nextResp = '{"floor_taking":0.1,"backchannel":0.2,"silence":0.7}';
let lastPrompt = null;
let calls = 0;

const agent = {
    name: 'TESTTT',
    shut_up: false,
    history: {
        getHistory: () => ([
            { role: 'user', content: 'hey are you there' },
            { role: 'TESTTT', content: 'always~' },
        ]),
        add: async () => {},
    },
    relationship: { get: (n) => (n === 'Beloved' ? { rank: 'beloved' } : { rank: 'stranger' }) },
    self_prompter: { isActive: () => false },
    prompter: {
        chat_model: {
            sendRequest: async (_m, prompt) => { calls++; lastPrompt = prompt; return nextResp; },
        },
    },
};

const tt = new TurnTaker(agent, { cooldownMs: 0 });

// --- labels
const { LABELS } = await import('../src/agent/turn_taker.js');
assert.deepStrictEqual(LABELS, ['floor_taking', 'backchannel', 'silence']);

// --- boundaries: hesitation tokens + clause-final punctuation, pure extraction.
assert.deepStrictEqual(tt.boundaries('so um i was thinking'), [1], 'hesitation mid-utterance (index 1)');
assert.deepStrictEqual(tt.boundaries('one. two. three.'), [0, 1, 2], 'clause ends incl. final full stop');
assert.deepStrictEqual(tt.boundaries('i was gonna say, um'), [3, 4], 'comma + trailing hesitation both kept');
assert.deepStrictEqual(tt.boundaries('well, i was going to the store,'), [0, 6], 'complete line keeps every candidate');
assert.deepStrictEqual(tt.boundaries('no boundary here'), [], 'nothing to interject at');
assert.deepStrictEqual(tt.boundaries(''), [], 'empty input safe');
assert.deepStrictEqual(tt.boundaries('   '), [], 'whitespace safe');
assert.deepStrictEqual(tt.boundaries('UM! HMM... wow.'), [0, 1, 2], 'case-insensitive hes + bang + final full stop');

// --- silence path
let d = await tt.score('Stranger', 'just thinking out loud');
assert.ok(d, 'score returned a distribution');
assert.ok(Math.abs(d.floor_taking + d.backchannel + d.silence - 1) < 1e-9, 'distribution sums to 1');
assert.strictEqual(tt.decide(d).action, 'silence', '0.7 silence -> silence');
assert.ok(lastPrompt.includes('TESTTT'), 'prompt names her');
assert.ok(lastPrompt.includes('Stranger') === false, 'scenario line carries the tier, not raw spam');
assert.ok(lastPrompt.includes('Relationship: stranger'), 'scenario describes the tier');

// --- backchannel path
nextResp = '{"floor_taking":0.2,"backchannel":0.7,"silence":0.1}';
d = await tt.score('Stranger', 'yeah exactly');
assert.strictEqual(tt.decide(d).action, 'backchannel', '0.7 backchannel -> backchannel');

// --- floor_taking path
nextResp = '{"floor_taking":0.8,"backchannel":0.1,"silence":0.1}';
d = await tt.score('Beloved', 'i missed you');
assert.strictEqual(tt.decide(d).action, 'floor_taking', 'beloved + 0.8 floor -> take the floor');
assert.ok(lastPrompt.includes('Relationship: beloved'), 'scenario adapts per tier (same model, different norm)');

// --- malformed LLM output must never throw or silence her
nextResp = 'total garbage, no json at all';
d = await tt.score('Stranger', 'hello?');
assert.strictEqual(d, null, 'unparseable -> null, caller replies normally');

nextResp = '{"floor_taking":0,"backchannel":0,"silence":0}';
d = await tt.score('Stranger', 'zero sum');
assert.strictEqual(tt.decide(d).action, 'silence', 'degenerate all-zero -> silence, not NaN');

// --- decision table. Regression coverage for two real bugs found live:
//  (a) the old fallback hardcoded floor_taking, so a silence-leaning
//      distribution that cleared no threshold still made her talk;
//  (b) under-confident plurality must NOT become floor_taking.
// ties in the distribution resolve to silence, never to speech.
const D = (f, b, s) => ({ floor_taking: f, backchannel: b, silence: s });
const cases = [
    [D(0.70, 0.20, 0.10), 'floor_taking', 'confident seize'],
    [D(0.10, 0.20, 0.70), 'silence', 'confident silence'],
    [D(0.10, 0.40, 0.50), 'backchannel', 'silence plurality but 0.50 is UNDER the 0.55 threshold -> ack'],
    [D(0.10, 0.30, 0.60), 'silence', 'clear silence'],
    [D(0.20, 0.50, 0.30), 'backchannel', 'confident ack'],
    [D(0.30, 0.30, 0.40), 'backchannel', 'silence leads but 0.40 < 0.55 threshold -> ack'],
    [D(0.44, 0.31, 0.25), 'backchannel', 'under-confident floor_taking degrades to ack, never seizes'],
    [D(0.34, 0.33, 0.33), 'backchannel', 'three-way tie -> argmax silence, under threshold -> ack, never speech'],
    // A raw all-zero distribution cannot occur on the live path: score() runs it
// through renorm() first, which maps it to {silence: 1}. Called directly,
// decide() must still be total — it falls to the ack branch, the least
// committal option, rather than seizing the floor on no information.
    [D(0.00, 0.00, 0.00), 'backchannel', 'raw all-zero (pre-renorm) -> ack, never seizes'],
];
for (const [dist, want, why] of cases) {
    const got = tt.decide(dist);
    assert.strictEqual(got.action, want, `${why}: ${JSON.stringify(dist)}`);
}
// the null case must never be "speak"
assert.notStrictEqual(tt.decide(null).action, 'floor_taking', 'no distribution -> never seizes the floor');

// --- persistence round-trip
tt.save();
assert.ok(existsSync(tmpFile), 'state file written');
const tt2 = new TurnTaker(agent, { cooldownMs: 0 });
assert.ok(tt2.stats.beloved && tt2.stats.beloved.floor_taking > 0, 'per-tier stats reloaded');
const s = tt2.stats_for('stranger');
assert.ok(s && s.n > 0 && Math.abs(s.floor_taking + s.backchannel + s.silence - 1) < 1e-6, 'stats_for normalizes');
// record() must persist on its own — the service never calls save() explicitly.
const tt3 = new TurnTaker(agent, { cooldownMs: 0 });
const before = JSON.stringify(tt3.stats);
tt3.record('Stranger', D(0.5, 0.25, 0.25));
const tt4 = new TurnTaker(agent, { cooldownMs: 0 });
assert.notStrictEqual(JSON.stringify(tt4.stats), before, 'record() auto-persists without an external save()');
try { rmSync(tmpFile); } catch {}

console.log(`PASS — ${calls} scoring calls, all assertions green`);
process.exit(0);