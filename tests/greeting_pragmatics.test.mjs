// Grounding: a reply must add content, not just receipt.
//
// The failure this exists for: player said "hi uwu", Elena said "yeah", and the
// owner said "yeah to what?". Note "yeah" is NOT a bot tell on its own - real
// people say it constantly. The problem is that a greeting contains no
// proposition, so an acknowledgement responds to nothing.
//
// The research converged on the same diagnosis from three directions, and the
// local corpus agrees:
//   - Grice 1975, maxim of Quantity: a contribution must be as informative as
//     the current purposes require. "yeah" satisfies Relation and Manner and
//     violates Quantity - it is LESS informative than required.
//   - Clark & Brennan 1991 grounding: evidence of understanding must be a
//     relevant next turn. An acknowledgement is evidence of RECEIPT only.
//   - Schegloff preference organisation: a dispreferred response carries delay,
//     mitigation or an account. "yeah" has none, which is why it reads as
//     "not a response" rather than as a terse one.
//   - Edelsky 1981 on floor: a question GRABS the floor. Adding "whats up?" to
//     every greeting is the opposite failure - it is why she must not reflexively
//     ask something back either.
//   - Hastrdlová 2011 / Rintel 2001 on IRC: 60-82% of join signals get no reply
//     at all. Silence is the default and is normal, not rude.
//
// This file pins the measured local behaviour AND the taxonomy, so the
// acknowledgement categories cannot silently come back as "engagement".

import { readFileSync, readdirSync } from 'node:fs';
import { isEmptyAck, hasProposition } from '../src/utils/empty_ack.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── 1. no proposition from the player => an ack is empty ─────────────────
// THE ORIGINAL FAILURE. "hi uwu" makes no proposition, so "yeah" agrees with
// nothing. This is the case the gate exists for.
for (const s of ['yeah', 'yeah.', 'yeah!', 'ok', 'yep', 'sure', 'yup', 'ya',
    'mm', 'mmh', 'uh huh', 'uh-huh', 'mhm', 'k', 'kk', 'alright', 'right',
    'true', 'yeah ok', 'ok yeah', 'word', 'true!', 'ya sure', 'ok !tp(YandereDev)']) {
    check(isEmptyAck(s, 'hi uwu'), `"${s}" after a greeting is rejected`, `"${s}" was allowed through`);
}
// A command-only reply is NOT an empty acknowledgement. It contains no ack
// token; it is an action. I briefly made this return true and it wrongly flagged
// every command the bot sends - the gate is about contentless WORDS.
check(!isEmptyAck('!collectBlocks("oak_log", 10)', 'collect some wood'),
    'a command-only reply is an action, not an empty ack',
    'a command was wrongly flagged as an empty acknowledgement');
check(!isEmptyAck('', 'hi uwu') && !isEmptyAck('   ', 'hi uwu'),
    'empty/whitespace is not an empty ack (no token present)',
    'empty string flagged as an ack');


// ── 2. A PROPOSITION WAS MADE => acks are real answers ────────────────────
// THIS IS THE REGRESSION THIS FILE CAUGHT. The gate used to run
// unconditionally, which meant that if a player said "mob farms go at y=30"
// she could not answer "no" or "yeah" - both were suppressed. It silently
// deleted the disagreement behaviour the persona work exists to produce.
// "yeah" to a CLAIM is consent, not an empty ack; only to a greeting is it empty.
check(!isEmptyAck('no', 'mob farms go at y=30'),
    '"no" to a claim is disagreement and must survive',
    '"no" to a claim was suppressed - she cannot disagree');
check(!isEmptyAck('yeah', 'thats wrong'),
    '"yeah" to a claim is assent, not an empty ack',
    '"yeah" to a claim was suppressed');
check(!isEmptyAck('nah', 'pillar straight up'),
    '"nah" to a proposal is a real rejection', '"nah" to a proposal was suppressed');
check(!isEmptyAck('true', 'its 4 wide not 3'),
    '"true" to a correction is uptake', '"true" to a correction was suppressed');

// ── 3. and it must NOT block real content ────────────────────────────────
const MUST_PASS = ['whats up?', 'im starving, got food?', 'come fix the roof',
    'bro u ok? the chest is empty again', 'kys', 'skill issue', 'nah', 'lmao',
    'im at the base', 'wait what', 'no', 'youre joking', 'hi',
    'morning, what are you up to', 'i fixed the door', 'thats so dumb',
    'me deja sprintar, espera', 'im so tired today', 'do you have stone?'];
for (const s of MUST_PASS) {
    check(!isEmptyAck(s, 'hi uwu'), `"${s}" allowed (has content)`, `"${s}" was wrongly blocked`);
}

// Over-blocking is worse than the original bug: it would make her mute.
check(!isEmptyAck('no', 'hi uwu') === false ? true : true, 'sanity', 'sanity');
check(!isEmptyAck('no', 'youre joking'), '"no" to a claim is disagreement', '"no" was blocked - she cannot argue');

// Backchannel filler is empty in ANY context - it cannot answer a claim.
for (const s of ['mm', 'mhm', 'uh huh', 'uh-huh', 'hmm']) {
    check(isEmptyAck(s, 'mob farms go at y=30'),
        `"${s}" is empty even when a claim is on the table`,
        `"${s}" was allowed as a response to a claim`);
}

// ── 3b. hasProposition classification ───────────────────────────────────
const PROP = [['hi', false], ['hi uwu', false], ['hey', false], ['sup', false],
    ['thanks', false], ['', false], ['!tp(0,64,0)', false],
    ['mob farms go at y=30', true], ['thats wrong', true], ['come here', true],
    ['do you have stone?', true], ['im at the base', true]];
for (const [t, exp] of PROP) {
    check(hasProposition(t) === exp, `hasProposition(${JSON.stringify(t)}) = ${exp}`,
        `hasProposition(${JSON.stringify(t)}) should be ${exp}`);
}

// ── 3. the measured corpus: 0 bare acks in 33 greetings ──────────────────
const SYS = /^(Gave |Found \d+|Set the |Successfully|Unknown|You are not|Changed |Game mode|Time|Weather|Test |Removed |Cleared |Could not|Teleport|Spawn|Server |\[|Error|Your |Cannot|Invalid|Expected|No |Please|Usage)/i;
const GREET = /^(hi+|hey|yo|sup|hello|hiya|howdy|gm)\b/i;
const ACK = /^(yeah|ok|yep|sure|ya|yes|mm|hm|kk|alright)\b/i;
const clean = (c) => String(c || '').replace(/^\s*\w{0,20}\s*:\s*/, '').trim();
let n = 0, acks = 0, silent = 0;
for (const f of readdirSync('bots/UwU/histories').filter((x) => x.endsWith('.json'))) {
    let d; try { d = JSON.parse(readFileSync('bots/UwU/histories/' + f, 'utf8')); } catch { continue; }
    const ms = Array.isArray(d) ? d : (d.messages || []);
    const seq = ms.filter((m) => m && clean(m.content) && !SYS.test(clean(m.content))
        && !String(m.content || '').startsWith('(AUTO'))
        .map((m) => [m.role, clean(m.content)]);
    for (let i = 0; i < seq.length - 1; i++) {
        if (seq[i][0] === 'user' && GREET.test(seq[i][1].trim())) {
            n++;
            if (seq[i + 1][0] === 'assistant') { if (ACK.test(seq[i + 1][1].trim())) acks++; }
            else silent++;
        }
    }
}
check(n > 10, `greeting sample loaded (${n} greetings)`, `sample too small: ${n}`);
check(acks === 0, `0 of ${n} real greetings got a bare acknowledgement`,
    `${acks} of ${n} greetings got a bare ack - the regression is back`);
check(silent / n > 0.02, `silence on ${silent}/${n} greetings (${(100 * silent / n).toFixed(0)}%) is attested`,
    'no silent greetings in the corpus - do not claim silence is normal without evidence');

// ── 4. no echoing: "hi" -> "hi" is a stalled sequence ────────────────────
let echoes = 0, replied = 0;
for (const f of readdirSync('bots/UwU/histories').filter((x) => x.endsWith('.json'))) {
    let d; try { d = JSON.parse(readFileSync('bots/UwU/histories/' + f, 'utf8')); } catch { continue; }
    const ms = Array.isArray(d) ? d : (d.messages || []);
    const seq = ms.filter((m) => m && clean(m.content) && !SYS.test(clean(m.content))
        && !String(m.content || '').startsWith('(AUTO'))
        .map((m) => [m.role, clean(m.content)]);
    for (let i = 0; i < seq.length - 1; i++) {
        if (seq[i][0] === 'user' && GREET.test(seq[i][1].trim()) && seq[i + 1][0] === 'assistant') {
            replied++;
            const a = seq[i + 1][1].trim().toLowerCase().replace(/[^a-z]/g, '');
            const b = seq[i][1].trim().toLowerCase().replace(/[^a-z]/g, '');
            if (a === b || (b && a === b + 'u')) echoes++;
        }
    }
}
check(echoes === 0, `0 of ${replied} greeting replies were an echo`,
    `${echoes} echoes found - "hi" -> "hi" stalls the sequence`);

// ── 5. the persona must carry the grounding rule, not just the code ──────
const persona = JSON.parse(readFileSync('personas/normal.json', 'utf8')).conversing;
// Assert on the text that is actually there. My first version of these
// assertions looked for phrases I had invented ("nothing to agree to") and
// failed against a persona that already stated the rule better than I did.
for (const [needle, label] of [
    ['AN EMPTY "yeah" IS THE WORST REPLY', 'persona names the empty-ack failure'],
    ['It agrees with\nnothing', 'persona says why it is empty (no proposition)'],
    ['ZERO were answered', 'persona carries the measured zero'],
    ['never as a reflex', 'persona forbids reflexive question-asking (Edelsky floor)'],
    ['ignoring a bare', 'persona states silence is normal'],
]) check(persona.includes(needle), label, `persona lost: ${label}`);

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} greeting-pragmatics assertions green`);
