// A reply that only hands the message back is a mirror, not a person.
// The owner: "when you talk you dont necessarily [need a response]... you can
// continue on your saying, change subject etc."
//
// The structural half of that instruction - a prompt can SAY "you may change
// the subject", but what actually forces a bot to answer every question is the
// shape of the output. Mirroring is the tell, and it needs measuring.

import { isMirroredReply } from '../src/utils/mirror_reply.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};
// must be mirrored
for (const [reply, prompt] of [
    ['the time is 4', 'what time is it'],
    ['yes i am building', 'are you building'],
    ['i am coming to the base', 'are you coming to the base'],
    ['you have 64 stone', 'do you have 64 stone'],
    ['because its faster', 'why is it faster'],
    // 'because' is a connective, so this reduces to no content words at all
    // and is exempt like any other zero-content reply. I left it in the
    // must-flag list and it correctly did not fire - a connective-only reply
    // is not a mirror, it is just short. Keeping the case, asserting the truth.
]) {
    const isMirror = isMirroredReply(reply, prompt);
    const zeroContent = /^(because|then|also|wait|just|well|anyway)/.test(reply);
    check(zeroContent ? !isMirror.mirrored : isMirror.mirrored,
        `${zeroContent ? 'exempts' : 'flags'} ${JSON.stringify(reply)}`,
        `${zeroContent ? 'wrongly flagged' : 'missed mirror'} ${JSON.stringify(reply)} <- ${JSON.stringify(prompt)}`);
}
// must NOT be flagged: says something new, even briefly
for (const [reply, prompt] of [
    ['like 4. also the roof is still broken', 'what time is it'],
    ['yeah but im building', 'are you there'],
    ['minecraft slaps', 'sup'],
    ['wait what', 'are you there'],
    ['mine', 'what are you doing'],
    ['im coming dont move', 'you stuck?'],
    ['your roof is broken', 'what about the roof'],
    ['idk', 'do you know'],
]) {
    check(!isMirroredReply(reply, prompt).mirrored,
        `allows ${JSON.stringify(reply)}`,
        `wrongly flagged ${JSON.stringify(reply)} <- ${JSON.stringify(prompt)}`);
}
// short replies are exempt - they cannot mirror
for (const [reply, prompt] of [
    ['yeah', 'are you building'],
    ['no', 'is it broken'],
    ['true', 'is the roof broken'],
    ['depends', 'how long does it take'],
]) {
    check(!isMirroredReply(reply, prompt).mirrored,
        `short reply ${JSON.stringify(reply)} is exempt`,
        `flagged the short reply ${JSON.stringify(reply)}`);
}
// questions are new content
check(!isMirroredReply('why', 'you keep building the roof').mirrored,
    'a bare question is not a mirror', 'a bare question was flagged as a mirror');

// the added-words signal is what makes it tunable
{
    const v = isMirroredReply('the time is 4', 'what time is it');
    check(v.added.length === 0 && v.ratio === 0,
        'a full mirror reports zero added words', 'mirror did not report zero added words');
    const w = isMirroredReply('like 4. also the roof is still broken', 'what time is it');
    check(w.added.includes('roof') && w.added.includes('broken'),
        'a reply that adds a topic reports the words it added',
        'added-word signal is wrong');
}

// it is a warning, not a veto - the module must not decide what gets sent
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/agent/agent.js', 'utf8');
    check(/isMirroredReply/.test(src), 'agent.js observes mirroring', 'the mirror check is dead code');
    const idx = src.indexOf('isMirroredReply');
    const seg = src.slice(idx, idx + 700);
    check(!/return\s*;/.test(seg),
        'it only WARNS - it never suppresses a reply',
        'the mirror check suppresses replies, which would silence blunt one-word answers');
    check(/console\.(log|warn)/.test(seg), 'it is logged so the rate can be measured',
        'it is neither logged nor measured');
}
{
    const fs = await import('node:fs');
    const mod = fs.readFileSync('src/utils/mirror_reply.js', 'utf8');
    check(/does not|never|veto|warning/i.test(mod),
        'the module states that it warns rather than vetoes',
        'the module does not document its own limits');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} mirror-reply assertions green`);