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

import { readFileSync, existsSync as fsExists } from 'node:fs';
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

    // The reflex must be on entityHurt, NOT on health. This is the bug, not a
    // detail: bot.on('health') is emitted with no argument, so the reflex I first
    // wrote there read `source` from a callback that never receives one - the
    // attacker was always null and the fight branch was unreachable, which is
    // exactly why a phantom produced a complaint and no command. entityHurt is
    // the only event that carries the attacker.
    const hurtEvt = agent.indexOf("this.bot.on('entityHurt'");
    const hurt = agent.indexOf('REACT, DO NOT NARRATE');
    check(hurtEvt > 0 && hurt > hurtEvt,
        'the reflex lives on entityHurt, the only event carrying an attacker',
        'the reflex is not on entityHurt');
    // and it must NOT be in the health handler any more
    const healthEvt = agent.indexOf("this.bot.on('health'");
    const healthBlk = agent.slice(healthEvt, agent.indexOf("this.bot.on('error'", healthEvt));
    check(!/self_prompter\.start\(/.test(healthBlk),
        'no dead reflex left in the health handler, which cannot see an attacker',
        'a reflex that cannot see the attacker is still in the health handler');

    // Size to the end of the handler, not a guessed character count - the guard
    // and the tidy strip lines both sit further on than a fixed window reached.
    // The block runs from the marker to the end of the entityHurt handler.
    const end = agent.indexOf("this.bot.on('entityHurt", hurt + 10);
    const blk = agent.slice(hurt, end > 0 ? end : hurt + 2500);
    check(/self_prompter\.start\(/.test(blk),
        'being hit starts an ACTION goal', 'being hit starts no action');
    // Whether she fights or flees, and whether the layer can fail silently, are
    // asserted by EXECUTION in tests/threat.test.mjs - a pickaxe counting as a
    // weapon and a nearby zombie outranking a creeper were both real bugs that
    // only a behavioural test could find.

    // It must not route through the model - a round trip cannot answer a hit.
    check(!/bot\.chat\(|Generated response/.test(blk),
        'the reflex does not go through the model (too slow for a hit)',
        'the reflex asks the model what to do about being hit');

    // The fight logic is asserted for real in tests/threat.test.mjs, which imports
    // src/utils/threat.js and EXECUTES it. It is not asserted here, because this
    // file cannot: the logic used to be inline in agent.js, and four separate
    // attempts to recover it by slicing the handler out of the source and eval'ing
    // it failed on the window bounds, the arrow's closing paren, a `message =`
    // inside a comment, and an intermediate `.trim()`. Every one of those read as
    // a code failure. The logic now lives in a module both can import.
    check(fsExists('src/utils/threat.js'),
        'the threat logic lives in a testable module', 'no threat module');

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
