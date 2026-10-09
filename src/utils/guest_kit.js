// Guest kit awareness (public servers): parse /kit list, pick a free
// starter, classify the claim reply. Pure functions — no bot, no chat —
// so tests pin them headless. agent.js does the chatting.

const SKIP_WORDS = new Set(['list', 'preview', 'show', 'info', 'help', 'claim', 'kits']);

// All the names servers actually call their free starter kit. Conservative
// on purpose: iron/diamond/vip are often donor or rank-gated — claiming
// those unasked is begging at best, a no-permission error at worst. When
// nothing matches, the caller reports the list and plays honest.
const STARTER_RE = /^(starter|start|basic|default|free|food|tools?|gear|stone|wooden|beginner|welcome|newbie|player|survival|daily|common|kit)s?$/i;

// Pull candidate kit names out of a /kit list reply blob.
export function parseKitNames(blob) {
    const names = new Set();
    if (!blob) return [];
    for (const m of String(blob).matchAll(/\/kit\s+([A-Za-z0-9_\-]+)/g)) {
        if (!SKIP_WORDS.has(m[1].toLowerCase())) names.add(m[1]);
    }
    for (const line of String(blob).split('\n')) {
        if (/kit/i.test(line) && line.split(',').length >= 2) {
            for (const tok of line.split(',')) {
                const w = tok.replace(/[^A-Za-z0-9_\- ]/g, '').trim().split(/\s+/).pop();
                if (w && /^[A-Za-z0-9_\-]{2,24}$/.test(w) && !/kit/i.test(w)) names.add(w);
            }
        }
    }
    return [...names];
}

// First obvious free starter, or null (caller plays honest + reports).
export function pickStarterKit(names) {
    return (names || []).find((n) => STARTER_RE.test(n)) || null;
}

// No kits at all on this server?
export function noKitsReply(blob) {
    return !blob || /unknown command|no such command|doesn.t exist|doesn't exist|no kits available|no permission/i.test(blob);
}

// What did the server say after `/kit <name>`?
// -> { ok } on success, { ok:false, retryMs } on cooldown, { ok:false, noPerm }
// on rank/permission gates, { ok:false } on anything else.
export function classifyKitReply(text) {
    const t = String(text || '');
    if (/no permission|you (do not|don't) have|requires? (rank|vip|donor|premium)|ranked|donor only|vip only|playtime|play time|hours? (of )?play/i.test(t)) {
        return { ok: false, noPerm: true };
    }
    let m = t.match(/(?:wait|cooldown|available in|try again in|come back in)\s*(\d+)\s*(second|minute|hour|day)/i)
        || t.match(/(\d+)\s*(second|minute|hour|day)s?\s*(?:remaining|left|cooldown)/i);
    if (m || /cooldown|try again|come back|not (yet|ready)|already (claimed|received)|\bmust wait\b|\bwait\b/i.test(t)) {
        let retryMs = 0;
        if (m) {
            const n = parseInt(m[1], 10);
            const unit = m[2].toLowerCase();
            retryMs = n * (unit.startsWith('day') ? 864e5 : unit.startsWith('hour') ? 36e5 : unit.startsWith('minute') ? 6e4 : 1e3);
        }
        return { ok: false, retryMs };
    }
    if (/receiv|given|enjoy|claimed|here (you|is)|added to your inventory|kit .*applied/i.test(t)) {
        return { ok: true };
    }
    return { ok: t.length === 0 ? false : true, uncertain: t.length > 0 };
}
