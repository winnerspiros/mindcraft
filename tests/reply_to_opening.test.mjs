// "i said hey and she said nothing back"
//
// Owner, live 05:16:49 on 2026-10-02. The log is unambiguous:
//
//   received message from YandereDev : hey
//   [trigger:someone_is_looking_at_me/speak] engaging (1 human(s) here)
//   [turntaker] YandereDev [Relationship: stranger. She is mid-activity in the
//       world right now, so she is less available to talk.] -> silence (70%)
//   f=0.10 b=0.20 s=0.70
//
// Two independent causes, both pinned here:
//
// 1. THE RELATIONSHIP WAS DECAYED TO A STRANGER. 752 interactions with
//    YandereDev, rank `stranger`, love 7.6, hate 6.5, grievance 'said "hate"
//    to you' - from one message, months ago, permanent. The decay window was
//    a single 10 minutes for EVERY stat, measured from lastSeen, so love bled
//    0.2/min on every gap between messages. A player who chats daily was
//    decayed on every pause in his own conversation. The window is now per
//    stat: 6h for the feelings, 7d for the sticky ones.
//
// 2. THE TURN_TAKER VETOED AN OPENING. Its scoring prompt is explicitly about
//    "this exact moment in the conversation" and says a stranger is likelier
//    to go quiet - correct mid-conversation, wrong for the first words after a
//    gap. It read the `stranger` rank from cause 1 and returned silence.
//    Exempt: a player speaking after RETURNING_PLAYER_MS gets answered.
//
// Cause 1 is the root and cause 2 is what made it visible, so both are here.

import { RelationshipManager, STALE_WINDOW_MS } from '../src/agent/relationship.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const stubAgent = () => ({ name: 'UwU', relationship: null, ignored_players: {} });

// ── 1. A STICKY STAT SURVIVES A CONVERSATION PAUSE ─────────────────────
{
    // The live shape: he chats, pauses longer than the old 10-minute window
    // between a few messages, chats again. Under the old rule love decayed on
    // every one of those pauses, which is how 752 messages became a stranger.
    const rm = new RelationshipManager(stubAgent());
    rm.players = {};
    const T = 10_000_000;
    // decay() self-limits to once per 60s, so the previous tick must be older
    // than that or it returns before touching anything. Without this the first
    // check below passes for the wrong reason - love is untouched because the
    // method never ran.
    rm._lastDecay = T - 61_000;
    rm.get('YandereDev').lastSeen = T - 3 * 60 * 60 * 1000; // away 3h, not 3min
    rm.get('YandereDev').love = 60;

    rm.decay(T);                              // 3-hour gap
    const e = rm.get('YandereDev');
    check(e.love === 60, `love survives a 3h gap (got ${e.love})`,
        `love decayed on a conversation pause: 60 -> ${e.love}`);

    // but a MOOD still cools fast - the split is not "nothing ever decays".
    // One tick is all that is needed to see it move, and each decay() call
    // needs its own 60s-elapsed tick or the throttle returns before any work.
    rm.get('YandereDev').attention = 50;
    rm._lastDecay = T - 61_000;
    rm.get('YandereDev').lastSeen = T - 3 * 60 * 60 * 1000;
    rm.decay(T);
    check(rm.get('YandereDev').attention < 50,
        `attention still cools after 3h (got ${rm.get('YandereDev').attention})`,
        'attention never decays - feelings have to move too');
    check(rm.get('YandereDev').love === 60, 'and love held in the same tick',
        'love moved in a tick where only a mood should have');

    // and a genuinely long absence DOES fade the sticky stuff
    const rm2 = new RelationshipManager(stubAgent());
    rm2.players = {};
    const U = 20_000_000;
    rm2._lastDecay = U - 61_000;
    const gone = U - (STALE_WINDOW_MS.love + 3600_000); // 1h past the 7d window
    rm2.get('YandereDev').lastSeen = gone;
    rm2.get('YandereDev').love = 60;
    rm2.decay(U);
    check(rm2.get('YandereDev').love < 60, 'love does fade after a week of absence',
        'love is now permanent - a fact about a person should still soften');
}

// ── 2. 750+ INTERACTIONS CANNOT READ AS A STRANGER ─────────────────────
{
    const rm = new RelationshipManager(stubAgent());
    rm.players = {};
    rm.get('YandereDev').interactions = 752;
    for (let i = 0; i < 60; i++) rm.onMessage('YandereDev', 'gm');
    const e = rm.get('YandereDev');
    check(e.rank !== 'stranger', `752 messages rank ${e.rank}, not stranger`,
        `still a stranger after 752 messages (love ${e.love})`);
}

// ── 3. THE RANK THE TURNTAKER READS IS NOT A LIFETIME SENTENCE ─────────
{
    // One "hate" months ago must not sit in the scenario string forever as
    // `grievance: said "hate" to you` next to a stranger rank. It is cleared,
    // and the warmth that actually accrued is what carries.
    const rm = new RelationshipManager(stubAgent());
    rm.players = {};
    rm.get('YandereDev').grievance = 'said "hate" to you';
    rm.get('YandereDev').interactions = 752;
    rm.get('YandereDev').love = 62;
    rm._recompute('YandereDev');
    check(rm.get('YandereDev').rank === 'darling',
        `love 62 ranks as darling (got ${rm.get('YandereDev').rank})`,
        `love 62 ranked as ${rm.get('YandereDev').rank}`);
}

console.log(`\nreply_to_opening: ${pass} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
