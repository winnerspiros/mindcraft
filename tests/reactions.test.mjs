// Reactions are replies. "lol", "haha", "wtf" - a reaction to what he said is
// often the WHOLE reply, and it must not be filtered as contentless.
//
// The owner: "btw she can respond with feelings like laughter, mad etc. like the
// haha shit i said to her" and "lol for example".
//
// This file exists because the persona used to say the opposite. It claimed
// "lol/lmao are NOT how people talk here, do not lean on them" - which is not
// what the data says. Measured on 21,822 real player messages: 89 contain a
// reaction token (0.4%), lol 51, haha 26, lmao 4, omg 3, yikes 2, wtf 1. Rare,
// yes. Banned, no.

import { isEmptyAck } from '../src/utils/empty_ack.js';
import { isMirroredReply } from '../src/utils/mirror_reply.js';
import { scrubIdentitySlur } from '../src/utils/identity_slur.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const REACTIONS = [
    'lol', 'lmao', 'haha', 'hahaha', 'LOL', 'LmAo', 'omg', 'wtf', 'no way',
    'ffs', 'rip', 'bruh', 'yikes', 'xd', 'lmaooo', 'F in chat', 'KEKW',
];

// ── a reaction to something with a proposition is not an empty ack ──────
// "yeah" to a claim is consent, and "lol" to a claim is a reaction - neither
// is agreeing with nothing.
for (const ctx of ['you fell in lava', 'you got diamond', 'your build is on fire',
    'that mob killed you', 'i finished it']) {
    for (const r of REACTIONS) {
        check(!isEmptyAck(r, ctx), `${JSON.stringify(r)} passes as a reply to a real message`,
            `SUPPRESSED: ${JSON.stringify(r)} <- ${JSON.stringify(ctx)}`);
    }
}

// ...and a reaction to a bare greeting is also fine, because laughing IS an
// answer to "hi" in a way that "yeah" is not.
for (const r of ['lol', 'lmao', 'haha', 'xd']) {
    check(!isEmptyAck(r, 'hi'), `${JSON.stringify(r)} to a greeting is allowed`,
        `SUPPRESSED reaction to a greeting: ${JSON.stringify(r)}`);
}

// ── and it is not "mirroring" - a reaction shares no content words ──────
for (const r of REACTIONS) {
    check(!isMirroredReply(r, 'lol what did you do').mirrored,
        `${JSON.stringify(r)} is not a mirror`, `${JSON.stringify(r)} flagged as a mirror`);
}

// ── nothing scrubs it ───────────────────────────────────────────────────
for (const r of REACTIONS) {
    check(scrubIdentitySlur(r).clean, `${JSON.stringify(r)} survives the scrubber`,
        `scrubber mangled ${JSON.stringify(r)}`);
}

// ── the persona must ALLOW it, and say so ───────────────────────────────
{
    const fs = await import('node:fs');
    const p = JSON.parse(fs.readFileSync('personas/normal.json', 'utf8'));
    const c = p.conversing;
    check(/SHE REACTS/.test(c), 'the persona has a reactions section',
        'no reactions section in the persona');
    // The old ban read "lol/lmao are NOT how people talk here, do not lean on
    // them". I now QUOTE that sentence in the persona while explaining it was
    // wrong, so a naive substring test flags my own correction. The assertion is
    // that the ban is not stated as a rule - i.e. not followed by "do not".
    const bans = c.match(/(?:lol|lmao)[^.]*NOT how people talk[^.]*do not lean on them(?!\s*[,.]?\s*which is not)/gi) || [];
    check(!bans.length, 'the old BAN on lol/lmao is gone as a rule',
        `the persona still bans reactions: ${JSON.stringify(bans[0])}`);
    // the measured rate must be stated, not guessed
    check(/0\.4%|0,4%/.test(c), 'the persona cites the measured reaction rate',
        'no measured rate in the persona');
    // and the distinction that actually matters: reaction vs reaction-tic
    check(/tic|every time is a tic|reaction PLUS/i.test(c),
        'it warns against the tic rather than the reaction',
        'no warning against the tic');
    // examples must show it
    const replies = p.conversation_examples
        .map((m) => m.find((x) => x.role === 'assistant')?.content ?? '')
        .filter((a) => /^(lol|lmao|haha|omg|wtf|ffs|rip|yikes|lmfao)\b/i.test(a.trim()));
    check(replies.length >= 5, `${replies.length} examples reply with a bare reaction`,
        `only ${replies.length} examples do - she will not learn to react`);
}

// ── and the cap: rare, not sprayed. 0.4% of 21,822 = 89 messages. ──────
{
    // Sanity-bound the guidance rather than the model: the persona must not
    // tell her to use them often.
    const fs = await import('node:fs');
    const c = JSON.parse(fs.readFileSync('personas/normal.json', 'utf8')).conversing;
    check(!/use (them|reactions) (often|a lot|frequently)/i.test(c),
        'it does not tell her to use reactions often',
        'the persona encourages frequent reactions, contradicting the 0.4%');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} reaction assertions green`);