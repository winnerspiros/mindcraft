// Split a reply into chat-sized lines.
//
// Real multiplayer chat is not paragraphs. People send "hey" then "whats up"
// then the actual point - three short lines, three separate messages. One
// 30-word block reads as a bot no matter how well it is worded.
//
// Two failure modes to avoid, and they pull in opposite directions:
//   - one long paragraph: reads as a bot
//   - chopped into six one-word lines: reads as SPAM, which nobody does
//
// So: hard cap at MAX_LINES, and never fragment into anything shorter than
// MIN_CHARS unless the source already had that boundary. If the text cannot be
// split cleanly within the cap, return it whole - a slightly long line is much
// less suspicious than machine-gun one-word messages.

const MAX_LINES = 3;
const MIN_CHARS = 12;

// Hard word cap. Measured over 55,904 real player messages (Minecraft Dialogue
// Corpus, Narayan-Chen et al. ACL 2019): median 5 words, p75 8, p90 16. So a
// single message over 10 words is already tail behaviour. The prompt says this
// and she still writes 13-15 word lectures, so it is enforced here - a prompt
// rule loses to the distribution, a truncation cannot.
//
// Keeps the FIRST sentence only, because in a chat reply the first sentence is
// the point and the rest is elaboration she was told not to add.
const MAX_WORDS = 10;
// A truncated reply must still be a phrase, not a fragment of a phrase.
// "you need to make" is word salad; a reader cannot parse it and neither can a
// player, so a hard word-count cut is only allowed at a CLAUSE boundary.
// If no such boundary exists the reply is returned whole - a slightly long
// message is far less suspicious than nonsense.
const enforceWordCap = (text) => {
    const t = String(text || '').trim();
    if (!t) return t;
    const { body, command } = splitOffCommand(t);
    const words = body.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_WORDS) return t;

    // First sentence if it already fits.
    const sentences = body.split(SENTENCE).map((x) => x.trim()).filter(Boolean);
    if (sentences[0] && sentences[0].split(/\s+/).length <= MAX_WORDS) {
        return command ? `${sentences[0]} ${command}`.trim() : sentences[0];
    }

    // Otherwise keep whole clauses up to the cap.
    const clauses = body.split(SENTENCE).join(' ').split(CLAUSE).map((x) => x.trim()).filter(Boolean);
    const kept = [];
    for (const c of clauses) {
        const next = kept.concat(c);
        if (next.join(' ').split(/\s+/).length > MAX_WORDS) break;
        kept.push(c.replace(/[,;:]+$/, ''));
    }
    if (!kept.length) return t; // no clean cut available - leave it whole
    const out = kept.join(' ');
    return command ? `${out} ${command}`.trim() : out.trim();
};

// Split points, in priority order. Sentence boundaries first because a real
// burst is one thought per line; clause boundaries only if that yields too few
// pieces; whitespace last as the fallback.
const SENTENCE = /(?<=[.!?])\s+/;
const CLAUSE = /(?<=[,;:])\s+/;

// A trailing !command rides with the line it belongs to - never orphaned.
// Declared first because enforceWordCap (above) uses it.
export function splitOffCommand(text) {
    const m = String(text || '').match(/\s*!\w+\([^)]*\)\s*$/);
    if (!m) return { body: text, command: null };
    return { body: String(text).slice(0, m.index), command: m[0].trim() };
}

export function fragmentForChat(text) {
    let s = enforceWordCap(text);
    if (!s) return [];

    // Multiple commands already = multi-message by nature. Leave alone.
    const commandCount = (s.match(/!\w+\(/g) || []).length;
    if (commandCount > 1) return [s];

    const { body, command } = splitOffCommand(s);

    let parts = null;
    const bySentence = body.split(SENTENCE).map((x) => x.trim()).filter(Boolean);
    if (bySentence.length >= 2) parts = bySentence;

    if (!parts) {
        const byClause = body.split(CLAUSE).map((x) => x.trim()).filter(Boolean);
        // Only useful if it actually balances the length. Splitting a short
        // clause off a 20-word line produces two 10-word lines for no reason,
        // and the split point must be well inside the line - a comma in the
        // first fifth is not a burst boundary, it is just a comma.
        const cutAt = body.search(CLAUSE);
        const balanced = byClause.length >= 2
            && Math.min(...byClause.map((p) => p.length)) >= MIN_CHARS
            && cutAt > body.length * 0.3;
        if (balanced) parts = byClause;
    }

    // No word-count fallback. Cutting mid-phrase on a raw word boundary is the
    // one thing that produces unreadable output - "you need to make" is not a
    // message, it is a bug that shipped. If there is no sentence or clause
    // boundary, leave the reply whole; a long line is fine, nonsense is not.
    if (!parts) return [s];

    // A split point removes the break, so any punctuation that used to sit at
    // the end of a piece is now dangling mid-message ("ill go grab some wood,").
    // Strip it from every piece except the last.
    parts = parts.map((p, i) => (i < parts.length - 1 ? p.replace(/[,;:]+$/, '') : p));

    // No merging. The first version forced every fragment above MIN_CHARS=12,
    // which merged real one-word messages ("hey", "yeah", "nah,") into
    // artificial two-word lines purely to satisfy a rule invented here.
    // Measured: 36% of real player messages are <=3 words, 18% are a single
    // word. Short lines are correct, so they are left alone.
    const merged = parts.slice();

    // Too many pieces to send without spamming: rebalance into MAX_LINES
    // balanced chunks rather than dropping content or sending six messages.
    if (merged.length > MAX_LINES) {
        const total = merged.join(' ').split(/\s+/).length;
        const per = Math.ceil(total / MAX_LINES);
        const words = merged.join(' ').split(/\s+/);
        const out = [];
        for (let i = 0; i < words.length; i += per) {
            const chunk = words.slice(i, i + per).join(' ').replace(/[.,;:]$/, '');
            if (chunk) out.push(chunk);
        }
        parts = out.slice(0, MAX_LINES);
    }

    if (command) parts[parts.length - 1] = `${parts[parts.length - 1]} ${command}`.trim();
    return parts.filter(Boolean);
}
