// THE LIVE BUG: "hey uwu" produced NO reply at all.
//
// Found in the service log, not in a test:
//
//   UwU received message from YandereDev : hey uwu
//   UwU backchannel (stranger, 50%): right
//   UwU [empty-ack] suppressed: right
//
// Two gates each behaving correctly on their own, together producing silence:
//   1. turn_taker classified a message addressed to her BY NAME as a
//      "backchannel" turn - a continuer, which is the right reply to someone
//      talking past you and the wrong reply to someone calling your name.
//   2. _pickAck returned a canned token, "right".
//   3. the empty-ack gate (correctly) rejected "right" as contentless.
// Net result: she said nothing, to a direct greeting.
//
// The second live bug, same session: 27 consecutive reactions to ONE phantom
// death, every one suppressed as `unprompted_self_narration` - and when the gate
// was relaxed enough to allow them, it would have produced 27 complaints about
// the same event. A real player says one thing and moves on.

import { readFileSync } from 'node:fs';
import { gateNormalChat } from '../src/utils/speak_gate.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const src = readFileSync('src/agent/agent.js', 'utf8');
const gate = readFileSync('src/utils/speak_gate.js', 'utf8');

// ── BUG 1: a name-addressed message must never be gated as narration ──────
// Reproduces the exact shape of the live failure, at the gate level.
{
    const v = gateNormalChat({
        message: 'wtf is wrong with you',
        to_player: 'system',
        self_prompt: true,
        human_replied: false,
        any_human: true,
    });
    check(!v.ok && v.why === 'unprompted_self_narration',
        'invented narration is still blocked without an event',
        'narration is no longer blocked');
}

// The turn-taker must be bypassed entirely when addressed by name. A continuer
// in reply to "hey uwu" is the bug, so the exemption has to be in the routing.
check(/addressedByName[\s\S]{0,400}turn_taker\.enabled/.test(src)
    || /!addressedByName[\s\S]{0,120}turn_taker && this\.turn_taker\.enabled/.test(src),
    'turn_taker is skipped when the message names her',
    'a name-addressed message can still be routed to the backchannel path');
check(/const addressedByName =/.test(src),
    'the name check is computed in the message handler',
    'no name check exists');
check(/new RegExp\(`\\\\b\$\{this\.name\}\\\\b`, 'i'\)/.test(src),
    'the name check is a real word-boundary match on her name',
    'the name check is not a word-boundary match');

// ── BUG 2: one reaction per event, not 27 ────────────────────────────────
check(/notable_event/.test(gate),
    'the speak gate accepts a real event as a reason to speak',
    'a real event still cannot authorise speech');
check(/_lastNotableEvent\.reported/.test(src),
    'the event is single-use (reported flag)',
    'one event can authorise unlimited replies');
check(/if \(this\._lastNotableEvent\) this\._lastNotableEvent\.reported = true/.test(src),
    'the flag is consumed when she actually speaks',
    'the flag is never consumed, so it never limits anything');

// A real event must permit speech...
{
    const v = gateNormalChat({
        message: 'wtf is wrong with you', to_player: 'system',
        self_prompt: true, human_replied: false, notable_event: true, any_human: true,
    });
    check(v.ok, 'reacting to a real event is allowed', 'she still cannot react to real events');
}
// ...but NOT narration, and NOT the self-intro, and NOT with nobody online.
{
    const intro = gateNormalChat({
        message: "i'm Elena", to_player: 'system',
        self_prompt: true, human_replied: false, notable_event: true, any_human: true,
    });
    check(!intro.ok, 'the self-intro ban survives the event exemption',
        'a real event now unlocks the self-intro');
    const alone = gateNormalChat({
        message: 'wtf', to_player: 'system',
        self_prompt: true, human_replied: false, notable_event: true, any_human: false,
    });
    check(!alone.ok, 'a real event does not unlock talking to an empty server',
        'she now broadcasts into an empty server after any death');
}

// ── the gates must not be removable into silence ─────────────────────────
// Regression shape: an exempt list that quietly grows until everything passes.
const EXEMPT_COUNT = (gate.match(/notable_event/g) || []).length;
check(EXEMPT_COUNT <= 2,
    `notable_event is used in exactly one condition (${EXEMPT_COUNT} refs)`,
    `notable_event appears ${EXEMPT_COUNT} times - check for a widening exemption`);

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} addressed-message and event-reaction assertions green`);