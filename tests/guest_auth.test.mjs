// Guest auth hardening: password isolation + .local overlay.
//
// 1. A guest entry (op=false + auto_auth:true) with NO auth_password must NOT
//    fall back to the profile (home EasyAuth) password — handing a public
//    server the home credential would burn it. password:null = stay silent.
// 2. servers.json.local (gitignored) overlays per-server secrets onto the
//    base entry, so the public password lives outside the main file.
// 3. Home entries keep the old behavior: profile password fallback works.
//
// Each case runs in its own node subprocess (own cwd + own module registry)
// so the server_context singleton and the settings object can't leak across.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const base = (over = {}) => ({
    active: 'guest',
    servers: {
        guest: { host: 'play.example.net', port: 25565, op: false, auto_auth: true, auth_password: null, version: 'auto', ...over },
        home: { host: '127.0.0.1', port: 25565, op: true, auto_auth: false, auth_password: null, version: '26.3' },
    },
});

const PROBE = (box) => `
import * as m from ${JSON.stringify(path.join(box, 'ctx.mjs'))};
import s from ${JSON.stringify(path.join(box, 'settings.mjs'))};
for (const k of Object.keys(s)) delete s[k];
s.profile = { auth_password: process.env.PROFILE_PW || null };
const ctx = m.serverContext();
const flow = m.authFlow();
console.log(JSON.stringify({ op: ctx.op, auto: ctx.auto_auth, pw: flow.password }));
`;

// Build one sandbox dir with real node_modules resolution.
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-auth-'));
try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(box, 'node_modules')); } catch (_) {}
let ctxSrc = fs.readFileSync(path.join(REPO, 'src', 'utils', 'server_context.js'), 'utf8');
ctxSrc = ctxSrc.replaceAll('../agent/settings.js', './settings.mjs');
fs.writeFileSync(path.join(box, 'ctx.mjs'), ctxSrc);
fs.copyFileSync(path.join(REPO, 'src', 'agent', 'settings.js'), path.join(box, 'settings.mjs'));
fs.writeFileSync(path.join(box, 'probe.mjs'), PROBE(box));

const run = (files, server, profilePw) => {
    const dir = fs.mkdtempSync(path.join(box, 'case-'));
    for (const [name, obj] of Object.entries(files)) {
        if (obj !== null && obj !== undefined) fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
    }
    fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE(box));
    const env = { ...process.env, UWU_SERVER: server, PROFILE_PW: profilePw || '' };
    const out = execSync('node probe.mjs', { cwd: dir, env, encoding: 'utf8' });
    const line = out.trim().split('\n').pop();
    return JSON.parse(line);
};

// 1. guest without own password: NEVER the profile password
{
    const r = run({ 'servers.json': base() }, 'guest', 'HOME_SECRET');
    check(r.auto === true, 'guest auto_auth stays on', 'guest auto flag lost');
    check(r.pw === null || r.pw === undefined, 'guest without auth_password gets no password (home pw refused)', `guest leaked profile password: ${JSON.stringify(r.pw)}`);
}

// 2. .local overlay supplies the guest password
{
    const r = run(
        { 'servers.json': base(), 'servers.json.local': { servers: { guest: { auth_password: 'GUEST_ONLY_PW' } } } },
        'guest', 'HOME_SECRET');
    check(r.pw === 'GUEST_ONLY_PW', '.local overlay provides the guest password', `overlay failed: ${JSON.stringify(r.pw)}`);
}

// 3. home keeps profile fallback
{
    const r = run({ 'servers.json': base() }, 'home', 'HOME_SECRET');
    check(r.pw === 'HOME_SECRET', 'home still falls back to the profile password', `home fallback broke: ${JSON.stringify(r.pw)}`);
}

try { fs.rmSync(box, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${failed} failed`);
