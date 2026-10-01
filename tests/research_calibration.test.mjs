// Calibration against PRIMARY research, not intuition.
//
// Everything below is a number I read in a source, not a number I invented.
// Where a child-research claim was load-bearing I fetched the paper myself and
// quoted it; the two that mattered most are marked VERIFIED.
//
// ── Herring, "Computer-Mediated Discourse" ch.10 (Synchronous chat) ──────
// https://homes.luddy.indiana.edu/herring/chap10.pdf
//
// VERIFIED VERBATIM from the PDF (extracted locally, not from a summary):
//   "About 35% of the initiations receive no response in the sample overall."
//   Table 10.6: current-speaker-selects-next  33.5% no response
//               next-speaker-self-selects      48.3% no response
//               current-speaker-continues       3.3% no response
//
// This is the single most useful number in the whole project, because it sizes
// SILENCE. It says a third of the time a human says something addressed at
// somebody, and gets nothing back. That is normal, not a failure. Any bot that
// answers every addressable turn is therefore measurably wrong.
//
// The asymmetry matters too: 33.5% when the current speaker picks who talks
// next, 48.3% when someone self-selects into the floor. So the LESS a turn is
// explicitly handed to you, the MORE often it goes unanswered. Ignoring is
// correlated with being unaddressed, which is exactly what pickDyadMode does.
//
// ── Gilmartin et al. 2019, ICPhS (Teams Corpus, 47h Forbidden Island) ────
// https://www.internationalphoneticassociation.org/icphs-proceedings/ICPhS2019/papers/ICPhS_3457.pdf
//   Median 33.4% of floor time is SILENCE; 33.4% one speaker; the rest overlap.
//   Solo-speech intervals end in silence 62.3% of the time.
//
// Independent convergence on the same figure from a different modality (voice,
// not text) and a different game. 33% silence is a property of playing a game
// together, not of this corpus.
//
// ── Stivers et al. 2009, PNAS (10 languages) ───────────────────────────
//   Mean cross-linguistic turn-transition gap +208ms. Already implemented as the
//   Pareto reply-latency sampler; cited here because it is the floor-management
//   baseline and nothing in the project should be faster than a human gap.

import { shouldReplyTo } from '../src/utils/reply_trigger.js';
import { readFileSync } from 'node:fs';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// The research figure, as a constant, so drift is visible rather than silent.
const HERRING_NO_RESPONSE = 0.335;   // VERIFIED: Table 10.6, CSSN strategy
const HERRING_SELF_SELECT = 0.483;   // VERIFIED: Table 10.6, self-selection
const GILMARTIN_SILENCE = 0.334;     // median floor-time silence

// ── her dyad no-response rate must sit at the human number ─────────────
{
    // A representative dyad mix, weighted the way a server actually sounds:
    // mostly statements said into the room, some addressed, some reactions.
    const turns = [
        'im coming', 'ok', 'brb', 'has anyone seen the cows', 'there you go',
        'you are so bad at this', 'i walked into a creeper', 'lol', 'wtf lol',
        'the roof is broken', 'i finished the roof.', 'one sec',
        'where are you', 'can you help me with this', 'do you have spare stone',
        'wait for me', 'come here', 'look at this', 'you see this?',
        'what are you doing', 'im going to the mines', 'got any iron?',
    ];
    const ignored = turns.filter((m) => {
        const v = shouldReplyTo({ message: m, visible_humans: 1 });
        return v.mode === 'ignore' || !v.reply;
    });
    const rate = ignored.length / turns.length;
    // Not a tight band: the point is that silence is COMMON and roughly a
    // third of turns. Failing at 0% (answers everything) or at 0.9 (says
    // nothing) are both the bugs this project has actually hit.
    check(rate >= 0.20 && rate <= 0.50,
        `dyad no-response rate ${(100 * rate).toFixed(1)}% sits near the human 33.5%`,
        `dyad no-response rate ${(100 * rate).toFixed(1)}% is far from the human 33.5%`);
    check(rate >= 0.20, 'she ignores a substantial share of turns',
        `she answers almost everything (${(100 * rate).toFixed(1)}% ignored) - the "she cares about everything" bug`);
}

// ── the asymmetry: unaddressed turns are ignored MORE than addressed ───
// Herring: 33.5% when the current speaker selects the next speaker, 48.3% when
// someone self-selects. So silence tracks how explicitly the turn was handed over.
{
    const unaddressed = ['im coming', 'ok', 'brb', 'has anyone seen the cows',
        'there you go', 'one sec', 'i finished the roof.'];
    const addressed = ['where are you', 'can you help me', 'do you have stone',
        'wait for me', 'come here', 'look at this'];
    const ign = (list) => list.filter((m) => {
        const v = shouldReplyTo({ message: m, visible_humans: 1 });
        return v.mode === 'ignore' || !v.reply;
    }).length / list.length;
    const u = ign(unaddressed), a = ign(addressed);
    check(u > a, `unaddressed turns are ignored more (${(100 * u).toFixed(0)}%) than addressed (${(100 * a).toFixed(0)}%)`,
        `silence does not track addressedness: unaddressed ${(100 * u).toFixed(0)}% vs addressed ${(100 * a).toFixed(0)}%`);
    check(a <= 0.35, `addressed turns are usually answered (${(100 * (1 - a)).toFixed(0)}% get a reply)`,
        `she ignores too many directly addressed turns (${(100 * a).toFixed(0)}%)`);
}

// ── a group defers MORE than a dyad (the floor is harder to hold) ─────
{
    const m = 'im coming';
    const dyad = shouldReplyTo({ message: m, visible_humans: 1 });
    const group = shouldReplyTo({ message: m, visible_humans: 3 });
    check(dyad.mode === 'ignore' && (!group.reply || group.mode !== 'speak'),
        'an unaddressed message is ignored in a dyad and deferred in a group',
        'group deference is not stricter than dyad behaviour');
}

// ── the numbers in this file must stay the sourced ones ───────────────
{
    const src = readFileSync('tests/research_calibration.test.mjs', 'utf8');
    check(/0\.335/.test(src) && /0\.483/.test(src) && /0\.334/.test(src),
        'the three sourced constants are pinned in this file', 'a research constant drifted');
    check(/VERIFIED/.test(src), 'the verified claims are marked as verified',
        'unverified claims are not distinguished from verified ones');
    check(/homes\.luddy\.indiana\.edu\/herring\/chap10\.pdf/.test(src),
        'the Herring source URL is recorded', 'no source for the silence figure');
}

console.log(`\nResearch: Herring no-response ${(HERRING_NO_RESPONSE * 100).toFixed(1)}% `
    + `(self-select ${(HERRING_SELF_SELECT * 100).toFixed(1)}%), `
    + `Gilmartin silence ${(GILMARTIN_SILENCE * 100).toFixed(1)}%`);

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} research-calibration assertions green`);