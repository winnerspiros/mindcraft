// Reject replies that acknowledge without responding.
//
// "hi uwu" -> "yeah" was the failure. Not a length problem, not a tone problem,
// and not a politeness problem. The reply is in-register and it is grammatical
// and it says nothing: it agrees with no proposition, because none was made.
//
// MEASURED on this server's own chat (157 sessions, 868 unique player lines):
// 33 bare greetings, and what followed one:
//
//   'hi' -> 'eat me'          'hi' -> 'im a bit hungry'
//   'hi' -> 'whats the meaning of life?'    'hi' -> 'follow me'
//   'hi' -> 'you have a wood infront of you'
//   'sup' -> 'do you think server is lagging?'
//   'hey uwu' -> 'uwu tp to me'
//   'hi uwu' -> 'i have a request, can you try flying?'
//
// ZERO of 33 were answered with a bare acknowledgement. 24% got no reply at all.
//
// This is a SEPARATE check from speak_gate.js and persona_bite. Those answer
// "should she speak at all" and "must she be nice". Neither can see this: a bare
// ack is legitimate speech to both of them.

// A bare acknowledgement: one ack token (or a stutter of one) plus optional
// trailing punctuation. Anchored at both ends, so this is an exhaustive list of
// the empties rather than a general "short reply" test — anything longer than
// one token cannot match and is left alone.
// SPLIT BY CONTEXT, because these are not the same kind of thing.
//
// ACKS_NO_PROPOSITION only empties a reply when the player made no proposition
// to answer. "yeah" to "hi" is nothing; "yeah" to "mob farms go at y=30" is
// assent, and "no" to that is disagreement. Applying these unconditionally made
// her unable to disagree with anything - it silently deleted the exact
// behaviour the persona work spent this whole session adding.
//
// ALWAYS_EMPTY have no content in any context. A lone "lol" or ":)" is a
// reaction, not a reply, and stays a reaction whether or not a proposition was
// on the table.
const ACKS_NO_PROPOSITION = [
    'ok', 'okay', 'k', 'kk', 'yeah', 'yeah yeah', 'yep', 'yup', 'ya', 'yep yeah',
    'sure', 'sure thing', 'mm', 'mhm', 'hm', 'hmm', 'right', 'true', 'agreed',
    'nice', 'cool', 'word', 'bet', 'alright', 'sup',
    // Two-token stutters. The old list had 'yeah yeah' and 'yep yeah' but not
    // these, and the regex is anchored to a single token, so a two-word ack
    // slipped straight through - the same hole in a different place.
    'yeah ok', 'ok yeah', 'ya sure', 'yeah sure', 'ok ok', 'yeah yeah yeah',
    'sure sure', 'yeah no', 'ok cool', 'yeah bro', 'yep yep',
];
// I first put "no"/"nah"/"lmao" here. That was wrong: "nah" to "hi" is a
// contentful rejection in exactly her register, "lmao" is engagement, and "np"
// answers an actual request. Only pure backchannel filler belongs here - tokens
// that claim receipt and cannot answer anything in any context. Gardner's
// continuers and acknowledgements, nothing else.
const ALWAYS_EMPTY = [
    'mm', 'mhm', 'hmm', 'mmh', 'hm', 'uh huh', 'uh-huh',
];
// Rebuild the alternatives from the array so a stray paren can never break the
// regex again - that is exactly how the first version died.
const esc = (a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bare = (list) => new RegExp(
    `^(${[...list, ...ALWAYS_EMPTY].map(esc).join('|')})[.!,]*$`, 'i');

// Does the player's message contain something to agree or disagree WITH?
// A greeting, a name-call and a pure command make no proposition, so an ack
// answering them is empty. A claim, a question or a request does, so "no" and
// "yeah" are real answers to it.
//
// The trailing VOCATIVES are the live bug this fixed. The regex is end-anchored,
// so "hey" matched but "hey bro" did not - the trailing word was not in the
// vocabulary, and the whole thing fell through to hasProposition() as if it
// were a claim. Live, 07:0x:
//
//   received message from YandereDev : hey bro
//   [turntaker] -> backchannel (30%)
//   UwU backchannel (darling, 30%): ok
//
// A vocative after a greeting is still a greeting. "hey bro", "yo dude",
// "hi man" are openers, not propositions, and greeting_pragmatics.test.mjs
// caught the resulting "ok" in the recorded history. Kept as a separate
// alternative rather than loosening the anchor, so a real claim that merely
// starts with a greeting word ("hey that farm is broken") is still a claim.
const NO_PROPOSITION = new RegExp(
    '^(hi+|hey|yo|sup|hello|hiya|howdy|gm|gn|good (morning|evening|night)|'
    + 'thanks?|ty|thx|np|nice|cool|wow|oh|ah|eh|hey uwu|hi uwu|uwu|'
    // Presence checks. "you there" / "anyone" ask whether she is present, not
    // for any position to agree with - "right" to "you there" is the same
    // non-sequitur as "right" to "nothing much you?", and the live dyad suite
    // already lists "you there" as an ordinary opener that must be answered
    // with content.
    + 'you (there|here|online)|anyone( there| here| online)?|'
    + '!\\w+\\([^)]*\\)|\\s*)+$', 'i');

// "hey bro", "yo dude", "hi man" - a greeting plus a vocative. Checked as a
// prefix match on the greeting alone, then the remainder must be nothing but
// vocatives/fillers. That way "hey that farm is broken" is NOT caught, because
// "that farm is broken" is not a vocative.
const GREETING_VOCATIVE = /^(hi+|hey|yo|sup|hello|hiya|howdy|gm)\b[\s,]*((bro|dude|man|guys?|dudes|everyone|all|chat|friends?|fam|yall|people)\b[\s,!.]*)*$/i;

// A QUESTION IS NOT SOMETHING YOU CAN AGREE WITH. It asks for information, and
// every ack in the table is an assertion of belief, so an ack to a question
// asserts agreement with a position the player never took. This is the case
// that produced the owner's own words: asked "nothing much you?" she said
// "right", and the reply was "right to what? what right?".
//
// The distinction from the comment above is deliberate and it is the whole
// point: "mob farms go at y=30" is a CLAIM, so "yeah" to it is assent and "no"
// is disagreement, and the persona work needs both. A question is neither -
// there is no proposition in it to hold, so there is nothing for an ack to do.
// Assent to a question is only ever a non-sequitur, and the fix is to answer
// the question instead of acknowledging it.
//
// A QUESTION MARK IS THE SIGNAL, and the wh-words only count as a fallback at
// the START of a clause. Matching wh-words anywhere bit "thats what i said",
// which is a claim - it holds a position - and an existing test protects "right"
// answering exactly that. "what" inside a sentence is a relative pronoun
// describing something already asserted; a question word that is genuinely
// interrogative opens the clause it is in.
const ASKS_SOMETHING = /\?/;
const ASKS_AT_START = /(^|[.!?]\s+)\b(what|where|when|why|how|who|which)\b/i;

// A REQUEST IS NOT A PROPOSITION EITHER. This is the second half of the same
// defect, and it is the one that was still live after the question fix: the
// owner typed
//
//   YandereDev: "yo help im dying"
//   [turntaker] -> backchannel (40%)
//   UwU backchannel (darling, 40%): yeah
//
// "yeah" for WHAT. A question asks for information and an ack cannot supply it,
// which is why asksSomething() exists - but a request asks for an ACTION, and
// an ack cannot supply that either. hasProposition() only knows how to say
// "there is a position to agree with", so "help im dying", "can you help me",
// "come here" and "need food" all came back true and the ack sailed through.
//
// The distinction that matters: a CLAIM ("mob farms go at y=30") is something to
// agree or disagree with, and the persona needs both of those. A REQUEST is
// something to DO. "yeah" to a claim is assent; "yeah" to a plea for help is
// the bot declining to help while sounding like it agreed.
//
// Imperative-verb detection at the START of a clause. The first version
// required the verb at the END of the string, which was wrong for exactly the
// live case: "yo help im dying" is verb-first with a plea after it, so the
// anchor missed it and "yeah" went straight back out. A request in this genre
// is verb-first, so that is where the match belongs, and the trailing text is
// the reason for the request rather than a change of subject.
//
// Deliberately NOT matching mid-sentence: "i need a minute" is not a demand on
// her, and matching "need" anywhere turned ordinary conversation into empties.
const REQUESTS_ACTION = /(^|[.!?]\s+)(yo\s+|hey\s+|ok\s+|please\s+|pls\s+)?\b(help|come|go|give|bring|wait|stop|follow|drop|pick up|do it|look|check|open|close|fix|build|rescue|save|revive|tp|tpa)\b/i;
const ASKS_CAN = /\b(can|could|would|will)\s+(you|u)\b/i;
const PLEA = /\b(please|pls|urgent|im dying|help)\b/i;

export function asksForAction(playerText) {
    const t = String(playerText || '')
        .replace(/![A-Za-z_][A-Za-z_0-9]*\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return false;
    // A QUESTION is askedSomething()'s job, and it must win. "wait what" opens
    // with the imperative "wait" and would otherwise match REQUESTS_ACTION,
    // which is only correct because the turn taker also has no say here - an
    // ack cannot answer "what" any more than it can answer "?" so the ack is
    // wrong either way. Checking it costs nothing and keeps the two rules from
    // disagreeing about the same sentence.
    if (asksSomething(t)) return false;
    if (REQUESTS_ACTION.test(t)) return true;
    if (ASKS_CAN.test(t)) return true;
    // "pls" / "help" / "urgent" anywhere is a plea, not a position. This is
    // what catches "yo help im dying" even with a greeting in front of it.
    return PLEA.test(t);
}

// "wait what" is the hard case for ASKS_AT_START, and it is worth spelling out
// because both of my fixes missed it. It has no question mark, and "what" is
// not at the start of the string - it follows the imperative "wait". The
// original rule was deliberately conservative here, because matching wh-words
// anywhere bit "thats what i said" (a claim, which must stay assent-able) and
// an existing test protects "right" answering exactly that.
//
// The narrow fix: a wh-word that is NOT clause-initial but IS the last content
// word of the utterance is interrogative, because nothing follows it to be the
// relative pronoun it would otherwise be. "thats what i said" ends on a noun;
// "wait what" ends on the question word itself.
const ASKS_TRAILING = /\b(what|where|when|why|how|who|which)\s*[?.!]*\s*$/i;

export function asksSomething(playerText) {
    const t = String(playerText || '')
        .replace(/![A-Za-z_][A-Za-z_0-9]*\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return false;
    return ASKS_SOMETHING.test(t) || ASKS_AT_START.test(t) || ASKS_TRAILING.test(t);
}

export function hasProposition(playerText) {
    const t = String(playerText || '')
        .replace(/![A-Za-z_][A-Za-z_0-9]*\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return false;
    // "hey bro" is a greeting, not a claim. Checked before NO_PROPOSITION
    // because that one is end-anchored and does not cover a trailing vocative.
    if (GREETING_VOCATIVE.test(t)) return false;
    return !NO_PROPOSITION.test(t);
}

export function isEmptyAck(text, playerText) {
    // Commands are stripped first, so "ok !tp(0,64,0)" is judged as "ok" — still
    // an empty ack, because a teleport does not acknowledge anything.
    const body = String(text || '')
        .replace(/![A-Za-z_][A-Za-z_0-9]*\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Body empty means either an empty/whitespace reply, or a command-only reply
    // like "!tp(0,64,0)". Neither contains an acknowledgement token, so neither is
    // what this gate is about - an empty string is not a "yeah", and a command is
    // a real action rather than a contentless word. I briefly returned true here
    // and it wrongly flagged both.
    if (!body) return false;
    // Backchannel filler is empty whatever the context.
    if (bare(ALWAYS_EMPTY).test(body)) return true;
    // Is this word even a CANDIDATE for being empty? Checked first, so the
    // question case below does not have to re-derive the ack table.
    if (!bare(ACKS_NO_PROPOSITION).test(body)) return false;
    // Everything else only empties a reply to a message with no proposition.
    // Without this, "no" and "yeah" get suppressed mid-argument and she cannot
    // disagree with anybody about anything.
    if (playerText === undefined) return true;
    // A QUESTION is never answered by an ack, whatever else it is. Checked
    // before hasProposition() because a question is not a NO_PROPOSITION
    // string, so it reads as having a proposition to agree with and the ack
    // sailed straight through. Live: "nothing much you?" -> "right".
    if (asksSomething(playerText)) return true;
    // Same for a REQUEST, for the same structural reason: "yo help im dying"
    // carries no question mark, so it read as a proposition and "yeah" went
    // out. A request wants an action; an ack is not one. See asksForAction().
    if (asksForAction(playerText)) return true;
    return !hasProposition(playerText);
}

// Extra punctuation-stripped form: "yeah." / "yeah!" / "ok :)" still count.
export function isEmptyAckLoose(text) {
    if (isEmptyAck(text)) return true;
    const stripped = String(text || '').replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim();
    return stripped !== String(text || '').trim() && isEmptyAck(stripped);
}