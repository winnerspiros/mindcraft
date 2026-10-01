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
// "you feel chatty" was still injected on a timer in normal mode and PERSISTED
// into memory.json, where the next turn read it back as a reason to speak. It
// was found there live, after surviving a restart. Must be gated on the input
// side, not merely suppressed at the output side.
// A stale "(AUTO) You feel chatty" turn WAS found in memory.json, surviving a
// restart. It is persisted as history, so the next turn reads it back as a
// reason to speak — the same data-loop shape as the clingy prompt.
//
// It is not fixed by a bare persona return (persona_parity.test.mjs rejects
// that: both personas keep every capability). It is fixed by the trigger gate
// in conversation_starter's update(), which requires a real reason — someone
// spoke recently, a notable event, or she was addressed by name — before the
// self-prompt is emitted at all. So assert THAT gate exists.
const chatty = 'You feel chatty';
const code = CODE(modes);
const chattyCtx = (() => {
    const idx = code.indexOf(chatty);
    return idx < 0 ? '' : code.slice(Math.max(0, idx - 9000), idx);
})();
const triggerGate = /recentlySpokeTo/.test(chattyCtx)
    && /eventWorthSaying/.test(chattyCtx)
    && /addressedByName/.test(chattyCtx)
    && /if\s*\(!recentlySpokeTo\s*&&\s*!eventWorthSaying\s*&&\s*!addressedByName\)/.test(chattyCtx);
if (chattyCtx === '' || triggerGate) ok('"you feel chatty" requires a real trigger (recent msg / notable event / named)');
else bad('"you feel chatty" is emitted without a real trigger gate - it persists as history');

// The gate above is necessary but was not sufficient. A live "(AUTO) You feel
// chatty" turn still landed in memory.json because the gate correctly fired -
// the player had said "hey uwu", so she WAS addressed - and then the prompt
// itself carried yandere wording into a turn that gets persisted as history.
// Assert the normal branch does not EMIT that phrasing at all.
const chattyEmit = code.slice(Math.max(0, code.indexOf(chatty) - 400),
    code.indexOf(chatty) + 200);
const normalPhrasingOk = !/handleMessage\('system',\s*`\(AUTO\) You feel chatty/.test(chattyEmit)
    || /isYandere\(\)\s*\?/.test(chattyEmit);
if (normalPhrasingOk) ok('normal mode does not emit the "you feel chatty" self-prompt verbatim');
else bad('normal mode still emits "(AUTO) You feel chatty" - the wording itself is yandere residue');

// And normal must not lose the mode entirely.
if (/if\s*\(!isYandere\(\)\)\s*return;/.test(CODE(modes)))
    bad('bare persona return disables a mode for normal');
else ok('no bare persona return disables a mode for normal');

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
    // Count persona WORDING, not the substring "yandere". "YandereDev" is the
    // owner's username and appears legitimately in system turns reporting who is
    // nearby, so a bare substring scan flags correct behaviour — it just did,
    // and it had failed the same way before: excluding only [user] turns is not
    // enough, because "(AUTO) ... YandereDev is nearby" is a system turn she is
    // supposed to emit. What must never appear is the yandere VOICE.
    const y = (authored.match(/you feel (chatty|clingy|lonely|possessive)|clingy|possessive|your beloved|bound to you/gi) || []).length;
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
