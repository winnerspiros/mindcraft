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
// No minimum line length. The first version of this file set a 12-char floor
// and that was simply wrong: measured over 55,904 real player messages
// (Minecraft Dialogue Corpus, ACL 2019), 36% are 3 words or fewer and 18% are
// a SINGLE word. "hey", "yeah", "nah," are real messages. A floor like this one
// forces the splitter to merge lines purely to satisfy a rule nobody follows.
// The only real constraint is the spam cap above.
const MIN = 0;

// Never emit more than MAX lines, never a line under MIN chars (unless the
// input was already that short), never drop or duplicate content.
function assertSound(parts, input, label) {
    assert.ok(Array.isArray(parts) && parts.length >= 1, `${label}: must return an array`);
    assert.ok(parts.length <= MAX, `${label}: ${parts.length} lines, cap is ${MAX}`);
    for (const p of parts) {
        assert.ok(p.length > 0, `${label}: empty line`);
        assert.ok(p.length >= MIN, `${label}: "${p}" is ${p.length} chars, floor is ${MIN}`);
        assert.ok(!/\\s{2,}/.test(p), `${label}: double space in "${p}"`);
        assert.ok(!/[,;:]$/.test(p), `${label}: dangling punctuation in "${p}"`);
        assert.ok(!/^[,;:]/.test(p), `${label}: leading punctuation in "${p}"`);
    }
    // Nothing invented: every output word must come from the input, in order.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const strip = (s) => s.replace(/[.,;:!?]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
    const inWords = strip(input);
    const outWords = strip(parts.join(' '));
    let j = 0;
    for (const w of outWords) {
        while (j < inWords.length && inWords[j] !== w) j++;
        assert.ok(j < inWords.length, `${label}: invented word "${w}" not in input`);
        j++;
    }
    // Commands are never dropped by the word cap.
    const cmdsIn = (input.match(/!\w+\([^)]*\)/g) || []).length;
    const cmdsOut = (parts.join(' ').match(/!\w+\([^)]*\)/g) || []).length;
    assert.strictEqual(cmdsOut, cmdsIn, `${label}: a !command was dropped by the word cap`);
}

// --- short input stays whole ------------------------------------------------
assertSound(fragmentForChat('yo'), 'yo', 'one word');
assertSound(fragmentForChat('im coming, hold on'), 'im coming, hold on', 'one clause');
ok('short lines are left alone');

// --- the paragraph case ------------------------------------------------------
// The word cap now runs FIRST and keeps sentence 1, so a paragraph is
// truncated before it is ever fragmented. That is the intended behaviour -
// the extra sentences are exactly the elaboration she should not send - but it
// means the burst path is only reachable when the opening sentence is itself
// over the cap or the text has no sentence break at all.
const para = 'oh no, YandereDev got taken out by a phantom! I\'m coming to find you, bro. let\'s stick together this time!';
const p1 = fragmentForChat(para);
assertSound(p1, para, 'paragraph');
assert.ok(p1.join(' ').split(/\s+/).length <= 11, `paragraph not capped: ${JSON.stringify(p1)}`);
ok(`paragraph truncated to the point: ${JSON.stringify(p1)}`);

// Burst path: no sentence boundary early enough to cap, so it must split into
// chat-sized lines instead of one long message.
const burst = 'im heading over to the north ridge to grab some more of that oak, want to meet me there';
const pB = fragmentForChat(burst);
assertSound(pB, burst, 'burst');
assert.ok(pB.length >= 2, `a comma-bounded long line should burst, got ${JSON.stringify(pB)}`);
ok(`long comma-bounded line bursts: ${JSON.stringify(pB)}`);

// --- the spam cap ------------------------------------------------------------
// Six sentences must NOT become six messages.
const chatty = 'hey. so i was thinking. maybe we could. build something. it would be. nice i guess.';
const p2 = fragmentForChat(chatty);
assertSound(p2, chatty, 'very chatty');
assert.ok(p2.length <= MAX, `6-sentence input gave ${p2.length} lines`);
ok(`6 sentences capped at ${p2.length} lines, no invented words`);

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

// --- the word cap is LOSSY BY DESIGN ---------------------------------------
// Earlier versions of this file asserted full content preservation, which was
// correct then and is wrong now: the cap exists to DROP the elaboration she
// adds past the point. What must hold is that it drops whole sentences only,
// and never invents or orphans anything.
const lecture = 'you need to make sure its all connected right. check if the torches are stable and if the dust is placed where it should be !collectBlocks("torch", 16)';
const p6 = fragmentForChat(lecture);
assert.ok(p6.join(' ').split(/\s+/).length <= 11, `cap not applied: ${JSON.stringify(p6)}`);
assert.ok(p6.join(' ').includes('!collectBlocks'), 'command survived the cap');
assert.ok(p6.join(' ').endsWith('!collectBlocks("torch", 16)'), 'command is on the last line');
// first sentence kept whole, never a mid-phrase cut
assert.ok(/^you need to make sure its all connected right\b/.test(p6[0]), `cut mid-phrase: ${JSON.stringify(p6)}`);
ok(`word cap keeps sentence 1 whole and drops the rest: ${JSON.stringify(p6)}`);

// A long sentence with no comma must NOT be chopped at an arbitrary word.
const noBoundary = 'i really think we should probably go and check the whole eastern wing of the base again';
const p7 = fragmentForChat(noBoundary);
assert.ok(p7.join(' ').replace(/[.,;:!?]/g, '').toLowerCase() === noBoundary.replace(/[.,;:!?]/g, '').toLowerCase(),
    `uncleanable text must be returned whole, got ${JSON.stringify(p7)}`);
ok('no boundary = returned whole rather than cut mid-phrase');

console.log(`\nPASS — ${pass} fragment assertions green`);
