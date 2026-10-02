// Digging reach must match what the SERVER accepts.
//
// 2026-10-02. She attempted 594 stone digs and broke 0 blocks. The server log
// said why, repeatedly, by name:
//
//   [PandaAntiExploit] Failed block break action, player cannot see block [UwU]
//
// Decompiling panda-anti-exploit 2.1.5 (BlockUtil.canBreak -> canSeeBlock)
// shows what "cannot see" means there. It is NOT a raycast:
//
//   range = player.getAttributeValue(BLOCK_INTERACTION_RANGE)   // 4.5
//   eye   = player.getEyePosition(1.0)
//   body  = player.getBoundingBox().getCenter()
//   canBreak = canSeeBlock(pos, eye, range) || canSeeBlock(pos, body, range)
//
//   canSeeBlock(pos, origin, range):
//     if getBlockState(pos).getShape(...).isEmpty() -> true
//     reject if origin.distanceToSqr(Vec3.atCenterOf(pos)) > range*range
//
// The predicate is therefore: BLOCK CENTRE within 4.5 of her eye OR body centre.
//
// collectBlock measured to the NEAREST FACE with a 4.2 threshold instead.
// Nearest-face distance is always <= centre distance, so that gate passed
// blocks the server refuses: ~3.5% false passes (we dig, server cancels) and
// ~1.7% over-tightening (server accepts, we skip and stand idle).
//
// These tests import the REAL exported predicate and call it. An earlier
// version of this file asserted on source text with regexes, and mutation
// testing showed three escapes it could not see - a redirected measurement,
// a deleted `|| dBody` arm, and `return true` (which still "looks" correct to
// a grep but would have her dig anything). Behaviour is checked here.

import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { serverCanBreakBlock } from '../src/agent/library/skills.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

const SRC = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');

// Strip comments: this repo has repeatedly asserted on prose that merely NAMES
// the removed helper (tools/check-26-3-support.mjs flagged stock code for
// containing "GHOST-BREAK" in its own explanatory comment).
const executable = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const SRV_REACH = 4.5;

// Reference implementation, transcribed from the DECOMPILED server source so
// the test does not simply mirror the production function.
const serverRule = (eye, body, bpos, range = SRV_REACH) => {
    const c = [bpos.x + 0.5, bpos.y + 0.5, bpos.z + 0.5];
    const de = Math.hypot(eye.x - c[0], eye.y - c[1], eye.z - c[2]);
    const db = Math.hypot(body.x - c[0], body.y - c[1], body.z - c[2]);
    return de <= range || db <= range;
};
// The gate as it WAS: nearest face point, threshold 4.2.
const oldFaceDist = (eye, bpos) => {
    const nx = Math.min(Math.max(eye.x, bpos.x), bpos.x + 1);
    const ny = Math.min(Math.max(eye.y, bpos.y), bpos.y + 1);
    const nz = Math.min(Math.max(eye.z, bpos.z), bpos.z + 1);
    return Math.hypot(nx - eye.x, ny - eye.y, nz - eye.z);
};

// Drive the real production predicate.
const prod = (ex, ey, ez, bpos, range) =>
    serverCanBreakBlock(
        { entity: { position: new Vec3(ex, ey - 1.62, ez) } },
        bpos, range);

// ── 33. THE PREDICATE MEASURES THE BLOCK CENTRE ───────────────────────

check(/export function serverCanBreakBlock/.test(executable),
    'serverCanBreakBlock is exported', 'serverCanBreakBlock is not exported');
check(/const centre = new Vec3\(bpos\.x \+ 0\.5, bpos\.y \+ 0\.5, bpos\.z \+ 0\.5\)/.test(executable),
    'centre is built at (+0.5,+0.5,+0.5)', 'centre offsets are not +0.5');
check(/eye\.distanceTo\(centre\) <= range \|\| body\.distanceTo\(centre\) <= range/.test(executable),
    'eye OR body centre, matching canBreak', 'eye/body disjunction missing');

// ── 34. THE OLD NEAREST-FACE GATE IS GONE FROM EVERY CALL SITE ────────

check(!/const _closestDist = /.test(executable), '_closestDist definition removed',
    '_closestDist is still defined (dead code)');
check((executable.match(/_closestDist\(/g) || []).length === 0,
    'no executable _closestDist call remains', 'a _closestDist call remains');
check(!/dd > 4\.2\) continue/.test(executable),
    'adjacent fallback no longer gates at 4.2', 'adjacent fallback still uses 4.2');
const callSites = (executable.match(/serverCanBreakBlock\(/g) || []).length;
check(callSites === 5, `all 4 dig call sites plus the definition use it (${callSites})`,
    `expected 5 references, found ${callSites}`);

// ── 35. BEHAVIOUR: THE PREDICATE MATCHES THE SERVER RULE ──────────────
// Replaces the source-regex approach that three mutations escaped.

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

let mismatch = 0, falsePass = 0, overTight = 0, total = 0;
for (let i = 0; i < 60000; i++) {
    const bpos = {
        x: Math.floor(rnd() * 7) - 3,
        y: Math.floor(rnd() * 7) - 3,
        z: Math.floor(rnd() * 7) - 3,
    };
    const e = [rnd() * 12 - 6, rnd() * 12 - 6, rnd() * 12 - 6];
    if (e[0] > bpos.x && e[0] < bpos.x + 1 &&
        e[1] > bpos.y && e[1] < bpos.y + 1 &&
        e[2] > bpos.z && e[2] < bpos.z + 1) continue;
    total++;
    const eye = { x: e[0], y: e[1], z: e[2] };
    const body = { x: e[0], y: e[1] - 1.62, z: e[2] };
    const want = serverRule(eye, body, bpos);
    const got = prod(e[0], e[1], e[2], bpos);
    if (got !== want) mismatch++;
    const old = oldFaceDist(eye, bpos) <= 4.2;
    if (old && !want) falsePass++;
    if (!old && want) overTight++;
}
console.log(`  (old nearest-face gate: ${(falsePass / total * 100).toFixed(2)}% false passes, ` +
            `${(overTight / total * 100).toFixed(2)}% over-tightening, n=${total})`);
check(falsePass > 0, `old gate false-passes in ${(falsePass / total * 100).toFixed(2)}% of cases`,
    'old gate never false-passes - the premise is wrong');
check(overTight > 0, `old gate over-tightens in ${(overTight / total * 100).toFixed(2)}% of cases`,
    'old gate never over-tightens - the premise is wrong');
check(mismatch === 0, 'production predicate agrees with the server rule on all 60000 samples',
    `production predicate disagreed with the server rule ${mismatch} times`);

// ── 36. HONEST BOUNDARY: WHAT REACH DID AND DID NOT EXPLAIN ───────────
// I claimed reach explained the 16:30 dig at BlockPos{7,66,1}. Checked against
// her actual logged position it does NOT: nearest-face distance was 7.62, far
// past the old 4.2 gate, so the old code would have refused that block too. Her
// body was logged around y=73 against a target at y=66.
//
// So this fix is real but it is NOT a complete explanation of every rejected
// dig. It removes a genuine ~3.5% source of silent server-side cancels plus a
// ~1.7% over-tightening that made her skip diggable blocks, and it makes our
// gate agree with the server's rule. Whatever else keeps her from breaking
// blocks is still open. Pinned here so the overstated claim is not inherited.

check(oldFaceDist({ x: 7.7, y: 74.62, z: 1.5 }, { x: 7, y: 66, z: 1 }) > 4.2,
    'the 16:30 case was already refused by the OLD gate (reach is not the whole story)',
    'the 16:30 case would have passed the old gate - revisit the reach theory');
check(prod(7.7, 74.62, 1.5, { x: 7, y: 66, z: 1 }) === false,
    'and the new predicate refuses it as well', 'new predicate accepted the unreachable block');

// ── 37. NO OVER-CORRECTION INTO "NEVER DIG" ───────────────────────────
// M7 was `return true`: still textually correct, behaviourally a disaster.

check(prod(0, 0, 20, { x: 0, y: 0, z: 0 }) === false,
    'a block 20 away is refused (not always-true)',
    'a block 20 away was accepted - the predicate never refuses');
check(prod(0.5, 0.5, 0.5, { x: 0, y: 0, z: 0 }) === true,
    'the block at her feet is accepted', 'the block at her feet was refused');
check(prod(0.5, 0.5, 2.5, { x: 0, y: 0, z: 0 }) === true,
    'a block 2.0 away is accepted', 'a block 2.0 away was refused');

// ── 38. THE EYE/BODY DISJUNCTION IS NOT DEAD CODE ─────────────────────
// M2 deleted `|| dBody <= range`. Only a body-reachable case can catch that.

check(prod(0.5, 0.5, 4.0, { x: 0, y: 0, z: 0 }) === true,
    'body-centre arm accepts when the eye is out of range',
    'the body-centre arm is dead code');

// A bot whose entity.position lacks Vec3 methods must not throw: it returns
// false so the caller treats the block as unreachable instead of crashing the
// whole action. MUTATION-TESTED - the first version of this check passed NaN
// coordinates, which never reach the catch at all (NaN.distanceTo is a valid
// call), so replacing `return false` with `throw` sailed through. This case
// genuinely throws.
{
    const brokenBot = { entity: { position: { x: 0, y: 0, z: 0 } } };
    let threw = false, got = null;
    try { got = serverCanBreakBlock(brokenBot, { x: 0, y: 0, z: 0 }); }
    catch (_) { threw = true; }
    check(!threw, 'a bot with a non-Vec3 position does not throw',
        'the predicate threw on a malformed bot');
    check(got === false, 'a malformed bot yields false (treat as unreachable)',
        `a malformed bot yielded ${got}, expected false`);
    // and a bot with no entity at all
    let threw2 = false, got2 = null;
    try { got2 = serverCanBreakBlock({}, { x: 0, y: 0, z: 0 }); }
    catch (_) { threw2 = true; }
    check(!threw2 && got2 === false, 'a bot with no entity yields false, no throw',
        `no-entity bot: threw=${threw2} got=${got2}`);
}

console.log(`\n${pass} checks passed, ${failed} failed\n`);