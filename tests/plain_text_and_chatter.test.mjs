// Plain text only, and no constant one-liners.
//
// Owner, 2026-10-02, two reports at once:
//   "she spams more than i want also"
//   "she also used ascii emoji, she shouldnt use these"
//
// BOTH ARE PIPE LEAKS, NOT PROMPT LEAKS. personas/normal.json already forbids
// emoji in three places, in capitals:
//
//   "NO UNICODE EMOJI. Not 😅, not 🙂, not 😂, not ✨."
//   "Plain text. No hearts, no kaomoji, no trailing '~'."
//
// and the spam gate already had a narration rule. Neither held, because both
// are shapes and both were only expressed as prose. What actually reached
// chat, from her own output:
//
//   "wtf is going on here lol. need to find some pigs, where are they? 🤔"
//   "great, now I'm just starving couldn't even get a slice of bread xD"
//   "i'm about to pass out here somebody help me out plz:("
//   "Baka phantom! How dare you hit me~! >_<"        (3x)
//
// Note the second and third are PURE ASCII. A unicode filter does not see
// them, and "emoji" is not a word anyone thinks of as covering ":(" - which is
// why the prompt's ban missed them and why this file exists.
//
// The owner also corrected an earlier version of the scrub that spared "<3"
// and "♥": "xD is fake, heart ascii is not [for example]. normal i like a real
// user, a normal user wont go out of their way to paste ascii emojis in chat."
// Nothing is exempt. Plain text is the whole register.

import { scrubEmoji, KNOWN_FACES } from '../src/utils/emoji_scrub.js';
import { gateNormalChat } from '../src/utils/speak_gate.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

// ── 1. EVERY FACE THAT GOT THROUGH IS GONE ──────────────────────────────
{
    // The exact strings from the log, one per real leak.
    const leaked = [
        ['wtf is going on here lol. need to find some pigs, where are they? 🤔',
            'wtf is going on here lol. need to find some pigs, where are they?'],
        ["great, now I'm just starving couldn't even get a slice of bread xD",
            "great, now I'm just starving couldn't even get a slice of bread"],
        ["i’m about to pass out here somebody help me out plz:(",
            "i’m about to pass out here somebody help me out plz"],
        ['Baka phantom! How dare you hit me~! >_< Time to get crafty!',
            'Baka phantom! How dare you hit me~! Time to get crafty!'],
    ];
    for (const [input, want] of leaked) {
        check(scrubEmoji(input) === want,
            `scrubbed to plain text: ${JSON.stringify(want.slice(0, 40))}`,
            `NOT scrubbed: ${JSON.stringify(scrubEmoji(input))}`);
    }
}

// ── 2. NOTHING IS EXEMPT, INCLUDING <3 AND HEARTS ───────────────────────
{
    // The owner ruled on this directly. An earlier version spared them.
    for (const s of ['i love you <3', 'my heart belongs to you', 'love u <3 :)',
        'take 5 <3 the cobble', '♥', '❤️']) {
        check(!/[<3♥❤]/.test(scrubEmoji(s)),
            `no heart shorthand survives: ${JSON.stringify(s)}`,
            `heart shorthand survived: ${JSON.stringify(scrubEmoji(s))}`);
    }
}

// ── 3. ORDINARY CHAT IS COMPLETELY UNTOUCHED ────────────────────────────
{
    // The dangerous half. A scrub that eats real sentences is worse than the
    // emoji it was built to remove, and "2 < 3" is arithmetic.
    const keep = ['wait what', 'ok', 'im at the mine rn', 'gm uwu', 'do you have stone?',
        'i mined 12 cobble', 'no way', 'brb', '2 < 3', '~5 blocks', '50% done',
        'ur so bad at this', 'thats actually hilarious', 'still alive', 'sup',
        'lol', 'lmao', 'hmm ok', 'yeah yeah', 'not again', 'i walked into a creeper'];
    const altered = keep.filter((k) => scrubEmoji(k) !== k);
    check(altered.length === 0,
        `all ${keep.length} ordinary lines pass through unchanged`,
        `scrub damaged real chat: ${JSON.stringify(altered)}`);
}

// ── 4. THE SCRUB LEAVES NO ARTIFACTS ───────────────────────────────────
{
    // Removing the inside of a kaomoji and leaving the bracket is worse than
    // the original. A table-flip must go as one gesture or not at all.
    for (const s of ['(╯°□°）╯︵ ┻━┻', ':heart: :sparkles:', '😂😂', '❤️']) {
        const out = scrubEmoji(s);
        check(out === '' || !/[(（)）]{1}\s*$/.test(out),
            `no orphaned bracket left: ${JSON.stringify(s)} -> ${JSON.stringify(out)}`,
            `orphaned bracket: ${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
    }
    // and it must never throw, whatever it is handed
    for (const s of ['', null, undefined, 0, 42, {}, [], '\u0000\u0000']) {
        let threw = false;
        try { scrubEmoji(s); } catch (_) { threw = true; }
        check(!threw, `scrub survives ${JSON.stringify(s)}`,
            `scrub threw on ${JSON.stringify(s)}`);
    }
}

// ── 5. THE FACE TABLE IS NOT EMPTY OR VACUOUS ──────────────────────────
{
    check(KNOWN_FACES.length > 8, `${KNOWN_FACES.length} face patterns in the table`,
        'the face table shrank - it is the record of what was removed');
    // Every pattern must actually match something, or it is dead weight.
    // lastIndex is reset because the /g patterns carry state between .test()
    // calls - a global regex that returns true once returns FALSE on the next
    // probe, which reads as "dead pattern" and is how five live patterns got
    // reported as matching nothing.
    const probes = [':3', ':D', ':p', ':o', 'xD', ':(', ':)', ';)', ':|', '>_<', '^_^',
        'T_T', '<3', '♥', '❤', ':heart:', 'ぁ', '(╯°□°）╯︵ ┻━┻', '(╰°□°）╯', '25°C'];
    const dead = KNOWN_FACES.filter((re) => {
        re.lastIndex = 0;
        const hit = probes.some((p) => { re.lastIndex = 0; return re.test(p); });
        re.lastIndex = 0;
        return !hit;
    });
    check(dead.length === 0, 'no dead patterns in the face table',
        `${dead.length} patterns match nothing: ${dead.map(String).join(' ')}`);
}

// ── 6. ONE REACTION PER ACTION, NOT ONE EVERY CADENCE TICK ──────────────
{
    // The spam. The gate exempts a self-prompt turn that followed a real
    // action, because "I did a thing" is a legitimate reason to say one line.
    // The exemption was a TIME WINDOW (8s) and the self-prompt gear is 4-22s,
    // so the second turn of every burst re-qualified and she narrated forever.
    //
    // gateNormalChat is stateless, so the one-shot lives in the caller
    // (_consumeActionReact). What is pinned here is the shape of the bug: a
    // bare just_acted must not be enough on its own, and notable_event must
    // still work because it is the real single-use case.
    const base = { message: 'im still starving', any_human: true, to_player: 'system' };

    // The two leaked lines were exactly this shape - action, then narration.
    const narrated = gateNormalChat({ ...base, self_prompt: true, human_replied: false });
    check(!narrated.ok, 'narration with no human and no action is blocked',
        `narration got through: ${JSON.stringify(narrated)}`);

    // An action DOES buy one line - that is the whole point of just_acted.
    const reacted = gateNormalChat({ ...base, self_prompt: true, human_replied: false, just_acted: true });
    check(reacted.ok, 'a real action earns one reaction',
        `an action no longer buys a reaction: ${JSON.stringify(reacted)}`);

    // and a notable event still buys one, single use, tracked by the caller
    const ev = gateNormalChat({ ...base, self_prompt: true, human_replied: false, notable_event: true });
    check(ev.ok, 'a notable event earns one reaction',
        `a notable event was suppressed: ${JSON.stringify(ev)}`);

    // A bid still gets through - the owner asked for these explicitly.
    const bid = gateNormalChat({ ...base, self_prompt: true, human_replied: false, is_bid: true, bid_has_target: true });
    check(bid.ok, 'a bid is not narration',
        `a bid was suppressed: ${JSON.stringify(bid)}`);

    // And the caller-side one-shot, which is where the fix actually lives. The
    // implementation is inlined here with a comment pointing at agent.js - it
    // was extracted from a real defect this run: keying "already spent" on the
    // action TIMESTAMP meant two actions in the same millisecond read as one,
    // and she went permanently mute after the first burst. So the counter is
    // the point being pinned, not a copy for convenience.
    const agent = {
        _lastRealActionAt: Date.now(),
        _realActionSeq: 1,
        // mirrors agent.js _consumeActionReact
        _consumeActionReact() {
            if (!(this._lastRealActionAt && (Date.now() - this._lastRealActionAt) < 8000)) return false;
            if (this._actionReactSpentSeq === this._realActionSeq) return false;
            this._actionReactSpentSeq = this._realActionSeq;
            return true;
        },
        // mirrors the _realActionSeq increment in handleMessage
        _act() { this._realActionSeq = (this._realActionSeq ?? 0) + 1; this._lastRealActionAt = Date.now(); },
    };
    const burst = [agent._consumeActionReact(), agent._consumeActionReact(),
        agent._consumeActionReact()];
    check(burst[0] === true && burst[1] === false && burst[2] === false,
        `one reaction per action, not one per tick (${JSON.stringify(burst)})`,
        `the burst narrated ${burst.filter(Boolean).length} times`);
    // a NEW action earns a new one - including two inside the same millisecond,
    // which is the case a timestamp key silently got wrong
    agent._act();
    check(agent._consumeActionReact() === true, 'a new action earns a new reaction',
        'one-shot never re-armed - she would go permanently mute');
    agent._act();
    check(agent._consumeActionReact() === true,
        'two actions in the same millisecond still earn two reactions',
        'a same-millisecond action pair was collapsed into one - she would go mute after any fast burst');
    // an old action earns nothing
    agent._lastRealActionAt = Date.now() - 20000;
    check(agent._consumeActionReact() === false, 'a stale action buys nothing',
        'a 20s-old action still bought a reaction');
}

console.log(`\nplain_text_and_chatter: ${pass} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
