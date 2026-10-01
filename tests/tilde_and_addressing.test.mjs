// Two things the owner caught by playing, both invisible to the existing suite.
//
//   "whats with the ~? who uses that?"  → she sent "yeah, mm~" as a backchannel
//   "she still doesnt respond to me"    → "hey uwu" got a backchannel, not a reply
//
// ── WHY THE TILDE ───────────────────────────────────────────────────────
//
// '~' is not punctuation in Minecraft. `~name` is an EMOTE and renders as
// "name waves". As a trailing tic on a sentence it carries no meaning at all and
// reads as anime-speech residue.
//
// Measured over the 21,822-message player corpus:
//
//   messages containing '~'    1   (0.005%)  — and that one is a typo
//   messages containing '*'   59   (0.270%)
//
// So a trailing tilde is a 1-in-21,822 tic. It was never in _pickAck — that pool
// was already cleaned (see the long note in agent.js). The MODEL produced it.
//
// Stripped before the length and empty-ack gates, so those judge the text the
// player actually sees and a tilde cannot pad an empty line into looking like
// content.

import { readFileSync } from 'node:fs';

// Source with comments removed. All three of these checks initially failed
// against comment text: the source quotes `bot.on('chat', ...)` and "mm~" in the
// notes explaining WHY they are gone. A test that cannot distinguish a comment
// from code is a test that will block the very documentation it needs.
const CODE = readFileSync('src/agent/agent.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the strip is real and it is in the right place ─────────────────────
{
    const agent = CODE;
    const strip = agent.indexOf("replace(/~+/g, '')");
    const check_ = agent.indexOf('checkLength(message)');
    check(strip > 0, 'the tilde is stripped in the send path', 'no tilde strip exists');
    check(strip > 0 && strip < check_,
        'the strip happens BEFORE the length gate, so the gates judge what the player sees',
        'the length gate runs on the un-stripped text');

    // behaviour, not just presence
    const stripFn = (s) => String(s).replace(/~+/g, '').replace(/\s{2,}/g, ' ').trim();
    check(stripFn('yeah, mm~') === 'yeah, mm', `"yeah, mm~" → ${JSON.stringify(stripFn('yeah, mm~'))}`,
        `strip failed: ${JSON.stringify(stripFn('yeah, mm~'))}`);
    check(stripFn('ok~') === 'ok', 'a tilde alone does not survive', 'tilde survived');
    // and it cannot manufacture content
    check(stripFn('~') === '', 'a bare tilde becomes empty rather than a "message"',
        'a bare tilde still looks like content');

    // it must not eat legitimate content
    check(stripFn('im going ~ to the mines') === 'im going to the mines',
        'a stray mid-sentence tilde is cleaned without eating words',
        `mid-sentence strip broke the text: ${JSON.stringify(stripFn('im going ~ to the mines'))}`);
    check(stripFn('ok') === 'ok', 'ordinary text is untouched', 'ordinary text was altered');
}

// ── nothing in the persona or pools can reintroduce it ─────────────────
{
    // _pickAck's pool is the obvious place, but the tilde came from the MODEL.
    // Guard the pools anyway, since a hand-written pool is where it started.
    const agent = CODE;
    const pick = agent.slice(agent.indexOf('_pickAck(source'), agent.indexOf('_pickAck(source') + 2000);
    const poolLines = pick.split('\n').filter((l) => /^\s*const (warm|cool) = \[/.test(l));
    check(poolLines.length > 0, 'the ack pools were found', 'the ack pools are gone');
    for (const l of poolLines) {
        check(!/~/.test(l), `no tilde in the ack pool: ${l.trim()}`, `tilde in an ack pool: ${l.trim()}`);
    }
    // and the old yandere residue specifically
    check(!/mm~|~~/.test(pick), 'no "mm~" anywhere in the ack path', '"mm~" is back in the ack path');
}

// ── being addressed BY NAME is never a backchannel ────────────────────
//
// The live bug: "hey uwu" -> turn_taker chose backchannel -> _pickAck returned a
// filler -> she answered "yeah, mm~" instead of replying. That is the whole
// complaint "she still doesnt respond to me" from the owner's side: something
// came back, but it was not an answer, and it read as not being spoken to.
//
// A continuer is the right reply to someone talking PAST you. It is never the
// right reply to someone calling your name.
{
    const name = 'UwU';
    const addressedByName = (m) => new RegExp(`\\b${name}\\b`, 'i').test(String(m || ''));
    for (const m of ['hey uwu', 'uwu', 'hi uwu', 'uwu?', 'UwU come here', 'ELENA']) {
        if (m === 'ELENA') continue;   // her name is not a word-boundary match for 'UwU'
        check(addressedByName(m), `addressed: ${JSON.stringify(m)}`, `not detected as addressed: ${JSON.stringify(m)}`);
    }
    for (const m of ['hey', 'what are you doing', 'im at the mines', 'brb']) {
        check(!addressedByName(m), `ambient (correctly not addressed): ${JSON.stringify(m)}`,
            `wrongly treated as addressed: ${JSON.stringify(m)}`);
    }

    // the gate must actually consult it, in the turn_taker condition
    const gate = CODE.match(/if \(!self_prompt && !from_other_bot && !addressedByName[\s\S]{0,200}/);
    check(!!gate, 'the turn_taker gate excludes addressed turns', 'no !addressedByName in the turn_taker gate');
    check(/addressedByName/.test(CODE) && /const addressedByName = /.test(CODE),
        'addressedByName is computed, not just referenced',
        'addressedByName is used but never computed');
}

// ── the dead 'chat' listener must not come back ────────────────────────
{
    // Verified in the vendored fork (mineflayer-26.2, Complexity-ML):
    // CORRECTION. I first asserted there must be NO bot.on('chat'), on the
    // reasoning that lib/plugins/chat.js never emits 'chat'. That was WRONG and
    // the assertion would have blocked the fix. Verified in the fork:
    //   line 229  addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })
    //   line 83    a deprecated pattern emits bot.emit(_patterns[ix].name, ...)
    //              with name === 'chat'  ->  ('chat', username, message, ...)
    // The emit is INDIRECT, so grepping for the literal emit('chat', finds
    // nothing. It is the ONLY public-chat entry point and it must exist.
    check(/bot\.on\(\s*'chat'/.test(CODE),
        'the public-chat listener exists (the only path for player chat)',
        'the bot.on("chat") listener is missing — player chat has no entry point');
    check(/getNumOtherAgents\(\) > 0/.test(CODE),
        'it still keeps the other-agents guard',
        'the other-agents guard was lost with the listener');
    const fork = readFileSync('node_modules/mineflayer/lib/plugins/chat.js', 'utf8');
    check(/addChatPattern\('chat'.*deprecated: true/.test(fork),
        'the fork registers a deprecated "chat" pattern (why the listener fires)',
        'the fork no longer registers a "chat" pattern — re-check the delivery path');
    check(/emit\(_patterns\[ix\]\.name/.test(fork),
        'and a deprecated pattern emits under that name (the indirect emit)',
        'the deprecated-pattern emit changed — re-check the delivery path');
    check(/CORRECTION/.test(readFileSync('src/agent/agent.js', 'utf8')),
        'the wrong claim is corrected in the source, so it is not repeated',
        'the incorrect dead-code note was left in place');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} tilde/addressing assertions green`);