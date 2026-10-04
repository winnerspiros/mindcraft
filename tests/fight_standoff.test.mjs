// Regressions for the three live bugs found on 2026-10-04 ~12:00, each
// diagnosed from server truth rather than from the client (26.3 withholds
// entities and mis-decodes slots, so client reads lie).
//
// 1. FIGHT PREEMPTION LOOP. One pillager survived ~80 scan cycles at 6 blocks
//    for 40 minutes. The log alternated:
//      preempted running action "action:attack" for a reflex - not waiting
//      Pathfinding stopped: The goal was changed before it could be completed!
//      [threat] scan fight result: done=false
//    `unstuck` (interrupts:['all']) saw her standing still during the melee
//    APPROACH leg, called that wedged, and preempted the attack. She was never
//    stuck; the rescue was the interruption. `unstuck` must stand down while a
//    threat is in flight.
//
// 2. LYING BOW GATE. The client inventory reported bow + arrows. The server
//    reported bow + ZERO arrows, and `data get entity <pillager> Health` stayed
//    20.0 across 32 "fired=true" scan shots. Drawing an empty bow consumes
//    nothing and flies nothing. `_hasBowFor` must read a COUNT, not a
//    `some()`, and must let RCON arbitrate.
//
// 3. FIRED != KILLED. `fired` only ever meant "the arrow stack dropped". Nothing
//    consumed the signal, so a mob that could not be hit was re-shot forever.
//    A failed shot has to hand the target back to melee.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const agentSrc = readFileSync(resolve(here, '../src/agent/agent.js'), 'utf8')
const modesSrc = readFileSync(resolve(here, '../src/agent/modes.js'), 'utf8')
const skillsSrc = readFileSync(resolve(here, '../src/agent/library/skills.js'), 'utf8')

let ok = 0, failed = 0
const check = (name, cond) => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}`) }
}

// ── 1. unstuck stands down during a fight ─────────────────────────────────
const unstuckBody = (() => {
  const i = modesSrc.indexOf("name: 'unstuck'")
  const m = modesSrc.slice(i).match(/update: async function \(agent\) \{[\s\S]*?\n        \},\n/s)
  return m ? m[0] : ''
})()
check('the unstuck mode body was located', unstuckBody.length > 500)
check('unstuck returns early while a threat is in flight',
  /if \(agent\._fightInFlight \|\| agent\._threatTargetName\)/.test(unstuckBody))
check('the stand-down comes BEFORE the stillness counter can accumulate',
  unstuckBody.indexOf('agent._fightInFlight') > 0 &&
  unstuckBody.indexOf('agent._fightInFlight') < unstuckBody.indexOf('_idleStill = (this._idleStill || 0) + 1'))
check('the stand-down resets the stillness counter instead of leaving it stale',
  /_idleStill = 0;\s*\n\s*return;/.test(unstuckBody))
check('the stand-down is documented with the measured evidence',
  /40 minutes/.test(unstuckBody) && /preempted/.test(unstuckBody))

// ── 2. the scan records what it is fighting ───────────────────────────────
check('the scan records the threat it is dealing with',
  /_threatTargetName = r\.target \?/.test(agentSrc))
check('the record is set for fight and avoid decisions',
  /if \(r\.action === 'fight' \|\| r\.action === 'avoid'\) \{\s*\n\s*this\._threatTargetName/.test(agentSrc))
// Setting it without clearing it would leave `unstuck` disabled for the rest
// of the process after the first hostile — the exact opposite of the fix.
// The windows are wide because the branch carries a long explanatory comment.
check('the record is CLEARED when there is nothing left to deal with',
  /if \(r\.action === 'ignore'\) \{[\s\S]{0,700}?this\._threatTargetName = null;/.test(agentSrc))
check('the bow-spent key is cleared with it',
  /if \(r\.action === 'ignore'\) \{[\s\S]{0,700}?this\._threatBowSpentKey = null;/.test(agentSrc))
check('both clearances happen in the ignore branch, before the fight record is set',
  agentSrc.indexOf("if (r.action === 'ignore')") <
    agentSrc.indexOf("if (r.action === 'fight' || r.action === 'avoid')"))

// ── 3. the bow gate counts arrows and lets the server arbitrate ────────────
const bowBody = (() => {
  const i = agentSrc.indexOf('_hasBowFor(entity)')
  const m = agentSrc.slice(i).match(/_hasBowFor\(entity\) \{[\s\S]*?\n    \}/)
  return m ? m[0] : ''
})()
check('the bow gate body was located', bowBody.length > 400)
check('the gate sums arrow COUNTS instead of testing for a stack',
  /\.reduce\(\(n, i\) => n \+ \(i\.count \|\| 0\), 0\)/.test(bowBody))
check('the gate refuses on zero arrows',
  /arrows > 0/.test(bowBody))
check('the gate asks the server for the arrow count',
  /rconCountAll/.test(bowBody) && /rconCountAll\(this\.name, 'arrow'\)/.test(bowBody))
check('the server verdict is cached so the sync scan stays sync',
  /_bowForCache/.test(bowBody))
// An UNCONFIRMED client count must not be allowed to fire: the first live run
// logged three SHOOTING lines and only then "server says 0 arrows", because
// the sync gate answered yes for the whole RCON round trip.
check('an unconfirmed client count answers false (melee now, bow next tick)',
  /return false; \/\/ unconfirmed this tick/.test(bowBody))
check('the pending state is recorded while RCON is in flight',
  /pending: true/.test(bowBody))
check('a confirmed live quiver is logged too, not only the negative case',
  /bow is live/.test(bowBody))
check('an unreadable RCON falls back to trusting the client',
  // Anchor on the RCON read itself — the function also has an outer
  // catch(_){return false} for a missing inventory, which is a different case.
  // The window covers the two console.log arms plus the arrow/bow reads.
  /rconCountAll\(this\.name, 'arrow'\)[\s\S]{0,900}?\} catch \(_\) \{[\s\S]{0,300}?setVerdict\(true\);/.test(bowBody))
// The cache must key on something stable for the length of an engagement. An
// entity.id does not qualify: a phantom is re-spawned constantly, so its id
// changes every tick and the cache never hits — which silently disabled the
// bow entirely (measured live: "bow is live" logged, no shot ever taken).
check('the bow gate cache is NOT keyed on entity.id',
  !/entityId: entity\?\.id/.test(agentSrc))
check('the cache keys on the target name, which is stable',
  /const cacheKey = entity\?\.name \|\| 'mob';/.test(agentSrc) &&
  /cached\.key === cacheKey/.test(bowBody))
check('all bow-cache writes go through one helper, so they cannot drift apart',
  /const setVerdict = \(v, pending\) => \{/.test(bowBody) &&
  (bowBody.match(/setVerdict\(/g) || []).length >= 4 &&
  !/this\._bowForCache = \{/.test(bowBody.replace(/const setVerdict[\s\S]*?\};/, '')))
check('the pending flag marks an RCON read still in flight',
  /\{ t: Date\.now\(\), key: cacheKey, v, pending: true \}/.test(bowBody))
check('a server-verdict mismatch is logged, not silent',
  /switching to melee/.test(bowBody))

// ── 4. shootBow itself refuses on server truth ────────────────────────────
const shootBowBody = (() => {
  const i = skillsSrc.indexOf('export async function shootBow')
  const m = skillsSrc.slice(i).match(/export async function shootBow[\s\S]*?\n\}/)
  return m ? m[0] : ''
})()
check('the shootBow body was located', shootBowBody.length > 800)
check('shootBow asks the server how many arrows she has',
  /rconCountAll\(bot\.username, 'arrow'\)/.test(shootBowBody))
check('shootBow aborts when the server says zero, whatever the client claimed',
  /serverArrows\.total === 0[\s\S]{0,200}return false;/.test(shootBowBody))
check('an unavailable RCON falls back to the client instead of blocking',
  /catch \(_\) \{ \/\* survival server/.test(shootBowBody))

// ── 5. a shot that lands nothing goes back to melee ────────────────────────
check('a failed shot is remembered so the next scan uses the sword',
  /if \(!fired\) this\._threatBowSpentKey = key;/.test(agentSrc))
check('a shot that throws also falls back to the sword',
  /catch\(\(e\) => \{[\s\S]{0,220}?_threatBowSpentKey = key;/.test(agentSrc))
check('the spent key is cleared before melee is allowed to run',
  /if \(this\._threatBowSpentKey === key\) this\._threatBowSpentKey = null;/.test(agentSrc))
// There are now two `_threatBowSpentKey = null;` writes: the mid-fight one
// (between the bow return and the melee guard) and the ignore-branch
// clearance. Assert the mid-fight one specifically, so this cannot pass on the
// clearance write alone.
check('the spent-key clear sits between the bow return and the melee guard',
  agentSrc.indexOf('if (this._threatBowSpentKey === key) this._threatBowSpentKey = null;') >
    agentSrc.indexOf('shootBow(this.bot, r.target, 2, true)') &&
  agentSrc.indexOf('if (this._threatBowSpentKey === key) this._threatBowSpentKey = null;') <
    agentSrc.indexOf('if (this._fightInFlight) return;'))
check('"fired" is documented as NOT meaning the mob died',
  /fired=true means an arrow LEFT THE BOW, not/.test(agentSrc))

// ── 6. a flee that did not flee ───────────────────────────────────────────
// Verified live 12:0x: the log read "Moved away from (-12, 32, 7) to (-12, 32, 7)"
// — same block — while `return true` told self_preservation she had escaped a
// threat she was still standing in. goToGoal already fails honestly, so
// swallowing its result here re-introduced the lie one layer up.
const moveAwayBody = (() => {
  const i = skillsSrc.indexOf('export async function moveAway')
  const m = skillsSrc.slice(i).match(/export async function moveAway[\s\S]*?\n\}/)
  return m ? m[0] : ''
})()
check('the moveAway body was located', moveAwayBody.length > 400)
check('a flee measures how far it actually got',
  /const gained = bot\.entity\.position\.distanceTo\(pos\);/.test(moveAwayBody))
check('a flee that barely moved reports failure, not success',
  /if \(gained < 1\.5\) \{[\s\S]{0,400}?return false;/.test(moveAwayBody))
check('the failed flee is stated plainly, with the block she stayed on',
  /Didn't get away/.test(moveAwayBody))
check('a failed flee feeds the nav-failure signal like other nav failures',
  /reportNav\(false\)/.test(moveAwayBody))
check('success is still reported when she really moved',
  /Moved away from \$\{pos\.floored\(\)\} to \$\{new_pos\.floored\(\)\}/.test(moveAwayBody) &&
  /return true;/.test(moveAwayBody))

// ── 7. the earlier surface-climb fix is still in place ────────────────────
check('goToPlayer climbs out of a cave before walking the legs',
  /getting out of this cave first/.test(skillsSrc))
check('the water-above branch swims instead of refusing to climb',
  /Water above — swimming up instead of digging it/.test(skillsSrc))
check('a stall falls through to a carved staircase step',
  /staircaseStep/.test(skillsSrc))

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
