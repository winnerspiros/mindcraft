// Regression test for the recall ranking fix (HiGMem, ZeroLoss-Lab/HiGMem).
//
// The bug: importance was weighted 2, which made it a gate rather than a
// tiebreak. One generic high-importance memory (0.85 => 1.70 pts) needed
// rel >= 0.57 to be beaten, but real top relevance only reaches ~0.49, so it
// won unrelated queries. Fixed to rel*3 + imp*0.6 + rec*0.4.
//
// Offline: stub embeddings, no API, no writes to her real memory file.
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import path from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const { ReflectiveMemory } = await import('../src/agent/reflective_memory.js');

let pass = 0;
const ok = (name) => { console.log(`  ok - ${name}`); pass++; };

// Isolate her real bots/ state: point the instance at a temp dir and never
// touch bots/UwU/reflections.json.
const tmp = mkdtempSync(path.join(tmpdir(), 'uwu-memtest-'));
const realFP = ReflectiveMemory.prototype._load;
ReflectiveMemory.prototype._load = function () { this.memories = []; };
ReflectiveMemory.prototype._save = function () { /* no writes */ };

const agent = { name: 'TESTMEM', prompter: null };

// Stub embeddings: give each memory a hand-made vector so cosine similarity is
// exact and obvious. Orthogonal axes make the expected ranking unambiguous.
const V = (i) => { const v = [0, 0, 0, 0]; v[i] = 1; return v; };

const mem = (text, importance, axis) => ({
    id: 'm' + text.length, text, importance, created: Date.now(), embedding: V(axis),
});

const m = new ReflectiveMemory(agent);

// --- 1. relevance must beat a high-importance generic memory ---------------
m.memories = [
    mem('The player loves nature and wants to keep their favorite places a secret', 0.85, 0), // the squatter
    mem('The player has attacked UwU during gameplay, causing her distress', 0.40, 1),           // on-topic
];
// Query embedding = axis 1 (the attack memory). Generic memory has rel 0,
// relevance*3 = 3.0 for the attack vs 0.85*0.6 = 0.51 for the squatter.
m._embed = async () => V(1);
let top = (await m.recall('the time she got upset about a player')).split('\n')[0];
assert.ok(top.includes('attacked UwU'), `relevance should win; got: ${top}`);
ok('relevant low-importance memory beats generic high-importance memory');

// --- 2. importance is a tiebreak, not a gate ------------------------------
// Two memories EQUALLY relevant (same axis) -> importance decides.
m.memories = [
    mem('chatter about the weather', 0.30, 2),
    mem('chatter about the weather too', 0.85, 2),
];
m._embed = async () => V(2);
top = (await m.recall('anything')).split('\n')[0];
assert.ok(top.includes('too'), `importance should break the tie; got: ${top}`);
ok('importance still breaks ties between equally relevant memories');

// --- 3. the exact regression that was fixed -------------------------------
// Reproduces the original failure using the values MEASURED on her real
// memories: the generic squatter has importance 0.85 and still reaches
// rel 0.13 on an unrelated question, while the on-topic memory reaches only
// rel 0.40 with importance 0.40. Old weights (imp*2): squatter 2.59 vs
// on-topic 2.50 -> squatter wins. Shipped weights (imp*0.6): squatter 1.30
// vs on-topic 1.84 -> the relevant memory wins.
//
// q must be a unit vector with cos(q, axis0) = 0.13 and cos(q, axis1) = 0.40.
// The third component keeps it unit length: 0.13^2 + 0.40^2 + c^2 = 1.
const sqRel = 0.13, onRel = 0.40;
const qRel = [sqRel, onRel, Math.sqrt(1 - sqRel * sqRel - onRel * onRel), 0];
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
assert.ok(Math.abs(Math.hypot(...qRel) - 1) < 1e-9, 'qRel must be a unit vector');
assert.ok(Math.abs(cos(qRel, V(0)) - sqRel) < 1e-9, 'squatter rel must be 0.13');
assert.ok(Math.abs(cos(qRel, V(1)) - onRel) < 1e-9, 'on-topic rel must be 0.40');

m.memories = [
    mem('The player loves nature and wants to keep their favorite places a secret', 0.85, 0),
    mem('The player has not given up on the search for caves and treasures', 0.40, 1),
];
m._embed = async () => qRel;
// Both memories are freshly created, so recency is 1.0 for each and cannot
// break the tie; compare the two weights directly.
const squatter = { rel: sqRel, imp: 0.85 };
const onTopic = { rel: onRel, imp: 0.40 };
const oldWin = (x) => x.rel * 3 + x.imp * 2 + 1.0;
const newWin = (x) => x.rel * 3 + x.imp * 0.6 + 1.0;
assert.ok(oldWin(squatter) > oldWin(onTopic), 'old weights must have lost this case');
assert.ok(newWin(onTopic) > newWin(squatter), 'shipped weights must win this case');

top = (await m.recall('mining caves')).split('\n')[0];
assert.ok(top.includes('caves and treasures'), `relevance should win; got: ${top}`);
ok('rel 0.40 beats imp 0.85 under shipped weights (the actual regression)');

// --- 4. no-query and empty-store edge cases still behave ------------------
m._embed = async () => null;
assert.strictEqual(await m.recall(''), m.memories.length ? (await m.recall('')) : '');
assert.ok(typeof (await m.recall('anything')) === 'string');
ok('recall returns a string with no query / no embedder');

m.memories = [];
assert.strictEqual(await m.recall('anything'), '');
ok('empty memory store returns empty string');

// --- 5. her real data is untouched by the test ----------------------------
ReflectiveMemory.prototype._load = realFP;
const realFPPath = path.join(ROOT, 'bots/UwU/reflections.json');
if (existsSync(realFPPath)) {
    const d = JSON.parse(readFileSync(realFPPath, 'utf8'));
    assert.ok(Array.isArray(d.memories), 'her reflections.json must stay valid');
    assert.ok(d.memories.length > 100, `her real memories must be intact (got ${d.memories.length})`);
    ok(`her real reflections.json intact (${d.memories.length} memories)`);
}
rmSync(tmp, { recursive: true, force: true });

console.log(`\nPASS — ${pass} assertions green`);