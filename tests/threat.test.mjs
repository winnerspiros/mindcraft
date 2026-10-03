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
import { reactToHurt, assessThreats, isArmed, mobName,
    MELEE_RANGE, HOSTILE_NOTICE, distanceBetween } from '../src/utils/threat.js';

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
    // Do NOT pin the exact import list - it breaks every time a symbol is added
    // to the module, and then someone "fixes" it by removing the new symbol.
    // Assert the import exists and carries the names it is called for.
    const threatImport = agent.match(/import \{([^}]*)\} from '\.\.\/utils\/threat\.js'/)
    check(!!threatImport, 'the agent imports the threat module', 'the threat module is not imported')
    check(threatImport ? /reactToHurt/.test(threatImport[1]) && /assessThreats/.test(threatImport[1]) : false,
        'the import carries reactToHurt and assessThreats', `import = ${threatImport && threatImport[1]}`)
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

const Vec3 = (await import('vec3')).default
const vec = (x, y, z) => new Vec3(x, y, z)
const mob_ = (name, x, y, z) => ({ id: name + x, name, type: 'hostile', position: vec(x, y, z), height: 1.8 })
const nanVec = new Vec3(0, 64, 0)
nanVec.x = NaN

// --- null-position entities ------------------------------------------------
// Measured live on 26.3 (mineflayer 4.37): Object.values(bot.entities) contains
// `zombie@{"x":null,"y":null,"z":null}` next to perfectly normal entries. A
// Vec3 with null components makes distanceTo() return NaN, the old
// `typeof d === 'number'` test accepted it (NaN is a number), and the range
// check then dropped the mob - so a hostile standing next to her was invisible
// and the 1s scan never fired. These assert the mob is either measured
// correctly or skipped for an HONEST reason (out of range), never silently
// lost to NaN.
{
  const mk = (pos, type = 'hostile', name = 'zombie') => ({ id: Math.random(), type, name, position: pos, height: 1.8 })
  const bot = {
    health: 20, food: 18,
    entity: { position: vec(0, 64, 0) },
    inventory: { items: () => [{ name: 'diamond_sword' }] },
  }
  // null components, as the real bot reported
  // A REAL Vec3 whose components are null - this is what mineflayer actually
  // produced, and it is Vec3.distanceTo() that turns it into NaN. A bare
  // {x,y,z} takes the fallback branch instead, so the old bug survives here and
  // the test passes even with the guard deleted.
  const nullPos = mk(new Vec3(0, 64, 0))
  // Mineflayer really does build this: a Vec3 instance whose own x/y/z were
  // assigned null, so `new Vec3(null,null,null)` is useless as a stand-in (it
  // coerces to 0). Measured: ctor=Vec3 dTo=function keys=["x","y","z"]
  // posRaw={"x":null,"y":null,"z":null} on a live 26.3 hostile.
  nullPos.position.x = null
  nullPos.position.y = null
  nullPos.position.z = null
  const r = assessThreats({ bot, entities: [nullPos] })
  check(r.action === 'ignore' && r.reason === 'no hostiles nearby',
    'a null-position mob is skipped without throwing', JSON.stringify(r))

  // a real, close mob must still be detected - the null one must not poison it
  const good = mk(vec(4, 64, 0))
  const r2 = assessThreats({ bot, entities: [nullPos, good] })
  check(r2.action === 'fight' && r2.target === good,
    'a null-position neighbour does not hide a real threat', JSON.stringify(r2.action))

  // mixed order, and many nulls
  const r3 = assessThreats({ bot, entities: [nullPos, nullPos, nullPos, mk(vec(6, 64, 0))] })
  check(r3.action === 'fight' && Math.abs(r3.target.position.x - 6) < 0.01,
    'many null-position mobs still leave the real one detectable', JSON.stringify(r3.reason))

  // a Vec3-like whose components are strings ("5") must not silently vanish
  // Vec3 coerces a numeric STRING to a number, so '5' is a legitimate 5 blocks
  // away and must be fought. Assert that, rather than the invalid case I first
  // wrote - Vec3('5') is not the same as an unparseable value.
  const strPos = mk(new Vec3('5', 64, 0))
  const r4 = assessThreats({ bot, entities: [strPos] })
  check(r4.action === 'fight' && r4.reason === 'armed, zombie at 5.0 blocks',
    'a numeric-string coordinate still measures a real distance', JSON.stringify(r4.reason))

  // and the real thing: NaN components
  const nanPos = mk(new Vec3(NaN, 64, 0))
  const r5 = assessThreats({ bot, entities: [nanPos] })
  check(r5.action === 'ignore' && r5.reason === 'no hostiles nearby',
    'a NaN-coordinate mob is skipped, not measured as NaN', JSON.stringify(r5))

  // THE MUTATIONS THAT MUST DIE. distanceBetween() is the unit that holds the
  // guard, so test it directly: through assessThreats() the NaN is also caught
  // by the caller's own !Number.isFinite(d), so the typeof-vs-isFinite
  // mutation survives an end-to-end test no matter what - two independent
  // defences, one of them invisible from outside.
  check(distanceBetween(nanVec, vec(0, 64, 0)) === Infinity,
    'a NaN component is rejected outright',
    String(distanceBetween(nanVec, vec(0, 64, 0))))
  check(distanceBetween(vec(0, 64, 0), nanVec) === Infinity,
    'a NaN component is rejected from either side')
  const oddVec = vec(3, 64, 0)
  oddVec.distanceTo = () => NaN
  check(distanceBetween(oddVec, vec(0, 64, 0)) === Infinity,
    'a distanceTo() of NaN becomes Infinity, not NaN',
    String(distanceBetween(oddVec, vec(0, 64, 0))))
  const infVec = vec(3, 64, 0)
  infVec.distanceTo = () => Infinity
  check(distanceBetween(infVec, vec(0, 64, 0)) === Infinity,
    'an Infinity distance stays Infinity')
  const okVec = vec(3, 64, 0)
  okVec.distanceTo = () => 3
  check(distanceBetween(okVec, vec(0, 64, 0)) === 3,
    'a genuine distance still comes through', String(distanceBetween(okVec, vec(0, 64, 0))))
  check(distanceBetween(3, vec(0, 64, 0)) === Infinity || distanceBetween(3, vec(0, 64, 0)) > 0,
    'a non-vector degrades to Infinity rather than throwing')
  check(distanceBetween(null, null) === Infinity && distanceBetween(undefined, vec(0,64,0)) === Infinity,
    'null/undefined inputs are Infinity, never NaN')
  check(distanceBetween(vec(3, 64, 0), vec(0, 64, 0)) === 3,
    'the plain Vec3 case still measures 3 blocks')
}


// --- every 26.3 hostile must be a known behaviour -------------------------
// A mobName() with no HOSTILE_BEHAVIOUR row is dropped by `if (!behaviour)
// continue`, which is a SILENT skip: the mob is right there and she does
// nothing. Measured live census on 26.3: hostile/enderman and hostile/spider
// were both visible while she ignored a husk 7 blocks away.
//
// This asserts a floor, not the whole list - it fails when a hostile anyone
// meets is unlisted, which is the failure that actually happened.
{
  const seenLive = ['zombie', 'husk', 'creeper', 'skeleton', 'pillager', 'vindicator',
                    'witch', 'stray', 'phantom', 'wither_skeleton', 'enderman', 'spider',
                    'breeze', 'evoker', 'zombified_piglin', 'piglin_brute', 'hoglin',
                    'zoglin', 'ravager', 'silverfish', 'endermite', 'blaze', 'guardian',
                    'elder_guardian', 'slime', 'magma_cube', 'cave_spider', 'drowned',
                    ]
  const bot = {
    health: 20, food: 18, entity: { position: vec(0, 64, 0) },
    inventory: { items: () => [{ name: 'diamond_sword' }] },
  }
  const unlisted = []
  for (const name of seenLive) {
    const r = assessThreats({ bot, entities: [mob_(name, 4, 64, 0)] })
    // 'avoid' is a CORRECT answer for a priming creeper, not a gap.
    if (r.action !== 'fight' && !(name === 'creeper' && r.action === 'avoid')) {
      unlisted.push(`${name}:${r.action}`)
    }
  }
  check(unlisted.length === 0, 'every 26.3 hostile she can meet has a behaviour row',
    'ignored: ' + unlisted.join(', '))
  // And the unknown-name case must stay ignored: a player is not a mob, and an
  // unlisted string must not become fightable just because we widened the map.
  check(assessThreats({ bot, entities: [mob_('some_new_hostile', 4, 64, 0)] }).action === 'ignore',
    'an unknown mob name is still ignored, not auto-fought')
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\n${pass - failed} passed, ${failed} failed — threat assertions`);


// ── a bow is a weapon: ranged combat must be reachable ───────────────
// Until this existed the whole ranged path was dead code. assessThreats()
// gated on isArmed() (melee only) and returned 'ignore' for a bow-only
// survivor, so the agent's _hasBowFor branch could never be reached.
// Reproduced live: a husk 12 blocks away produced no reaction at all and she
// logged "unarmed, no reason to start a fight with a husk".
{
    const kit = [{ name: 'bow' }, { name: 'arrow', count: 30 }];
    const far = assessThreats({ bot: botWith(kit), entities: [mob('husk', 12, 64, 0)] });
    check(far.action === 'fight' && /bow armed/.test(far.reason),
        'a bow with arrows engages at range',
        `bow-only survivor is reported unarmed: got ${far.action} (${far.reason})`);

    const close = assessThreats({ bot: botWith(kit), entities: [mob('husk', 2, 64, 0)] });
    // The bow answers at 30 blocks and is useless at 2. Engaging there would be
    // worse than standing off.
    check(close.action === 'ignore' && /unarmed/.test(close.reason),
        'a bow does not get her into a melee grapple it cannot win',
        `bow-only survivor should decline at 2 blocks, got ${close.action}`);

    const dry = assessThreats({ bot: botWith([{ name: 'bow' }, { name: 'arrow', count: 0 }]), entities: [mob('husk', 12, 64, 0)] });
    check(dry.action === 'ignore',
        'an empty quiver is not a weapon',
        `bow with 0 arrows must not count as armed, got ${dry.action}`);

    const noBow = assessThreats({ bot: botWith([{ name: 'arrow', count: 30 }]), entities: [mob('husk', 12, 64, 0)] });
    check(noBow.action === 'ignore',
        'arrows with no bow are not a weapon',
        `arrows alone must not count as armed, got ${noBow.action}`);

    for (const ammo of ['spectral_arrow', 'tipped_arrow']) {
        const r = assessThreats({ bot: botWith([{ name: 'bow' }, { name: ammo, count: 4 }]), entities: [mob('husk', 12, 64, 0)] });
        check(r.action === 'fight', `${ammo} counts as a quiver`, `${ammo} did not count as ammo (${r.action})`);
    }

    const melee = assessThreats({ bot: botWith([{ name: 'diamond_sword' }]), entities: [mob('husk', 12, 64, 0)] });
    check(melee.action === 'fight' && /^armed, /.test(melee.reason),
        'melee keeps its own reason string so the logs stay readable',
        `expected "armed, ...", got ${melee.reason}`);

    const bare = assessThreats({ bot: botWith([]), entities: [mob('husk', 12, 64, 0)] });
    check(bare.action === 'ignore',
        'a bare survivor still declines - the fix is not "always fight"',
        `bare survivor must stay passive, got ${bare.action}`);

    const pick = assessThreats({ bot: botWith([{ name: 'diamond_pickaxe' }]), entities: [mob('husk', 12, 64, 0)] });
    check(pick.action === 'ignore',
        'a pickaxe still does not count as a melee weapon',
        `pickaxe must not count as armed, got ${pick.action}`);

    // A creeper at range is exactly what a bow is FOR - shooting it from 12
    // blocks is the correct answer. Only a PRIMING one outranks the bow, and
    // priming means it is already on top of her.
    const farCreeper = assessThreats({ bot: botWith(kit), entities: [mob('creeper', 12, 64, 0)] });
    check(farCreeper.action === 'fight',
        'a bow handles a distant creeper - that is what it is for',
        `expected fight at 12 blocks, got ${farCreeper.action} (${farCreeper.reason})`);

    const primed = assessThreats({ bot: botWith(kit), entities: [mob('creeper', 2, 64, 0)] });
    check(primed.action === 'avoid',
        'a priming creeper still outranks the bow',
        `explodes must beat fight at melee range, got ${primed.action}`);
}
