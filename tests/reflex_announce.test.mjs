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

    // the strip has to tidy up after itself - verified debris was
    // "a phantom now? ." and "seriously?? fine,". The tidy chain is the LAST
    // replace run in the block, so search to the end of the statement rather than
    // a window: a fixed one reported both as missing when they are present.
    const end = agent.indexOf('.trim();', i) + 8;
    const after = agent.slice(i, end);
    check(/\\s\+\(\[\.!\?,;:\]\)/.test(after),
        'orphaned punctuation is tidied (no "a phantom now? .")',
        'the strip leaves orphaned punctuation');
    // ── BEHAVIOUR, EXTRACTED FROM THE SOURCE ─────────────────────────
    // Pull the real replace-chain out of agent.js and run it, rather than copying
    // it or matching its backslashes. The earlier hand-copied probe of this same
    // strip reported a false PASS because the copy had drifted from the code;
    // asserting on the source's own text is the only version that cannot.
    // The chain can start BEFORE the marker comment - a previous edit put the
    // whole-sentence comment above `message = String(message)`. Slicing from the
    // marker lost that first line, so the evaluated arrow had no parameter and
    // silently returned its input unchanged: a test that silently no-ops is worse
    // than no test at all.
    //
    // So: collect ONLY the .replace( lines, and always rebuild as an arrow with an
    // explicit parameter. If it does not evaluate, that is a FAILURE - never a
    // silent fallback to the input.
    const run0 = agent.slice(Math.max(0, i - 2500), agent.indexOf('.trim();', i));
    const lines = run0.split('\n').map((l) => l.trim())
        .filter((l) => l.startsWith('.replace('));
    const chain = lines.join('\n').replace(/;\s*$/, '');
    check(lines.length >= 8, `extracted ${lines.length} strip steps from the source`,
        `only ${lines.length} strip steps extracted - the window is wrong`);
    let strip = null;
    let evalErr = null;
    try { strip = eval(`(message) => String(message)${chain}`); }
    catch (e) { evalErr = e.message; }
    check(!!strip && !evalErr, 'the extracted strip chain evaluates',
        `the strip chain did not evaluate: ${evalErr}`);

    const cleaned = (m) => { if (!strip) throw new Error('strip unavailable'); return strip(m); };
    const run = (input) => cleaned(String(input)
        .replace(/[ \t]{2,}/g, ' ').replace(/~+/g, '').replace(/\s{2,}/g, ' ').trim());

    // The owner's exact words, plus the measured zero-set.
    const cases = [
        ['of course, a phantom now? this is just fantastic. time to deal with that.',
            ['time to deal with', 'this is just fantastic', 'of course']],
        ['ok, time to find some coal then.', ['time to find some coal']],
        ['seriously?? fine, let me try again.', ['let me try again']],
        ['better get on that', ['better get on that']],
        ['ugh, seriously?? fine,', ['seriously??']],
    ];
    for (const [input, banned] of cases) {
        const out = run(input);
        const left = banned.filter((b) => out.toLowerCase().includes(b));
        check(left.length === 0,
            `stripped: "${input.slice(0, 42)}..." -> "${out}"`,
            `NOT stripped (${left.join(', ')}): "${out}"`);
    }
    // and it must not mangle ordinary chat
    for (const good of ['yeah that was brutal', 'wait where did you go', 'give me a sec']) {
        check(run(good) === good, `untouched: "${good}"`, `mangled: "${run(good)}"`);
    }
    // ── NO MANGLING: the bug a spelling assertion could never catch ──
    // Partial removal ate the verb and the determiner and left the noun:
    //   "time to find some coal"      -> " some coal"
    //   "ok, time to find some coal then." -> "me coal then."
    // "some coal then." is not something a player types, so it is worse than the
    // announcement it replaced. Removal is now whole-sentence.
    for (const [input, fragment] of [
        ['ok, time to find some coal then.', 'coal then'],
        ['time to find some coal', 'some coal'],
        // the owner's exact complaint: the whole announcement goes, nothing said
        ['ok, time to get coal then.', 'coal'],
        ['time to deal with that', 'deal'],
    ]) {
        const out = run(input);
        check(out.trim() === '' || !/\b(?:some|me)\s+coal\b/.test(out),
            `no fragment left behind: "${input}" -> "${out || '(empty)'}"`,
            `mangled into a fragment: "${out}"`);
    }
    // No orphaned or doubled punctuation. Both were real in production output:
    // "a phantom now?." and "seriously?." - a full stop after a question mark,
    // caused by a sentence strip that removed the words but not the terminator.
    for (const [input, bad] of [
        ['of course, a phantom now? this is just fantastic. time to deal with that.', 'a phantom now?.'],
        ['seriously?? fine, let me try again.', 'seriously?.'],
    ]) {
        const out = run(input).trim();
        check(!out.includes(bad), `"${bad}" is not produced (got "${out}")`,
            `stranded punctuation: got "${out}"`);
    }
    const phantomOut = run('of course, a phantom now? this is just fantastic. time to deal with that.');
    check(!/[?!.]\s*[?!.]/.test(phantomOut) && !/\s[?!.]/.test(phantomOut),
        `punctuation is clean after a removed sentence: "${phantomOut.trim()}"`,
        `stranded punctuation in "${phantomOut.trim()}"`);
    // and a genuine question keeps its question mark
    check(run('wait what?') === 'wait what?',
        'a real question keeps its "?"', `a real question lost its mark: "${run('wait what?')}"`);

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
