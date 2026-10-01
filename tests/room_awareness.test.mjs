// Room awareness: does she defer while two humans are talking to each other?
//
// HUMA (arXiv 2511.17315) is the source for the idea, and the reason this is
// worth building. Its #1 detection cue, cited by 34% of participants who tried
// to spot the AI, was "response speed/consistency" - and its second was language
// patterns. The architecture that paper proposes to fix this is a Router that
// decides BEFORE the LLM is called, with "Keep Silent" as a first-class strategy
// exempt from its timeliness penalty.
//
// HUMA is a FACILITATOR and reports no peer-level baselines at all, so none of
// its numbers are portable. What transfers is the structural idea: the decision
// to stay quiet belongs before generation, not in the persona script. A prompt
// cannot make her wait; only code can.
//
// Measured before this change: 42 interruptions in 12,953 turns (0.3%). All 42
// are legacy yandere output ("my beloved", Rcon gift spam), so the low rate was
// the absence of the behaviour, not evidence of the behaviour.

import { readFileSync } from 'node:fs';
import { SelfPrompter } from '../src/agent/self_prompter.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const mk = () => {
    const sp = new SelfPrompter({ name: 'UwU', bot: null });
    sp._last_human_at = 0;
    sp._last_human_speaker = null;
    sp._human_exchange_speakers = 0;
    return sp;
};

// ── one human talking: her floor, she is free to join ─────────────────────
{
    const sp = mk();
    sp.noteHumanTurn('YandereDev');
    check(!sp.humanExchangeInProgress(),
        'one human speaking is not a human-human exchange',
        'a single speaker was treated as an exchange');
    sp.noteHumanTurn('YandereDev');
    sp.noteHumanTurn('YandereDev');
    check(!sp.humanExchangeInProgress(),
        'the same person talking repeatedly is still one speaker',
        'one person repeating themselves counted as a group exchange');
}

// ── two humans alternating: an exchange is under way ──────────────────────
{
    const sp = mk();
    sp.noteHumanTurn('YandereDev');
    check(!sp.humanExchangeInProgress(), 'no exchange before anyone replies', 'spurious exchange');
    sp.noteHumanTurn('Abstrakto754');
    check(sp.humanExchangeInProgress(),
        'a second human replying starts a human-human exchange',
        'two humans talking were not detected as an exchange');
    sp.noteHumanTurn('YandereDev');
    check(sp.humanExchangeInProgress(),
        'it stays in progress while they keep trading',
        'exchange cleared mid-conversation');
}

// ── her own voice is not a human speaker ─────────────────────────────────
{
    const sp = mk();
    sp.noteHumanTurn('YandereDev');
    sp.noteHumanTurn('UwU');
    check(!sp.humanExchangeInProgress(),
        'her own turn does not create a human-human exchange',
        'she treated her own message as a second human');
    sp.noteHumanTurn('');
    sp.noteHumanTurn(undefined);
    check(!sp.humanExchangeInProgress(), 'empty usernames are ignored', 'blank speaker counted');
}

// ── it expires: a dead thread is not still in progress ───────────────────
{
    const sp = mk();
    sp.noteHumanTurn('YandereDev');
    sp.noteHumanTurn('Abstrakto754');
    check(sp.humanExchangeInProgress(), 'exchange active', 'setup failed');
    // Pretend the last human message was long ago.
    sp._last_human_at = Date.now() - 10 * 60 * 1000;
    check(!sp.humanExchangeInProgress(),
        'a thread that ended 10 min ago is no longer "in progress"',
        'a stale exchange never expires - she would defer to a dead conversation');
    sp._last_human_at = Date.now() - 10 * 60 * 1000;
    sp._human_exchange_speakers = 2;
    sp._decayEngagement();
    check(sp._human_exchange_speakers === 0,
        'the tick path decays the counter too',
        'counter never decayed on the game tick');
}

// ── the gate is wired where it can actually gate something ───────────────
{
    const modes = readFileSync('src/agent/modes.js', 'utf8');
    check(/humanExchangeInProgress\(\)/.test(modes),
        'modes.js consults humanExchangeInProgress before speaking',
        'the room tracker is never consulted - it is dead code');
    check(/humansTalking\s*&&\s*!addressedByName/.test(modes),
        'being addressed by name overrides the deferral',
        'she defers even when addressed directly by name');
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    check(/noteHumanTurn\(/.test(agent),
        'agent.js feeds real human messages into the tracker',
        'nothing populates the room tracker');
}

// ── capability parity: this must not disable normal mode ────────────────
{
    const modes = readFileSync('src/agent/modes.js', 'utf8');
    const idx = modes.indexOf('humanExchangeInProgress');
    const window = modes.slice(Math.max(0, idx - 700), idx + 700);
    check(!/if\s*\(!isYandere\(\)\)\s*return/.test(window),
        'no bare return that would disable normal mode',
        'the room gate disables normal mode entirely');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} room-awareness assertions green`);