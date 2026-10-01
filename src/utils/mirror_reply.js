// Does this reply actually SAY anything, or is it just handing the message back?
//
// The owner: "when you talk you dont necessarily [need a response] for
// responses. you can continue on your saying, change subject etc. thats also
// important."
//
// The structural half of that. A prompt can SAY "you may change the subject",
// but the thing that actually forces a bot to answer every question is the
// shape of what it produces: a reply whose content words are all lifted from
// the message being answered. "what time is it" -> "the time is 4". "are you
// building" -> "yes i am building". That is a mirror, and nobody talks like that
// - it is the shape of a search engine returning your own query.
//
// So this flags a reply that ADDS NOTHING: every meaningful content word in the
// reply is already in the prompt. It is deliberately narrow, because the rule
// has to catch mirroring and nothing else:
//
//   - Short replies are exempt. "yeah" to a claim is a real answer and shares
//     no content words anyway; "ok" is not a mirror.
//   - Only CONTENT words count. Function words, and words shared because the
//     topic forces them ("time" in a question about the time), are excluded -
//     see TOPIC_WORDS below.
//   - A reply that introduces ANY new content word passes, however short.
//   - Questions count as new content, so "why?" is never a mirror.
//
// It returns a WARNING, not a veto. Deciding whether a reply is interesting is a
// judgement, and a deterministic gate that silently deleted good replies would
// be worse than the problem it solves - Elena is supposed to be blunt, and some
// blunt one-word replies are correct. This exists to make the mirror visible in
// the logs so it can be measured and tuned, not to enforce.

// Function words and greetings. NOT content nouns. My first version put 'time',
// 'building', 'stone' in here, which excluded the exact words that make a
// reply a mirror - so every mirror tested clean and 4 of 5 assertions failed.
// The set below is only words that are structurally forced by the turn, never
// the topic itself.
const TOPIC_WORDS = new Set([
    'what', 'when', 'where', 'who', 'why', 'how', 'are', 'is', 'was', 'were',
    'do', 'did', 'you', 'i', 'me', 'my', 'your', 'yours', 'it', 'that', 'this',
    'and', 'or', 'but', 'so', 'no', 'yes', 'yeah', 'nah', 'ok', 'okay', 'yep',
    'sup', 'hi', 'hello', 'hey', 'not',
]);

const STOP = new Set([
    ...TOPIC_WORDS,
    'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
    'am', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
    'im', 'ive', 'id', 'ill', 'u', 'ur', 'r', 'ok', 'lol', 'lmao', 'haha',
    'xd', 'pls', 'plz', 'thx', 'ty', 'np', 'gg', 'bro', 'dude', 'im', 'dont',
    'cant', 'wont', 'didnt', 'isnt', 'wasnt', 'arent', 'aight', 'ight', 'lemme',
    // discourse connectives - they organise a reply without adding content
    'because', 'then', 'than', 'also', 'maybe', 'actually', 'wait', 'just',
    'only', 'anyway', 'though', 'well', 'bout', 'about', 'after', 'before',
]);

function words(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s']/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP.has(w) && !TOPIC_WORDS.has(w));
}

/**
 * @param {string} reply    what she is about to send
 * @param {string} prompt   the message she is responding to
 * @returns {{mirrored: boolean, ratio: number, added: string[]}}
 */
export function isMirroredReply(reply, prompt) {
    const r = words(reply);
    // No content words at all ("yeah", "ok", "idk") - nothing to mirror.
    // The threshold below is 1, not 2: after stopwords are removed,
    // "the time is 4" reduces to just ['time'], and that IS a mirror. My first
    // version required 2 and so missed every short mirror, which is most of
    // them - short messages are the whole register here.
    if (r.length === 0) return { mirrored: false, ratio: 0, added: [] };
    const p = new Set(words(prompt));
    const added = r.filter((w) => !p.has(w));
    const ratio = added.length / r.length;
    // Every content word was already in the prompt, and there were enough of
    // them for that to mean something.
    return { mirrored: added.length === 0, ratio, added };
}
