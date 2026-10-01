// Physical addressing: close AND facing her.
//
// The owner: "unless addresses i mean physically or by text you can build that
// i think". Proximity alone is far too loose in Minecraft - players collide
// constantly, so "within 8 blocks" is true most of the time on a busy server
// and means nothing. Orientation is the second cue that makes it real.

import { isAddressingMe, CLOSE_BLOCKS } from '../src/utils/proximity.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

const her = { x: 0, z: 0 };
const facing = (dx, dz) => ({ x: dx, z: dz });

// ── close and facing = addressed ────────────────────────────────────────
{
    const them = { x: 2, z: 0 };
    check(isAddressingMe(her, them, facing(1, 0)).addressed,
        '2 blocks away, looking straight at her', 'did not register being approached');
    // angled but still within ~60 degrees
    check(isAddressingMe(her, { x: 2, z: 2 }, facing(1, 1)).addressed,
        'diagonal but still facing her', 'too strict an angle');
}

// ── too far = not addressed ─────────────────────────────────────────────
{
    const far = { x: CLOSE_BLOCKS + 1, z: 0 };
    check(!isAddressingMe(her, far, facing(1, 0)).addressed,
        'just out of range is not addressed', 'addressed someone across the map');
    check(!isAddressingMe(her, { x: 0, z: 0 }, facing(1, 0)).addressed,
        'same block but not facing is not addressed', 'same block counts automatically');
}

// ── close but NOT facing = not addressed. This is the whole point. ──────
{
    const them = { x: 2, z: 0 };
    const v = isAddressingMe(her, them, facing(-1, 0));
    check(!v.addressed, 'standing right next to her, facing AWAY, is not addressed',
        'someone with their back to her counted as addressing her');
    check(v.why === 'not_facing_me', 'and says why', 'wrong reason');
    // sideways also fails
    check(!isAddressingMe(her, them, facing(0, 1)).addressed,
        'facing sideways is not addressing her', 'sideways counted as addressing');
}

// ── unknown facing counts as NOT addressed: silence is the safe default ──
{
    check(!isAddressingMe(her, { x: 1, z: 1 }, undefined).addressed,
        'no facing data means not addressed', 'assumed addressed with no data');
    check(isAddressingMe(her, { x: 1, z: 1 }, null).why === 'facing_unknown',
        'and it reports the reason', 'no reason given');
    // no position at all
    check(!isAddressingMe(null, { x: 1, z: 1 }, facing(1, 0)).addressed,
        'no position means not addressed', 'crashed on missing position');
    check(!isAddressingMe(her, null, facing(1, 0)).addressed,
        'no other player means not addressed', 'crashed on missing player');
}

// ── the range is tight enough to be meaningful ──────────────────────────
{
    check(CLOSE_BLOCKS <= 5,
        `close range is ${CLOSE_BLOCKS} blocks - tight enough that it means something`,
        `${CLOSE_BLOCKS} blocks is too loose in Minecraft; players collide constantly`);
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} proximity assertions green`);
