// Regression: she must never respawn (or stand) permanently unable to fight.
//
// The combat fixes made isArmed() authoritative: assessThreats resolves every
// threat to "flee" when she has no sword or axe. That is correct behaviour, but
// it turns a missing weapon into total passivity.
//
// Two holes let her end up in that state:
//
//  1. _reArmor() gated the ENTIRE re-kit on armor alone. She respawned holding a
//     helmet but no sword -> "armor survived" branch -> equip-only path -> still
//     bare-handed forever. rconEnsureKit always granted diamond_sword; the
//     problem was that _reArmor never asked for it.
//  2. The pest-clear path re-derived "do I have a weapon" as
//     /sword|axe/i.test(i.name), which ALSO matches "diamond_pickaxe" (pickaxe
//     ends in "axe"). So she refused a winder while holding a pickaxe.
//
// Both were live on 2026-10-02, found by reading her actual inventory:
// 18 tools, zero swords, holding a diamond_shovel.
//
// These assert the BEHAVIOUR of respawnKitNeeds/isArmed rather than grepping the
// call site. An earlier shape-based version passed with the weapon test deleted
// outright (`hasWeapon = true` still looks like a check to a regex), which is
// exactly the class of test that rots silently.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { isArmed, respawnKitNeeds, equippedArmorNames } from '../src/utils/threat.js'

const here = dirname(fileURLToPath(import.meta.url))
const agentSrc = readFileSync(resolve(here, '../src/agent/agent.js'), 'utf8')
const skillsSrc = readFileSync(resolve(here, '../src/agent/library/skills.js'), 'utf8')

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}
const inv = (...names) => names.map(n => ({ name: n }))
const needs = (items, equipped = []) => {
  const r = respawnKitNeeds(inv(...items), equipped.map(n => ({ name: n })))
  return !r.hasArmor || !r.hasWeapon || !r.hasFood
}

// ── the real rule: she needs armor AND a weapon AND food ─────────────────
check('a full kit needs nothing', needs(['diamond_helmet', 'diamond_chestplate',
  'diamond_leggings', 'diamond_boots', 'diamond_sword', 'cooked_beef']) === false)

// ── THE ARMOR-IS-WORN BUG ────────────────────────────────────────────────
// Verified over RCON on a fully-armored, fully-armed her:
//   data get entity UwU Inventory -> ZERO armor pieces
//   data get entity UwU equipment -> all four
// So reading armor from inventory.items() reported hasArmor=false while she
// was wearing full diamond, and _reArmor re-kitted on EVERY respawn. She is
// now genuinely wearing it, so the predicate must see worn armor.
check('WORN armor counts as armor even when inventory has none',
  needs(['diamond_sword', 'cooked_beef'], ['diamond_helmet', 'diamond_chestplate',
    'diamond_leggings', 'diamond_boots']) === false)
check('worn armor is reported by equippedArmorNames', (() => {
  const bot = { inventory: { slots: [
    { name: 'diamond_helmet' }, { name: 'diamond_chestplate' },
    { name: 'diamond_sword' }, { name: 'cobblestone' },
  ] } }
  return equippedArmorNames(bot).join(',') === 'diamond_helmet,diamond_chestplate'
})())
check('equippedArmorNames ignores non-armor', equippedArmorNames(
  { inventory: { slots: [{ name: 'diamond_sword' }, { name: 'bow' }] } }).length === 0)
check('equippedArmorNames survives a broken inventory', equippedArmorNames(
  { inventory: { get slots() { throw new Error('PartialReadError') } } }).length === 0)
check('equippedArmorNames handles a missing inventory', equippedArmorNames({}).length === 0)
check('one worn piece is enough for the armor flag',
  respawnKitNeeds(inv('diamond_sword', 'cooked_beef'), [{ name: 'diamond_helmet' }]).hasArmor === true)
check('a non-diamond worn piece does NOT count as diamond armor',
  respawnKitNeeds(inv('diamond_sword', 'cooked_beef'), [{ name: 'leather_helmet' }]).hasArmor === false)
// THE REGRESSION: armor present, weapon absent -> must still re-kit.
check('a helmet but no sword still needs the kit',
  needs(['diamond_helmet', 'cooked_beef']) === true)
check('full armor but no weapon still needs the kit',
  needs(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']) === true)
check('a weapon but no armor still needs the kit',
  needs(['diamond_sword', 'cooked_beef']) === true)
check('armor + weapon but no food still needs the kit',
  needs(['diamond_helmet', 'diamond_sword']) === true)
check('her actual death-spawn inventory (18 tools, no sword) needs the kit',
  needs(['diamond_shovel', 'diamond_pickaxe', 'diamond_axe', 'diamond_hoe', 'cobblestone',
    'dirt', 'spruce_log', 'water_bucket', 'bow', 'arrow']) === true)

// ── weapon detection must be anchored ─────────────────────────────────────
// "pickaxe" ends in "axe" - the bug isArmed() already fixed once.
check('a pickaxe is NOT a weapon (respawnKitNeeds)',
  respawnKitNeeds(inv('diamond_pickaxe')).hasWeapon === false)
check('a shovel is NOT a weapon (respawnKitNeeds)',
  respawnKitNeeds(inv('diamond_shovel')).hasWeapon === false)
check('a sword IS a weapon', respawnKitNeeds(inv('diamond_sword')).hasWeapon === true)
check('an axe IS a weapon', respawnKitNeeds(inv('diamond_axe')).hasWeapon === true)
check('an iron axe IS a weapon', respawnKitNeeds(inv('iron_axe')).hasWeapon === true)
check('a pickaxe is NOT a weapon (isArmed)',
  isArmed({ inventory: { items: () => inv('diamond_pickaxe') } }) === false)
check('a sword IS a weapon (isArmed)',
  isArmed({ inventory: { items: () => inv('diamond_sword') } }) === true)
// the two must agree, or the pest path and the respawn path disagree
check('respawnKitNeeds and isArmed agree on every item',
  ['diamond_sword', 'iron_sword', 'diamond_axe', 'iron_axe', 'diamond_pickaxe',
    'diamond_shovel', 'bow', 'cobblestone', 'cooked_beef', 'elytra'].every(
    n => respawnKitNeeds(inv(n)).hasWeapon === isArmed({ inventory: { items: () => inv(n) } })))

// ── food is recognised ───────────────────────────────────────────────────
check('cooked beef counts as food', respawnKitNeeds(inv('cooked_beef')).hasFood === true)
check('bread counts as food', respawnKitNeeds(inv('bread')).hasFood === true)
check('raw beef does NOT count as food', respawnKitNeeds(inv('beef')).hasFood === false)
check('a sword does NOT count as food', respawnKitNeeds(inv('diamond_sword')).hasFood === false)

// ── robustness: bad input must not throw or grant a kit ──────────────────
check('an empty inventory needs the kit', needs([]) === true)
check('a non-array needs the kit', respawnKitNeeds(null).hasWeapon === false)
check('malformed entries do not throw', (() => {
  try { const r = respawnKitNeeds([null, undefined, {}, { name: null }, 'diamond_sword'])
    return r.hasWeapon === false
  } catch (_) { return false }
})())

// ── the call sites must actually use it ───────────────────────────────────
const method = (src, name) => {
  const i = src.indexOf(name)
  if (i < 0) return ''
  let depth = 0, started = false
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1) }
  }
  return src.slice(i, i + 3000)
}
const reArmor = method(agentSrc, 'async _reArmor')
check('_reArmor was found', reArmor.length > 200)
check('_reArmor calls the shared predicate', /respawnKitNeeds\(items\(\), equippedArmorNames\(this\.bot\)\)/.test(reArmor))
check('_reArmor reads worn armor, not just carried', /equippedArmorNames\(this\.bot\)/.test(reArmor))
check('equippedArmorNames is imported by agent.js',
  /import \{[^}]*equippedArmorNames[^}]*\} from '\.\.\/utils\/threat\.js'/.test(agentSrc))
// The gate is `missing.length`, where `missing` names all three gaps. Assert
// that all three are enumerated - a check for the old `!hasArmor ||` shape
// would have failed a refactor that changed nothing.
check('the re-kit gate considers all three gaps',
  /\[!hasArmor && 'armor', !hasWeapon && 'weapon', !hasFood && 'food'\]/.test(reArmor) &&
  /missing\.length/.test(reArmor))
check('the log names what is missing',
  /missing \$\{missing\.join\('\+'\)\}/.test(reArmor))
check('the old armor-only gate is gone', !/if \(!hasArmor\) \{/.test(reArmor))
check('the equip path is shared, not duplicated', (() => {
  const m = method(agentSrc, 'async _equipWhatSheHas')
  return m.length > 100 && /_equipWhatSheHas\(\)/.test(reArmor)
})())
// The survival-server policy: she is op here, but the rule is that on a
// survival server she never re-/gives. Removing that branch entirely would
// silently start handing out kit.
check('the survival-server no-re-give branch survives',
  /missing\.length && !canOp\(\)/.test(reArmor) &&
  /survival server: respawned without/.test(reArmor))
check('the survival branch still equips what she has',
  /return this\._equipWhatSheHas\(\);/.test(reArmor))
check('_equipWhatSheHas anchors the sword name (no pickaxe)',
  /\/sword\$\//.test(method(agentSrc, 'async _equipWhatSheHas')))
check('respawnKitNeeds is imported by agent.js',
  /import \{[^}]*respawnKitNeeds[^}]*\} from '\.\.\/utils\/threat\.js'/.test(agentSrc))

// ── the pest path must reuse isArmed, not re-derive ──────────────────────
const pestBlock = skillsSrc.slice(skillsSrc.indexOf("want('pests')"), skillsSrc.indexOf("want('pests')") + 2600)
check('the pest path uses isArmed()', /isArmed\(bot\)/.test(pestBlock))
check('the pest path has no loose /sword|axe/i test', !/\/sword\|axe\/i\.test/.test(pestBlock))
check('the dead `equipHighestAttack ? true : true` is gone',
  !/equipHighestAttack \? true : true/.test(skillsSrc))
check('isArmed is imported by skills.js',
  /import \{ isArmed \} from '\.\.\/\.\.\/utils\/threat\.js'/.test(skillsSrc))

// ── a fight must not be queued behind ordinary work ──────────────────────
// Measured 2026-10-02: she was mid-dig when a zombie reached her.
//   action "action:collectBlocks" trying to interrupt current action "action:attack"
//   [threat] scan fight result: done=false
// collectBlocks takes the generic stop() path (700ms + up to 10s of waiting),
// so the swing phase saw interrupt_code and bailed with the mob untouched.
// The scan already serialises fight-vs-fight; this is fight-vs-housekeeping.
const amSrc = readFileSync(resolve(here, '../src/agent/action_manager.js'), 'utf8')
check('action:attack preempts instead of waiting', /actionLabel === 'action:attack'/.test(amSrc))
check('the attack preempt path calls _preempt()', (() => {
  const i = amSrc.indexOf("actionLabel === 'action:attack'")
  return i >= 0 && /_preempt\(\)/.test(amSrc.slice(i, i + 1600))
})())
// Flatten comments to a single line before matching prose: a sentence wrapped
// across two `//` lines must still match, or every re-wrap breaks the check and
// it gets quietly weakened into checking something else. Two passes - drop the
// marker, then collapse the newline the marker left behind.
const prose = amSrc.replace(/^\s*\/\/\s?/gm, ' ').replace(/\s+/g, ' ')
check('the combat preempt is documented in-file',
  /COMBAT PREEMPT/.test(prose) && /Never wait out a fight\./.test(prose))
check('the combat preempt cites the measured log',
  /action:collectBlocks/.test(amSrc) && /done=false/.test(amSrc))
check('mode: still preempts too', /actionLabel\.startsWith\('mode:'\)/.test(amSrc))

// ── interrupt_code is STICKY and the scan bypasses the clearer ───────────
// requestInterrupt() sets bot.interrupt_code = true; the ONLY clearer is
// action_manager's clearBotLogs(). The scan calls attackEntity directly, so
// any interrupt raised by an unrelated action stayed set and every later fight
// bailed on its first poll with done=false - one zombie at 3 blocks, full
// diamond, and she never swung because of a flag from an old dig.
const scanStart2 = agentSrc.indexOf('this._threatScan = setInterval')
const scanBody = agentSrc.slice(scanStart2, scanStart2 + 1200)
check('the scan consumes the sticky interrupt flag',
  /this\.bot\.interrupt_code = false;/.test(scanBody))
check('the flag is cleared BEFORE the threat decision',
  (() => {
    const i = scanBody.indexOf('this.bot.interrupt_code = false;')
    const j = scanBody.indexOf('assessThreats(')
    return i >= 0 && j >= 0 && i < j
  })())
check('the sticky-flag reason is documented in-file',
  /interrupt_code is STICKY/.test(scanBody) && /bypassing the manager/.test(scanBody))

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)