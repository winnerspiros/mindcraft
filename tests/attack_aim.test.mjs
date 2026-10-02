// Regression: melee attacks must be aimed so PandaAntiExploit accepts them.
//
// PandaAntiExploit/AngleCheck.isValidAttackAngle rejects any melee hit whose
// angle between the player's view vector and the target's bounding-box centre
// exceeds MAX_ATTACK_ANGLE = 70 degrees, logging
// "FAILED TO HIT ENTITY: INVALID ANGLE". Measured live against the real
// service (hostiles summoned next to her, every swing logging its angle):
// 32-69deg swings were accepted, >70deg swings drew a matching server
// rejection. Same disease class as the block-dig bug - the server decides from
// ITS view vector, and it only ever sees what we flushed to the wire.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../src/agent/library/skills.js'), 'utf8')

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}

// --- the helper must exist and measure the SERVER's geometry ---
check('attackAimAngle helper exists', /function attackAimAngle \(bot, entity\)/.test(src))
// Must be the bbox centre at 0.5*height. A plain `entity.position` or a
// 0.8*height offset both satisfy a loose regex, so pin the exact expression
// AND assert no other aim offset crept in.
// Scope to the two helper functions: critAttack's own 0.8*height lookAt is a
// legitimate pre-existing line, so a file-wide pattern would flag it and the
// check would get weakened into uselessness.
const helperRegion = src.slice(
  src.indexOf('function attackAimAngle'),
  src.indexOf('async function equipHighestAttack'))
const centreHits = (helperRegion.match(/entity\.position\.offset\(0, \(entity\.height \|\| 1\.8\) \* 0\.5, 0\)/g) || []).length
const badAim = /entity\.position\.offset\(0, \(entity\.height \|\| 1\.8\) \* (?!0\.5)[\d.]+/.test(helperRegion)
const plainAim = /entity\.position(?![\s.]*\.offset)/.test(helperRegion)
check('aim uses the bounding-box centre, not entity.position',
  centreHits >= 2 && !badAim && !plainAim,
  `centreHits=${centreHits} badAim=${badAim} plainAim=${plainAim}`)
// and the helper must be what the aiming path calls
check('aimAtTarget aims at the bbox centre',
  /const centre = entity\.position\.offset\(0, \(entity\.height \|\| 1\.8\) \* 0\.5, 0\)/.test(helperRegion))
check('view vector matches the server getViewVector formula',
  /-Math\.sin\(yw\) \* Math\.cos\(pt\)/.test(src) &&
  /-Math\.sin\(pt\)/.test(src) &&
  /Math\.cos\(yw\) \* Math\.cos\(pt\)/.test(src))
check('the 70 degree threshold is exported', /PANDAS_MAX_ATTACK_ANGLE = 70/.test(src))

// --- the helper must gate on that threshold, not just aim and hope ---
check('attackAimed returns false when outside tolerance',
  /return angle <= PANDAS_MAX_ATTACK_ANGLE/.test(src))

// --- every melee call site must route through the helper ---
// Each of these was measured swinging while aimed elsewhere. The windows are
// deliberately generous: the calls carry explanatory comments, and a check that
// breaks when someone edits a comment is a check that gets deleted.
// `near` finds the anchor and looks forward; `nearAnywhere` returns true if
// ANY occurrence of the anchor has attackAimed in the window (several anchors
// like setControlState('jump', true) appear ~19 times in this file, and
// indexOf would silently match an unrelated one).
const near = (anchor, span = 900) => {
  const i = src.indexOf(anchor)
  if (i < 0) return false
  return /attackAimed\(/.test(src.slice(i, i + span))
}
const nearAnywhere = (anchor, span = 900) => {
  let i = src.indexOf(anchor)
  while (i >= 0) {
    if (/attackAimed\(/.test(src.slice(i, i + span))) return true
    i = src.indexOf(anchor, i + 1)
  }
  return false
}
// looks backward instead: the melee branch aims before its bookkeeping line
const hasBefore = (anchor, span = 700) => {
  const i = src.indexOf(anchor)
  return i > 0 && /attackAimed\(/.test(src.slice(Math.max(0, i - span), i))
}
const sites = [
  ['the fight loop swing', near("if (foe) { // eyes recovered")],
  ['the per-tick guard swing', near('getNearestEntityWhere(bot, e => mc.isHostile(e), range)')],
  ['attackEntity non-kill branch', near("console.log('attacking mob...')", 300)],
  ['attackEntity kill branch', near('bot.pvp.stop();', 300)],
  ['crit attack', nearAnywhere("bot.setControlState('jump', true)", 600)],
  // The melee map aims BEFORE its bookkeeping line (lookAt/swingArm sit above
  // it), so this one looks backward.
  ['the melee map branch', hasBefore('bot._meleeHitAt[_eid] = _now', 700)],
]
for (const [name, cond] of sites) check(`${name} is aimed`, cond)

// --- the kill branch must RE-SWING, not fire once and poll ---
// Regression for the original bug: one rejected swing ended the whole fight.
const killIdx = src.indexOf('while (world.getNearbyEntities(bot, 24).includes(entity))')
check('kill branch re-aims inside the poll loop',
  killIdx > 0 && /attackAimed\(/.test(src.slice(killIdx, killIdx + 700)))

// --- no unaided pvp.attack may remain on a hostile target ---
const unaided = [...src.matchAll(/^\s*bot\.pvp\.attack\(([^)]*)\)/gm)].map(m => m[1])
check('no bare unaided bot.pvp.attack(...) call remains', unaided.length === 0,
  unaided.length ? `found: ${unaided.join(', ')}` : '')

// --- the derivation must stay documented so it is not "simplified" back ---
check('the 70deg / Panda derivation is documented in-file',
  /INVALID ANGLE/.test(src) && /70 degrees/.test(src) && /bounding-box centre/.test(src))

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)