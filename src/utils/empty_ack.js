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
const NO_PROPOSITION = new RegExp(
    '^(hi+|hey|yo|sup|hello|hiya|howdy|gm|gn|good (morning|evening|night)|'
    + 'thanks?|ty|thx|np|nice|cool|wow|oh|ah|eh|hey uwu|hi uwu|uwu|'
    + '!\\w+\\([^)]*\\)|\\s*)+$', 'i');

export function hasProposition(playerText) {
    const t = String(playerText || '')
        .replace(/![A-Za-z_][A-Za-z_0-9]*\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return false;
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
    // Everything else only empties a reply to a message with no proposition.
    // Without this, "no" and "yeah" get suppressed mid-argument and she cannot
    // disagree with anybody about anything.
    if (playerText === undefined) return bare(ACKS_NO_PROPOSITION).test(body);
    return !hasProposition(playerText) && bare(ACKS_NO_PROPOSITION).test(body);
}

// Extra punctuation-stripped form: "yeah." / "yeah!" / "ok :)" still count.
export function isEmptyAckLoose(text) {
    if (isEmptyAck(text)) return true;
    const stripped = String(text || '').replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim();
    return stripped !== String(text || '').trim() && isEmptyAck(stripped);
}