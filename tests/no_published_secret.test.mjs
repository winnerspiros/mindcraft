// No credential may be committed, in the working tree or in history.
//
// uwu.json is her persona AND her EasyAuth password. It was tracked, so
// the live auth_password sat in the published fork from the very first
// commit -- and keys.json was already gitignored for exactly this reason,
// one line above it. Two files, same secret class, opposite handling.
//
// This checks the working tree and the shipped template. History is the
// harder half: the old value is still reachable in published commits, so
// rotating the credential is what actually closes it, and this test is
// what stops the next one from being published in the first place.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const isIgnored = f => { try { git('check-ignore', '-q', f); return true; } catch { return false; } };
const tracked = f => { try { git('ls-files', '--error-unmatch', f); return true; } catch { return false; } };

// ── the secret files must be untracked and ignored ──────────────────────
for (const f of ['keys.json', 'uwu.json']) {
    check(!tracked(f), `${f} is not tracked`, `${f} IS tracked -- it can be committed`);
    check(isIgnored(f), `${f} is gitignored`, `${f} is not gitignored`);
}

// ── the shipped template must exist and be blank where it matters ───────
const tplPath = path.join(ROOT, 'uwu.example.json');
check(fs.existsSync(tplPath), 'uwu.example.json exists as the safe template', 'uwu.example.json is missing');
if (fs.existsSync(tplPath)) {
    const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
    check(!tpl.auth_password, 'template auth_password is empty', 'template ships an auth_password');
    check(!tpl.beloved, 'template beloved is empty', 'template ships the owner\'s MC name');
    check(!!tpl.conversing?.length, 'template keeps her persona prompt', 'template persona prompt is empty');
}

// ── and the tracked tree must be clean of anything password-shaped ──────
// Only files git would actually add, so an ignored local secret can't
// produce a false positive here (that mistake cost us a scan earlier).
const staged = git('ls-files', '-z').split('\0').filter(Boolean);
const suspicious = [];
for (const f of staged) {
    if (!/\.(json|js|mjs|sh|env)$/.test(f)) continue;
    let body;
    try { body = git('show', `:${f}`); } catch { continue; }
    // a non-empty auth_password / *_PASSWORD / *_API_KEY assigned a literal
    if (/(?:auth_password|"\w*_PASSWORD"|"\w*_API_KEY")\s*:\s*"[^"]{6,}"/.test(body)) suspicious.push(f);
}
check(suspicious.length === 0,
    `no password-shaped literals in ${staged.length} tracked files`,
    `tracked files with a literal secret: ${suspicious.join(', ')}`);

console.log(`\n${pass} passed, ${failed} failed`);
if (failed === 0) console.log('no credential is staged for commit');
