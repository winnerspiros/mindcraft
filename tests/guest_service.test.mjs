// Guest service slot: the second-process wiring must stay intact.
//
// 1. systemd/uwu-bot@.service exists, sets UWU_SERVER=%i + UWU_COUNT_ID,
//    and is NOT bound to the local minecraft-fabric.service.
// 2. standalone.js honors UWU_COUNT_ID (viewer port offset).
// 3. tools/boot.sh resolves the wait host from servers.json for guests.
// 4. docs/guest-join-runbook.md exists (the human checklist).

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

const unit = path.join(REPO, 'systemd', 'uwu-bot@.service');
check(fs.existsSync(unit), 'guest service template exists', 'systemd/uwu-bot@.service missing');
if (fs.existsSync(unit)) {
    const u = fs.readFileSync(unit, 'utf8');
    check(/Environment="UWU_SERVER=%i"/.test(u), 'template picks the server entry from the instance name', 'template does not set UWU_SERVER=%i');
    check(/Environment="UWU_COUNT_ID=1"/.test(u), 'template offsets the viewer port', 'template does not set UWU_COUNT_ID');
    check(!/^(After|Wants|Requires|BindsTo)=.*minecraft-fabric/m.test(u), 'guest slot is not bound to the local MC service', 'guest slot follows the local MC service (wrong for remotes)');
}

{
    const s = fs.readFileSync(path.join(REPO, 'standalone.js'), 'utf8');
    check(/UWU_COUNT_ID/.test(s), 'standalone honors UWU_COUNT_ID', 'standalone ignores UWU_COUNT_ID');
}

{
    const b = fs.readFileSync(path.join(REPO, 'tools', 'boot.sh'), 'utf8');
    check(/WAIT_HOST/.test(b) && /servers\.json\.local/.test(b), 'boot wait resolves the guest host', 'boot wait still hardcodes localhost');
}

check(fs.existsSync(path.join(REPO, 'docs', 'guest-join-runbook.md')), 'join runbook exists', 'docs/guest-join-runbook.md missing');

console.log(`\n${pass} passed, ${failed} failed`);
