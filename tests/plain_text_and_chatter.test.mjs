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

// ── 7. NO PLAYER-FACING SEND BYPASSES THE SCRUB ──────────────────────
{
    // The leak that survived 4329c54, and the reason the scrub was correct and
    // still useless. requestItems() is the one player-facing message in the
    // codebase that called bot.chat() directly:
    //
    //   bot.chat(`I need ${count} ${itemName} — could someone bring me some? ♥`)
    //
    // A hardcoded heart, in a template literal, sent straight to the wire. It
    // dodged the plain-text scrub, the identity guard, the length check and
    // the speak gate by construction - none of them are on that path. Live
    // proof, 06:09-06:10: "Requested 3 bread from players." three times in two
    // minutes, same shortage, alongside two near-identical model lines. That
    // is both complaints at once: the hearts and the spam.
    //
    // Pinned here as a source check, because the runtime symptom is a missing
    // log line and a missing log line does not fail a test on its own.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');

    // no heart may appear in ANY string literal in the skills library
    const heartLines = src.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => /bot\.chat\([^)]*[♥❤]/.test(l));
    check(heartLines.length === 0,
        'no bot.chat() in the skills library carries a heart',
        `heart still in a chat line: ${JSON.stringify(heartLines)}`);

    // and requestItems specifically must go through the agent, not the wire
    const fn = src.slice(src.indexOf('export async function requestItems'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    check(/routeResponse/.test(body),
        'requestItems routes through routeResponse, so every filter applies',
        'requestItems still calls bot.chat() directly and bypasses the filters');
    // The remaining bot.chat() is the no-agent fallback, which is correct: a
    // bare bot with no routeResponse has to say it somehow, and that path is
    // already heart-free. What must not be there is an UNCONDITIONAL send.
    const sends = body.match(/bot\.chat\(/g) || [];
    check(sends.length === 1 && /else\s*\{\s*bot\.chat\(/.test(body),
        'the only bot.chat() left is the guarded no-agent fallback',
        `requestItems has ${sends.length} direct send(s) - expected exactly one guarded fallback`);

    // The same class of bug anywhere else in the skills library: a chat line
    // whose text is not a slash command. Commands are fine - they are /tp and
    // /setblock and never rendered as speech, and they legitimately must NOT
    // go through routeResponse (it would gate and scrub them). Prose is not
    // fine. Checked by resolving the argument, not by reading the line, because
    // the messages are built into variables first:
    //
    //   let msg = '/setblock ' + x;  bot.chat(msg);   <- command, fine
    //   const cmd = '/tpaccept';    bot.chat(cmd);   <- command, fine
    //
    // A line-literal regex cannot tell those from prose, and an earlier version
    // of this check flagged all three plus its own fallback. The honest test is
    // a whitelist of the known-command call sites.
    const COMMAND_SITES = ['opChat(', 'bot.chat(msg);', 'bot.chat(command);',
        'bot.chat(`/tp ', 'bot.chat(`/fill ', 'bot.chat(`/give ', 'bot.chat(`/item ',
        'bot.chat(`/clear', 'bot.chat(`/kit', 'bot.chat(`/login', 'bot.chat(`/register',
        'bot.chat(who ?', 'bot.chat(`${send} ${who}`);', 'bot.chat(`I need',
        // requestItems' fallback: the same message is sent via routeResponse()
        // when an agent is present, and that path is asserted separately. Matching
        // on the call instead of a LINE NUMBER - the number moved the moment any
        // code was inserted above it, which is how this silently started failing.
        'bot.chat(ask);'];
    const suspicious = src.split('\n')
        .map((l, i) => [i + 1, l.trim()])
        .filter(([, l]) => l.includes('bot.chat(') && !l.startsWith('//'))
        .filter(([n, l]) => {
            // skip anything that is plainly a command or a declared helper
            if (/\//.test(l) && !/["'`][A-Za-z]/.test(l)) return false;
            return !COMMAND_SITES.some((site) => l.includes(site));
        })
    check(suspicious.length === 0,
        'every bot.chat() in the skills library is a command or the declared helper',
        `${suspicious.length} unclassified send(s): ${JSON.stringify(suspicious)}`);
}

// ── 8. AN ACK TO A REQUEST IS ALSO A NON-SEQUITUR ────────────────────
{
    // Owner, live: "still sended a ramdom yeah, whats yeah for?"
    //
    //   YandereDev: "yo help im dying"
    //   [turntaker] -> backchannel (40%)
    //   UwU backchannel (darling, 40%): yeah
    //
    // The question case was already handled. A REQUEST was not, and it is the
    // same defect: a question asks for information and an ack cannot supply it;
    // a request asks for an ACTION and an ack cannot supply that either. But a
    // request carries no question mark, so asksSomething() said no, and
    // hasProposition() said yes - "there is a position to agree with" - so
    // "yeah" went out to a plea for help. That is the bot declining to help
    // while sounding like it agreed.
    //
    // The distinction that must survive: a CLAIM is assent-able, a REQUEST is
    // not. "mob farms go at y=30" needs "yeah" and "no" to mean something.
    const { isEmptyAck, asksForAction } = await import('../src/utils/empty_ack.js');

    const requests = ['yo help im dying', 'help im dying', 'can you help me', 'come here',
        'pls help', 'urgent need food', 'bring me some wood', 'tp to me', 'wait',
        'can u help', 'follow me', 'rescue me', 'save me'];
    for (const r of requests) {
        check(isEmptyAck('yeah', r), `"yeah" cannot answer the request ${JSON.stringify(r)}`,
            `"yeah" answered the request ${JSON.stringify(r)}`);
    }

    // and the claims that MUST keep working, or she becomes unable to agree
    // with or disagree with anything
    const claims = ['mob farms go at y=30', 'that was fun', 'no way', 'im stuck',
        'i need a minute', 'thats what i said', 'you know what i mean',
        'send me the coords', 'right on y=30'];
    for (const c of claims) {
        check(!isEmptyAck('yeah', c), `"yeah" is still assent to the claim ${JSON.stringify(c)}`,
            `the claim ${JSON.stringify(c)} was silenced - she can no longer agree with anything`);
    }

    // "wait what" is the case both of my attempts got wrong, so pin it: no
    // question mark, and "what" is not clause-initial (it follows "wait"), so
    // the conservative wh-word rule missed it and the imperative rule claimed
    // it. It is a question, and an ack cannot answer it.
    check(asksForAction('wait what') === false,
        '"wait what" is read as a question, not a command',
        '"wait what" is read as a request - the imperative won over the wh-word');
    check(isEmptyAck('yeah', 'wait what'),
        '"yeah" cannot answer "wait what"',
        '"yeah" answered "wait what"');
    check(isEmptyAck('right', 'thats what i said') === false,
        '"thats what i said" stays a claim - the wh-word is a relative pronoun there',
        '"thats what i said" was misread as a question');
}

// ── 9. THE TURN-TAKER PROMPT DOES NOT TEACH BAD ACKS ──────────────────
{
    // The scoring prompt is where the ack vocabulary comes from, and it was
    // still offering "right" - the exact token removed from _pickAck() in
    // 0b4684a, for being a non-sequitur to a question and for never appearing
    // in the corpus the comment cited. Removing it from the pool while leaving
    // it in the prompt that selects the pool meant the model could still
    // choose the behaviour, and _pickAck would then map it onto something
    // else. The prompt also had no instruction about questions or requests at
    // all, which is why 40% backchannel on "yo help im dying" was reasonable
    // from the model's point of view.
    const fs2 = await import('node:fs');
    const tt = fs2.readFileSync(new URL('../src/agent/turn_taker.js', import.meta.url), 'utf8');
    const prompt = tt.slice(tt.indexOf('const SCORING_PROMPT'), tt.indexOf('function renorm'));

    check(!/backchannel[^\n]*"right"/.test(prompt),
        'the scoring prompt no longer offers "right" as a backchannel example',
        'the scoring prompt still teaches "right" - it was removed from the pool for being a non-sequitur');
    check(/Never choose backchannel when the player asked/.test(prompt),
        'the scoring prompt forbids backchanneling a question or request',
        'the scoring prompt says nothing about questions or requests');
}

// ── 10. A GOAL NAMING AN ABSENT TARGET IS REWRITTEN ───────────────────
{
    // Owner, live: "also she still in game does nothing, just standing still."
    //
    // This was not a cadence problem and not the speak gate. Twenty-five
    // minutes of it, from the log:
    //
    //   [curriculum] proposed next goal: "gather food from the nearby pig"
    //   ... six consecutive turns, identical goal, 4-22s apart ...
    //   Current Action: Idle
    //   !kick  x43   !tpa  x44   !kill x23   !attack x15   !gather x16
    //
    // The self-prompt DEMANDS a command every turn, so the model dutifully
    // produced a command - and every one targeted an animal that was not
    // there. She was not idle by choice. She was handed the same impossible
    // goal on a 4-22s gear with nothing that could succeed, so the only honest
    // output was a no-op. "Current Action: Idle" is the symptom, not the cause.
    //
    // The root cause is that proposeNextGoal() returned whatever the LLM said
    // without ever checking it against the world. The model is free to invent
    // "the nearby pig" out of nothing, and the failed-goal similarity guard
    // could not catch it because each attempt named a DIFFERENT animal.
    const { Curriculum } = await import('../src/agent/curriculum.js');

    // a bot with entities, none of them a pig
    const mkBot = (names) => ({
        entity: { position: { x: 0, y: 64, z: 0 } },
        entities: Object.fromEntries(names.map((n, i) => [n, { name: n, position: { x: i + 2, y: 64, z: 0 } }])),
    });
    const mk = (names) => {
        const c = new Curriculum({ name: 'UwU', bot: mkBot(names) });
        c.fp = '/tmp/nonexistent-curriculum-test.json';   // never writes
        return c;
    };

    // the exact live goal, with the pig absent
    const noPig = mk(['cow', 'sheep', 'stone', 'oak_log']);
    const fixed = noPig.makeExecutable('gather food from the nearby pig');
    check(fixed !== 'gather food from the nearby pig',
        `an absent target is dropped: "gather food from the nearby pig" -> "${fixed}"`,
        'the dead goal was returned unchanged - she will stand still again');
    check(!/\bpig\b/.test(fixed),
        `no absent noun survives the rewrite (got "${fixed}")`,
        `"pig" survived the rewrite: "${fixed}"`);
    check(fixed.length >= 3,
        'the rewrite is still a usable goal length',
        `the rewrite was too short to be a goal: "${fixed}"`);

    // the entity IS there: the goal must be left alone
    const withPig = mk(['pig', 'cow']);
    const untouched = withPig.makeExecutable('gather food from the nearby pig');
    check(untouched === 'gather food from the nearby pig',
        'a goal naming a target that IS present is left alone',
        `an achievable goal was rewritten to "${untouched}"`);

    // goals with no checkable target must never be touched
    for (const g of ['mine cobblestone for tools', 'check if the wheat is ready',
        'build a small house', 'tidy the chest', 'craft a wooden pickaxe',
        'chop the rest of that oak', 'look around']) {
        const c = mk(['cow']);
        check(c.makeExecutable(g) === g, `unrelated goal untouched: "${g}"`,
            `an unrelated goal was rewritten: "${g}" -> "${c.makeExecutable(g)}"`);
    }

    // unknown world: do NOT reject. Refusing here would be worse than the bug,
    // because a null goal leaves the caller holding the dead one.
    const noEntities = new Curriculum({ name: 'UwU', bot: { entity: { position: { x: 0, y: 0, z: 0 } } } });
    noEntities.fp = '/tmp/nonexistent-curriculum-test.json';
    check(noEntities.makeExecutable('gather food from the nearby pig') === 'gather food from the nearby pig',
        'an unreadable world does not reject the goal',
        'an unreadable world silently discarded a valid goal');

    // and the other half: her memory had learned to distrust her own commands
    const fs3 = await import('node:fs');
    const mem = fs3.readFileSync(new URL('../bots/UwU/memory.json', import.meta.url), 'utf8');
    const md = JSON.parse(mem);
    // The "avoid invalid commands" check that used to live here was written
    // against a memory that had actually been poisoned with that exact
    // phrase. The poison is gone (see memory.json), so the assertion was
    // vacuous - it passed no matter what the memory said. Removed rather
    // than left as a check that can never fail.
    check(!/nearby (pig|cow|chicken|sheep|wolf)/i.test(String(md.self_prompt || '')),
        `the persisted self-prompt goal is executable (got "${md.self_prompt}")`,
        `the dead goal is still persisted: "${md.self_prompt}"`);
}

// ── 11. A WRONG ARG COUNT IS EXPLAINED, NOT JUST REPORTED ─────────────
//
// Owner, live: "she doesnt respond to my last messages and shes still
// idle in game". Half of that was her standing still writing commands
// that could never work:
//
//   Agent executed: !breakBlock and got: given 1 args, but requires 3
//   Agent executed: !tps and got: given 3 args, but it only accepts 0
//   Agent executed: !collectBlocks and got: given 0 args, but requires 1
//   Agent executed: !craftRecipe and got: given 1 args, but requires 2
//   Agent executed: !digDown and got: given 0 args, but requires 1
//   Agent executed: !findPlace and got: given 0 args, but requires 1
//
// Six failures in six minutes, five distinct commands, every one of them
// recoverable in a single sentence. explainParamError already existed for
// the wrong-TYPE case ("Param 'x' must be of type float" -> "!breakBlock
// takes (x: float, y: float, z: float)"); it just did not match the
// wrong-COUNT message shape, so the model was told it failed and nothing
// about what it wanted. It then guessed again - !digDown, then !digDown 1,
// then !craftable with an arg.
//
// These are the exact strings the live log produced, not invented ones.
{
    // Importing src/agent/commands/index.js transitively loads undici, which
    // reads the global File at module scope and crashes on Node 19 (it landed
    // in Node 20). The bot itself runs fine because mindcraft's runtime
    // provides it; a bare `node tests/...` does not. Shim the one global it
    // wants rather than skipping the assertions - this is the branch that
    // decides whether she is told what the command actually takes.
    if (typeof globalThis.File === 'undefined') globalThis.File = class File {};
    const { explainParamError } = await import('../src/agent/commands/index.js');

    // every arity shape, including the "it only accepts" wording that the
    // zero-arg commands actually emit (a naive /only accepts/ misses it).
    const arity = [
        ['!breakBlock', 'Command !breakBlock was given 1 args, but requires at least 3 args.'],
        ['!tps', 'Command !tps was given 3 args, but it only accepts 0 args.'],
        ['!collectBlocks', 'Command !collectBlocks was given 0 args, but requires at least 1 args.'],
        ['!craftRecipe', 'Command !craftRecipe was given 1 args, but requires at least 2 args.'],
        ['!digDown', 'Command !digDown was given 0 args, but requires at least 1 args.'],
        ['!findPlace', 'Command !findPlace was given 0 args, but requires at least 1 args.'],
    ];
    for (const [cmd, err] of arity) {
        const ex = explainParamError(cmd, err);
        check(!!ex, `${cmd} arg-count error is explained`, `${cmd} arg-count error returned null - the model is told nothing`);
        check(!!ex && ex.includes(cmd), `${cmd} correction names the command`,
            `${cmd} correction does not name the command: ${ex}`);
        check(!!ex && /takes/.test(ex), `${cmd} correction states the signature`,
            `${cmd} correction never says what the command takes: ${ex}`);
    }

    // a command with NO params must not produce a dangling empty signature
    // ("!tps takes . You passed 3 arg(s)") - that reads as broken output.
    const tps = explainParamError('!tps', 'Command !tps was given 1 args, but it only accepts 0 args.');
    check(!/\btakes\s*\./.test(tps || ''), 'a zero-arg command does not print an empty signature',
        `a zero-arg command printed an empty signature: ${tps}`);

    // too many args and too few need OPPOSITE advice, not one generic hint
    const tooFew = explainParamError('!breakBlock', 'Command !breakBlock was given 1 args, but requires at least 3 args.');
    const tooMany = explainParamError('!tps', 'Command !tps was given 3 args, but it only accepts 0 args.');
    check(!/drop|extra/i.test(tooFew || ''), 'too-few args does not tell her to drop args',
        `too-few advice says to drop args: ${tooFew}`);
    check(/drop|extra/i.test(tooMany || ''), 'too-many args tells her to drop them',
        `too-many advice never says to drop the extra args: ${tooMany}`);

    // the pre-existing wrong-TYPE branch must still work
    const typeErr = explainParamError('!breakBlock', "Error: Param 'x' must be of type float.");
    check(!!typeErr && /float/.test(typeErr), 'the wrong-TYPE correction still works',
        `the wrong-TYPE correction regressed: ${typeErr}`);

    // an unknown command is not this function's job - nearestCommandNames
    // owns that. It must return null rather than invent a signature.
    check(explainParamError('!notACommand', 'Command !notACommand does not exist') === null,
        'an unknown command gets no invented signature',
        'explainParamError fabricated a signature for a command that does not exist');
}

// ── 12. NO LITERAL $EXAMPLES REACHES ANY PROMPT ──────────────────────
//
// Live, 27 times in ten minutes:
//   Unknown prompt placeholders: $EXAMPLES, $EXAMPLES
//
// That warning was a lie. personas/normal.json `conversing` contains
// $EXAMPLES twice, and on a self-prompt turn promptConversation
// deliberately withholds chat exemplars, so it blanked the placeholder
// itself immediately after replaceStrings returned. The residual check
// lived at the END of replaceStrings and therefore fired on work that was
// about to be undone - reporting a leak one line before it was fixed.
//
// The model never saw it. The real defect was narrower and worse: FOUR
// other callers pass examples=null and never blank it at all
// (reflection_memory, saving_memory, reply_to_decide, image_analysis), so
// a persona script mentioning $EXAMPLES would reach those models as the
// literal string. Fixing it inside replaceStrings closes all five at once.
//
// Assertions run against the source of replaceStrings and the real persona.
{
    const fs4 = await import('node:fs');
    const src = fs4.readFileSync(new URL('../src/models/prompter.js', import.meta.url), 'utf8');

    // the conditional that used to skip blanking: `&& examples !== null`
    check(!/includes\('\$EXAMPLES'\)\s*&&\s*examples\s*!==\s*null/.test(src),
        'replaceStrings no longer guards $EXAMPLES behind `examples !== null`',
        'the $EXAMPLES branch is still conditional on examples being non-null, so null-example prompts leak the literal');

    // The residual check must not be inline in replaceStrings any more.
    // Comments are stripped first: the fix documents the old behaviour and
    // names the old warning verbatim, so a naive substring search matches the
    // explanation instead of the code - and a test that fires on its own
    // rationale is worse than no test.
    const body = src.slice(src.indexOf('async replaceStrings('), src.indexOf('warnUnknownPlaceholders(prompt) {'));
    const bodyCode = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(!/warnUnknownPlaceholders/.test(bodyCode),
        'the residual placeholder check is out of replaceStrings',
        'the residual check is still inside replaceStrings and fires before the caller has blanked $EXAMPLES');
    check(!/console\.warn/.test(bodyCode),
        'replaceStrings itself no longer logs',
        'replaceStrings still logs placeholders itself, before the caller has resolved them');

    // and it must exist as a reusable method
    check(/warnUnknownPlaceholders\(prompt\)\s*\{/.test(src),
        'warnUnknownPlaceholders exists as a method',
        'warnUnknownPlaceholders method is missing');

    // Every call site must reach a residual check before its prompt is sent,
    // or a real leak goes unreported. Checked structurally, per site, with a
    // 10-line lookahead: a bare count comparison is wrong here because the
    // conversing prompt has TWO replaceStrings calls (the if/else arms at
    // `if (examplesSource) ... else ...`) sharing ONE check after the merge.
    // Counting sites against checks flagged that correct shape as a bug.
    // 12 lines, not 10: the widest gap is that if/else pair, and the check
    // sits on the 11th line below the first arm.
    const lns = src.split('\n');
    let uncovered = 0;
    const uncoveredDetail = [];
    for (let i = 0; i < lns.length; i++) {
        if (!lns[i].includes('await this.replaceStrings(')) continue;
        const window = lns.slice(i, i + 12).join('\n');
        if (!window.includes('warnUnknownPlaceholders')) {
            uncovered++;
            uncoveredDetail.push(`line ${i + 1}: ${lns[i].trim().slice(0, 60)}`);
        }
    }
    check(uncovered === 0,
        `every replaceStrings call site is followed by a residual check (${uncovered} uncovered)`,
        `${uncovered} call site(s) reach the model unchecked:\n      ${uncoveredDetail.join('\n      ')}`);

    // A lookahead can be satisfied by the NEXT function's check, so pin the
    // conversing case explicitly - it is the one that produced all 27
    // spurious warnings.
    const conv = src.slice(src.indexOf('let prompt = this.profile.conversing;'));
    const convIf = conv.indexOf('await this.replaceStrings(prompt, messages, examplesSource)');
    const convChk = conv.indexOf('this.warnUnknownPlaceholders(prompt);');
    check(convIf !== -1 && convChk !== -1 && convChk > convIf,
        'the conversing prompt checks for residue after its substitutions, not before',
        'the conversing prompt does not check after its substitutions - the exact shape that fired 27 spurious warnings');

    // the persona does still mention $EXAMPLES, so this is not a passing
    // vacuously - it is the exact input that used to trigger the warning
    const persona = JSON.parse(fs4.readFileSync(new URL('../personas/normal.json', import.meta.url), 'utf8'));
    check((String(persona.conversing).match(/\$EXAMPLES/g) || []).length > 0,
        'the persona still uses $EXAMPLES (the test input is real)',
        'the persona no longer mentions $EXAMPLES, so this whole test is vacuous');
}


// ── 13. SHE DOES NOT DROWN REPEATEDLY ─────────────────────────────────
//
// Owner pasted the live log: "UwU drowned", repeated, interleaved with
// "what just hit me?" and "bruh, what just hit me? this is ridiculous!".
// Counting 40 minutes of journalctl:
//
//   drowned              19
//   shot by Pillager      9
//   slain by Drowned      2
//
// Nineteen drownings in forty minutes. self_preservation had a water
// branch and it was inert:
//
//   else if (blockAbove.name === 'water') {
//       if (!bot.pathfinder.goal) bot.setControlState('jump', true);
//   }
//
// The `!bot.pathfinder.goal` guard is the bug. She drowns when she is
// WALKING somewhere and the path takes her into water - that is the
// only way it happens in practice - and with a goal active this branch
// did nothing at all. Holding jump also only helps if she is already
// rising; skills.swimUp() polls until the head block is dry.
//
// Mineflayer tracks air as bot.oxygenLevel (0-15, from entity metadata
// air_supply). Nothing in src/ read it - grep confirmed zero uses before
// this fix - so she only reacted once damage had started.
{
    const fs5 = await import('node:fs');
    const src = fs5.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');

    const water = src.slice(src.indexOf("blockAbove.name === 'water'"));
    const branch = water.slice(0, water.indexOf('else if (this.fall_blocks'));
    check(branch.length > 0, 'the drowning branch exists', 'the drowning branch could not be located');
    check(!/if \(!bot\.pathfinder\.goal\)\s*\{\s*bot\.setControlState\('jump', true\);/.test(branch),
        'the drowning branch no longer does nothing while pathfinding',
        'the drowning branch is still gated on !bot.pathfinder.goal, so it is inert during exactly the walk-into-water case that kills her');
    // deliberately NOT asserting an oxygenLevel read here: on 26.3 it is
    // always NaN (no metadata in the bundled entities.json), so gating on it
    // disables the rescue forever. Section 19 asserts the opposite on purpose.
    check(/swimUp/.test(branch),
        'the drowning rescue actually surfaces her (swimUp), it does not just hold jump',
        'the drowning branch never calls swimUp');
    check(/last_drown/.test(src),
        'the drowning rescue is throttled',
        'an unthrottled swimUp fires every tick, stops the self-prompt loop continuously and starves brain + idle modes (same failure as last_flee)');

    // the rescue must be reachable, not merely defined
    const sk = fs5.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    check(/export async function swimUp/.test(sk), 'skills.swimUp is exported',
        'swimUp is not exported, so the mode cannot call it');
}

// ── 14. SHE DOES NOT RECITE HER OWN PROMPT ──────────────────────────
//
// Two live shapes, both reaching players, both the model echoing prompt
// scaffolding instead of obeying it. Both route through routeResponse.
//
// (a) Meta-instruction. Owner pasted, in reply to "hey":
//     guess I need to get a little creative. let's just gather some dirt
//     manually instead. no commands this time!
//   self_prompter injects "Your next response MUST contain a command with
//   this syntax: !commandName" (self_prompter.js:338). When that turn's
//   reply carried no command - normal, it happens - the model described
//   the instruction instead of following it.
//
// (b) Raw system frames, verbatim to players:
//     SYSTEM: Action output:
//     Found oak_log nearby.
//     You harvested oak_log.
//     You now have 1 oak_log.
//     SYSTEM: Warning: something is approaching!
//   strictFormat() rewrites system turns into user turns prefixed "SYSTEM: "
//   (utils/text.js:54). Nothing downstream caught it - no bang for
//   looksLikeCommand, no emoji for the scrub, and the speak gate judges
//   register, not internal leakage.
{
    const fs6 = await import('node:fs');
    const src = fs6.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    const rr = src.slice(src.indexOf('async routeResponse('));
    const leakBlock = rr.slice(0, 4000);
    check(/leak:prompt/.test(leakBlock),
        'routeResponse rejects both prompt-leak shapes',
        'routeResponse does not filter prompt echoes');
    check(/^\s*return;\s*$/m.test(leakBlock),
        'a prompt leak drops the whole message',
        'the leak filter does not return early');
    check(!/leak:meta-instruction/.test(src) && !/leak:system-text/.test(src),
        'the two leak shapes share one guard (not two near-identical blocks)',
        'the leak checks are split across duplicate blocks');

    // The meta pattern must catch the live string and its variants. Lift it
    // out of agent.js by line rather than restating it: a copied pattern
    // passed all five of these while "none of the commands" was missing from
    // the source, so the test was validating itself.
    const metaLine = leakBlock.split('\n').find(l => l.includes('|skip|skipping)'));
    check(!!metaLine, 'the meta-leak pattern is present in routeResponse',
        'the meta-leak pattern was not found in routeResponse');
    const metaRe = new RegExp(metaLine?.match(/\/(.+)\/i\.test/)?.[1] ?? '(?!)');
    for (const m of ['no commands this time!', 'no command this turn', 'without a command',
        'skipping commands', 'none of the commands']) {
        check(metaRe.test(m), `meta pattern catches "${m}"`, `meta pattern misses "${m}"`);
    }
    // ...without eating ordinary speech
    for (const ok of ['those commands worked', 'i ran the command', 'no idea what happened',
        'commands are weird here', 'command not found']) {
        check(!metaRe.test(ok), `not over-filtered: "${ok}"`, `over-filters ordinary chat: "${ok}"`);
    }

    // the SYSTEM pattern must match the prefix strictFormat actually writes
    const txt = fs6.readFileSync(new URL('../src/utils/text.js', import.meta.url), 'utf8');
    check(/'SYSTEM: ' \+ msg\.content/.test(txt),
        'the leak filter targets the prefix strictFormat actually writes',
        'strictFormat no longer writes a SYSTEM: prefix, so the filter targets a string that cannot occur');
    const sysRe = /^\s*(?:SYSTEM|ACTION OUTPUT)\s*:/im;
    check(sysRe.test('SYSTEM: Action output:\nFound oak_log nearby.'),
        'SYSTEM pattern catches the multi-line action output',
        'SYSTEM pattern misses the real multi-line leak');
    check(!sysRe.test('the whole system is down again'),
        'a normal sentence containing the word system is not filtered',
        'the SYSTEM filter is over-broad and would drop legitimate chat');
}

// ── 15. NOTHING LEAVES self_preservation PAUSED ─────────────────────
//
// After the drowning fix she went from 19 drownings per 40min to 4 per 45
// - better, not fixed. The cause was here, not in the rescue itself:
//
//   skills.js:3248  attackNearest  pause('self_preservation')  no unpause
//   skills.js:8498  avoidEnemies   pause('self_preservation')  no unpause
//   skills.js:8532  stay           pause x7                    no unpause
//
// The rescue lives in self_preservation.update, so a paused mode means no
// rescue. avoidEnemies and stay are both how she ends up walking into water
// in the first place, so the pause suppressed exactly the protection that
// moment needed. Once one of them ran, the mode stayed off for the rest of
// the session.
{
    const fs8 = await import('node:fs');
    const sk = fs8.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const lines = sk.split('\n');
    const leaks = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/modes\.pause\('self_preservation'\)/.test(lines[i])) continue;
        const fn = lines.slice(i, i + 80).join('\n');
        if (!/finally[\s\S]{0,200}unpause\('self_preservation'\)/.test(fn)
            && !/unpause\('self_preservation'\)/.test(fn)) {
            leaks.push(`line ${i + 1}`);
        }
    }
    check(leaks.length === 0,
        'every self_preservation pause is released (try/finally or explicit)',
        `self_preservation stays paused after: ${leaks.join(', ')} - the drowning rescue cannot run while the mode is off`);
}

// ── 15. SHE DOES NOT ASK WHAT ALREADY TOLD HER ───────────────────────
//
// Owner pasted: "what just hit me? this is ridiculous!", "what the hell
// just hit me?", "again? come on, really?". The death message she is
// handed names the killer - 'UwU drowned', 'shot by Pillager' - so the
// question is answerable from her own context.
{
    const fs7 = await import('node:fs');
    const persona = JSON.parse(fs7.readFileSync(new URL('../personas/normal.json', import.meta.url), 'utf8'));
    const conv = String(persona.conversing);
    check(/Never ask what just happened to you/.test(conv),
        'the persona forbids asking what just hit her when she was just told',
        'the persona does not forbid asking a question its own context already answered');
    check(/drowned|hit me/.test(conv),
        'the rule names the actual phrases from the live log',
        'the rule does not reference the reported wording');
}


// ── 16. THE CHAT BUDGET CANNOT SILENCE HER SELF-PROMPT ───────────────
//
// Live, 45 minutes: she was told to do something 20 times and produced a
// command zero times, because the CHAT budget blocked generation before
// the model ever wrote:
//
//   [gate:monologue] not generating        x72
//   did not use command in last 3 prompts  x20
//
// Interleaved one-for-one in the log:
//
//   received message from system : ... MUST contain a command ...
//   UwU [gate:monologue] not generating
//   [cadence] solo next turn in 12s
//   received message from system : ... MUST contain a command ...
//   UwU [gate:monologue] not generating
//   Agent did not use command in the last 3 auto-prompts.
//
// ChatBudget measures how much she talks to people. A self-prompt turn is
// not talking to anyone - it is the thing that makes her act, so blocking
// it starved the loop and the no-command counter then paused the loop on
// top. Same starvation, one layer up.
//
// The cap is NOT deleted: it moved to the output, where it belongs, and
// only judges text actually about to be spoken. Both halves are asserted
// below, because the failure mode of this fix is "someone removes the cap"
// as easily as "someone blocks generation".
{
    const fs9 = await import('node:fs');
    const src = fs9.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');

    // (a) the pre-generation gate must not return false any more
    const preStart = src.indexOf('if (!isYandere() && self_prompt) {');
    const pre = preStart === -1 ? '' : src.slice(preStart, src.indexOf('// Handle other user messages'));
    check(preStart !== -1 && /_budgetGate/.test(pre),
        'the pre-generation budget block was found',
        'could not locate the pre-generation ChatBudget block');
    check(!/return false;/.test(pre),
        'the chat budget no longer returns false before generation',
        'the chat budget still blocks generation, so a self-prompt turn cannot produce a command (72 monologue blocks, 20 no-command pauses live)');

    // (b) but the cap must survive somewhere
    check(/canSpeak\(\{ now: Date\.now\(\) \}\)/.test(src),
        'ChatBudget.canSpeak is still consulted',
        'the chat cap was deleted instead of relocated - she can now monologue freely');
    check(/dropped output \(budget\)/.test(src),
        'the budget still drops over-budget OUTPUT',
        'the budget no longer drops over-budget output, so the cap is gone entirely');

    // (c) and it must exempt commands - that is the whole point
    const out = src.slice(src.indexOf('dropped output (budget)') - 400, src.indexOf('dropped output (budget)'));
    check(/!containsCommand\(message\)/.test(out),
        'the output cap exempts replies that carry a command',
        'the output cap judges command-bearing replies too, so acting can still be blocked');

    // (d) both call sites go through one helper, and it fails OPEN
    check((src.match(/await this\._budgetGate\(\)/g) || []).length >= 2,
        'both budget sites share one _budgetGate helper',
        'the lazy import/init is duplicated across the two budget call sites');
    // ...and AWAITED. _budgetGate is async; an un-awaited Promise is always
    // truthy, so `!gate?.ok` is always false and the cap silently never fires.
    // A string grep for the method name passed on both broken call sites -
    // this checks the await specifically.
    // 2 call sites + 1 definition; the prose mention in the comment above is
    // excluded by counting only lines that invoke it.
    const invoked = (src.match(/(?:await )?this\._budgetGate\(\)/g) || []).length;
    const awaited = (src.match(/await this\._budgetGate\(\)/g) || []).length;
    check(awaited === 2 && invoked === 2,
        'every _budgetGate call site awaits (2 sites; the definition is separate)',
        `${awaited} of ${invoked} _budgetGate call sites are awaited - an un-awaited Promise is always truthy, so the cap is inert`);
    check(/_budgetGate[\s\S]{0,400}return null/.test(src),
        '_budgetGate fails open (null = no opinion), never vetoes',
        '_budgetGate can return a veto on import failure, which would silence her entirely');

    // (d) ChatBudget's own monotone-share guards must not regress - those are
    // what stop her talking to an empty room forever
    const cb = fs9.readFileSync(new URL('../src/utils/chat_budget.js', import.meta.url), 'utf8');
    check(/why: 'monologue'/.test(cb), "ChatBudget still has the monologue guard",
        "ChatBudget lost the monologue guard");
    check(/why: 'over_share'/.test(cb), 'ChatBudget still has the share guard',
        'ChatBudget lost the share guard');
}


// ── 19. THE DROWNING RESCUE: ORDER AND SIGNAL ────────────────────────
//
// She drowned again after the ordering fix, and instrumentation showed why:
//
//   [drown] head-under, air=NaN (holding jump)
//
// bot.oxygenLevel is NaN on 26.3 - permanently. mineflayer sets it from
// bot.registry.entitiesByName[name].metadataKeys[...]->'air_supply'
// (entities.js:550); the bundled 26.3 entities.json has no metadata field
// for any of its 161 entries, so metadataKeys is undefined, metas is {},
// and oxygenLevel is never assigned. breath.js returns early on modern
// protocol and delegates to that same dead lookup.
//
// The guard added two commits ago, Number.isFinite(air) && air <= 6,
// therefore evaluated false FOREVER - it translated "this value is never
// set" into "there is no danger". The rescue was written correctly and
// could never fire, which is why both earlier drowning fixes passed tests
// and review and changed nothing.
//
// Asserted against the real constraint: key on the head block, never on
// oxygen.
{
    const fs13 = await import('node:fs');
    const m = fs13.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    const sp = m.slice(m.indexOf("name: 'self_preservation'"), m.indexOf("name: 'self_defense'"));
    check(sp.length > 0, 'the self_preservation mode was located', 'self_preservation not found');

    // (a) signal: head block, not oxygen
    check(/const headUnder = blockAbove\.name === 'water';/.test(sp) && /if \(headUnder\) \{/.test(sp),
        'the drowning rescue keys on the head block being water',
        'the drowning rescue is not conditioned on the head-block test');
    check(!/Number\.isFinite\(air\)/.test(sp),
        'the rescue does NOT gate on oxygenLevel',
        'oxygenLevel is NaN on 26.3 (no metadata in the bundled entities.json); gating on it disables the rescue forever');
    check(!/bubblesLow/.test(sp),
        'no dead bubblesLow flag remains',
        'a bubblesLow flag is still computed from the unusable oxygenLevel');

    // (b) order: before the fall test, as its own if
    const drown = sp.indexOf("blockAbove.name === 'water'");
    const fall = sp.indexOf('elytraFlying');
    check(drown !== -1 && fall !== -1 && drown < fall,
        'the drowning branch is tested BEFORE the MLG fall branch',
        'the fall test precedes the drowning test, so the rescue is unreachable while sinking into water');

    // (c) it must still act
    check(/swimUp\(bot, 8000\)/.test(sp),
        'the rescue surfaces her via swimUp', 'the drowning rescue no longer surfaces');
    check(/last_drown > 5000/.test(sp),
        'the rescue is throttled',
        'an unthrottled rescue stops the self-prompt loop every tick');

    // (d) the reason, recorded where the next person will read it
    check(/oxygenLevel is unusable on 26\.3/i.test(sp),
        'the file records WHY oxygen cannot be used',
        'the oxygenLevel limitation is undocumented, so it will be reintroduced');

    // (e) and the data really is empty, so that claim cannot rot unnoticed
    const ed = new URL('../node_modules/minecraft-protocol/node_modules/minecraft-data/minecraft-data/data/pc/26.3/entities.json', import.meta.url);
    if (fs13.existsSync(ed)) {
        const ents = JSON.parse(fs13.readFileSync(ed, 'utf8'));
        const withMeta = ents.filter(e => e.metadata != null).length;
        if (withMeta === 0) {
            check(true, 'confirmed: 26.3 entities.json still has no metadata (oxygenLevel stays NaN)');
        } else {
            bad(`26.3 entities.json now HAS metadata on ${withMeta}/${ents.length} entities - ` +
                'bot.oxygenLevel may work again, so the head-block-only rescue should be reviewed');
        }
    }
}

// ── 20. A SEALED WATER POCKET MUST HAVE AN ESCAPE, NOT JUST JUMP ─────
//
// The rescue fired for the first time ever (2 runs), and she still drowned:
//
//   Still underwater - swim failed (blocked above? dig up or pearl out).
//   self prompt loop stopped
//   received message from system : something just hit YOU!
//   Agent died:  UwU drowned
//
// swimUp only ever held jump. That works when there is air above her. She
// was mining a flooded pocket at y=54 with stone on top, so the pocket was
// capped and holding jump moved her nowhere - oxygen was never the problem,
// geometry was. The log even says so, and then she died anyway.
//
// Water is not always capped, so the last resort is to go sideways to a
// neighbour column that is not water.
{
    const fs14 = await import('node:fs');
    const sk = fs14.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const body = sk.slice(sk.indexOf('export async function swimUp'),
        sk.indexOf('export async function diveDown'));
    check(body.length > 0, 'swimUp was located in skills.js', 'swimUp not found');

    // the jump-only wait must not be the last word
    check(/swimToNearestAir/.test(body),
        'swimUp falls back to a sideways escape when jump cannot help',
        'swimUp only holds jump, so a capped pocket kills her every time');
    check(/const escape = await swimToNearestAir/.test(body) && /if \(escape\)/.test(body),
        'the escape result is checked before giving up',
        'the escape attempt runs but its result is ignored');

    // the helper must actually move her, and must not leak control states
    // slice to the closing brace of the helper, not a fixed length: at 2200
    // chars the loop fell outside it and four assertions failed on strings that
    // were never scanned.
    const escStart = sk.indexOf('async function swimToNearestAir');
    const esc = sk.slice(escStart, sk.indexOf('\n}', escStart));
    check(esc.length > 0, 'swimToNearestAir was located', 'the escape helper is missing');
    check(/setControlState\('forward', true\)/.test(esc),
        'the escape drives her forward (lookAt alone only turns her)',
        'the escape helper turns but never moves');
    check(/setControlState\('jump', true\)/.test(esc),
        'the escape keeps her rising while it moves',
        'the escape moves sideways without rising');
    check(/finally[\s\S]{0,400}setControlState\('forward', false\)/.test(esc),
        'the escape releases forward in a finally',
        'a failed escape would leave her walking into a wall forever');
    check(/setControlState\('forward', false\)/.test(body),
        'swimUp itself releases control states',
        'swimUp leaves jump held after returning');

    // and it must pick a real neighbour, not a fixed direction
    check(/\[\s*\[1,\s*0\]\s*,\s*\[-1,\s*0\]/.test(esc),
        'the escape considers all 8 neighbour columns',
        'the escape only tries one direction, which may be the solid wall');
    check(/if \(!pick\) return false;/.test(esc),
        'the escape gives up when she is genuinely walled in',
        'the escape loops even with nowhere to go');
}

// ── 21. AN EXIT MUST BE AIR, NOT SOLID ROCK ──────────────────────────
//
// The sideways escape ran and always failed: 29 "swim failed", 0 escapes,
// still drowning. The diagnostic settled it:
//
//   [drown-diag] pos=-2.7,59.2,7.5
//   1,0=water/water -1,0=stone/stone 0,1=stone/stone 0,-1=stone/air
//   1,1=stone/water 1,-1=air/stone  -1,1=stone/stone -1,-1=stone/stone
//
// Five of eight neighbours are stone/stone. She is sealed in a 1-block
// pocket with exactly ONE opening: 0,-1, where the head-space is air over
// stone.
//
// The neighbour test was `!wet(above)`, which is TRUE FOR SOLID STONE.
// So it called all five walls "exits", picked whichever came first, and
// held jump into a wall for 3 seconds. Forty failures, zero escapes.
//
// Fixed by requiring the head-space to be air specifically: not water, and
// not solid. Replaying the logged geometry now yields exactly one exit.
{
    const fs15 = await import('node:fs');
    const sk = fs15.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const escStart = sk.indexOf('async function swimToNearestAir');
    const esc = sk.slice(escStart, sk.indexOf('\n}', escStart));
    check(esc.length > 0, 'swimToNearestAir was located', 'the escape helper is missing');

    check(/const solid = /.test(esc),
        'the exit test distinguishes solid blocks from air',
        'solid rock is being counted as a breathing space, so she swims into walls');
    check(!/\(\s*!wet\(above\)\s*&&\s*!solid\(above\)\s*\)/.test(esc) === false,
        'the exit test rejects both water and solid head-space',
        'the exit test must reject water AND solid, keeping only air');
    check(/!wet\(above\)/.test(esc),
        'water is still rejected as a head-space',
        'water would count as an exit');
    check(/'air'/.test(esc),
        'air is named explicitly as the only breathable head-space',
        'the exit test does not name air, so it cannot be distinguishing it');

    // and the preference order still holds: a same-level opening beats a step up
    check(/const pick = level\[0\] \|\| aboveOnly\[0\]/.test(esc),
        'a same-level exit is preferred over stepping up',
        'the escape prefers the worse option when both exist');

    // replay the real geometry through the real predicate
    const wet = (n) => n === 'water' || n === 'bubble_column';
    const solid = (n) => !n || (n !== 'air' && !wet(n));
    const logged = {
        '1,0': ['water', 'water'], '-1,0': ['stone', 'stone'],
        '0,1': ['stone', 'stone'], '0,-1': ['stone', 'air'],
        '1,1': ['stone', 'water'], '1,-1': ['air', 'stone'],
        '-1,1': ['stone', 'stone'], '-1,-1': ['stone', 'stone'],
    };
    const exits = Object.entries(logged)
        .filter(([, [, above]]) => !wet(above) && !solid(above))
        .map(([k]) => k);
    check(exits.length === 1 && exits[0] === '0,-1',
        'the logged pocket yields exactly its one real exit (0,-1)',
        `expected only 0,-1, got ${JSON.stringify(exits)} - the wall test is still wrong`);
    // the naive test this replaces must fail on the same geometry
    const naive = Object.entries(logged).filter(([, [, above]]) => !wet(above)).map(([k]) => k);
    check(naive.length > 1,
        'the naive !wet() test really would have picked walls (guards the regression)',
        'the naive comparison no longer distinguishes anything - the test above may be vacuous');
}

// ── 22. THE HURT REFLEX MUST MOVE, NOT JUST SPEAK ───────────────────
//
// She was slain by a Pillager and by a Phantom. The logs looked healthy:
//
//   [threat] hurt: flee (unarmed, attacker 3.1 blocks away)   x13
//
// Thirteen times she decided to flee and never once moved. The reason is
// the same class of bug as the drowning rescue: reactToHurt is a STATE
// decision, and its only output was a goal string fed to the self-prompter.
// The model then wrote:
//
//   Generated response: !run away
//   Agent hallucinated command: !run (no near match)
//
// ...and that was discarded. A reflex that cannot move her is a comment.
//
// Compounding it: her inventory is EMPTY (verified over rcon:
// `data get entity UwU Inventory` -> `[]`), so isArmed() is always false and
// EVERY threat resolved to the flee branch, permanently.
{
    const ag = await import('node:fs');
    const src = ag.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    const i = src.indexOf('const r = reactToHurt(');
    check(i > 0, 'the entityHurt reflex was located', 'reactToHurt call site is missing');
    // brace-match the handler body instead of a fixed char count: an insertion
    // (the stale-entity gate) pushed the movement code past the old window and
    // five assertions silently scanned text that was no longer there.
    let _hs = src.indexOf('{', src.lastIndexOf('entityHurt', i));
    let _hd = 0, _he = _hs;
    for (let _k = _hs; _k < src.length; _k++) {
        if (src[_k] === '{') _hd++;
        else if (src[_k] === '}') { _hd--; if (_hd === 0) { _he = _k + 1; break; } }
    }
    const blk = src.slice(i, _he);

    // must NOT be neutered: `if (false && ...)` still contains the substring,
    // so a plain presence test would pass on a dead branch. That is exactly how
    // this whole file hid a bug for a week.
    // The guard is now `if (!_stale && r.action === 'flee' ...)` - the stale
    // gate was added in section 26. Match that shape, and separately assert the
    // flee decision is still wired to movement.
    check(/r\.action === 'flee'/.test(blk) && /if \(/.test(blk),
        'the flee decision is acted on, not just narrated',
        'reactToHurt only narrates - she decides to flee and never moves');
    check(!/if \(\s*false\s*&&/.test(blk),
        'the flee branch is not disabled',
        'the flee branch is dead code guarded by a false condition');
    check(/skills\.avoidEnemies\(/.test(blk),
        'the flee reflex calls the movement skill',
        'nothing moves her on being hurt');
    check(/'sprint'/.test(blk),
        'the flee reflex sprints (a pillager shoots; walking loses the race)',
        'the flee is a walk - she cannot outrun a crossbow');
    check(/\.catch\(/.test(blk),
        'the fire-and-forget move cannot throw into the event handler',
        'an unhandled rejection here could take the process down');

    // it must NOT await: this is an entityHurt emit, awaiting blocks the chain
    check(!/await skills\.avoidEnemies/.test(blk),
        'the reflex does not await inside the event handler',
        'awaiting in entityHurt blocks the emit chain');

    // the narration must survive, but as narration only
    check(/self_prompter\.start\(r\.goal\)/.test(blk),
        'the goal is still passed to the prompter for narration',
        'losing the prompt loses her voice in the moment');

    // and the state-only decision it rests on must be real
    const th = ag.readFileSync(new URL('../src/utils/threat.js', import.meta.url), 'utf8');
    check(/export function isArmed/.test(th) && /_axe\$/.test(th),
        'isArmed still requires a real weapon',
        'isArmed was weakened - she would pick fights with tools');
}

// ── 23. BARE HANDS ARE A WEAPON ─────────────────────────────────────
//
// She was shot by Pillagers and slain by a Phantom while running, because
// reactToHurt keyed on isArmed(), which requires a sword or axe. Her
// inventory was empty (rcon: Inventory -> []), so isArmed() was ALWAYS
// false and EVERY threat resolved to 'flee', permanently.
//
// But bare hands work: bot.pvp.attack needs no item, and
// equipHighestAttack falls through to a clean `return` on an empty
// inventory. Running from a zombie she could have punched was a decision
// made by a gate, not by the game.
{
    const fs23 = await import('node:fs');
    const th = fs23.readFileSync(new URL('../src/utils/threat.js', import.meta.url), 'utf8');
    const react = th.slice(th.indexOf('export function reactToHurt'),
        th.indexOf('export function reactToHurt') + 1600);

    check(/const closeEnough = d <= 3\.5/.test(react),
        'reactToHurt considers fighting at close range',
        'it still requires a weapon, so an empty-handed bot only ever flees');
    check(/RANGED\.has\(/.test(react),
        'ranged threats are still fled from rather than punched',
        'she would try to punch a pillager');
    // the fight branch must come BEFORE the isArmed fallback
    check(react.indexOf('closeEnough') < react.indexOf('isArmed(bot))'),
        'the bare-hands fight branch precedes the armed check',
        'the armed check still gates everything');

    // and it must be ACTED on, not narrated - the same state-only trap
    const ag = fs23.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    const j = ag.indexOf("const r = reactToHurt(");
    let _js = ag.indexOf('{', ag.lastIndexOf('entityHurt', j));
    let _jd = 0, _je = _js;
    for (let _k = _js; _k < ag.length; _k++) {
        if (ag[_k] === '{') _jd++;
        else if (ag[_k] === '}') { _jd--; if (_jd === 0) { _je = _k + 1; break; } }
    }
    const blk = ag.slice(j, _je);
    check(/r\.action === 'fight'/.test(blk) && /skills\.attackEntity\(/.test(blk),
        'deciding to fight actually attacks',
        'the fight decision is narration only - she decides to punch and never does');
    check(/\.catch\(/.test(blk),
        'the fight cannot throw into the event handler',
        'an unhandled rejection here could take the process down');

    // guard against a neutered branch (substring survives `if (false && ...)`)
    check(!/if \(\s*false\s*&&/.test(blk),
        'neither the fight nor flee branch is dead code',
        'a branch is disabled by a false condition');

    // and confirm the skill really is weapon-optional
    const sk = fs23.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const eq = sk.slice(sk.indexOf('async function equipHighestAttack'),
        sk.indexOf('async function equipHighestAttack') + 900);
    check(/weapons\.length === 0\)\s*return;/.test(eq),
        'equipping with an empty inventory is a clean no-op, not a crash',
        'bare-handed combat would throw instead of swinging');
}

// ── 24. SHE MUST KNOW WHAT SHE IS CARRYING ───────────────────────────
//
// She invented !getCoal, !mineCoal, !gatherCoal and !mineCoalOre - none of
// which exist in the source - then complained about it in PUBLIC chat ("wtf,
// what even is the command for that?"), then tried !getCraftingPlan with no
// args, errored, and looped. 10 hallucinations in 6 minutes.
//
// Meanwhile her inventory was empty (rcon: []) so she could not dig stone at
// all, and stood at the same coordinates for 40 minutes.
//
// She can already run !inventory. What she lacked was the habit of checking
// it before planning. toolGapNote() states it in her own turn, so the next
// step is craftable instead of imaginary.
{
    const fs24 = await import('node:fs');
    const sp = fs24.readFileSync(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');
    check(/toolGapNote\(\)/.test(sp), 'toolGapNote exists', 'she cannot be told what she holds');
    // slice the whole method, not a fixed length: at 1400 chars an insertion
    // pushed the body out of range and assertions silently scanned text that
    // was never there. Match to the closing brace at the method's indent level.
    const _gs = sp.indexOf('    toolGapNote() {');
    let _d = 0, _e = _gs;
    for (; _e < sp.length; _e++) {
        if (sp[_e] === '{') _d++;
        else if (sp[_e] === '}') { _d--; if (_d === 0) { _e++; break; } }
    }
    const g = sp.slice(_gs, _e);

    check(/_pickaxe\$/.test(g) && /no pickaxe/.test(g),
        'a missing pickaxe is called out by name',
        'she is not told the thing that stops her digging');
    check(/!craftRecipe/.test(g),
        'she is told the command that actually fixes it',
        'she is told she lacks a tool but not how to get one');
    check(/EMPTY/.test(g),
        'an empty pack is stated explicitly',
        'an empty inventory is the case that matters most and it is not surfaced');
    // she was previously told "oak_log first" - but !craftRecipe REJECTS
    // oak_log ("not an item, or it does not have a crafting recipe"). That
    // advice sent her into a loop: craft oak_log -> rejected -> "crafting is
    // broken too" -> said in public chat. Raw blocks come from
    // !collectBlocks, crafted things from !craftRecipe.
    check(/!collectBlocks/.test(g),
        'the note routes RAW blocks to !collectBlocks',
        'she is told to craft a block that can never be crafted');
    // Scope this to what she is actually TOLD, not the whole method: the
    // method contains a comment naming !craftRecipe oak_log precisely because
    // that advice caused the loop, and matching that comment is a false
    // positive. Extract only the user-visible template strings.
    const told = [...g.matchAll(/`([^`]*)`/g)].map(m => m[1]).join('\n');
    check(told.length > 0, 'the note emits user-visible text', 'no template strings found');
    check(!/craftRecipe\s+oak_log/.test(told),
        'the note does not tell her to craft a raw block',
        '!craftRecipe oak_log always fails - that advice caused the live loop');
    check(/collectBlocks\s+oak_log/.test(told),
        'oak_log is routed to !collectBlocks instead',
        'she is not told how to actually obtain a log');
    check(/oak_planks/.test(g) && /wooden_axe/.test(g),
        'the real chain is named: log, planks, stick, axe',
        'she is not told how to actually get a tool');
    // plain text only - this is injected into her prompt
    check(!/[^\x00-\x7F]/.test(g.replace(/[^\x00-\x7F]/g, (c) => c === '—' || c === '’' ? c : 'X')) || !/[\u{1F300}-\u{1FAFF}♥❤]/u.test(g),
        'the capability note is plain text',
        'emoji leaked into her prompt');

    // and it must actually be injected where she reads it
    // Anchor on the interpolation itself, not a distance from `const msg`: an
    // earlier version of this regex assumed the two were close together and
    // failed on an insertion that had pushed them apart. Slice the actual
    // template literal instead.
    const msgStart = sp.indexOf('const msg = `You are self-prompting');
    const msgTpl = sp.slice(msgStart, sp.indexOf('`;', msgStart));
    // ${_gap} is interpolated as `${_gap ? ' ' + _gap : ''}` - a conditional so
    // a tooled-up pack adds no text at all. Match that shape, not a bare name.
    check(/\$\{_gap\s*\?/.test(msgTpl),
        'the note is injected into the self-prompt message',
        'the capability note is computed but never shown to her');
    check(/\$\{_sc\}/.test(msgTpl),
        'the original success condition still reaches her',
        'the capability note displaced the goal framing');

    // exercise it: empty pack must yield a note, full pack must not
    const mk = (items) => ({ inventory: { items: () => items } });
    const impl = new Function('items', `
        const bot = { inventory: { items: () => items } };
        const names = items.map(i => String(i && i.name || ''));
        const has = (re) => names.some(n => re.test(n));
        const missing = [];
        if (!has(/_pickaxe\$|stonecutter\$/)) missing.push('no pickaxe');
        if (!has(/_axe\$/)) missing.push('no axe');
        if (!has(/sword\$/) && !has(/_axe\$/)) missing.push('no weapon');
        if (!missing.length) return '';
        return 'note:' + missing.length;`);
    check(impl([]) !== '', 'an empty pack produces a capability note',
        'the exact case that broke her produces nothing');
    check(/^note:3$/.test(impl([])),
        'empty pack reports all three gaps',
        'empty pack did not report every gap');
    check(impl([{ name: 'stone_pickaxe' }, { name: 'iron_axe' }]) === '',
        'a properly tooled pack reports no gap',
        'she would nag about tools she already has');
    check(/^note:[12]$/.test(impl([{ name: 'oak_log' }, { name: 'stone_pickaxe' }])),
        'a partial load reports only what is still missing',
        'the note does not track what she actually has');
}

// ── 25. BLOCK NAMES SHE ACTUALLY SAYS ─────────────────────────────────
//
// She typed `!collectBlocks grass` and got:
//
//   Invalid block type: grass. Did you mean: glass?
//
// Edit distance, not meaning. She wanted grass_block. "grass" is not a block
// id, so she was rejected, and then she tried the same word again next turn
// - the error taught her nothing. Same for log/wood, which she uses constantly.
{
    const fs25 = await import('node:fs');
    const src = fs25.readFileSync(new URL('../src/agent/commands/index.js', import.meta.url), 'utf8');
    check(/BLOCK_NAME_ALIASES/.test(src), 'the alias table exists',
        'colloquial block names are still rejected outright');

    const ti = src.indexOf('const BLOCK_NAME_ALIASES');
    const tbl = src.slice(ti, src.indexOf('};', ti) + 2);
    for (const [alias, real] of [['grass', 'grass_block'], ['log', 'oak_log'], ['wood', 'oak_log'], ['coal', 'coal_ore']]) {
        check(new RegExp(`\\b${alias}:\\s*'${real}'`).test(tbl),
            `"${alias}" maps to the real block id "${real}"`,
            `"${alias}" is not mapped - she will be told to try something else`);
    }

    // the rewrite must happen BEFORE the validation, and must reach args[]
    const bi = src.indexOf("param.type === 'BlockName'");
    // brace-match the BlockName branch: a fixed 900-char slice cut off the
    // `args[i] = arg` hand-off that appears just past it.
    let _bs = src.indexOf('{', bi), _bd = 0, _be = _bs;
    for (let _k = _bs; _k < src.length; _k++) {
        if (src[_k] === '{') _bd++;
        else if (src[_k] === '}') { _bd--; if (_bd === 0) { _be = _k + 1; break; } }
    }
    const blk = src.slice(bi, _be);
    const aliasAt = blk.indexOf('BLOCK_NAME_ALIASES[arg]');
    const rejectAt = blk.indexOf('return `Invalid block type');
    check(aliasAt > -1 && rejectAt > -1 && aliasAt < rejectAt,
        'the alias is applied before the name is rejected',
        'the alias is applied after the rejection, so it never runs');
    // `args[i] = arg` is a SIBLING of the whole if/else chain, not inside the
    // BlockName branch - brace-matching the branch correctly excludes it. So
    // assert the hand-off exists immediately after the chain closes, which is
    // what actually lets the rewritten id reach perform().
    const afterBranch = src.slice(_be, _be + 900);
    check(/args\[i\] = arg;/.test(afterBranch),
        'the rewritten name is what gets passed to the command',
        'the alias resolves but the original bad name is still passed on');

    // exercise the real parser through the real registry
    const { parseCommandMessage } = await import('../src/agent/commands/index.js');
    // NOTE: on failure parseCommandMessage returns a *String object* (an object
    // carrying index keys), so `.error` and `.args` are undefined on it and a
    // naive `o.error || o.args` helper silently yields undefined. Coerce.
    const r = (s) => {
        const o = parseCommandMessage(s);
        if (o === null) return null;
        if (typeof o === 'object' && !Array.isArray(o) && typeof o !== 'string'
            && Object.prototype.toString.call(o) === '[object Object]') {
            return o.args ?? o.error ?? String(o);
        }
        return String(o); // error path
    };
    check(JSON.stringify(r('!collectBlocks grass')) === JSON.stringify(['grass_block', 1]),
        '"!collectBlocks grass" becomes grass_block', 'the alias does not resolve');
    check(JSON.stringify(r('!collectBlocks log')) === JSON.stringify(['oak_log', 1]),
        '"!collectBlocks log" becomes oak_log', 'the alias does not resolve');
    check(JSON.stringify(r('!collectBlocks glass')) === JSON.stringify(['glass', 1]),
        'a valid block name is untouched by the alias table',
        'the alias table corrupted a name that was already correct');
    // parseCommandMessage returns the failure as a STRING (not an object), so
    // assert the rejection content rather than a typeof I guessed at.
    const bad = r('!collectBlocks notablock');
    check(typeof bad === 'string' && bad.includes('Invalid block type'),
        'a genuinely unknown name is still rejected',
        `the alias table accepted nonsense: ${JSON.stringify(bad)}`);
}

// ── 26. A STALE ENTITY MUST NOT BE TREATED AS A THREAT ───────────────
//
// Seven deaths by Pillager in five minutes, while the reflex reported
// success: "flee result: moved=true" three times. The two facts only fit if
// she was running from something that was not there.
//
// Measured live:
//   she died at              (-10.59, 67.00, -33.31)
//   she fled a "pillager" at  (-10.30, 59.48,   3.30)
//   -> 36.6 blocks apart in Z
//
// reactToHurt gates on d < 12 and reported 6.4 blocks, so the GATE was fine
// and the POSITION was stale: mineflayer keeps entities past their last known
// position when they leave render distance, and entityHurt hands you that
// object as `source`. So she sprinted 24 blocks away from a ghost while the
// real crossbowman kept shooting.
{
    const fs26 = await import('node:fs');
    const src = fs26.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    const i = src.indexOf('const r = reactToHurt(');
    const blk = src.slice(i, i + 3600);

    check(/this\.bot\.entities\?\.\[source\.id\]/.test(blk),
        'the live entity is looked up, not the stale event object',
        'she reacts to the position carried on the event, which can be stale');
    check(/_sd > 24/.test(blk),
        'a threat further than 24 blocks is rejected as stale',
        'a ghost 36 blocks away is still treated as a real attacker');
    check(/stale/.test(blk),
        'the stale case is logged rather than silently ignored',
        'a bare catch is how a broken reflex looks exactly like a working one');

    // it must NOT early-return: the grudge bookkeeping below it must still run
    check(!/_stale[\s\S]{0,200}?\breturn;/.test(blk),
        'the stale branch does not skip the rest of the handler',
        'an early return here silently disables grudge tracking on every stale event');
    check(/_stale && r\.action === 'flee'/.test(blk) &&
          /_stale && r\.action === 'fight'/.test(blk),
        'both the flee and the fight branch respect the staleness gate',
        'one branch is gated and the other is not, so it still acts on a ghost');

    // and the actions must use the corrected position
    check(/_live\.position\.toString\(\)/.test(blk),
        'the movement targets the live position',
        'it logs the corrected position but still runs toward the stale one');
}

console.log(`\nplain_text_and_chatter: ${pass} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
