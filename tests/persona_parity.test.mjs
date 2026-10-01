// Capability parity between personas.
//
// RULE: yandere and normal must have IDENTICAL capabilities. She can do
// exactly the same actions in both. Only voice, framing and emotional
// baselines differ.
//
// This exists because I got it wrong: the first normal-mode sleep_together
// returned early, which quietly REMOVED an action from normal. Nothing else
// caught it, because "normal is calmer" felt true while a mode silently did
// nothing. Parity is a property, so it gets tested.
//
// Offline: no model, no writes. Checks config + source-level gates.

import assert from 'node:assert';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const { setSettings } = await import('../src/agent/settings.js');
const rootSettings = (await import('../settings.js')).default;

let pass = 0;
const ok = (n) => { console.log(`  ok - ${n}`); pass++; };

// --- 1. identical mode set --------------------------------------------------
const profile = JSON.parse(readFileSync('uwu.json', 'utf8'));
const enabled = Object.entries(profile.modes).filter(([, v]) => v).map(([k]) => k).sort();
assert.ok(enabled.length >= 10, `expected a real mode list, got ${enabled.length}`);
ok(`${enabled.length} modes enabled for both personas (modes are not persona-gated)`);

// persona-specific mode overrides in servers.json could break parity
const servers = JSON.parse(readFileSync('servers.json', 'utf8'));
for (const [name, s] of Object.entries(servers.servers || {})) {
    const m = s.modes || {};
    // A server MAY legitimately disable a mode (that is a server setting, not
    // a persona setting) - but flag it so it is a conscious choice.
    if (Object.keys(m).length) console.log(`  note: servers.json[${name}] overrides modes: ${JSON.stringify(m)}`);
}

// --- 2. no persona gate may remove an action --------------------------------
// Every isYandere() guard in modes.js must change FRAMING, not whether the
// mode runs. Catch the exact mistake: a bare `if (!isYandere()) return;`
// inside a mode's update() disables the whole action for normal.
const modesSrc = readFileSync('src/agent/modes.js', 'utf8');
const bareReturns = [...modesSrc.matchAll(/if \(!isYandere\(\)\)\s*return;/g)];
assert.strictEqual(
    bareReturns.length, 0,
    `modes.js has ${bareReturns.length} bare persona guard(s) that would disable an action ` +
    'in normal. Both personas must keep every capability - change framing instead.'
);
ok('no mode is disabled by persona (no bare `if (!isYandere()) return`)');

// framing must differ somewhere, or the guard is doing nothing at all
assert.ok(/yandere \? \[/.test(modesSrc), 'expected persona-specific opener lines');
assert.ok(/const yandere = isYandere\(\);/.test(modesSrc), 'expected mode to branch on persona');
ok('modes branch on persona for framing (opener lines / rates), not for capability');

// --- 3. relationship state is stored identically ----------------------------
// summarize() may relabel ranks for the prompt, but must not mutate stored
// state, or normal mode would slowly destroy her relationship data.
const relSrc = readFileSync('src/agent/relationship.js', 'utf8');
assert.ok(/DEMOTED/.test(relSrc), 'expected rank relabelling');
assert.ok(
    !/this\.players\[[^\]]+\]\.rank\s*=/.test(relSrc.split('summarize()')[1] || ''),
    'summarize() must not write to stored ranks'
);
ok('summarize() relabels for the prompt only, stored ranks untouched');

// --- 4. both personas resolve a usable prompt -------------------------------
const { personaPrompt, personality, personalityOverlay, resetServerContext, setServerContextOverride } = await import('../src/utils/server_context.js');
// personality() prefers the PER-SERVER override in servers.json over the
// settings.js value, so pinning only setSettings is not enough: a server
// configured for "normal" (which the home context now is) made every
// iteration below resolve to normal and the yandere case failed even though
// the code was fine. Pin the server override too, and restore it after.
const activeName = servers.active;
const activeSrv = servers.servers[activeName];
const savedServerPersonality = activeSrv ? activeSrv.personality : undefined;
for (const p of ['yandere', 'normal']) {
    setServerContextOverride({ personality: p });
    setSettings({ ...rootSettings, personality: p });
    resetServerContext();
    assert.strictEqual(personality(), p, `${p} should resolve`);
    const script = personaPrompt();
    const final = script || (profile.conversing + personalityOverlay());
    assert.ok(final && final.length > 500, `${p} prompt too short (${final && final.length})`);
    // a real, standalone script for normal; the profile for yandere
    if (p === 'yandere') assert.strictEqual(script, null, 'yandere should use the profile prompt verbatim');
    else assert.ok(script && script.length > 1500, 'normal should use its own standalone script');
}
ok('both personas produce a full-length chat prompt');

// --- 5. her real state is untouched ----------------------------------------
const refl = JSON.parse(readFileSync('bots/UwU/reflections.json', 'utf8'));
assert.ok(refl.memories.length > 100, `her memories must be intact (${refl.memories.length})`);
ok(`her reflections.json intact (${refl.memories.length} memories)`);

if (activeSrv) {
    if (savedServerPersonality === undefined) delete activeSrv.personality;
    else activeSrv.personality = savedServerPersonality;
}
setServerContextOverride(null);
resetServerContext();
setSettings(rootSettings);
console.log(`\nPASS — ${pass} parity assertions green`);
console.log('NOTE: this checks gates and config, not live behaviour.');
console.log('      Live persona parity (same actions, different voice) is tests/personality_probe.mjs');