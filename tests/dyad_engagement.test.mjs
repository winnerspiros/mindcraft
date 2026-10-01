// In a dyad, engaging is not the same as answering.
//
// The owner: "lets say scenarios also ppl talk to tbe server, she doesnt care no
// response whatsover from her but smn says smething funny so she just reacts wkth
// lets say xD. again im nit telling hardcode shit, logically build this"
//
// Three outcomes, and 'react' is one of them:
//   ignore  he is talking to the room or to himself. She hears it, says nothing.
//   react   something was funny or stupid. A reaction IS the whole reply.
//   speak   he asked her something or said something to her.
//
// The point of the test is that this is STRUCTURE, not vocabulary - there is no
// list of joke words, and a message that happens to contain a funny word but is
// addressed to somebody else is still not hers.

import { shouldReplyTo } from '../src/utils/reply_trigger.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// shouldReplyTo takes ONE ctx object, not (msg, ctx) - my first version called
// it positionally and every mode came back undefined, which the assertions
// correctly reported as "answered a room message".
const dyad = (msg, extra = {}) => shouldReplyTo({ message: msg, visible_humans: 1, ...extra });

// ── ignore: the server gets talked at, and she does not care ──────────
{
    // Narration and status - what a server actually sounds like.
    //
    // 'ok' was REMOVED from this list. Its premise was "an acknowledgement is not
    // a thing you say TO anyone", which is a GROUP observation - with several
    // people present, "ok" goes to whoever spoke and may not be for her. In a dyad
    // there is one other person, so "ok" is said to her by default. It now gets
    // `react` (see the dyad-ack rule), not silence. The group path still ignores
    // it, via group_ack_to_nobody.
    for (const m of ['im coming', 'brb', 'on my way', 'one sec', 'wait',
        '*builds a wall*', 'im going to the mines', 'there you go',
        'has anyone seen the cows']) {
        const v = dyad(m);
        check(v.mode === 'ignore', `ignored: ${JSON.stringify(m)}`, `answered a room message: ${JSON.stringify(m)} -> ${v.mode}`);
    }
}
{
    // The stated period and a second full stop. A statement delivered to the
    // room is not a question to her.
    for (const m of ['i finished the roof.', 'the creeper is at the base.',
        'im building a tower.']) {
        check(dyad(m).mode === 'ignore', `ignored: ${JSON.stringify(m)}`,
            `answered: ${JSON.stringify(m)} -> ${dyad(m).mode}`);
    }
}

// ── speak: actually at her ─────────────────────────────────────────────
{
    for (const m of ['can you help me with this', 'where are you', 'you see this?',
        'do you have spare stone', 'wait for me', 'come here', 'look at this',
        'what are you doing']) {
        const v = dyad(m);
        check(v.mode === 'speak', `speak: ${JSON.stringify(m)}`, `not treated as for her: ${JSON.stringify(m)} -> ${v.mode}`);
    }
}

// ── react: bare acks, reactions, and the funny/stupid case ─────────────
//
// CHANGED. These four used to be required to reach `react`, and they no longer
// do - deliberately. A dyad is one-to-one, so "you are so bad at this" is said
// TO her and now gets a real reply. Forcing a reaction there was the phrase-table
// thinking the owner rejected: matching wording instead of judging intent.
//
// What still reaches `react` is the genuine reaction/acknowledgement shape:
// a bare ack, or a noise like "lol". Those want a noise back, not a sentence.
{
    for (const m of ['ok', 'yeah', 'sure', 'right', 'k']) {
        const v = dyad(m);
        check(v.mode === 'react', `bare ack reacts rather than speaking: ${JSON.stringify(m)}`,
            `bare ack not treated as an ack: ${JSON.stringify(m)} -> ${v.mode}`);
    }
    for (const m of ['lol', 'nice', 'wow']) {
        const v = dyad(m);
        check(v.mode === 'react', `noise reacts: ${JSON.stringify(m)}`, `noise did not react: ${JSON.stringify(m)} -> ${v.mode}`);
    }
    const inGroup = shouldReplyTo({ message: 'ok', visible_humans: 3 });
    check(!inGroup.reply && inGroup.why === 'group_ack_to_nobody',
        'but in a GROUP a bare ack is still not for her',
        `group ack gave ${JSON.stringify(inGroup)}`);
}
{
    // The failure mode this guards: if react were keyed on joke vocabulary, a
    // message containing those same words but addressed to someone ELSE would
    // also fire. Structure must beat vocabulary.
    const withJokeWord = 'i just got raided by a zombie and lost all my stuff';
    const v = dyad(withJokeWord, { visible_humans: 3 });
    check(v.mode !== 'react', 'a funny-word message in a GROUP is not a reaction',
        'react fired on vocabulary instead of structure');
}

// ── a group is still a group: this must not leak into 2+ humans ────────
{
    const v = dyad('im coming', { visible_humans: 2 });
    check(v.mode !== 'react', 'a group message is never a reaction', 'react leaked into a group');
    check(!v.reply || v.mode !== 'speak', 'unaddressed group message is not a real reply', 'spoke in a group unprompted');
}

// ── NO PHRASE LIST, and no xD anywhere in the logic ────────────────────
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/utils/reply_trigger.js', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // The distinction that matters, and my first test got it wrong: CASUAL_NOISE
    // lists words the HUMAN says ("lol", "nice one") so the router can recognise
    // that he is reacting. That is a list about HIS utterance. It is not a list
    // of what SHE replies with, and it must not become one.
    //
    // The real test: the module must contain no word that looks like a reply SHE
    // would send. A reaction word appearing only inside a regex that CLASSIFIES
    // incoming text is fine; appearing in a returned object or a default is not.
    const returnsReaction = /return[^;]*\b(lol|lmao|haha|xd|rofl|ffs|omg|wtf|yikes)\b/i.test(src);
    check(!returnsReaction, 'the router never RETURNS a reaction as text',
        'the router is emitting a canned reaction');
    // And pickDyadMode must not contain any reaction vocabulary at all - it only
    // ever returns one of the three mode names.
    const pick = src.slice(src.indexOf('function pickDyadMode'));
    const pickBody = pick.slice(0, pick.indexOf('\n}'));
    const words = pickBody.match(/\b[a-z]+\b/gi) || [];
    const leaked = words.filter((w) => /^(?:lol|lmao|haha|xd|rofl|ffs|omg|wtf|yikes)$/i.test(w));
    check(!leaked.length, `pickDyadMode contains no reaction vocabulary (${words.length} words, all logic)`,
        `reaction vocabulary in the decision: ${JSON.stringify(leaked)}`);
    // The "xD" the owner mentioned must not exist anywhere as something she says.
    check(!/\bxd\b[^\n]*[,;)]/i.test(pickBody), 'the "xD" example stayed an example',
        '"xD" became part of the logic');
    // The three modes are named, and nothing else is a mode.
    const modes = [...src.matchAll(/mode: '([a-z_]+)'/g)].map((m) => m[1]);
    check(modes.every((m) => ['react', 'speak', 'ignore'].includes(m)),
        `only the three modes exist (${[...new Set(modes)].join(', ')})`,
        `unexpected modes: ${JSON.stringify(modes)}`);
    check(/function pickDyadMode/.test(src), 'the decision is a function, not inline trivia',
        'mode selection is not a named decision');
}

// ── ignore must not cost her the thread ───────────────────────────────
{
    // Hearing a message is not the same as replying to it: the history entry is
    // what lets her react to something he said three messages ago. Tested at the
    // integration level below, but the intent is that ignore is cheap and does
    // not mark her as having spoken.
    const v = dyad('im coming');
    check(v.reply !== undefined, 'the router still reports a decision for ignored messages',
        'ignore has no decision shape');
}

// ── wired in, and the caller honours 'ignore' ──────────────────────────
{
    const fs = await import('node:fs');
    const agent = fs.readFileSync('src/agent/agent.js', 'utf8');
    // The consumed variable is `_final`, not `_verdict`: room engagement can
    // override the text verdict, and reading `_verdict` here would make that
    // override computed-and-dropped. These checks used to pin `_verdict` and
    // failed once that moved - correctly, since the pin was the bug.
    check(/_final\.mode === 'ignore'/.test(agent), 'agent.js honours mode:ignore',
        'ignore is computed and then ignored - she replies anyway');
    // "before the send" has to mean the ignore check is inside routeResponse,
    // which returns early. Comparing string offsets against the FIRST bot.chat(
    // in the file is meaningless - the file has several and routeResponse is not
    // the first thing in it. Check the enclosing function instead.
    // `_final`, not `_verdict` - room engagement overrides the text verdict and
    // reading `_verdict` would make that override dead.
    const ri = agent.indexOf("_final.mode === 'ignore'");
    const rStart = agent.lastIndexOf('routeResponse', ri);
    const rEnd = agent.indexOf('\n    }', ri);
    const body = agent.slice(rStart, rEnd);
    check(rStart > 0 && rEnd > ri, 'the ignore check is inside routeResponse',
        'could not locate the ignore check within routeResponse');
    check(!/routeResponse[\s\S]{0,4000}bot\.chat\(/.test(body), 'routeResponse returns early rather than sending',
        'the ignore path may fall through to a send');
    // and the early return must actually return
    const after = agent.slice(ri, ri + 600);
    check(/return true;|return false;/.test(after), 'the ignore path returns instead of continuing',
        'ignore does not stop the message');
    check(/_final\.mode === 'react'/.test(agent), 'react reaches the model as intent',
        'react mode is computed and then dropped');
    // and ignore must not be a silent discard - she has to have HEARD it
    const h = agent.indexOf('said to the room, not to you');
    check(h > 0, 'an ignored message is still stored, so she heard it',
        'ignore throws the message away entirely');
}

// ── REGRESSION: she only answered when her NAME was used ───────────────
//
// Owner, live: "only answered when i said uwu. thats bad". Then "i did, no
// response" - after direct chat delivery was fixed she received the messages and
// still said nothing for 'yo', 'gm', 'you there', 'yo bitch'.
//
// Cause: pickDyadMode gated on a hand-written phrase list (DIRECT_NEED_DYAD:
// 'can you', 'help me', 'come here', ...). Anything not on the list fell to
// `react` or `ignore`, so an ordinary conversational opener produced silence.
// That is phrase-matching standing in for a judgement - exactly the hardcoding to
// avoid - and it is wrong on its own terms: in a DYAD there is one other person,
// so most of what he says is addressed to her BY POSITION.
{
    const openers = ['yo', 'yo bitch', 'gm', 'gm uwu', 'you there', 'sup',
        'yo u', 'hey hey', 'well well', 'that was close', 'holy shit',
        'ur so bad at this', 'thats actually hilarious', 'no way',
        'i walked into a creeper', 'you literally cannot play this game',
        'still alive', 'i found diamonds', 'wait what'];
    const silent = openers.filter((m) => !dyad(m).reply);
    check(silent.length === 0,
        `all ${openers.length} ordinary dyad openers get a response`,
        `${silent.length}/${openers.length} produced silence: ${JSON.stringify(silent)}`);

    // a question and a request are still replies, for the structural reason
    for (const m of ['what are you doing', 'can you help me', 'wait for me']) {
        check(dyad(m).mode === 'speak', `question/request speaks: ${JSON.stringify(m)}`,
            `${JSON.stringify(m)} -> ${dyad(m).mode}`);
    }
    // naming her is still a reply, and is no longer the ONLY thing that is
    check(dyad('uwu').mode === 'speak', 'naming her speaks', `uwu -> ${dyad('uwu').mode}`);
    check(dyad('gm').mode === 'speak', 'but so does an ordinary opener',
        `gm -> ${dyad('gm').mode}`);

    // the gate must not be a phrase list any more
    const src = (await import('node:fs')).readFileSync('src/utils/reply_trigger.js', 'utf8');
    const picker = src.slice(src.indexOf('function pickDyadMode'), src.indexOf('function pickDyadMode') + 2600);
    check(!/DIRECT_NEED_DYAD/.test(picker),
        'the dyad picker no longer gates on a phrase table',
        'the dyad picker still gates on DIRECT_NEED_DYAD');
    // and the picker's own 'speak' default must be reachable, not dead
    check(/return 'speak';\s*\}/.test(picker),
        'the picker ends in a speak default (engaging is the dyad norm)',
        'the picker has no speak default');

    // narration must STILL be silence - the fix is not "answer everything"
    for (const m of ['im coming', 'im going to the mines', 'wait', 'here',
        'done', 'there you go', 'has anyone seen the cows']) {
        check(dyad(m).mode === 'ignore', `narration still silent: ${JSON.stringify(m)}`,
            `narration now gets an answer: ${JSON.stringify(m)} -> ${dyad(m).mode}`);
    }
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} dyad-engagement assertions green`);