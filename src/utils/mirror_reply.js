// Does this reply actually SAY anything, or is it just handing the message back?
//
// The owner: "when you talk you dont necessarily [need a response] for
// responses. you can continue on your saying, change subject etc."
//
// The structural half of that. A prompt can SAY "you may change the subject",
// but what forces a bot to answer every question is the SHAPE of what it
// produces: a reply whose content words are all lifted from the message being
// answered. "what time is it" -> "the time is 4". That is a search engine
// returning your own query, and nobody talks like that.
//
// So: a reply that introduces NO new content word is a mirror. A reply that
// introduces any - however briefly - is not, and neither is a reply with no
// content words at all ("yeah", "true", "idk"), which cannot mirror anything.
//
// WARNS, NEVER VETOES. Whether a reply is interesting is a judgement; a
// deterministic gate that deleted replies would silence exactly the blunt
// one-word answers Elena is supposed to give. This exists to make the rate
// visible in the logs so it can be measured, not to enforce.

// Function words, greetings, and discourse connectives - the things a turn
// forces on any reply. NOT content nouns: my first version put 'time',
// 'building' and 'stone' here, which excluded the very words that make a reply
// a mirror, so every mirror tested clean.
const STOP = new Set([
    // forced by the turn itself
    'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were',
    'do', 'did', 'you', 'i', 'me', 'my', 'your', 'yours', 'it', 'that', 'this',
    'and', 'or', 'but', 'so', 'not', 'a', 'an', 'the', 'to', 'of', 'in', 'on',
    'at', 'for', 'with', 'from', 'am', 'can', 'could', 'would', 'should',
    'will', 'shall', 'may', 'might', 'then', 'than', 'also', 'maybe', 'actually',
    'wait', 'just', 'only', 'anyway', 'though', 'well', 'bout', 'about',
    'after', 'before', 'because',
    // chat shorthand and greetings
    'im', 'ive', 'id', 'ill', 'u', 'ur', 'r', 'ok', 'lol', 'lmao', 'haha',
    'xd', 'pls', 'plz', 'thx', 'ty', 'np', 'gg', 'bro', 'dude', 'dont', 'cant',
    'wont', 'didnt', 'isnt', 'wasnt', 'arent', 'aight', 'ight', 'lemme', 'no',
    'yes', 'yeah', 'nah', 'yep', 'sup', 'hi', 'hello', 'hey',
]);

const contentWords = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/**
 * @param {string} reply   what she is about to send
 * @param {string} prompt  the message she is answering
 * @returns {{mirrored: boolean, ratio: number, added: string[]}}
 */
export function isMirroredReply(reply, prompt) {
    const r = contentWords(reply);
    // No content words at all - nothing to mirror.
    if (!r.length) return { mirrored: false, ratio: 0, added: [] };
    const p = new Set(contentWords(prompt));
    const added = r.filter((w) => !p.has(w));
    return { mirrored: !added.length, ratio: added.length / r.length, added };
}