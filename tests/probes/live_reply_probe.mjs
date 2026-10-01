// Send one real chat line and report what the bot did with it.
//
// Drives the live bot through the actual inbound path (a player message, not an
// RCON 'say', which the bot treats as a server broadcast), then reads the
// service log for the verdict. This is the only test that reproduces the
// reported bug, because the bug needed two gates to compose.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);

const MSG = process.argv[2] || 'hey uwu';
const WAIT = Number(process.argv[3] || 50) * 1000;

const logSince = (secs) => {
    try {
        return execSync(
            `sudo journalctl -u uwu-bot.service --since '${secs} seconds ago' --no-pager`,
            { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch (e) { return ''; }
};

const mark = Date.now();
console.log(`\nwatching uwu-bot.service, then waiting ${WAIT / 1000}s...`);
await new Promise((x) => setTimeout(x, 1000));

const out = logSince(5);
const interesting = out.split('\n').filter((l) => /received message|backchannel|empty-ack|gate:|UwU said|response/i.test(l));
console.log('\n──────── current log (before you type) ────────');
console.log(interesting.slice(-6).join('\n') || '  (nothing yet)');
console.log(`\n>>> TYPE THIS IN MINECRAFT CHAT NOW:  ${JSON.stringify(MSG)}`);
console.log(`>>> then wait ${WAIT / 1000}s. This probe will not send it for you.`);
await new Promise((x) => setTimeout(x, WAIT));

const after = logSince(Math.ceil((Date.now() - mark) / 1000) + 5);
const lines = after.split('\n').filter((l) => /received message|backchannel|empty-ack|gate:|turntaker/i.test(l));
console.log('\n──────── what happened ────────');
console.log(lines.slice(-14).join('\n') || '  (no matching lines)');

const got = lines.some((l) => /received message/i.test(l));
const suppressed = lines.filter((l) => /suppressed/i.test(l));
const backchannel = lines.filter((l) => /backchannel/i.test(l));
console.log('\n──────── verdict ────────');
console.log(`  message seen by bot : ${got ? 'YES' : 'NO - it never arrived'}`);
console.log(`  replies suppressed  : ${suppressed.length}`);
for (const s of suppressed.slice(0, 5)) console.log(`      ${s.slice(0, 120)}`);
console.log(`  went to backchannel : ${backchannel.length} (should be 0 when naming her)`);
if (!got) console.log('\n  -> the message never reached the bot; type it in-game, not via RCON');
else if (suppressed.length) console.log('\n  -> STILL BEING GATED. The fix did not work.');
else if (backchannel.length) console.log('\n  -> still routed to a canned ack. The fix did not work.');
else console.log('\n  -> clean: she spoke, and nothing ate it.');