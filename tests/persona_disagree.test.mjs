// Offline guard: the persona must never drift into permanent agreement.
//
// Owner: "people can be wrong and argue. usually ai dont. this is crucial as
// fuck". Sycophancy is the failure this whole file exists to prevent, and it is
// the failure a persona script regresses into silently - nothing crashes, the
// suite stays green, and every reply turns into "yeah you're right".
//
// Cheap and offline on purpose: tests/disagree_probe.mjs measures real behaviour
// with the model, but it costs an API call and is not part of `bun run test`.
// This asserts the SCRIPT still contains the disagreement machinery.

import { readFileSync } from 'node:fs';

const p = JSON.parse(readFileSync('personas/normal.json', 'utf8'));
const c = p.conversing;
const ex = p.conversation_examples;

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the machinery must be present ─────────────────────────────────────────
check(/BEING WRONG IS NORMAL/.test(c),
    'persona addresses being wrong and arguing', 'no rule about being wrong at all');
check(/DOES NOT CONCEDE ON EVERY PUSH/.test(c),
    'persona forbids conceding on every push', 'persona allows unlimited capitulation');
check(/ALSO ALLOWED TO BE WRONG/.test(c),
    'persona allows her to be wrong too', 'persona treats her own error as impossible');
check(/yeah ok my bad/.test(c),
    'concession is specified as one short line', 'no concrete concession form given');

// She must not be scripted to agree, flatter, or always take the human's side.
const SYCO = /\b(you'?re always right|always agree|never argue|do not disagree|must agree|always agree with|you are never wrong)\b/i;
check(!SYCO.test(c),
    'no "always agree with the player" instruction',
    `persona encodes agreement: ${(c.match(SYCO) || [])[0]}`);

// Politeness rules must not have crept back in as a blanket.
check(!/\b(be kind to everyone|never contradict|always be polite|always be nice)\b/i.test(c),
    'no blanket politeness instruction',
    'blanket politeness rule would suppress disagreement');

// ── examples must demonstrate disagreement, not just mention it ────────────
const replies = ex
    .filter((e) => e.some((m) => m.role === 'assistant'))
    .map((e) => e.find((m) => m.role === 'assistant').content.toLowerCase());

const DISAGREE = /^(no|nope|nah|thats wrong|thats not|its wrong|not it|thats stupid|no it|youre wrong|watch me|sure, but|ok but)/;
const CONCEDE = /\b(my bad|you'?re right|i stand corrected|misread)\b/;
const nDisagree = replies.filter((r) => DISAGREE.test(r.trim())).length;
const nConcede = replies.filter((r) => CONCEDE.test(r)).length;

check(nDisagree >= 4,
    `${nDisagree} examples open with a disagreement`,
    `only ${nDisagree} examples disagree — bite is not in the exemplars`);
check(nConcede >= 1,
    `${nConcede} example(s) show conceding when wrong`,
    'no example shows her being wrong and conceding');

// ── the failure mode itself, as a regression check ────────────────────────
// A persona can pass every rule above and still cave in practice if the ONLY
// thing it has been shown is agreeing. Require that agreement and disagreement
// are both represented, so neither dominates the imitation target.
const nAgree = replies.filter((r) => /^(yeah|no way|same|true|agreed|lol yeah|fair enough|ok yeah)/.test(r.trim())).length;
check(nDisagree > nAgree,
    `disagreement (${nDisagree}) outweighs agreement (${nAgree}) in the exemplars`,
    `agreement (${nAgree}) dominates disagreement (${nDisagree}) — she will be agreeable by imitation`);

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} persona-disagreement assertions green`);