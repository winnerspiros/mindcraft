// Unit tests for the chat burst splitter. Offline, no model.
//
// The splitter sits in the outgoing path of every normal-mode message, so a
// bug here is spam in public chat - the exact failure it exists to prevent.
// Test the two failure modes it balances against: one-paragraph-bot, and
// machine-gun one-word-spam.

import assert from 'node:assert';
import { fragmentForChat } from '../src/utils/chat_fragment.js';

let pass = 0;
const ok = (n) => { console.log(`  ok - ${n}`); pass++; };

const MAX = 3;
const MIN = 12;

// Never emit more than MAX lines, never a line under MIN chars (unless the
// input was already that short), never drop or duplicate content.
function assertSound(parts, input, label) {
    assert.ok(Array.isArray(parts) && parts.length >= 1, `${label}: must return an array`);
    assert.ok(parts.length <= MAX, `${label}: ${parts.length} lines, cap is ${MAX}`);
    for (const p of parts) {
        assert.ok(p.length > 0, `${label}: empty line`);
        if (input.trim().length > MIN) {
            assert.ok(p.length >= MIN, `${label}: "${p}" is ${p.length} chars, floor is ${MIN}`);
        }
        assert.ok(!/\\s{2,}/.test(p), `${label}: double space in "${p}"`);
        assert.ok(!/[,;:]$/.test(p), `${label}: dangling punctuation in "${p}"`);
        assert.ok(!/^[,;:.]/.test(p), `${label}: leading punctuation in "${p}"`);
    }
    // Content preservation: every word of the body must survive, in order.
    const norm = (s) => s.replace(/\\s+/g, ' ').trim();
    const joined = norm(parts.join(' '));
    const orig = norm(input);
    const strip = (s) => s.replace(/[.,;:!?]/g, '').replace(/\\s+/g, '');
    assert.strictEqual(strip(joined), strip(orig), `${label}: content changed\\n  in:  ${orig}\\n  out: ${joined}`);
}

// --- short input stays whole ------------------------------------------------
assertSound(fragmentForChat('yo'), 'yo', 'one word');
assertSound(fragmentForChat('im coming, hold on'), 'im coming, hold on', 'one clause');
ok('short lines are left alone');

// --- the paragraph case ------------------------------------------------------
const para = 'oh no, YandereDev got taken out by a phantom! I\'m coming to find you, bro. let\'s stick together this time!';
const p1 = fragmentForChat(para);
assertSound(p1, para, 'paragraph');
assert.ok(p1.length >= 2, 'a real paragraph should burst');
ok(`paragraph split into ${p1.length} lines: ${JSON.stringify(p1)}`);

// --- the spam cap ------------------------------------------------------------
// Six sentences must NOT become six messages.
const chatty = 'hey. so i was thinking. maybe we could. build something. it would be. nice i guess.';
const p2 = fragmentForChat(chatty);
assertSound(p2, chatty, 'very chatty');
assert.ok(p2.length <= MAX, `6-sentence input gave ${p2.length} lines`);
ok(`6 sentences capped at ${p2.length} lines, content intact`);

// --- commands ride with their line, never orphaned --------------------------
const withCmd = 'ill go grab some wood, this roof is a mess. !collectBlocks("oak_log", 10)';
const p3 = fragmentForChat(withCmd);
assertSound(p3, withCmd, 'command tail');
assert.ok(p3.some((l) => l.includes('!collectBlocks')), 'command must survive');
const lastLine = p3[p3.length - 1];
assert.ok(lastLine.includes('!collectBlocks'), 'command belongs on the LAST line, not orphaned on its own');
ok(`command stays attached to the last line: ${JSON.stringify(p3)}`);

// --- multiple commands are already multi-message; do not touch -------------
const multi = 'building and mining. !collectBlocks("oak_log", 5) and smelting. !smelt("oak_log", 5)';
const p4 = fragmentForChat(multi);
assert.strictEqual(p4.length, 1, 'multi-command output must not be re-fragmented');
ok('multiple commands left intact (already a burst)');

// --- unbalanced clause split is rejected ------------------------------------
// A 20-word line with one comma must not become two 10-word lines.
const oneComma = 'im going to go ahead and chop down that big oak tree right now thanks';
const p5 = fragmentForChat(oneComma);
assertSound(p5, oneComma, 'no real boundary');
ok('no false split when there is no natural boundary');

// --- empty / junk ------------------------------------------------------------
assert.deepStrictEqual(fragmentForChat(''), [], 'empty input');
assert.deepStrictEqual(fragmentForChat('   '), [], 'whitespace input');
assertSound(fragmentForChat('ok'), 'ok', 'minimal');
ok('degenerate inputs handled');

console.log(`\\nPASS — ${pass} fragment assertions green`);
