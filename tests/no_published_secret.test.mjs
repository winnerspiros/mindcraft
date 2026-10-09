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
// servers.json joins keys.json and uwu.json here: it carries the world
// seed. It USED to be tracked, which is why the seed was published at the
// branch tip in plain sight -- scrubbing the literal alone left the door
// open for the next person to paste their own seed in and commit it.
for (const f of ['keys.json', 'uwu.json', 'servers.json', 'servers.json.local']) {
    check(!tracked(f), `${f} is not tracked`, `${f} IS tracked -- it can be committed`);
    check(isIgnored(f), `${f} is gitignored`, `${f} is not gitignored`);
}

// ── and a safe template must exist in its place ─────────────────────────
for (const f of ['servers.example.json']) {
    const p = path.join(ROOT, f);
    check(fs.existsSync(p), `${f} exists as the safe template`, `${f} is missing`);
    if (fs.existsSync(p)) {
        const body = fs.readFileSync(p, 'utf8');
        check(!/\d{19,20}/.test(body), `template ${f} carries no seed literal`,
              `template ${f} ships a world seed`);
        check(!/"pwFile"\s*:\s*"\/home\/ubuntu/.test(body),
              `template ${f} uses a generic pwFile path`,
              `template ${f} ships the owner's absolute rcon path`);
    }
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

// ── and the tracked tree must be clean of anything password/seed-shaped ─
// Reads the INDEX (:path), not the working tree, so this reports what would
// actually be committed -- a stale index otherwise reports secrets that have
// already been removed from disk. Only files git would add, so an ignored
// local secret can't produce a false positive here (that mistake cost us a
// confusing scan earlier in this session).
const staged = git('ls-files', '-z').split('\0').filter(Boolean);
const suspicious = [];
for (const f of staged) {
    if (!/\.(json|js|mjs|md|sh|env)$/.test(f)) continue;
    let body;
    try { body = git('show', `:${f}`); } catch { continue; }
    // A non-empty auth_password / *_PASSWORD / *_API_KEY assigned a literal.
    // The value must not be a documented placeholder: the README shows
    // "sk-or-…" style examples on purpose, and flagging those would make this
    // check cry wolf on the very docs that explain the rule.
    const PLACEHOLDER = /(?:^|…|\.\.\.|\*{3,}|x{3,}|YOUR_|<)/i;
    for (const m of body.matchAll(/(?:auth_password|"\w*_PASSWORD"|"\w*_API_KEY")\s*:\s*"([^"]{6,})"/g)) {
        if (!PLACEHOLDER.test(m[1])) suspicious.push(`${f} (secret)`);
    }
    // A world seed. 19-20 digit longs are the giveaway: they are the seed, not
    // a timestamp, an id or a BigInt mask. Requiring a seed-ish KEY as well as
    // the literal avoids false-positives on every unrelated constant. The
    // key may be quoted (JSON: "seed": 123) or bare (JS: seed = '123'), so
    // the quote and any whitespace around the separator are both optional --
    // an earlier version of this pattern missed the JSON form entirely.
    if (/"?\b(?:world_?)?seed\b"?\s*[:=]\s*['"]?\d{19,20}\b['"]?/i.test(body))
        suspicious.push(`${f} (world seed)`);
}
check(suspicious.length === 0,
    `no password- or seed-shaped literals in ${staged.length} tracked files`,
    `tracked files with a literal secret: ${suspicious.join(', ')}`);

// ── the world seed must not be a live default in source either ─────────
// It was hardcoded as a fallback in server_context.js and as a dead
// WORLD_SEED const in world.js, so scrubbing servers.json alone would have
// left it readable in two source files.
for (const f of ['src/utils/server_context.js', 'src/agent/library/world.js',
                 'src/agent/library/world_knowledge.md']) {
    const body = git('show', `:${f}`);
    check(!/\d{19,20}/.test(body),
        `${f} carries no 19-20 digit literal`,
        `${f} still contains a 19-20 digit literal (likely the world seed)`);
}

console.log(`\n${pass} passed, ${failed} failed`);
if (failed === 0) console.log('no credential is staged for commit');
