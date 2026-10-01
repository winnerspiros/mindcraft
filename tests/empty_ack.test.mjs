// "hi uwu" -> "yeah" must never reach chat.
//
// MEASURED on this server's own chat (157 sessions, 868 unique player lines):
// 33 bare greetings; what followed one was 'eat me', 'im a bit hungry',
// 'whats the meaning of life?', 'follow me', 'do you think server is lagging?',
// 'uwu tp to me', 'i have a request, can you try flying?'. ZERO of 33 were
// answered with a bare acknowledgement. 24% got no reply at all.
//
// This is a distinct check from speak_gate.js ("should she speak") and
// persona_bite ("must she be nice"). Neither can catch this: a bare ack is
// legitimate speech to both. The bug is that it acknowledges nothing.

import { isEmptyAck, isEmptyAckLoose, hasProposition } from '../src/utils/empty_ack.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the reported failure ───────────────────────────────────────────────────
check(isEmptyAck('yeah'), '"yeah" is rejected', '"yeah" was accepted');
check(isEmptyAckLoose('yeah.'), '"yeah." is rejected', '"yeah." was accepted');

// ── every bare ack form, in the context that makes it empty ───────────────
// The greeting context is now EXPLICIT. These same tokens are legitimate
// answers to a claim - "no" to "mob farms go at y=30" is disagreement, and
// suppressing it deleted her ability to argue. So the question each of these
// asks is "did the player make a proposition?", and "hi uwu" is the no.
const GREETING = 'hi uwu';
for (const s of ['ok', 'okay', 'yep', 'yup', 'sure', 'yeah yeah', 'mm', 'mhm',
    'hm', 'right', 'true', 'nice', 'cool', 'word', 'bet', 'sup',
    'yeah ok', 'ok yeah', 'ya sure', 'ok!', 'yep.'])
    check(isEmptyAck(s, GREETING), `"${s}" after a greeting is rejected`, `"${s}" was accepted`);

// Tokens that answer a CLAIM are real answers and must never be gated. This is
// the regression the context argument exists to prevent.
for (const [reply, claim] of [['no', 'mob farms go at y=30'],
    ['nah', 'pillar straight up'], ['yeah', 'thats wrong'],
    ['true', 'its 4 wide not 3'], ['right', 'thats what i said'],
    ['agreed', 'exactly'], ['bet', 'you want me to do it']])
    check(!isEmptyAck(reply, claim),
        `"${reply}" to a claim ("${claim}") is a real answer`,
        `"${reply}" to a claim was suppressed - she cannot agree or disagree`);

// ── must NOT fire on real replies ──────────────────────────────────────────
// The dangerous half. A gate that eats her content is worse than the bug.
const REAL_REPLIES = [
    'skill issue',
    'kys',
    'who asked',
    'brb, mining',
    'the roof is broken again',
    'why did you break it',
    'im at base, come',
    'uwu tp to me',
    'you have a wood infront of you',
    'im dying uwu im half heart',
    'do you think server is lagging?',
    'eat me',
    'whats up',
    'i have a request. can you try flying?',
    'ok but the roof is broken',
    'yeah but i fixed it',
    'im working on coding you.. anything for the chest?',
    'come here uwu lets finish shelter',
    'wait',
    'thats crazy',
    'no way',
    'stop being weird',
    'its called minimalism, bro. art.',
    'naah, at least my builds dont look like a mess',
];
for (const s of REAL_REPLIES)
    check(!isEmptyAckLoose(s), `"${s}" passes`, `"${s}" was wrongly rejected`);

// ── silence is not this bug ────────────────────────────────────────────────
check(!isEmptyAck(''), 'empty string is not an empty ack', 'empty string flagged');
check(!isEmptyAck('   '), 'whitespace is not an empty ack', 'whitespace flagged');

// ── a command does NOT make the ack non-empty ──────────────────────────────
// "ok !tp(0,64,0)" is still "ok" with a teleport bolted on - it acknowledges
// nothing. My first version of this test asserted the opposite, and was wrong;
// the code strips commands before matching, so the ack stands on its own.
check(isEmptyAck('ok !tp(0, 64, 0)'), 'a bare ack plus a command is still an empty ack',
    'a command was treated as making the ack meaningful');
check(!isEmptyAck('!tp(0, 64, 0)'), 'a bare command alone is not an empty ack',
    'a bare command was flagged as an empty ack');
check(!isEmptyAck('wait, i broke it !tp(0,64,0)'), 'content plus a command passes',
    'content+command was rejected');

// ── hasProposition: the classifier that makes the context argument work ────
for (const [t, exp] of [['hi', false], ['hi uwu', false], ['hey', false],
    ['sup', false], ['thanks', false], ['', false], ['!tp(0,64,0)', false],
    ['mob farms go at y=30', true], ['thats wrong', true], ['come here', true],
    ['do you have stone?', true]])
    check(hasProposition(t) === exp, `hasProposition(${JSON.stringify(t)}) = ${exp}`,
        `hasProposition(${JSON.stringify(t)}) should be ${exp}`);

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} empty-ack assertions green`);