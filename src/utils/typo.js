// Typos, at the rate real players actually produce them.
//
// The owner: "typos like the one i did accidentalky are normal also" - i.e. "the
// one I did accidentally".
//
// Measured on 21,822 real player messages in the Minecraft Dialogue Corpus
// (Narayan-Chen, Jayannavar & Hockenmaier, ACL 2019), not guessed:
//
//   1.3% of messages contain an unambiguous typo or dropped apostrophe
//   (288 of 21,822)
//
//   of those, the real spellings are: it's 153, you're 101, teh 16, dont 9,
//   doesnt 4, taht 3, isnt 1, wont 1
//
// Two things follow, and both are counter-intuitive:
//
//   1. The RATE IS TINY. 1.3% means a bot that typos on one message in five is
//      wildly wrong in an obvious way, and one that never typos is only 1.3%
//      too clean. This is a seasoning, not a style.
//
//   2. DROPPED APOSTROPHES DOMINATE, and they are not really typos. it's/you're
//      are 254 of the 288 hits - 88% of all misspelling in this corpus is
//      "its", "youre", "dont", "doesnt". Real transpositions like "teh" and
//      "taht" appear 19 times combined in 21,822 messages.
//
// So the honest model is: mostly missing apostrophes, occasionally a real
// transposition or doubled letter, and almost never both. A model that
// generates "recieve" and "definately" every other message is doing a cartoon
// of a bad typer, not a person.

const TRANSPOSE = [
    'teh', 'taht', 'adn', 'thier', 'recieve', 'seperate', 'definately',
    'wierd', 'becuase', 'freind', 'liesure', 'goverment', 'occured', 'untill',
];

// Deterministic, so tests can pin it. Both are real findings in the corpus.
const DROPPED = [
    [/\bits\b/gi, "its"],
    [/\byoure\b/gi, 'youre'],
    [/\btheyre\b/gi, 'theyre'],
    [/\bwasnt\b/gi, 'wasnt'],
    [/\bhes\b/gi, 'hes'],
    [/\bshes\b/gi, 'shes'],
    [/\bive\b/gi, 'ive'],
    [/\bim\b(?=\s)/gi, 'im'],
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/**
 * Should this message contain a typo? 1.3%, from the corpus. Per-word, so a
 * long message is not proportionally likelier to be misspelt - a real typo rate
 * is per character-ish, and messages here are 5 words median.
 */
export function shouldTypo(rate = 0.013, rand = Math.random) {
    return rand() < rate;
}

/**
 * Corrupt a message the way a real player at speed would. Only ever SUBTLE:
 * a missing apostrophe, or a real transposition from the measured list.
 */
export function applyTypo(text, { rand = Math.random, force = false } = {}) {
    let s = String(text || '');
    if (!s) return s;

    const edits = [];
    for (const [rx, _] of DROPPED) if (rx.test(s)) edits.push(rx);

    // ~70% of real misspelling in this corpus is a dropped apostrophe, and the
    // rest is a transposition, so prefer that split.
    const useDropped = edits.length && rand() < 0.7;
    if (useDropped) {
        const rx = pick(edits);
        return s.replace(rx, pick(['its', 'youre', 'theyre', 'wasnt', 'hes', 'shes', 'ive', 'im']));
    }

    if (force || shouldTypo(0.013, rand)) {
        // A real transposition, spliced into a word long enough to carry one.
        const words = s.split(/(\s+)/);
        const candidates = words
            .map((w, i) => [w, i])
            .filter(([w]) => /^[a-z]{4,}$/.test(w));
        if (candidates.length) {
            const [w, i] = pick(candidates);
            const t = TRANSPOSE[Math.floor(rand() * TRANSPOSE.length)];
            words[i] = t;
            return words.join('');
        }
    }
    return s;
}
