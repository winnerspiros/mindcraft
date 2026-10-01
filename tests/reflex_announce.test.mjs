// Two behaviours, both from the owner:
//
//  "shes spammy again.. and to a point that doesnt make sense like a phantom
//   attacjs her, she should fight, not complain"
//  "time to deal with that, who says that. who cares.. just deal with it, dont say"
//  "texts she sends feel ai still.. like this is juat fantastic. who says that"
//
// Measured over 21,822 real player lines:
//   "time to (deal|figure|handle)"                   0
//   "this is (just )?(great|fantastic|perfect)"     0
//   "of course"                                      1
//   "let me (try|just)"                             12
//   opens with an interjection                    14.05%, and the common ones are
//     PLAIN: ok 815, so 635, okay 427, yes 343, yeah 251, great 224, no 187
//
// So the whole complaint-opener family is absent from real chat. It appears in her
// output because the SELF-PROMPT turns narrate her own retries, and a model
// grading its own failure reaches for a stock opener. A persona line alone does
// not stop it, so it is also stripped in code.

import { readFileSync } from 'node:fs';
import { scrubOutput } from '../src/utils/scrub.js';

let pass = 0, failed = 0;
const check = (c, good, bad) => {
    if (!c) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const agent = readFileSync('src/agent/agent.js', 'utf8');
const persona = JSON.parse(readFileSync('personas/normal.json', 'utf8'));
const flat = persona.conversing.replace(/\s+/g, ' ');

// ── she reacts to being hit instead of narrating it ───────────────────
{
    // The event message legitimately lives in player_activity.js - that is where
    // the damage event is turned into text. What must not happen is her REPLYING
    // to it with a complaint, so the reflex is what matters, not the string.
    const pa = readFileSync('src/agent/player_activity.js', 'utf8');
    check(/just hit YOU/.test(pa), 'the damage event still reaches her (that is correct)',
        'the damage event message is gone');
    const agentCode = agent.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    check(!/this is (just )?fantastic/.test(agentCode),
        'no complaint wording is hardcoded in agent.js (comments excluded)',
        'a complaint is hardcoded');

    // The reflex must be in the health/damage handler, not the message path -
    // a model round-trip is far too slow to answer a phantom, and letting the
    // model decide is what produced "this is just fantastic" in the first place.
    const h = agent.indexOf("this.bot.on('health'");
    const hurt = agent.indexOf('REACT, DO NOT NARRATE');
    check(h > 0 && hurt > h,
        'the reflex lives in the damage handler, not the chat path',
        'the reflex is not in the damage handler');

    // Size to the end of the handler, not a guessed character count - the guard
    // and the tidy strip lines both sit further on than a fixed window reached.
    const blk = agent.slice(hurt, agent.indexOf("this.bot.on('entityHurt", hurt) > 0
        ? agent.indexOf("this.bot.on('entityHurt", hurt) : hurt + 4000);
    check(/self_prompter\.start\(/.test(blk),
        'being hit starts an ACTION goal', 'being hit starts no action');
    check(/sword|axe/i.test(blk),
        'and it chooses fight-or-flee from whether she is armed',
        'the reaction does not depend on being armed');
    check(/try \{/.test(blk) && /catch \(_\)/.test(blk),
        'and it is wrapped so a reflex can never take the bot down',
        'the reflex is unguarded');

    // It must not route through the model - a round trip cannot answer a hit.
    check(!/bot\.chat\(|Generated response/.test(blk),
        'the reflex does not go through the model (too slow for a hit)',
        'the reflex asks the model what to do about being hit');
}

// ── no announcing the action ──────────────────────────────────────────
{
    const i = agent.indexOf('DO NOT ANNOUNCE THE ACTION');
    check(i > 0, 'the announce strip exists', 'no announce strip');

    // measured reasons must be recorded so nobody relaxes them
    const why = agent.slice(i, i + 1200);
    check(/21,822/.test(why), 'the measurement is recorded next to the strip',
        'no measurement recorded');

    // every one of the owner's exact examples must be covered
    for (const [label, re] of [
        ['time to deal with that', /time to \(?:deal with|figure out|handle|get|gather|find|check|look at|try\)/],
        ['let me try again', /let me \(?:try|just|go|get|see|check|find|handle|deal\)/],
        ['better get on that', /better get on \(?:that|it|this\)/],
        ['of course', /of course/],
        ['this is just fantastic', /this is \(?:just \)\?\(?:great|fantastic|perfect|amazing|brilliant\)/],
    ]) {
        check(re.test(why), `covered: ${label}`, `NOT covered: ${label}`);
    }

    // Tidying is asserted by BEHAVIOUR below (stranded punctuation, repeated
    // punctuation, a dangling opener) rather than by grepping agent.js for the
    // regex text: the chain now lives in src/utils/scrub.js, so a source grep
    // here was looking in the wrong file and asserting nothing.
    // ── BEHAVIOUR, VIA THE SAME MODULE PRODUCTION USES ────────────────
    // This previously recovered the chain by slicing agent.js SOURCE TEXT and
    // eval'ing it. Every failure while fixing it was a failure of the extraction
    // - window bounds, the chain's own `message =` head, a lookbehind that made
    // the file unparseable, an intermediate .trim() that split the chain in two -
    // not of the behaviour. Importing the function means the test and production
    // cannot disagree, and there is no text to drift.
    check(typeof scrubOutput === 'function', 'scrubOutput is importable',
        'scrubOutput is not importable');
    const run = (input) => scrubOutput(String(input));

    // ── NO UNICODE EMOJI ──────────────────────────────────────────────
    // 0 of 21,822 real player lines contain any Unicode emoji, and she sent 🙃
    // in live play. TT is the dominant expressive device at 2.14%, 70x a smiley,
    // so the corpus-correct form is text, not the Unicode block.
    for (const emoji of ['\u{1F643}', '\u{1F612}', '\u{1F605}', '\u{1F44D}\u{1F44D}', '\u{26A0}']) {
        check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/u.test(run(`lost my pickaxe today ${emoji}`)),
            `no Unicode emoji survives: ${emoji}`, `a Unicode emoji survived: ${emoji}`);
    }
    check(run('TT that was rough') === 'TT that was rough',
        'the corpus-dominant TT form is left alone', 'TT was mangled');
    check(run('brb one sec') === 'brb one sec', 'plain chat untouched', 'plain chat mangled');

    // ── NO SELF-NARRATION ─────────────────────────────────────────────
    // Every one of these was in her live output. Each is 0 or near-zero in the
    // corpus: "time to <verb>" 0, "let's just" 0, "hope for" 0, "dig straight
    // down" 0, "forgot my" 0, "this is going well" 0, "just perfect" 0,
    // "so it needs/is/takes" 0.027%, "I (just) need to" 0.050%.
    for (const narration of [
        "ok, time to get coal then.",
        "time to hit the caves for some coal",
        "damn, okay. time to hit the caves for some coal then.",
        "so it needs a number too?",
        "I just need to figure out the materials",
        "hope for coal",
        "forgot my tools again",
        "this is going well",
        "just perfect",
        "let's just dig straight down and hope for coal",
    ]) {
        const out = run(narration).trim();
        check(out === '' || out === '.', `no narration survives: "${narration.slice(0, 40)}"`,
            `narration survived as "${out}"`);
    }
    // and the real thing still gets through
    check(run('ugh, this is a pain.') === 'ugh, this is a pain.',
        'a plain complaint survives', 'a plain complaint was stripped');

    // the persona must carry the same instruction, since the model is the source
    check(/DO NOT ANNOUNCE WHAT SHE IS ABOUT TO DO/i.test(flat),
        'the persona tells her not to announce actions', 'the persona does not say this');
    check(/time to \(deal\|figure\|handle\)/.test(flat),
        'and lists the measured-zero constructions', 'the persona omits the list');
}

// ── the gaze has a ceiling, so she does not stare at nothing ───────────
{
    const modes = readFileSync('src/agent/modes.js', 'utf8');
    check(/GLANCE_BUDGET_MAX/.test(modes), 'the glance budget still exists', 'the glance budget is gone');
    // NOT asserting "modes.js loads" by importing it: that pulls mineflayer ->
    // undici, which needs a global `File` that only exists in Node 20+, and
    // `bun run test` runs plain `node` (19.8.1 here). The import killed the whole
    // suite on an unrelated dependency before a single assertion ran.
    // tests/parse_check.sh and tests/parse_check cover loading properly.
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} reflex/announce assertions green`);
