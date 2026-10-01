// The examples are the teacher, so they have to be shaped like the corpus.
//
// The owner, repeatedly: "still think she doesnt shorten words and who the fuck
// uss !?", "like wtf instead of what the hell even just a bruhhh", and then the
// correction that matters most - "sorry again i dont want hardcoded stuff please
// work on the bigger picture with my examples".
//
// So: NO regex table that rewrites her text. That approach is gone - I built a
// 40-rule CONTRACTIONS table and it was itself a hardcoded phrase list, and
// worse, it fights the model instead of teaching it.
//
// This test does the opposite. It measures the EXAMPLES she learns from, and
// the PROMPT text she reads, against rates taken from 21,822 real player
// messages (Minecraft Dialogue Corpus, ACL 2019):
//
//   '!' in a message    2.79%      '?'  7.55%      ends '.'  5.81%
//   no punctuation    57.56%       >1 '!'  0.03%
//   contracted 280 vs uncontracted 254 = 52.4%     91% start lowercase
//
// If the examples drift back to formal punctuated English, the model will too -
// and this is the thing that actually caused it, because tilt.styleHint() was
// feeding it full punctuated sentences on every single death.

import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const persona = JSON.parse(readFileSync('personas/normal.json', 'utf8'));
const replies = persona.conversation_examples
    .map((m) => m.find((x) => x.role === 'assistant')?.content || '')
    .filter(Boolean);
const N = replies.length;
check(N > 150, `${N} examples available`, `only ${N} examples`);

// ── 1. no formal contractions: 52.4% of real messages contract ─────────
{
    // Only the APOSTROPHE form is formal. "its" and "isnt" are already the
    // casual spelling and are exactly what we want - my first regex matched
    // them and reported 34 correct examples as violations.
    const formal = replies.filter((t) =>
        /\b(?:I'm|you're|it's|don't|can't|won't|I'd|we're|they're|he's|she's|that's|you'll|I'll|we'll|isn't|aren't|I've|you've|couldn't|wouldn't|shouldn't|haven't|hasn't|wasn't|weren't|didn't|doesn't)\b/.test(t));
    check(!formal.length, 'no example uses a formal contraction',
        `${formal.length} examples write formally: ${JSON.stringify(formal.slice(0, 4))}`);
}

// ── 2. ! is 2.79%. Note "!command" is game syntax, not punctuation. ─────
{
    // strip the !command syntax before measuring, or every action message counts
    const stripped = replies.map((t) => t.replace(/!\w+\([^)]*\)/g, '').trim());
    const withBang = stripped.filter((t) => t.includes('!'));
    const rate = withBang.length / N;
    check(rate <= 0.028, `examples use ! at ${(100 * rate).toFixed(1)}% (corpus 2.79%)`,
        `examples use ! at ${(100 * rate).toFixed(1)}% - above the corpus 2.79%`);
    const doubles = stripped.filter((t) => /!!/.test(t));
    check(!doubles.length, 'no double !! anywhere (corpus 0.03%)',
        `${doubles.length} examples use !!`);
}

// ── 3. 57.56% have no punctuation; 5.81% end in a period ───────────────
{
    const stripped = replies.map((t) => t.replace(/!\w+\([^)]*\)/g, '').trim());
    const endsPunct = stripped.filter((t) => /[.,;:]$/.test(t));
    const rate = endsPunct.length / N;
    check(rate <= 0.06, `examples end in punctuation at ${(100 * rate).toFixed(1)}% (corpus 5.81%)`,
        `examples end in punctuation at ${(100 * rate).toFixed(1)}% - above 5.81%`);
    const unpunctuated = stripped.filter((t) => !/[.,;:!?]/.test(t));
    const urate = unpunctuated.length / N;
    check(urate >= 0.40, `${(100 * urate).toFixed(1)}% of examples have no punctuation (corpus 57.56%)`,
        `only ${(100 * urate).toFixed(1)}% unpunctuated - the examples are too formal`);
}

// ── 4. 91% start lowercase ────────────────────────────────────────────
{
    const caps = replies.filter((t) => /^[A-Z]/.test(t.trim()));
    check(caps.length / N <= 0.10, `${caps.length} examples start capital (corpus 9%)`,
        `${caps.length} examples start with a capital`);
    // A single word in caps is real and measured (the rage hint allows caps to
    // creep in, and "AGAIN" is a genuine reaction). Full SHOUTING is not.
    const shout = replies.filter((t) => t === t.toUpperCase() && t.trim().split(/\s+/).length > 1);
    check(!shout.length, 'no example is typed in full caps (a single caps word is fine)',
        `${shout.length} examples are in caps: ${JSON.stringify(shout.slice(0, 3))}`);
}

// ── 5. and the clipped register you asked for, in the prompt ───────────
{
    const c = persona.conversing;
    check(/wtf.{0,20}not.{0,20}what the hell/i.test(c) || /wtf" not "what the hell/i.test(c),
        'the persona says wtf, not "what the hell"', 'clipped swearing is not in the persona');
    check(/bruh/i.test(c), 'the persona carries "bruh"', 'bruh is not in the persona');
    check(/52\s*%/.test(c) || /52\s*percent/i.test(c),
        'the persona states the measured 52% contraction rate',
        'the persona has no real contraction rate');
    check(/2\.79|2,79/.test(c), 'the persona states the measured ! rate',
        'the persona has no ! rate');
    check(/57\.56|57,56/.test(c), 'the persona states the 57.56% unpunctuated rate',
        'the persona has no unpunctuated rate');
    // the old contradictory rule must not come back
    check(!/4%\s+drop apostrophes/.test(c),
        'the contradictory "4% drop apostrophes" rule is gone',
        'the persona still says 4%, which reads as rare');
}

// ── 6. tilt.js must not teach formality either ─────────────────────────
// This is the actual regression: the rage hint used to hand the model full
// punctuated sentences with apostrophes, and it fires on EVERY death, which is
// exactly when the journal showed her producing paragraphs and "?!".
{
    const tilt = readFileSync('src/utils/tilt.js', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const hints = [...tilt.matchAll(/return `([\s\S]*?)`;/g)]
        .map((m) => m[1]).join(' ');
    const quoted = [...hints.matchAll(/"([^"]{2,})"/g)].map((m) => m[1]);
    // Any example it shows must look like the corpus
    const formal = quoted.filter((s) => /\b(?:I'?m|you'?re|it'?s|this is|can ?n'?t)\b/.test(s));
    check(!formal.length, `all ${quoted.length} tilt examples are clipped/unpunctuated`,
        `tilt teaches formal speech: ${JSON.stringify(formal)}`);
    const punctuated = quoted.filter((s) => /[.!?]$/.test(s.trim()) && !/[?!]{2,}$/.test(s.trim()));
    check(!punctuated.length, 'no tilt example ends in a full stop',
        `tilt examples end in punctuation: ${JSON.stringify(punctuated)}`);
    check(/not a paragraph|no full stop|unpunctuated/i.test(hints),
        'tilt explicitly bounds the length', 'tilt sets no length bound');
}

// ── 7. and there is no rewrite table anywhere ──────────────────────────
{
    // The 40-rule casual.js approach was deleted. This asserts it stays deleted:
    // a module that rewrites her words into casual forms is the hardcoding the
    // owner rejected, whatever the table is called.
    const { existsSync } = await import('node:fs');
    for (const f of ['src/utils/casual.js', 'src/utils/casualize.js', 'src/utils/contractions.js']) {
        check(!existsSync(f), `no rewrite table at ${f}`, `${f} exists - that is a phrase list`);
    }
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    check(!/casualize|CONTRACTIONS/.test(agent),
        'the send path does not rewrite her words', 'the send path rewrites her text');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} example-shape assertions green`);