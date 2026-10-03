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
// attackEntity, bounded by its own closing brace line. Declared up here because
// checks above reference it. The gate's rationale comment lives with the
// MELEE_REACH constant at the top of the file, so it is checked against
// `reachDoc` rather than this slice - an earlier version looked for it here and
// passed vacuously on an empty slice.
const aeStart2 = src.indexOf('export async function attackEntity')
const ae = src.slice(aeStart2, src.indexOf('\n}\n', aeStart2))
const reachIdx = src.indexOf('const MELEE_REACH')
const reachDoc = src.slice(Math.max(0, reachIdx - 500), reachIdx)

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
  // The kill branch grew (it now closes distance and has a deadline), so give
  // it room. Anchored on the unique `else {` + goToPosition pair instead of a
  // bare pvp.stop(), which appears elsewhere too.
  ['attackEntity kill branch', near('await goToPosition(bot, pos.x, pos.y, pos.z, 2);', 600)],
  ['crit attack', nearAnywhere("bot.setControlState('jump', true)", 600)],
  // The melee map aims BEFORE its bookkeeping line (lookAt/swingArm sit above
  // it), so this one looks backward.
  ['the melee map branch', hasBefore('bot._meleeHitAt[_eid] = _now', 700)],
]
for (const [name, cond] of sites) check(`${name} is aimed`, cond)

// --- the kill branch must RE-SWING, not fire once and poll ---
// Regression for the original bug: one rejected swing ended the whole fight.
const killIdx = src.indexOf('while (world.getNearbyEntities(bot, 24).includes(entity))')
// Search the whole kill branch (`ae`), not a fixed 1200-char window: the stall
// abort added ~20 lines and pushed the in-loop re-aim outside it. A window here
// silently degrades to checking a different thing.
// There are TWO attackAimed calls: the opening swing before the loop, and the
// in-loop re-aim. indexOf finds the first, so search for the SECOND occurrence -
// a naive "does it appear after the while" check matched the opening call and
// would pass even if the in-loop re-aim were deleted.
const whileAt = ae.indexOf('while (world.getNearbyEntities(bot, 24).includes(entity))')
const firstSwing = ae.indexOf('attackAimed(bot, entity,')
const loopReaim = ae.indexOf('attackAimed(bot, entity,', firstSwing + 1)
check('kill branch re-aims inside the poll loop',
  whileAt > 0 && loopReaim > whileAt && firstSwing < whileAt)
// The poll must be BOUNDED. An unbounded while means a lost fight hangs the
// promise forever and the 1s threat scan can never start another one - which is
// how she ended up "fighting" a zombie that was hitting her, at 4.2 blocks,
// with no result ever logged.
check('the kill poll is bounded by a deadline',
  /const deadline = Date\.now\(\) \+ \d+/.test(src.slice(killIdx - 600, killIdx + 400)) &&
  /if \(Date\.now\(\) > deadline\)/.test(src.slice(killIdx, killIdx + 600)))
// and it must actually CLOSE the distance, not swing at air from detection range
// Both closing steps now key off MELEE_REACH rather than a hardcoded 2.5, and
// the opening one is behind a reach check - so this asserts the GATED form.
// It used to pin the literal 2.5, which silently stopped matching when the
// threshold became a named constant.
check('the kill branch closes distance before swinging',
  /if \(bot\.entity\.position\.distanceTo\(entity\.position\) > MELEE_REACH\) \{\s*\n\s*await goToPosition\(bot, pos\.x, pos\.y, pos\.z, 2\);/.test(ae) &&
  /distanceTo\(entity\.position\) > MELEE_REACH/.test(ae))

// --- no unaided pvp.attack may remain on a hostile target ---
const unaided = [...src.matchAll(/^\s*bot\.pvp\.attack\(([^)]*)\)/gm)].map(m => m[1])
check('no bare unaided bot.pvp.attack(...) call remains', unaided.length === 0,
  unaided.length ? `found: ${unaided.join(', ')}` : '')

// --- the derivation must stay documented so it is not "simplified" back ---
check('the 70deg / Panda derivation is documented in-file',
  /INVALID ANGLE/.test(src) && /70 degrees/.test(src) && /bounding-box centre/.test(src))

// --- a fight in reach must NOT depend on the pathfinder ------------------
// Measured 2026-10-03: a zombie in CONTACT (she 300.50, mob 300.77) still
// logged "No path found after retries - staying put (26.3 movement gate)"
// and the fight never started. attackEntity called goToPosition
// unconditionally, so a planner failure skipped a fight she could win standing
// still. The path is only for mobs that are genuinely out of reach.
// Widen to include the doc comment above the guard, not just from the
// signature line - a narrow slice made the documentation check pass vacuously.
check('MELEE_REACH is defined', /const MELEE_REACH = [\d.]+/.test(src))
check('the opening path is gated on reach',
  /if \(bot\.entity\.position\.distanceTo\(entity\.position\) > MELEE_REACH\) \{\s*\n\s*await goToPosition\(bot, pos\.x, pos\.y, pos\.z, 2\);/.test(ae))
// Count the gated path steps: the opening one AND the per-round re-close. A
// single regex matches both, so deleting only the re-close still satisfied it -
// this is why the per-round guard needs its own occurrence.
check('the per-round re-close is gated on reach too',
  [...ae.matchAll(/distanceTo\(entity\.position\) > MELEE_REACH/g)].length >= 2)
check('the unconditional goToPosition is gone from the kill branch',
  !/\n\s*await goToPosition\(bot, pos\.x, pos\.y, pos\.z, 2\);\s*\n\s*await attackAimed/.test(ae))
check('MELEE_REACH is smaller than sword reach (3.0)', (() => {
  const m = src.match(/const MELEE_REACH = ([\d.]+)/)
  return m && Number(m[1]) > 0 && Number(m[1]) <= 3.0
})())
check('a melee swing always happens regardless of pathing',
  /await attackAimed\(bot, entity, \(\) => bot\.pvp\.attack\(entity\)\);/.test(ae) &&
  ae.indexOf('attackAimed(bot, entity, () => bot.pvp.attack(entity))') >
    ae.indexOf('if (bot.entity.position.distanceTo(entity.position) > MELEE_REACH)'))
check('the reach-gate rationale is documented in-file',
  /planning a path to it is wasted work/.test(reachDoc))

// --- an unreachable target must not hold the single fight slot -----------
// There is ONE fight slot. Measured 2026-10-03: a phantom hovering at 1.7
// blocks held it for the full 30s bound, 3 zombies survived untouched, and she
// was at full health unable to start any of them. The poll must abort when the
// gap stops closing, so the next scan can pick a reachable target.
// bestGap must be INITIALISED from the real current distance, not a constant -
// `let bestGap = 0` would make the first poll always look like progress and
// never start the stall timer.
check('the fight loop tracks its best gap',
  /let bestGap = bot\.entity\.position\.distanceTo\(entity\.position\);/.test(ae) &&
  /let stallSince = null;/.test(ae))
check('a stalled close-out aborts early', /stallSince - ?\)? \|\| Date\.now\(\) - stallSince > 8000|stallSince\) ?\|\| Date\.now\(\) - stallSince > 8000/.test(ae) || /Date\.now\(\) - stallSince > 8000/.test(ae))
check('the abort releases the slot (pvp.stop + return false)',
  /breaking off \$\{entity\.name\}/.test(ae) &&
  /break[\s\S]{0,300}bot\.pvp\.stop\(\);[\s\S]{0,120}return false;/.test(ae))
check('progress resets the stall timer',
  /\} else \{ bestGap = nowGap; stallSince = null; \}/.test(ae))
check('being in reach resets the stall timer',
  /if \(nowGap <= MELEE_REACH\) \{ bestGap = nowGap; stallSince = null; \}/.test(ae))
check('the 30s hard bound survives as a backstop',
  /const deadline = Date\.now\(\) \+ 30000/.test(ae))
check('the stall-abort rationale is documented in-file',
  /ONE fight slot/.test(ae) && /starves every ground mob/.test(ae))

// --- every identifier used in the kill branch must exist in this file -----
// Caught a real shipped bug: the stall check used MELEE_RANGE, which is
// exported from utils/threat.js and NOT imported here, so every fight threw
// "MELEE_RANGE is not defined" and returned false the instant it started. All
// 31 checks above still passed, because they never evaluate the code. Free
// identifiers that look like constants are the one thing a regex suite cannot
// see, so resolve them against this module's own imports/declarations.
const declaredHere = new Set([
  ...[...src.matchAll(/^\s*(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
  ...[...src.matchAll(/^\s*(?:const|let|var)\s*\{([^}]*)\}/gm)].flatMap(m => m[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)),
  ...[...src.matchAll(/^import\s+(?:\*\s+as\s+([\w$]+)|\{([^}]*)\}|([\w$]+))/gm)].flatMap(m => m[1] ? [m[1]] : (m[2] ? m[2].split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : [m[3]])),
])
// Strip comments first: prose is full of SCREAMING_CASE words (ONE, CLOSED),
// which are not identifiers and would drown the real signal.
const aeCode = ae
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
const localCaps = [...new Set([...aeCode.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map(m => m[1]))]
const undefinedCaps = localCaps.filter(c => !declaredHere.has(c))
check('every SCREAMING_CASE constant in the kill branch is actually declared',
  undefinedCaps.length === 0,
  undefinedCaps.length ? 'undefined in this module: ' + undefinedCaps.join(', ') : undefined)

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)