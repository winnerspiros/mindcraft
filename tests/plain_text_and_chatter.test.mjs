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
        'bot.chat(who ?', 'bot.chat(`${send} ${who}`);', 'bot.chat(`I need'];
    const suspicious = src.split('\n')
        .map((l, i) => [i + 1, l.trim()])
        .filter(([, l]) => l.includes('bot.chat(') && !l.startsWith('//'))
        .filter(([n, l]) => {
            // skip anything that is plainly a command or a declared helper
            if (/\//.test(l) && !/["'`][A-Za-z]/.test(l)) return false;
            return !COMMAND_SITES.some((site) => l.includes(site));
        })
        .filter(([n]) => n !== 2603);   // the guarded fallback, asserted above
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
    check(/oxygenLevel/.test(branch),
        'the drowning rescue reads her remaining air',
        'the drowning branch never reads bot.oxygenLevel, so she only reacts after damage starts');
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
    const pre = src.slice(src.indexOf('if (!isYandere() && self_prompt) {\n            try {\n                const { ChatBudget }'),
        src.indexOf('// Handle other user messages'));
    check(!!pre, 'the pre-generation budget block was found',
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
    const out = src.slice(src.indexOf('dropped output (budget)') - 700, src.indexOf('dropped output (budget)'));
    check(/!containsCommand\(message\)/.test(out),
        'the output cap exempts replies that carry a command',
        'the output cap judges command-bearing replies too, so acting can still be blocked');

    // (d) ChatBudget's own monotone-share guards must not regress - those are
    // what stop her talking to an empty room forever
    const cb = fs9.readFileSync(new URL('../src/utils/chat_budget.js', import.meta.url), 'utf8');
    check(/why: 'monologue'/.test(cb), "ChatBudget still has the monologue guard",
        "ChatBudget lost the monologue guard");
    check(/why: 'over_share'/.test(cb), 'ChatBudget still has the share guard',
        'ChatBudget lost the share guard');
}

console.log(`\nplain_text_and_chatter: ${pass} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
