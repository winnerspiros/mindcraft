// Backchannel vocabulary + human cadence.
//
// Both exist because a hardcoded constant outlived the persona it was written
// for. See the long comment on _pickAck in src/agent/agent.js: "mm~" was a
// literal in an array, added with the DuplexGen turn-taking work (e50336a),
// never revisited when the persona switched to normal. The cadence was likewise
// a hardcoded 45000/150000.

import { readFileSync } from 'node:fs';

let pass = 0;
const ok = (m) => { console.log(`  ok - ${m}`); pass++; };
const bad = (m) => { console.error(`  NOT OK - ${m}`); process.exitCode = 1; };

const src = readFileSync('src/agent/agent.js', 'utf8');
const sp = readFileSync('src/agent/self_prompter.js', 'utf8');

// ── 1. the ack pool must contain no filler and no tildes ──────────────────
// Measured over 57,394 real player messages (MDC, ACL 2019):
//   'ok' 1606, 'okay' 678, 'yeah' 416, 'yep' 228 | 'mm'/'mhm' 2, '~' 2
const pool = src.match(/const warm = \[([^\]]*)\];\s*\n\s*const cool = \[([^\]]*)\];/);
if (!pool) bad('could not find the ack pools in _pickAck');
else {
    const acks = (pool[1] + ',' + pool[2])
        .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    ok(`ack pool: ${JSON.stringify(acks)}`);

    for (const a of acks) {
        if (/mm|mhm|hmm|uh-?huh/i.test(a) && a !== 'mhm')
            bad(`filler "${a}" is back in the ack pool`);
    }
    if (acks.some(a => a.includes('~'))) bad('tilde is back in the ack pool');
    else ok('no tildes — yandere residue gone from every pool');

    // Real acks must actually be there, or we overcorrected into silence.
    for (const want of ['ok', 'yeah', 'yep']) {
        acks.includes(want) ? ok(`keeps measured ack "${want}"`) : bad(`lost real ack "${want}"`);
    }
}

// ── 2. null ack must never reach chat ─────────────────────────────────────
if (/const ack = this\._pickAck\(source, _d\.confidence\);\s*\n\s*this\.routeResponse\(source, ack\)/.test(src)) {
    bad('a null ack would be sent to chat verbatim');
} else {
    ok('null ack is handled before routeResponse');
}
if (/if \(ack\)\s*\{/.test(src)) ok('null ack takes the silent branch');
else bad('no branch for a null ack');

// ── 3. three-in-a-row guard exists ────────────────────────────────────────
if (/this\._ackStreak >= 2/.test(src)) ok('no more than two acks in a row');
else bad('ack streak guard missing — "ok ok ok" every message is a machine tell');

// ── 4. cadence must be jittered, not constant ─────────────────────────────
// The bug: cooldown_chatty = 45000 / cooldown_solo = 150000 used directly at
// both call sites, so every gap was identical.
const jittered = sp.match(/_jitteredGear|_engagementGear/g) || [];
if (jittered.length < 2) bad('cadence is not jittered at the loop call sites');
else ok(`both cadence call sites use a jittered gear (${jittered.length} refs)`);

// The fixed constants are gone, not merely unused: leaving them behind invites
// the next reader to wire one back up.
if (/cooldown_chatty|cooldown_solo/.test(sp)) bad('a fixed cooldown constant survives');
else ok('no fixed cooldown constant left to be re-wired');
if (/const gear = solo \? this\._jitteredGear\(true\) : this\._engagementGear\(\)/.test(sp))
    ok('loop picks a fresh gear every turn');
else bad('loop still uses a constant gear');

// ── 5. engagement tracking is fed and decayed ─────────────────────────────
if (/noteHumanMessage/.test(src)) ok('real human messages feed the cadence tracker');
else bad('engagement tracker is never fed — cadence cannot adapt to you');
if (/tickCadence|_decayEngagement/.test(sp)) ok('engagement decays over time');
else bad('engagement never decays; a burst an hour ago keeps her fast');

console.log(`\nPASS — ${pass} cadence/ack assertions green`);
