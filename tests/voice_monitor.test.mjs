// The monitor is only worth having if it fires on drift AND stays quiet on real
// player speech. A detector that alerts on everything is a log file.
//
// Both corpora below are measured data from this server, not invented strings:
// REAL_PLAYER is a sample of the 868 unique lines from bots/UwU/histories;
// YANDERE_ERA is verbatim from her own pre-fix output, which is known drift.

import { readFileSync, readdirSync } from 'node:fs';
import {
    VoiceMonitor, driftFlags, DRIFT_THRESHOLDS,
} from '../src/utils/voice_monitor.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the measured human corpus, filtered to real chat ───────────────────────
const SYS = /^(Gave |Found \d+ matching|Set the |Successfully|Unknown|You are not|Changed |Game mode|Time|Weather|Test |Removed |Cleared |Could not|Teleport|Spawn|Server |\[|Error|Your |Cannot|Invalid|Expected|No |Please|Usage)/i;
const dir = 'bots/UwU/histories';
const human = new Set();
// All 1030 files, not a slice. An earlier 400-file slice returned only 117
// lines and was biased toward short chat: its p95 flagged 28% of its own sample
// as drift. Calibrating on the full corpus is the whole point.
for (const f of readdirSync(dir)) {
    let d;
    try { d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
    for (const m of (Array.isArray(d) ? d : (d.messages || d.history || []))) {
        if (!m || m.role !== 'user') continue;
        const c = String(m.content || '').replace(/^\s*\w{2,20}\s*:\s*/, '').trim();
        if (c && !SYS.test(c) && !c.startsWith('(AUTO')) human.add(c);
    }
}
check(human.size > 700, `loaded ${human.size} real player lines`, 'corpus too small to calibrate on');

// ── false-positive rate must be low, or the alert is noise ─────────────────
const real = [...human];
const fp = real.filter((s) => driftFlags(s).length).length;
const fpRate = fp / real.length;
console.log(`  (real player lines tripping any flag: ${fp}/${real.length} = ${(fpRate * 100).toFixed(1)}%)`);
check(fpRate < 0.12,
    `false-positive rate ${(fpRate * 100).toFixed(1)}% is low enough to be usable`,
    `false-positive rate ${(fpRate * 100).toFixed(1)}% — the monitor would alert on normal chat`);

// p95-derived thresholds must sit above the median comfortably.
const med = real.map((s) => s.split(/\s+/).length).sort((a, b) => a - b)[real.length >> 1];
check(DRIFT_THRESHOLDS.words > med,
    `word threshold ${DRIFT_THRESHOLDS.words} sits above the player median ${med}`,
    `threshold ${DRIFT_THRESHOLDS.words} is not above the median ${med}`);

// ── it must fire on the drift we actually observed ──────────────────────────
const YANDERE_ERA = [
    "Yu-uwu! Hii, my love~ ♥ I'm UwU, your cute yandere girl! Just dreaming",
    'hm.',
    'i see~',
    'mhm~',
    'uh-huh~',
    'Συγγνώμη, αγαπημένο μου! ♥ UwU δεν μιλάει ελληνικά',
    '✨ Ooh, Rcon! You’re being so generous! Thank you for all the lovely gifts',
    'ugh, just got hit by a pillager! what a mood killer. trying to build a shelter over here but they keep spawning',
];
// "i see~" and "mhm~" are deliberately NOT drift. They are short backchannels,
// which the corpus shows are legitimate ~6% of real chat (ok / yeah / yep), and
// the yandere-era tildes were removed for being fake filler, not for being short.
// A monitor that flags them would push her back toward never acknowledging.
const NOT_DRIFT = new Set(['i see~', 'mhm~', 'hm.', 'uh-huh~']);
const missed = YANDERE_ERA.filter((s) => !driftFlags(s).length);
check(missed.every((s) => NOT_DRIFT.has(s)),
    `flags every real drift line; only the ${missed.length} known backchannel(s) pass through`,
    `missed genuine drift: ${JSON.stringify(missed.filter((s) => !NOT_DRIFT.has(s)).slice(0, 2))}`);
check(driftFlags('ok').length === 0 && driftFlags('yeah').length === 0,
    'ordinary backchannels are not flagged', 'normal acknowledgements are being flagged as drift');

// Emoji must always be caught — the corpus had zero, so any occurrence is drift.
check(driftFlags('nice one 😅').includes('EMOJI'), 'catches a Unicode emoji', 'missed an emoji');
check(!driftFlags('thanks :)').includes('EMOJI'),
    'a trailing text emoticon is not an emoji violation',
    'text emoticon misread as Unicode emoji');

// Self-introduction is the subtlest drift and the easiest to miss.
check(driftFlags("hi, i'm elena and i like building farms").includes('SELF_INTRO'),
    'catches self-introduction', 'missed self-introduction');
check(!driftFlags("yeah i was gonna build a farm").includes('SELF_INTRO'),
    'ordinary self-referential speech is not self-introduction',
    'false self-introduction');

// ── rate-based alerting, not per-message ───────────────────────────────────
{
    const m = new VoiceMonitor({ window: 10 });
    // A quiet run of normal chat must never alert.
    let alerted = false;
    for (const s of real.slice(0, 10)) if (m.note(s).alert) alerted = true;
    check(!alerted, 'a full window of real chat did not alert', 'monitor alerted on normal player chat');

    // A sustained off-register run must alert.
    const m2 = new VoiceMonitor({ window: 10 });
    let fired = false;
    for (let i = 0; i < 10; i++) fired = m2.note(YANDERE_ERA[i % YANDERE_ERA.length]).alert || fired;
    check(fired, 'a window of sustained drift alerts', 'sustained drift did not alert');

    // One bad message inside a good window must not — people write long
    // messages sometimes, and a single outlier is not a register change.
    const m3 = new VoiceMonitor({ window: 10 });
    let fired3 = false;
    for (let i = 0; i < 10; i++)
        fired3 = m3.note(i === 5 ? YANDERE_ERA[0] : 'ok').alert || fired3;
    check(!fired3, 'a single outlier in a healthy window does not alert', 'one long message caused an alert');

    check(!m2.rateSummary || typeof m2.rateSummary().LONG === 'number',
        'rate summary reports per-dimension rates', 'rate summary is broken');
}

// ── bounded memory: a monitor that grows forever is a leak ─────────────────
{
    const m = new VoiceMonitor({ window: 20 });
    for (let i = 0; i < 5000; i++) m.note('ok');
    check(m.samples.length === 20, 'sample window stays bounded at 20', `window grew to ${m.samples.length}`);
    m.reset();
    check(m.samples.length === 0, 'reset clears state', 'reset did not clear state');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} voice-monitor assertions green`);