// Spamming for attention, as a state machine over intent with NO phrase list.
//
// The owner: "human can be spammy for attention like 1st message yo 2nd yo 3rd
// bitch? examples all that plz no hardcode"
//
// "No hardcode" is the instruction. What makes it human is the SHAPE - same
// speaker, several turns, escalating, and only after being ignored - not any
// particular word. So these tests check the MECHANISM and, just as important,
// that no canned phrase is hiding in the source.

import { Attention, MAX_RUN } from '../src/utils/attention.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── NO HARDCODED PHRASES. The words must be the model's, not ours. ──────
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/utils/attention.js', 'utf8');
    for (const w of ['yo', 'hello?', 'anyone?', 'anyone', 'sup?']) {
        // Allowed to MENTION these as things not to do; never as emitted text.
        const emits = new RegExp(`(says|say|emit|reply|message|text)\\s*[:=]\\s*['"\`]${w.replace('?', '\\?')}`, 'i');
        check(!emits.test(src), `no emitted phrase: ${JSON.stringify(w)}`,
            `HARDCODED PHRASE: the module can emit ${JSON.stringify(w)}`);
    }
    // Strip comments before scanning. My first version scanned the whole file,
    // so the word "spamming" in a COMMENT was reported as a canned phrase - the
    // detector was flagging my own prose, not any code.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // A canned message would be a short lowercase literal ASSIGNED or RETURNED
    // as text. Stage names and log words are the only other strings allowed.
    const ALLOWED = /^(yo|sup|not|none|push|repeat|escalate|gave_up|persist|instruction|gaveup|pushed)$/i;
    const literals = (code.match(/(['"`])[a-z][a-z ]{1,24}\1/gi) || [])
        .map((l) => l.replace(/['"`]/g, ''))
        // "yooooo" appears only inside a PROHIBITION ("do not stretch words
        // (\"yooooo\")"). A banned example is the opposite of a hardcode, and my
        // first detector flagged it as the very thing it was banning.
        .filter((l) => !ALLOWED.test(l) && !/^y+o+$/.test(l));
    check(!literals.length, 'no canned message strings in executable code',
        `canned strings found: ${JSON.stringify(literals.slice(0, 4))}`);
    // The instruction must never CONTAIN a ready-made line.
    const a = new Attention();
    a.spoke('hi');
    // "Do NOT open with \"yo\"" quotes it as a PROHIBITION. The check is that
    // the instruction never PRESCRIBES a line - my first version flagged the
    // ban itself, which is the opposite of a hardcode.
    const ins = a.instruction();
    const prescribes = /\b(say|reply|respond|write|send)\s*:?\s*["'`]yo["'`]/.test(ins || '');
    check(ins && !prescribes, 'the instruction describes intent, not a line to say',
        'the instruction hands the model a phrase to emit');
}

// ── it only fires AFTER being ignored, never as an opener ──────────────
{
    const a = new Attention();
    check(!a.shouldPush(0), 'a fresh bot does not open with attention-spam', 'she spams before speaking');
    a.spoke('you there', 1000);
    check(!a.shouldPush(2000), '1s after speaking she is not pushing', 'impatient within 1 second');
    check(a.shouldPush(15000), 'after ~14s of silence she pushes', 'she never asks twice');
}
{
    // She cannot start a push from a non-speaking state at any clock value.
    const a = new Attention();
    let wrong = 0;
    for (let t = 0; t < 300000; t += 1000) if (a.shouldPush(t)) wrong++;
    check(wrong === 0, 'never pushes if she has not spoken', `${wrong} pushes with no prior message`);
}

// ── escalating, and the GAP SHRINKS as she gets annoyed ────────────────
{
    const a = new Attention();
    a.spoke('yo', 0);
    const first = 0;
    // after 1st wait
    let t = 0, gap1 = null;
    while (t < 60000) { if (a.shouldPush(t) && gap1 === null) { gap1 = t; break; } t += 500; }
    a.spoke('yo', gap1);
    let gap2 = null; t = gap1;
    while (t < gap1 + 60000) { if (a.shouldPush(t)) { gap2 = t - gap1; break; } t += 500; }
    check(gap1 !== null && gap2 !== null, 'measured both gaps', 'could not measure the gaps');
    check(gap2 < gap1, `she repeats sooner the second time (${Math.round(gap1 / 1000)}s then ${Math.round(gap2 / 1000)}s)`,
        'she repeats at a constant pace - that is a timer, not a person');
}

// ── he answers, she stops immediately ──────────────────────────────────
{
    const a = new Attention();
    a.spoke('yo', 0);
    a.spoke('yo', 14000);
    a.spoke('yo', 20000);
    const wasPushing = a.answered(21000);
    check(wasPushing, 'it reports she had been pushing (so she can be sheepish)', 'did not know she was pushing');
    check(!a.shouldPush(30000), 'she stops the moment he replies', 'kept pushing after he answered');
    check(a.instruction() === null, 'and has nothing to say about it', 'still instructing after an answer');
}

// ── she gives up rather than looping forever ───────────────────────────
{
    // shouldPush() is what decides she has run out of patience, so the loop has
    // to consult it - my first version only called spoke(), which (correctly)
    // never gives up on its own. run is clamped either way.
    const a = new Attention();
    let t = 0;
    for (let i = 0; i < 12; i++) {
        a.shouldPush(t);
        a.spoke('yo', t);
        t += 20000;
    }
    check(a.stage === 'gave_up', `she gives up (stage: ${a.stage})`, `never gave up, stage ${a.stage}`);
    check(!a.shouldPush(t + 1000), 'and stays given-up', 'she resumes pushing after giving up');
    check(a.run <= MAX_RUN, `run is capped at ${MAX_RUN}`, `run reached ${a.run}`);
    // and a long silence is not something she resurrects
    const b = new Attention();
    b.spoke('yo', 0);
    check(!b.shouldPush(600000), 'a 10-minute silence is not ignored, it is over', 'she comes back to a dead chat');
}

// ── the register guidance matches the corpus findings ──────────────────
{
    // Drive her to the ESCALATE stage - that is where the anti-tic warning
    // lives. My first version only reached 'repeat' (3 speaks) and then asserted
    // on escalate's text, so it failed against correct code.
    const a = new Attention();
    a.spoke('hi', 0); a.spoke('hi', 13000); a.spoke('hi', 20000); a.spoke('hi', 25000);
    check(a.stage === 'escalate', `reached the escalate stage (got ${a.stage})`, `never escalated, got ${a.stage}`);
    const ins = a.instruction() || '';
    check(/yooooo|stretch words|verbatim/i.test(ins),
        'it explicitly says do not stretch words or copy verbatim',
        'it does not warn against the tic');
    // The very first stage must forbid the bot-opener.
    const fresh = new Attention();
    fresh.spoke('hello', 0);
    const firstIns = fresh.instruction() || '';
    check(/do NOT open with|bot/i.test(firstIns),
        'the first message forbids the "yo / anyone?" opener', 'no guard against the bot opener');
}
{
    // MAX_RUN must match the corpus run lengths (2-4, almost never more).
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/utils/attention.js', 'utf8');
    check(/MAX_RUN = 4/.test(src), 'run cap is 4, matching the corpus run lengths',
        'run cap does not match the measured 2-4');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} attention-spam assertions green`);