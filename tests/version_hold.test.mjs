// Version prework: the spawn-hold shape follows the negotiated wire.
//
// 26.x (tick_end exists) = full 25s hold incl. tick_end gating.
// Older (1.20/1.21, no tick_end on the wire) = 6s, no tick_end.
// physics.js sendTickEnd() self-gates on the same feature flag, so the
// two stay in agreement — verified here against minecraft-data.

import { holdShapeFor } from '../src/utils/mcdata.js';
import mc from 'minecraft-data';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

// 1. the feature flag ground truth: only 26.3 has tick_end
for (const [v, want] of [['26.3', true], ['26.2', false], ['1.21.4', false], ['1.20.1', false]]) {
    const d = mc(v);
    check(d.supportFeature('hasClientTickEnd') === want, `${v} hasClientTickEnd=${want}`, `${v} flag mismatch`);
}

// 2. hold shapes follow the flag
{
    const h26 = holdShapeFor('26.3');
    check(h26.ms === 25000, '26.3 gets the 25s hold', `26.3 hold ${h26.ms}`);
    check(h26.pkts.includes('tick_end'), '26.3 hold gates tick_end', '26.3 hold misses tick_end');
    const h262 = holdShapeFor('26.2');
    check(h262.ms === 25000, '26.2 gets the 25s hold', `26.2 hold ${h262.ms}`);
    for (const v of ['1.21.4', '1.21.1', '1.20.1', '1.20']) {
        const h = holdShapeFor(v);
        check(h.ms === 6000, `${v} gets the 6s hold`, `${v} hold ${h.ms}`);
        check(!h.pkts.includes('tick_end'), `${v} hold has no tick_end`, `${v} hold wrongly gates tick_end`);
    }
}

// 3. registry tables resolve on every wire we may join (recipes/sources work headless)
for (const v of ['1.21.4', '1.20.1', '26.2', '26.3']) {
    const d = mc(v);
    check(!!(d.itemsByName['bow'] && d.blocksByName['dirt']), `${v} tables resolve (bow, dirt)`, `${v} tables missing`);
}

// 4. teleport_confirm is never in any hold set (it must always go out)
for (const v of ['26.3', '1.21.4']) {
    check(!holdShapeFor(v).pkts.includes('teleport_confirm'), `${v}: teleport_confirm never held`, `${v}: teleport_confirm would be blocked`);
}

console.log(`\n${pass} passed, ${failed} failed`);
