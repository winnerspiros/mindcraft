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

// Split points, in priority order. Sentence boundaries first because a real
// burst is one thought per line; clause boundaries only if that yields too few
// pieces; whitespace last as the fallback.
const SENTENCE = /(?<=[.!?])\s+/;
const CLAUSE = /(?<=[,;:])\s+/;

// A trailing !command rides with the line it belongs to - never orphaned.
function splitOffCommand(text) {
    const m = String(text || '').match(/\s*!\w+\([^)]*\)\s*$/);
    if (!m) return { body: text, command: null };
    return { body: String(text).slice(0, m.index), command: m[0].trim() };
}

export function fragmentForChat(text) {
    let s = String(text || '').trim();
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

    if (!parts) {
        const words = body.split(/\s+/);
        if (words.length < 8) return [s];
        // Fall back to a balanced word split at a space near the middle.
        let cut = Math.floor(words.length / 2);
        const mid = cut;
        for (let i = mid; i > 0; i--) {
            if (words[i].length + words[i - 1].length >= MIN_CHARS) { cut = i; break; }
        }
        const a = words.slice(0, cut).join(' ').replace(/[.,;:]$/, '');
        const b = words.slice(cut).join(' ');
        if (a.length < MIN_CHARS || b.length < MIN_CHARS) return [s];
        parts = [a, b];
    }

    // A split point removes the break, so any punctuation that used to sit at
    // the end of a piece is now dangling mid-message ("ill go grab some wood,").
    // Strip it from every piece except the last.
    parts = parts.map((p, i) => (i < parts.length - 1 ? p.replace(/[,;:]+$/, '') : p));

    // Merge tiny pieces forward so we never emit a 3-character line.
    const merged = [];
    for (const p of parts) {
        if (merged.length && (merged[merged.length - 1].length < MIN_CHARS || p.length < MIN_CHARS)) {
            merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`.trim();
        } else {
            merged.push(p);
        }
    }

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
