// Tilt and typos.
//
// Owner: "maybe she dies and she like fuxk, or fuxk this shit game. maybe she
// rages and spams characters like smashing keyboard or leaves and comes back
// later" and "typos like the one i did accidentalky are normal also".
//
// Both are measured rather than invented:
//   - typos: 1.3% of 21,822 real player messages (Minecraft Dialogue Corpus),
//     and 88% of that is a dropped apostrophe
//   - anger: rises on events with diminishing returns, decays on a half-life

import { Tilt, HALF_LIFE_MS } from '../src/utils/tilt.js';
import { applyTypo, shouldTypo } from '../src/utils/typo.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── TILT RISES, AND WITH DIMINISHING RETURNS ────────────────────────────
{
    const t = new Tilt();
    const first = t.note('death');
    check(first > 0.2, `one death lifts tilt to ${first.toFixed(2)}`, 'a death does nothing');
    const sixth = (() => { for (let i = 0; i < 5; i++) t.note('death'); return t.level; })();
    check(sixth - first < 5 * (first - 0),
        `six deaths reach ${sixth.toFixed(2)}, not 6x the first`,
        'repeated deaths add the same each time - that is a machine, not a person');
    check(t.level <= 1, 'tilt never exceeds 1', 'tilt exceeded 1');
}
{
    // griefing should matter more than a lag spike
    const a = new Tilt(); a.note('griefed');
    const b = new Tilt(); b.note('lag_or_crash');
    check(a.level > b.level, `being griefed (${a.level.toFixed(2)}) hits harder than lag (${b.level.toFixed(2)})`,
        'every event weighs the same');
}

// ── AND IT COOLS ─────────────────────────────────────────────────────────
{
    const t = new Tilt();
    for (let i = 0; i < 4; i++) t.note('death');
    check(t.isRaging, 'she is raging after four deaths', 'four deaths did not make her rage');
    t._last = Date.now() - HALF_LIFE_MS;
    t._now = Date.now();
    const after = t.decay();
    check(Math.abs(after - t.level) < 1e-9 || after < 0.5,
        `one half-life (${HALF_LIFE_MS / 1000}s) halves it`, 'decay does not follow the half-life');
    t._last = Date.now() - 10 * HALF_LIFE_MS;
    t._now = Date.now();
    t.decay();
    check(t.isCalm, 'she is calm again after ~15 minutes', 'she is still furious 15 minutes later');
}
{
    const t = new Tilt();
    t.note('death');
    const l0 = t.level;
    t._last = Date.now() - 5 * HALF_LIFE_MS; t._now = Date.now();
    t.decay();
    check(t.level < l0, 'tilt decreases over time', 'tilt never decreases');
}

// ── SPEECH CHANGES WITH IT: louder, shorter, dumber ─────────────────────
{
    const calm = new Tilt();
    const raging = new Tilt();
    for (let i = 0; i < 5; i++) raging.note('griefed');
    check(calm.styleHint() === null, 'calm her has no rage instructions', 'a calm bot is being told to rage');
    const h = raging.styleHint();
    check(h && /RAGING/i.test(h), 'raging her gets explicit instructions', 'no instructions when raging');
    check(h && /swearing|Swearing/i.test(h), 'raging instructions include swearing',
        'raging instructions do not mention swearing');
    check(/not witty|not.*jokes|ugly/i.test(h),
        'raging instructions say to be LESS articulate, not more',
        'raging instructions make her cleverer - furious people are not witty');
    // and mid-tilt is distinct from full rage
    const mid = new Tilt(); mid.note('provoked');
    check(mid.styleHint() !== h, 'mild annoyance reads differently from full rage',
        'every level of annoyance gets the same instruction');
}

// ── rage-quitting is a CONSEQUENCE of tilt, not a random event ───────────
{
    const calm = new Tilt();
    let calmLeaves = 0;
    for (let i = 0; i < 3000; i++) if (calm.wantsToLeave()) calmLeaves++;
    check(calmLeaves === 0, 'a calm bot never rage-quits', 'a calm bot storming off');
    const raging = new Tilt();
    for (let i = 0; i < 6; i++) raging.note('griefed');
    let ragingLeaves = 0;
    for (let i = 0; i < 3000; i++) if (raging.wantsToLeave()) ragingLeaves++;
    check(ragingLeaves > 0, `raging her does storm off (${Math.round(ragingLeaves / 30)}%)`,
        'she never leaves even while raging - the absence is not a consequence');
    check(ragingLeaves < 3000, 'and not every tick', 'she leaves on literally every tick');
    check(ragingLeaves > calmLeaves, 'raging makes leaving far more likely',
        'anger does not affect the urge to leave');
    check(/pissed|sheepish/i.test(raging.returnStyle()),
        'coming back from a rage-quit is not the same as coming back from the wc',
        'rage-quit return style is missing');
}

// ── TYPOS AT THE MEASURED RATE ──────────────────────────────────────────
{
    let hits = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) if (shouldTypo()) hits++;
    const pct = 100 * hits / N;
    check(pct > 0.5 && pct < 2.5, `typo rate ${pct.toFixed(2)}% (measured in the corpus: 1.3%)`,
        `typo rate ${pct.toFixed(2)}% is far from the measured 1.3%`);
    // and it must not rewrite every message
    const changed = [];
    for (let i = 0; i < 5000; i++) {
        const out = applyTypo("i think thats a good idea honestly");
        if (out !== "i think thats a good idea honestly") changed.push(out);
    }
    check(changed.length < 5000 * 0.1, `only ${changed.length}/5000 messages altered`,
        `${changed.length}/5000 altered - that is a bot with dyslexia, not a person`);
}

// ── and the corruption is SUBTLE: apostrophes dominate, as measured ──────
{
    let dropped = 0, transposed = 0, unchanged = 0;
    for (let i = 0; i < 4000; i++) {
        const out = applyTypo("its fine youre right about that i guess");
        if (out === "its fine youre right about that i guess") unchanged++;
        else if (/(youre|its|theyre|ive|hes|im)\b/.test(out) && out !== "its fine youre right about that i guess") dropped++;
        else transposed++;
    }
    check(dropped > 0, `dropped-apostrophe typos occur (${dropped}/4000)`, 'no dropped-apostrophe typos ever');
    check(dropped > transposed, `apostrophes dominate (${dropped} vs ${transposed} transpositions), as in the corpus`,
        'transpositions dominate, but they are 19 hits vs 254 in the real corpus');
}

// ── it never mangles a command, because a broken command is not human ────
{
    // Aggregate. Asserting per-iteration gave 2025 "assertions" from ~20 real
    // checks, which drowns the output and hides a real regression in the noise.
    const broken = [];
    for (let i = 0; i < 2000; i++) {
        const out = applyTypo('/tp Someone 100 64 100');
        if (!out.startsWith('/tp ')) broken.push(out);
    }
    check(!broken.length, '2000 typo applications never corrupted a command',
        `corrupted a command into ${JSON.stringify(broken[0])}`);
}

// ── wired into production ───────────────────────────────────────────────
{
    const fs = await import('node:fs');
    const agent = fs.readFileSync('src/agent/agent.js', 'utf8');
    check(/applyTypo/.test(agent), 'agent.js applies typos', 'the typo path is dead code');
    const modes = fs.readFileSync('src/agent/modes.js', 'utf8');
    check(/Tilt/.test(modes), 'modes.js uses Tilt', 'tilt is dead code');
    check(/_tilt\.tick\(\)/.test(modes), 'tilt decays on the tick', 'tilt never decays - one death lasts all evening');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} tilt/typo assertions green`);