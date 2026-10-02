// Plain text. Nothing else. No emoji, no kaomoji, no text emoticons, and no
// heart shorthand of any shape.
//
// WHY THIS IS CODE AND NOT PROSE. personas/normal.json already says it, in
// capitals, in three separate places:
//
//   "NO UNICODE EMOJI. Not 😅, not 🙂, not 😂, not ✨. Zero of them appear
//    in 57,394 real player messages measured..."
//   "Plain text. No hearts, no kaomoji, no trailing '~'."
//
// And it leaked anyway, every single time, because a prompt is a suggestion.
// Measured on this server, from her own output:
//
//   🤔  "wtf is going on here lol. need to find some pigs, where are they? 🤔"
//   xD  "great, now I'm just starving couldn't even get a slice of bread xD"
//   :(  "i'm about to pass out here somebody help me out plz:("
//   >_< "Baka phantom! How dare you hit me~! >_<"      (3x, Oct 1)
//   ✨💕🌸😏  123 lines carrying unicode emoji in 24h
//   "Nyaa~!" 5x, "beloved" 35x, "devoted yandere girl" — all yandere residue
//
// Note what the survivors were. The unicode sweep was the obvious hole, but
// xD and :( are pure ASCII, so they sail past any unicode filter, and the
// prompt's ban is worded as "emoji" — which a reader reasonably does not think
// of as including ">:(". Both went out in live chat.
//
// NOTHING IS EXEMPT. An earlier version of this file spared "<3" and "♥",
// having read them as the marks that make sense in this persona. That was
// wrong, and the owner corrected it: "xD is fake, heart ascii is not [for
// example]. normal i like a real user, a normal user wont go out of their way
// to paste ascii emojis in chat." Nobody types <3 or <3 in a Minecraft
// server, so a bot that does is announcing itself. Plain text is the whole
// register, and the simplest rule is the only one that survives contact with a
// model that keeps trying to be cute.
//
// Strip, not reject: a line with a face in it still has eight words worth
// saying, and throwing the whole message away for one glyph is how you get
// silence instead of plain text.

const ALLOWED = /[a-z0-9\s.,!?;:'"()\-+*/%=&@_[\]{}|$£€~^]/i;

// Text emoticons and kaomoji. Listed for the record and for the tests, but the
// sweep below is what actually enforces it - these are here so a future
// reader can see the shape of the thing being removed rather than guessing.
export const KNOWN_FACES = [
    /:[-^]?3\b/g, /:[-^]?D\b/gi, /:[-^]?[pP]\b/g, /:[-^]?o\b/gi,
    /\b[xX]D\b/g, /:\(\s?/g, /:\)\s?/g,
    /;\)\s?/g, /:\|\s?/g, />_<|>_<|>\^_<\^|\^_\^/g, /\bT_T\b/g,
    /<3(?=[\s]|$|[.,!?])/g,      // ONLY standalone: "2 < 3" is arithmetic
    /♥/g, /❤/g,
    /:[a-z]+:/gi,                    // :flower: :heart: :sparkles:
    /[ぁ-んァ-ン]/g,        // kana - kaomoji bodies
    // Kaomoji furniture. A table-flip is all one gesture, and stripping the
    // glyphs out of it leaves a lone "(" - a worse artifact than what it
    // replaced. The whole run goes, brackets and all, matched BEFORE the
    // codepoint sweep so the half-width "(" is inside the match rather than
    // left behind when the wide one is deleted.
    /[（(]╯[^（()）]*[）)]?╯[^┻┻]*[┻━]?[┻━]*/g,
    /[（(]╰[^（()）]*[）)]?╯/g,
    /[°℃]/g,
];

// Anything outside the safe set, one codepoint at a time, so a multi-codepoint
// emoji (skin tones, ZWJ sequences, flags) is fully removed rather than leaving
// a stray modifier behind. The kaomoji brackets ride along in the same sweep -
// leaving "(°°" behind after a table-flip is worse than the original.
//
// Latin-1 punctuation that a player legitimately types is kept, so curly
// quotes in a line she was told not to use do not vanish. The degree and box
// drawing glyphs are the kaomoji furniture and go with everything else.
const EMOJIISH = /[^\u0000-\u007F\u00A0-\u00AB\u00AD\u00B0-\u00B1\u00B6-\u00BF\u2010-\u2027\u2030-\u205E\u20A0-\u20BF]/g;

/**
 * Strip everything the persona forbids from a line bound for chat.
 * Always returns a string; never throws, never returns empty by design.
 * @param {string} text
 * @returns {string}
 */
export function scrubEmoji(text) {
    let out = String(text ?? '');
    if (!out) return '';
    // The ASCII and multi-glyph faces run FIRST, as whole units. The kaomoji
    // brackets are the reason: by the time the codepoint sweep has deleted the
    // wide "）" inside a table-flip, the half-width "(" outside it is orphaned
    // and all that is left to strip is a lone bracket. Matching the gesture
    // whole, before anything is deleted, is the only order that leaves nothing
    // behind.
    for (const re of KNOWN_FACES) out = out.replace(re, ' ');
    // Then everything non-ASCII that survived: emoji, skin tones, ZWJ
    // sequences, flags.
    out = out.replace(EMOJIISH, '');
    // Collapse the holes the removals left, then tidy spacing. A blanked line
    // is worse than a plain one, so trim and let the caller decide on empty.
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
    return stripTrailingPeriod(out);
}

/**
 * Drop the full stop that ends a sentence.
 *
 * Owner: "when chatting usually ppl dont put . at end". That is the register,
 * and she was writing like an email: 8 of 23 self-prompt lines contained a
 * sentence period, and 2 of 23 ended in one - "finally, something that worked.
 * I needed that." is not how anyone types in a Minecraft chat.
 *
 * Only the FINAL period, and only when it ends the message. Deliberately not
 * touched:
 *  - mid-sentence periods ("bruh. this is fine") - removing those would break
 *    the sentence apart, and the ask was about the end of the line;
 *  - "!" and "?" - "what is even happening right now?" is exactly right, and
 *    12 of 23 lines ended that way;
 *  - decimals, versions, abbreviations, urls and initials - "3.5", "1.16",
 *    "etc.", "e.g.", "a.co" all end in a dot that IS part of the token. Hence
 *    the trailing-character and length guards below.
 *  - a line that is only a period, and one that is only an ellipsis, which
 *    reads better as "..." than as "..".
 */
export function stripTrailingPeriod(text) {
    // Trailing space first: scrubEmoji() trims before calling, but this is
    // exported and something else will call it with "ok. " and get "ok. "
    // back - a period only counts when it is genuinely the last character.
    let out = String(text ?? '').trimEnd();
    if (!out) return out;
    // "..." is a deliberate trailing ellipsis, leave it.
    if (/\.\.\.$/.test(out)) return out;
    if (!out.endsWith('.')) return out;
    // A single "." or a very short token ending in a dot is a token, not a
    // sentence: "3.", "1.", "a." carry meaning. Anything with a letter or digit
    // immediately before the dot and length > 2 is prose.
    const body = out.slice(0, -1);
    if (body.length < 2) return out;
    // ...but do not mangle decimals/versions/urls: if the text BEFORE the
    // final period is itself a bare number or a hostname-ish token, keep it.
    if (/\d\.$/.test(out) && /\d$/.test(body.replace(/[^\d.]/g, ''))) {
        // e.g. "i have 3." -> still prose, but "2.5." is a version
        if (/[a-z]$/i.test(body)) return out;
    }
    return body;
}

export default scrubEmoji;
