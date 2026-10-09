// Server switch: one command moves her home <-> public, never both at
// once (1 OCPU cannot hold two bots + Fabric). Pins the script contract.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const sh = path.join(REPO, 'tools', 'server-switch.sh');
check(fs.existsSync(sh), 'switch script exists', 'tools/server-switch.sh missing');
let src = '';
if (fs.existsSync(sh)) {
    src = fs.readFileSync(sh, 'utf8');
    check((fs.statSync(sh).mode & 0o111) !== 0, 'switch script is executable', 'not executable');
    check(src.includes('status') && src.includes('home') && src.includes('guest'), 'status/home/guest verbs', 'missing verbs');
    // One at a time: guest verb stops the home unit, home verb stops guest slots.
    const gi = src.indexOf('guest)');
    check(gi > 0 && src.slice(gi, gi + 800).includes('stop'), 'guest switch stops home first', 'guest would run alongside home');
    const hi = src.indexOf('\n    home)');
    check(hi > 0 && src.slice(hi, hi + 800).includes('uwu-bot@'), 'home switch stops guest slots first', 'home would run alongside guest');
    // Placeholder guard: refuses to send her to play.example.net.
    check(src.includes('play.example.net'), 'refuses the placeholder host', 'would join the placeholder');
    // Both-running warning for the 1 OCPU box.
    check(/both sides running/i.test(src), 'warns when both sides run', 'no both-running warning');
}

// Guest template: installed unit matches the repo copy.
try {
    const installed = fs.readFileSync('/etc/systemd/system/uwu-bot@.service', 'utf8');
    const repoCopy = fs.readFileSync(path.join(REPO, 'systemd', 'uwu-bot@.service'), 'utf8');
    check(installed.trim() === repoCopy.trim(), 'installed guest template matches repo', 'installed unit drifted');
} catch (e) {
    check(false, 'installed guest template matches repo', 'uwu-bot@.service not installed');
}

console.log(`\n${pass} passed, ${failed} failed`);
