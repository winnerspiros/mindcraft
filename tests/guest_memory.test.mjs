// Memory namespacing: the guest account must not read or write the home
// account's memory, and must not phone home (EasyAuth DB) from a foreign
// server. The guest username (UwU_Guest) already isolates every
// bots/<name>/ store — this pins the bypasses that ignored the name:
//
// 1. No hardcoded bots/UwU paths in shipped source (comments/docs exempt,
//    fallbacks of the form `|| 'UwU'` exempt — those only fire when no
//    name exists at all).
// 2. ledger paths resolve per bot name (furnace + station ledgers take bot).
// 3. EasyAuth IP enrichment refuses off-home (canOp gate).
// 4. Normal persona carries no home identity (no server name, no seed, no
//    RCON, no owner name, no console-power talk).

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

const srcFiles = execFileSync('git', ['ls-files', 'src/', 'standalone.js'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(f => f.endsWith('.js'));

// 1. hardcoded home paths
{
    const bad = [];
    for (const f of srcFiles) {
        const body = fs.readFileSync(path.join(REPO, f), 'utf8');
        for (const [i, line] of body.split('\n').entries()) {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*')) continue; // comments/docs
            if (/bots\/UwU/.test(line)) bad.push(`${f}:${i + 1}`);
            if (/loadKnownBuilds\?\.\('UwU'\)/.test(line)) bad.push(`${f}:${i + 1}`);
        }
    }
    check(bad.length === 0, 'no hardcoded home-account memory paths in source', `home paths bypass namespacing: ${bad.join(', ')}`);
}

// 2. ledgers resolve per bot
{
    for (const f of ['src/agent/library/furnace_ledger.js', 'src/agent/library/station_ledger.js']) {
        const body = fs.readFileSync(path.join(REPO, f), 'utf8');
        check(/function ledgerPath\(bot\)/.test(body), `${path.basename(f)} resolves its path per bot`, `${f} has no per-bot path`);
        check(!/const LEDGER = '\.\/bots\/UwU/.test(body), `${path.basename(f)} has no hardcoded home path`, `${f} still hardcodes the home path`);
    }
    const acts = fs.readFileSync(path.join(REPO, 'src/agent/commands/actions.js'), 'utf8');
    check(/function agentFile\(agent, leaf\)/.test(acts), 'actions.js resolves build/project paths per agent', 'actions.js has no per-agent path helper');
}

// 3. EasyAuth enrichment is home-only
{
    const body = fs.readFileSync(path.join(REPO, 'src/agent/profiles.js'), 'utf8');
    const i = body.indexOf('async enrichIdentity');
    const block = body.slice(i, i + 1200);
    check(/canOp\(\)/.test(block), 'EasyAuth IP enrichment refuses off-home', 'enrichIdentity has no home gate (guest would read foreign players via home DB)');
}

// 4. normal persona carries no home identity
{
    const n = JSON.parse(fs.readFileSync(path.join(REPO, 'personas/normal.json'), 'utf8'));
    const c = n.conversing || '';
    for (const pat of ['YandereCraft', 'kenoi', '1117332047292399705', 'RCON', 'rcon', '25575', 'EasyAuth', 'easyauth', 'YandereDev', 'console powers', 'seed']) {
        check(!c.includes(pat), `normal persona mentions no ${JSON.stringify(pat)}`, `normal persona leaks home identity: ${pat}`);
    }
}

console.log(`\n${pass} passed, ${failed} failed`);
