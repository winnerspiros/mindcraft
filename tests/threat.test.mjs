// Threat response: fight when hit, and deal with a creeper BEFORE it explodes.
//
// Owner, across three reports:
//   "a phantom attacjs her, she should fight, not complain"
//   "she is not fighting nothing"
//   "about enemies she needs to be aware and act before. lets say a creeper
//    approach her, deal with it before it just comes and explodes"
//
// These test the MODULE directly rather than slicing agent.js. The inline version
// could not be tested at all, and that is how a dead reflex shipped: it read the
// attacker from `source` inside bot.on('health'), which is emitted with no
// arguments, so the attacker was always null and the fight branch was
// unreachable. Four separate attempts to eval the handler out of agent.js source
// failed before the logic was moved somewhere it could actually be exercised.

import { readFileSync } from 'node:fs';
import {
    reactToHurt, assessThreats, isArmed, mobName,
    MELEE_RANGE, HOSTILE_NOTICE,
} from '../src/utils/threat.js';

let pass = 0, failed = 0;
const check = (c, good, bad) => {
    if (!c) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// A Mineflayer position is a Vec3 and HAS distanceTo. Using a bare {x,y,z} made
// the old reflex throw into a silent catch and the suite blamed the code.
const pos = (x, y, z) => ({
    x, y, z,
    distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z),
});
const HER = pos(0, 64, 0);
const mob = (name, x, y, z) => ({ id: name + x, name, type: 'mob', position: pos(x, y, z) });
const botWith = (items) => ({ entity: { position: HER }, health: 20, inventory: { items: () => items } });

// ── being hit: fight, or get clear ───────────────────────────────────
{
    const armed = botWith([{ name: 'iron_sword' }]);
    const r = reactToHurt({ bot: armed, attacker: mob('phantom', 3, 64, 0) });
    check(r.action === 'fight' && /hit me/i.test(r.goal || ''),
        `armed and hit -> fight (${r.reason})`, `armed and hit -> ${JSON.stringify(r)}`);

    // unarmed, holding nothing: no point trading hits with a mob
    const bare = botWith([]);
    const f = reactToHurt({ bot: bare, attacker: mob('phantom', 3, 64, 0) });
    check(f.action === 'flee' && /away|health/i.test(f.goal || ''),
        `unarmed and hit -> get clear (${f.reason})`, `unarmed and hit -> ${JSON.stringify(f)}`);

    // an axe counts as armed too
    check(isArmed(botWith([{ name: 'iron_axe' }])) === true, 'an axe counts as armed', 'an axe is not armed');
    check(isArmed(botWith([{ name: 'iron_pickaxe' }])) === false, 'a pickaxe does not', 'a pickaxe counts as armed');
    check(isArmed(botWith([{ name: 'iron_sword' }])) === true, 'a sword counts as armed', 'a sword does not');

    // nothing to fight and nothing in range: do nothing, do not invent a goal
    const none = reactToHurt({ bot: armed, attacker: null });
    check(none.action === 'ignore' && !none.goal,
        'no attacker -> no goal invented', `invented a goal: ${JSON.stringify(none)}`);

    // and it must never throw, whatever it is handed
    for (const junk of [{}, { bot: {} }, { bot: null }, { attacker: { position: null } }]) {
        let threw = false;
        try { reactToHurt(junk); } catch { threw = true; }
        check(!threw, `reactToHurt survives ${JSON.stringify(junk)}`, `threw on ${JSON.stringify(junk)}`);
    }
}

// ── THE OWNER'S ACTUAL CASE: a creeper, before it explodes ───────────
{
    const armed = botWith([{ name: 'iron_sword' }]);

    // far creeper, armed: notice it early and deal with it
    const far = assessThreats({ bot: armed, entities: [mob('creeper', 10, 64, 0)] });
    check(far.action === 'fight' && /creeper/i.test(far.goal || ''),
        `an approaching creeper is dealt with in advance (${far.reason})`,
        `an approaching creeper was ignored: ${JSON.stringify(far)}`);

    // CLOSE creeper: this is the one that matters. A priming creeper at melee
    // range is already on a timer, so distance beats a coin-flip sword swing.
    const close = assessThreats({ bot: armed, entities: [mob('creeper', 2, 64, 0)] });
    check(close.action === 'avoid' && /away|creeper/i.test(close.goal || ''),
        `a creeper at ${MELEE_RANGE - 1} blocks -> get off its approach line (${close.reason})`,
        `a priming creeper did not trigger avoidance: ${JSON.stringify(close)}`);

    // and it is more urgent than a zombie at the same distance, because one of
    // them can end her
    const z = assessThreats({ bot: armed, entities: [mob('zombie', 2, 64, 0)] });
    const c = assessThreats({ bot: armed, entities: [mob('creeper', 2, 64, 0)] });
    check(c.urgency > z.urgency,
        `a creeper outranks a zombie at equal range (${c.urgency.toFixed(2)} > ${z.urgency.toFixed(2)})`,
        `urgency does not distinguish an exploder: creeper ${c.urgency} vs zombie ${z.urgency}`);

    // unarmed, she does not start a fight she cannot win - but she still keeps
    // her distance from the one that explodes
    const bare = botWith([]);
    const bc = assessThreats({ bot: bare, entities: [mob('creeper', 2, 64, 0)] });
    check(bc.action === 'avoid',
        `unarmed, a close creeper still means keep away (${bc.reason})`,
        `unarmed creeper -> ${JSON.stringify(bc)}`);
    const bz = assessThreats({ bot: bare, entities: [mob('zombie', 6, 64, 0)] });
    check(bz.action === 'ignore',
        `unarmed, an ordinary zombie is left alone (${bz.reason})`,
        `unarmed zombie -> ${JSON.stringify(bz)}`);

    // out of range: not a threat, and she must not waste a goal on it
    const far2 = assessThreats({ bot: armed, entities: [mob('creeper', HOSTILE_NOTICE + 6, 64, 0)] });
    check(far2.action === 'ignore', 'a creeper past the notice range is ignored', `far creeper -> ${JSON.stringify(far2)}`);

    // non-hostile entities never count
    const cow = assessThreats({ bot: armed, entities: [mob('cow', 2, 64, 0)] });
    check(cow.action === 'ignore', 'a cow is not a threat', `a cow -> ${JSON.stringify(cow)}`);

    // and an empty world is not a crisis
    const empty = assessThreats({ bot: armed, entities: [] });
    check(empty.action === 'ignore', 'an empty world is not a threat', `empty -> ${JSON.stringify(empty)}`);
}

// ── neither layer may go through the model ───────────────────────────
{
    const src = readFileSync('src/utils/threat.js', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
        .map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    check(!/bot\.chat\(|chat_model|sendRequest|Generated response/.test(code),
        'threat handling never asks the model (too slow for a hit or a fuse)',
        'threat handling goes through the model');
}

// ── it is wired in, and the agent no longer holds a dead copy ────────
{
    const agent = readFileSync('src/agent/agent.js', 'utf8');
    check(/import \{ reactToHurt, assessThreats \}/.test(agent),
        'the agent imports the threat module', 'the threat module is not imported');
    check(/reactToHurt\(\{/.test(agent),
        'and calls it when she is hurt', 'reactToHurt is never called');
    check(/assessThreats\(\{/.test(agent),
        'and scans for threats proactively', 'assessThreats is never called');

    // The proactive scan must exist as its own timer - a hurt reflex alone is
    // what the owner is objecting to.
    check(/_threatScan\s*=\s*setInterval/.test(agent),
        'a recurring threat scan exists, so she acts BEFORE being hit',
        'no recurring threat scan - she can only react after the hit');

    // and the old inline copy must be gone, or it will rot into a second,
    // unreachable implementation
    const hurtBlk = agent.slice(agent.indexOf("this.bot.on('entityHurt'"),
        agent.indexOf("this.bot.on('health'"));
    check(!/distanceTo\(this\.bot\.entity\.position\)\s*<\s*12/.test(hurtBlk),
        'the dead inline reflex is gone from agent.js', 'a dead inline reflex remains');
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} threat assertions green`);
