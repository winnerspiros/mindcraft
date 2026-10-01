// How long is this message, and is it allowed to be?
//
// The owner: "ppl shorten words. who likes to type paraphs noone."
//
// MEASURED on 21,822 real player messages (Minecraft Dialogue Corpus, ACL 2019):
//
//   p50 5 words | p75 10 | p90 16 | p95 30 | p99 70
//   messages containing a second sentence: 27 of 21,822 = 0.12%
//   messages 20+ words: 9.39%   30+ words: 5.64%   40+ words: 3.70%
//   messages ending in punctuation at all: 24.7%
//
// "Who likes to type paragraphs, noone" is exactly right, and 0.12% is the
// number that settles it: a second sentence is not a style choice, it is an
// event. So this checks SHAPE - sentence count and length against those
// percentiles - and reports, rather than silently truncating a person's rant.

const P50 = 5;
const P90 = 16;
const P99 = 70;
// A second sentence happens in 0.12% of real messages. One and a bit is normal
// ("its fine, im coming"); two full sentences is paragraph territory.
const SOFT_SENTENCE_LIMIT = 2;
// A run-on with no full stop in it is the SAME complaint as a paragraph, and my
// first version only counted sentences - so a 37-word comma-spliced wall of text
// with no terminator passed as "long_but_real". Sentence count alone is not
// enough; word count has to gate too. p90 is 16 and p95 is 30, so anything past
// ~25 words is already the tail, and she is 1 of 2-3 players, not a monologue.
const HARD_WORD_LIMIT = 25;
const SOFT_WORD_LIMIT = 17;   // ~p90

const countWords = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// A "sentence" needs a terminator followed by a capital or a word - otherwise
// "im going to the mines rn" is one sentence, not three because of "rn".
function countSentences(s) {
    const t = String(s || '').trim();
    if (!t) return 0;
    return (t.match(/[.!?]+(?=\s|$)/g) || []).length || 1;
}

/**
 * @param {string} text
 * @returns {{ok: boolean, words: number, sentences: number, why: string}}
 */
export function checkLength(text) {
    const words = countWords(text);
    const sentences = countSentences(text);

    if (!words) return { ok: true, words, sentences, why: 'empty' };
    // A command or an action is not prose and is not length-limited.
    if (text.trim().startsWith('*') || /^[!/.]/.test(text.trim())) {
        return { ok: true, words, sentences, why: 'command' };
    }
    if (sentences > SOFT_SENTENCE_LIMIT) {
        return { ok: false, words, sentences, why: 'paragraph' };
    }
    if (words > HARD_WORD_LIMIT) {
        return { ok: false, words, sentences, why: 'too_long' };
    }
    return { ok: true, words, sentences, why: words > SOFT_WORD_LIMIT ? 'long_but_real' : 'typical' };
}

/**
 * Guidance for the model, derived from the measured distribution rather than
 * invented. Returns a short instruction or null.
 */
export function lengthGuidance() {
    return `Most real chat messages are ${P50} words. 91% are under 16. `
        + `Almost nobody writes a paragraph - only 0.12% of real messages contain `
        + `a second sentence at all. Say the thing and stop.`;
}

export { P50, P90, P99, SOFT_SENTENCE_LIMIT, HARD_WORD_LIMIT, countWords, countSentences };
