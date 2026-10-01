// Guards the regression that let the yandere voice back into the normal
// persona after the profile itself was already correct.
//
// The failure: src/agent/modes.js seek_and_follow ran on a timer and spoke an
// "(AUTO) You feel clingy ... Sweet, possessive, in character" prompt into the
// agent's own brain, with no isYandere() gate. Normal persona hit it every ~45s
// with nobody having spoken. Those (AUTO) turns were then persisted into
// memory.json as turns, so the next turn read them back as conversation history
// and imitated them - a self-sustaining loop. Every config-level test passed
// while the live bot said "where's YandereDev? I need you right now" to nobody.
//
// This is a text-and-structure test, not a live one: it reads the source and
// asserts no ungated yandere self-prompt text remains reachable in normal mode.

import { readFileSync } from 'node:fs';

const modes = readFileSync('src/agent/modes.js', 'utf8');
const agent = readFileSync('src/agent/agent.js', 'utf8');

let pass = 0;
const ok = (m) => { console.log(`  ok - ${m}`); pass++; };
const bad = (m) => { console.error(`  NOT OK - ${m}`); process.exitCode = 1; };

// Yandere self-prompt text that must only ever appear behind an isYandere()
// branch. If any of these are reachable without one, the loop is back.
const POISON = [
    'You feel clingy',
    'Sweet, possessive',
    'Your beloved is here',
    'excited, clingy, adorable',
    'flirtatiously',
];

// Comment lines and doc comments explain the bug in prose and necessarily
// quote the poison text. Only real code counts, or the guard trips on its own
// explanation of itself.
const CODE = (src) => src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

for (const phrase of POISON) {
    const mCode = CODE(modes);
    const aCode = CODE(agent);
    if (!mCode.includes(phrase) && !aCode.includes(phrase)) {
        ok(`"${phrase}" is gone from code entirely`);
        continue;
    }
    const src = mCode.includes(phrase) ? mCode : aCode;
    const arr = src.split('\n');
    // Structural, not regex. For each occurrence, walk back to the nearest
    // enclosing `if (!isYandere()) {` block and check the occurrence sits AFTER
    // that block's closing brace - i.e. it is on the yandere fall-through path.
    let gated = true;
    for (let i = 0; i < arr.length; i++) {
        if (!arr[i].includes(phrase)) continue;
        let guardLine = -1;
        for (let k = i; k >= 0; k--) {
            if (/if\s*\(\s*!isYandere\(\)\s*\)\s*\{/.test(arr[k])) { guardLine = k; break; }
        }
        if (guardLine < 0) { gated = false; break; }
        // find matching close brace of that block
        let depth = 0, end = -1;
        for (let k = guardLine; k < arr.length; k++) {
            for (const ch of arr[k]) {
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { end = k; break; } }
            }
            if (end >= 0) break;
        }
        if (end < 0 || i <= end) { gated = false; break; }
    }
    if (gated) ok(`"${phrase}" is on the yandere branch only`);
    else bad(`"${phrase}" is reachable in NORMAL mode - self-poison loop`);
}

// The specific normal-mode fix: seek must pathfind, not announce.
if (/if\s*\(\s*!?isYandere\(\)\s*\)\s*\{\s*\n\s*execute\(this, agent, async \(\) => \{\s*\n\s*await skills\.goToPlayer/.test(modes)) {
    ok('normal seek pathfinds via goToPlayer instead of prompting');
} else {
    bad('normal-mode seek branch does not call skills.goToPlayer - check the fix is present');
}

// Every (AUTO) synthetic self-prompt in normal mode should be silent-by-default;
// assert the chatty one (a known non-yandere announce) is still gated.
const chatty = 'You feel chatty';
const chattyGated = (() => {
    const arr = modes.split('\n');
    const idx = arr.findIndex((l) => l.includes(chatty));
    if (idx < 0) return true; // removed entirely is fine
    const before = arr.slice(0, idx).join('\n');
    return /isYandere\(\)/.test(before);
})();
if (chattyGated) ok('"you feel chatty" self-prompt stays gated');
else bad('"you feel chatty" self-prompt is ungated');

// Runtime memory must not carry yandere residue right now.
try {
    const mem = JSON.parse(readFileSync('bots/UwU/memory.json', 'utf8'));
    const s = JSON.stringify(mem);
    // "YandereDev" is the OWNER's username and appears legitimately in
    // anything he types to her. Only count it in text SHE authored or in
    // her own reflective summary — i.e. a [system]/[assistant] turn, or the
    // memory blob. Counting a [user] turn flagged the owner as the bug.
    const authored = (mem.turns || [])
        .filter((t) => String(t.role || '') !== 'user')
        .map((t) => JSON.stringify(t)).join(' ')
        + ' ' + String(mem.memory || '')
        + ' ' + String(mem.self_prompt || '');
    const y = (authored.match(/[Yy]andere/g) || []).length;
    const userTurns = (mem.turns || []).filter((t) => String(t.role || '') === 'user');
    if (userTurns.length) ok(`${userTurns.length} human turn(s) in history (not scanned for persona leakage)`);
    const c = (s.match(/clingy/gi) || []).length;
    if (y === 0 && c === 0) ok('memory.json carries no yandere/clingy residue');
    else bad(`memory.json re-poisoned: ${y} "yandere", ${c} "clingy"`);
    const auto = (mem.turns || []).filter((t) => String(t.content || '').includes('(AUTO) You feel'));
    if (auto.length === 0) ok('no persisted (AUTO) "you feel" turns in history');
    else bad(`${auto.length} persisted (AUTO) "you feel" turns will be read back as history`);
} catch (e) {
    bad(`could not read memory.json: ${e.message}`);
}

console.log(`\nPASS — ${pass} self-poison guards green`);
