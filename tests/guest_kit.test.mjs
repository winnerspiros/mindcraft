// Guest kit parsing: headless, no server. Pins what the join probe and
// respawn re-claim decide from /kit list + /kit <name> replies.

import { parseKitNames, pickStarterKit, noKitsReply, classifyKitReply } from '../src/utils/guest_kit.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

// EssentialsX-style list with /kit hints
{
    const blob = 'Available kits: use /kit starter, /kit vip, /kit tools to claim.';
    const names = parseKitNames(blob);
    check(names.includes('starter') && names.includes('tools'), 'parses /kit hints', `got [${names}]`);
    check(pickStarterKit(names) === 'starter', 'picks starter first', `picked ${pickStarterKit(names)}`);
}

// Comma-list style
{
    const names = parseKitNames('Kits: starter, vip, food, diamond');
    check(names.includes('starter') && names.includes('food'), 'parses comma lists', `got [${names}]`);
    check(pickStarterKit(names) !== null, 'finds a starter in the list', 'no pick');
}

// Donor-only list: no obvious starter -> honest, no claim
{
    const names = parseKitNames('Kits: vip, diamond, elite');
    check(pickStarterKit(names) === null, 'donor-only list yields no pick', `picked ${pickStarterKit(names)}`);
    check(!/^(vip|diamond|elite)$/i.test('vip') || pickStarterKit(['vip', 'diamond']) === null, 'never claims vip/diamond unasked', 'would claim a donor kit');
}

// No-plugin replies
{
    check(noKitsReply('Unknown command. Type "/help" for help.'), 'unknown command = no kits', 'missed');
    check(noKitsReply(''), 'empty reply = no kits', 'missed');
    check(!noKitsReply('Available kits: starter, tools'), 'real list is not no-kits', 'false negative');
}

// Claim replies
{
    check(classifyKitReply('You have received the starter kit!').ok, 'success line = ok', 'missed');
    const cd = classifyKitReply('You must wait 2 hours before claiming again.');
    check(!cd.ok && cd.retryMs === 2 * 36e5, 'cooldown parses to retryMs', `got ${JSON.stringify(cd)}`);
    const perm = classifyKitReply('You do not have permission for kit vip.');
    check(!perm.ok && perm.noPerm, 'rank gate = noPerm, never retry', `got ${JSON.stringify(perm)}`);
    const play = classifyKitReply('Requires 5 hours of playtime.');
    check(!play.ok && play.noPerm, 'playtime gate = noPerm', `got ${JSON.stringify(play)}`);
}

// agent.js wiring: probe + re-claim pieces present, home gives untouched
{
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    check(src.includes('_claimGuestKit') || src.includes('_claimGuest'), 'claim path exists in agent', 'missing');
    check(src.includes('_guestKit'), 'claimed kit is remembered', 'no memory');
    check(src.includes('guest_kit.js'), 'probe uses the shared parser', 'inline parsing (drift risk)');
    check(src.includes('if (!canOp())') || src.includes('!canOp()'), 're-claim is guest-only', 'could fire at home');
}

console.log(`\n${pass} passed, ${failed} failed`);
