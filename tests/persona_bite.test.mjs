// Offline guard: the normal persona script must not encode "always kind".
//
// The owner: "an all friendly, never verbal person is not human for sure."
// banter_probe.mjs is model-driven and costs an API call per case, so the
// cheap version of this check lives here and runs in `bun run test` on every
// boot. A script that says "be kind, never prank" fails that probe every time;
// it should fail before we pay for the probe at all.

import { readFileSync } from 'node:fs';

let pass = 0;
const ok = (m) => { console.log(`  ok - ${m}`); pass++; };
const bad = (m) => { console.error(`  NOT OK - ${m}`); process.exitCode = 1; };

const script = JSON.parse(readFileSync('personas/normal.json', 'utf8')).conversing;

// The exact blanket rule that was there before.
const BLANKET = /be kind\.?\s*don'?t hurt[^.]*prank/i;
BLANKET.test(script)
    ? bad('script still says "be kind. Don\'t hurt, poison, trap, prank ... ever"')
    : ok('no blanket "never prank" rule');

// "warm, friendly" as a self-description biases every generation toward
// agreeable output, which is the failure mode.
const WARM = /you are warm, (funny|spontaneous)/i;
WARM.test(script)
    ? bad('script still self-describes as "warm, funny, spontaneous"')
    : ok('self-description is not built around warmth');

// Bite must be explicitly permitted, or a future trim could quietly remove it.
const BITE = /kys|skill issue|ribbing|roast/i;
BITE.test(script)
    ? ok('script explicitly allows bite (roasting / kys / ribbing)')
    : bad('script never mentions roasting or kys — bite has been trimmed away');

// Banned: anything that would make her polite about cruelty.
const SOFTEN = [
    [/never (roast|tease|insult|be mean)/i, 'bans roasting outright'],
    [/always (be )?(kind|polite|nice)/i, 'demands she always be nice'],
    [/don'?t (be mean|roast|tease)/i, 'forbids being mean'],
];
let soft = 0;
for (const [re, label] of SOFTEN) {
    if (re.test(script)) { bad(`script ${label}`); soft++; }
}
if (!soft) ok('nothing in the script forces her to be polite');

// The identity line one is still enforced (that is a separate decision, kept
// narrow and explicit rather than silently broadened).
const IDENTITY_GUARD = /never slur/i;
IDENTITY_GUARD.test(script)
    ? ok('the single narrow guard is still present and explicit')
    : bad('the identity guard was removed — it was a deliberate decision, not an oversight');

console.log(`\nPASS — ${pass} persona-bite assertions green`);
