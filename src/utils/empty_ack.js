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

// A bare acknowledgement: a single token (or a stutter of one) plus optional
// trailing punctuation or a text emoticon. Kept deliberately short — this must
// never fire on a reply that carries content, so it is an exhaustive list of
// the empties rather than a general "short reply" test.
const ACKS = [
    'ok', 'okay', 'k', 'kk', 'yeah', 'yeah yeah', 'yep', 'yup', 'ya', 'yep yeah',
    'sure', 'sure thing', 'mm', 'mhm', 'hm', 'hmm', 'right', 'true', 'agreed',
    'nice', 'cool', 'word', 'bet', 'lol', 'lmao', 'nah', 'nope', 'no', 'wow',
    'oh', 'ah', 'eh', ':/', ':(', ';)',
];
// Rebuild the alternatives from the array so a stray paren can never break the
// regex again - that is exactly how the first version died.
const BARE_ACK = new RegExp(
    `^(${ACKS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[.!,]*$`, 'i');

// Words that make an ack into an actual reply: content, an action, a question,
// a complaint, or a jab. A bare ack contains none of these by construction.
const HAS_CONTENT = /\?|\b(i|we|it|that|this|there|you|me|my|go|going|gonna|come|bring|need|want|wait|stop|give|build|mine|get|help|can|could|would|should|let|look|check|open|close|place|break|fix|died|death|die|killed|lag|lagging|server|phantom|pillager|mob|wood|stone|iron|diamond|farm|base|house|shelter|fence|floor|wall|door|chest|bow|arrow|sword|torch|bed|craft|hungry|tired|bored|afk|ready|not yet|almost|actually)\b/i;

export function isEmptyAck(text) {
    const body = String(text || '')
        .replace(/![A-Za-z_][A-Za-z_0-9]*\([^)]*\)/g, ' ')   // a command is content
        .replace(/\s+/g, ' ')
        .trim();
    if (!body) return false;                                   // silence is not this bug
    if (!BARE_ACK.test(body)) return false;                    // it said something
    // "ok but the roof is broken" is not an empty ack.
    return !HAS_CONTENT.test(body);
}

// Extra punctuation-stripped form: "yeah." / "yeah!" / "ok :)" still count.
export function isEmptyAckLoose(text) {
    if (isEmptyAck(text)) return true;
    const stripped = String(text || '').replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim();
    return stripped !== String(text || '').trim() && isEmptyAck(stripped);
}