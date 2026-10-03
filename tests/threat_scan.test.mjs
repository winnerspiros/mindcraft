// Regression: the 26.3 threat scan must DETECT hostiles and must ACT, not narrate.
//
// Two separate 26.3-era defects made her stand there and die:
//
// 1. mobName() gated on `entity.type === 'mob'`. 26.3 reports a real taxonomy -
//    measured live: hostile/zombie, hostile/pillager, ambient/bat, animal/sheep,
//    player/player, other/item, projectile/arrow. There is NO `mob` bucket, so
//    mobName returned null for every hostile, assessThreats always returned
//    'no hostiles nearby', and the 1s scan never logged a single detection
//    all-time. The "act BEFORE it hits her" layer had been dead code.
//
// 2. Even when it did decide, the scan only called self_prompter.start() - a
//    goal handed to the model to write a sentence about. The exact failure this
//    repo already documents for reactToHurt as "a reflex that cannot move her
//    is a comment".
//
// Verified live after the fix: the scan logged "fight: armed, pillager at 1.9
// blocks", called attackEntity, and logged "Successfully killed pillager."
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { mobName, assessThreats } from '../src/utils/threat.js'

const here = dirname(fileURLToPath(import.meta.url))
const threatSrc = readFileSync(resolve(here, '../src/utils/threat.js'), 'utf8')
const agentSrc = readFileSync(resolve(here, '../src/agent/agent.js'), 'utf8')

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}

const pos = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) })

// ── 1. mobName must understand the real 26.3 taxonomy ─────────────────────
for (const t of ['hostile', 'mob', 'animal', 'ambient']) {
  check(`mobName accepts type="${t}"`,
    mobName({ type: t, name: 'zombie' }) === 'zombie')
}
check('mobName still strips the minecraft: prefix',
  mobName({ type: 'hostile', name: 'minecraft:pillager' }) === 'pillager')
// things that must NEVER be treated as a mob
for (const t of ['player', 'projectile', 'other', 'item', 'vehicle', 'orb']) {
  check(`mobName rejects type="${t}"`, mobName({ type: t, name: 'zombie' }) === null)
}
check('mobName rejects unknown/unresolved types',
  mobName({ type: 'unknown', name: 'zombie' }) === null)
// A player is NEVER a mob. If this guard is weakened she will punch humans,
// which is the worst possible regression here - so it gets a direct check on
// the live-shaped entity, not just the type string.
//
// Note on the two guards: mobName tests NON_MOB_TYPES *and* MOB_TYPES, and
// they are deliberately redundant. Removing EITHER one alone leaves players
// rejected by the other, so a single-guard mutation is not a real regression
// and correctly does not fail the suite. Only removing BOTH is, and that
// mutation is caught. Do not "simplify" this to one check.
check('mobName never returns a player name',
  mobName({ type: 'player', name: 'Steve' }) === null)
// Pin the guard itself. Every mobName() case above also passes when the
// NON_MOB_TYPES allowlist is neutered, because the type allowlist rejects them
// anyway. Assert the exclusion set directly so weakening it cannot pass.
// Behavioural check that actually depends on the guard: 'other' and 'orb' are
// NOT in the type allowlist either, so use a type the allowlist WOULD accept.
// The real risk is a non-mob type being newly allowed, so assert the allowlist
// and the exclusion list agree about players from the observable side.
check('NON_MOB_TYPES still excludes players explicitly', (() => {
  const m = threatSrc.match(/const NON_MOB_TYPES = new Set\(\[([\s\S]*?)\]\)/)
  if (!m) return false
  return /['"]player['"]/.test(m[1])
})())
check('NON_MOB_TYPES still excludes projectiles and dropped items', (() => {
  const m = threatSrc.match(/const NON_MOB_TYPES = new Set\(\[([\s\S]*?)\]\)/)
  if (!m) return false
  return /['"]projectile['"]/.test(m[1]) && /['"]item['"]/.test(m[1])
})())
// type:'hostile' + name:'player' is not a shape mineflayer produces, so this
// documents intent rather than guarding a reachable path:
//   mobName({ type: 'hostile', name: 'player' }) === 'player'  <- noted, not a bug
check('a player next to her is never chosen as a fight target', (() => {
  const r = assessThreats({
    bot: {
      entity: { position: pos(0, 64, 0) },
      inventory: { items: () => [{ name: 'diamond_sword' }] },
    },
    entities: [
      { id: 1, type: 'player', name: 'Steve', position: pos(0, 64, 1) },
      { id: 2, type: 'hostile', name: 'zombie', position: pos(0, 64, 9) },
    ],
  })
  return r.target?.name === 'zombie'
})())
check('mobName rejects null / nameless entities',
  mobName(null) === null && mobName({ type: 'hostile', name: '' }) === null)

// the exact entities the live census printed
check('mobName handles the measured census entries',
  mobName({ type: 'hostile', name: 'zombie' }) === 'zombie' &&
  mobName({ type: 'hostile', name: 'pillager' }) === 'pillager' &&
  mobName({ type: 'ambient', name: 'bat' }) === 'bat' &&
  mobName({ type: 'animal', name: 'sheep' }) === 'sheep')

// ── 2. the old dead guard must not come back ──────────────────────────────
// Scan code only: the explanatory comment quotes the old guard verbatim, and
// prose must not be mistaken for live code.
const threatCode = threatSrc.split('\n').map(l => l.replace(/^\s*(\/\/|\*).*$/, '')).join('\n')
check('mobName no longer hard-requires type === "mob"',
  !/entity\.type !== 'mob'/.test(threatCode))
check('the 26.3 taxonomy is documented in-file',
  /hostile\/zombie/.test(threatSrc) && /NO `mob` bucket|mob` bucket/.test(threatSrc))

// ── 3. end-to-end: assessThreats must now SEE a live-style hostile ───────
const armedBot = {
  entity: { position: pos(0, 64, 0) },
  inventory: { items: () => [{ name: 'diamond_sword' }] },
}
const live = assessThreats({
  bot: armedBot,
  entities: [
    { id: 1, type: 'hostile', name: 'zombie', position: pos(0, 64, 3) },
    { id: 2, type: 'hostile', name: 'pillager', position: pos(20, 70, 20) },
    { id: 3, type: 'player', name: 'Steve', position: pos(0, 64, 2) },
    { id: 4, type: 'other', name: 'item', position: pos(0, 64, 1) },
  ],
})
check('assessThreats detects the nearby 26.3 zombie', live.action === 'fight',
  `got action=${live.action} reason=${live.reason}`)
check('assessThreats targets the zombie, not the far pillager',
  live.target?.name === 'zombie', `got ${live.target?.name}`)
check('assessThreats ignores players and dropped items',
  live.target?.name !== 'Steve' && live.target?.name !== 'item')

// unarmed + nothing close = still quiet, so this is not just "always fight"
const unarmed = assessThreats({
  bot: { entity: { position: pos(0, 64, 0) }, inventory: { items: () => [] } },
  entities: [{ id: 1, type: 'hostile', name: 'zombie', position: pos(60, 64, 60) }],
})
check('assessThreats ignores a distant hostile', unarmed.action === 'ignore',
  `got ${unarmed.action}`)

// a creeper up close must still route to avoid, not fight
const creeper = assessThreats({
  bot: armedBot,
  entities: [{ id: 9, type: 'hostile', name: 'creeper', position: pos(0, 64, 2) }],
})
check('a priming creeper still resolves to avoid', creeper.action === 'avoid',
  `got ${creeper.action}`)

// ── 4. the scan must ACT, not only self-prompt ────────────────────────────
// The window must cover the whole interval body; it grew when the scan started
// dispatching skills and again when the fight serialisation was added. 2600
// chars silently truncated the tail, so the checks below passed vacuously.
const scanStart = agentSrc.indexOf('this._threatScan = setInterval')
// Bound the scan by its real closing brace, not a fixed character window. The
// window was 4200 against a 14417-char scan, so it silently truncated the
// avoid and serialisation branches - and the moment the scan grew by ~1.5KB
// (adding the bow check) every branch check began failing at once, which looks
// like a code regression and is actually a test that had been lying.
const scanRegion = agentSrc.slice(scanStart, agentSrc.indexOf('\n    }\n', scanStart + 8000))
// Slice from `anchor` to the end of its own `if` block, matched on indentation.
// A fixed char window silently truncated the real code out of scope whenever a
// comment in the branch grew, which is how "deletes the dispatch" mutations
// passed. Branch-scoped checks cannot rot that way.
// Depth-aware: walk braces from the anchor and stop at the one that closes the
// branch itself. Matching on an indentation pattern instead grabs the first
// `\n<indent-1>}` in the text, which is frequently the end of an arrow function
// nested inside the branch (` .then(x => { ... })`) - so the "branch" slice
// stopped early and checks against it failed for reasons unrelated to the
// dispatch they were meant to assert.
const branch = (src, anchor) => {
  const i = src.indexOf(anchor)
  if (i < 0) return null
  const open = src.indexOf('{', i + anchor.length - 1)
  if (open < 0) return null
  let depth = 0
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    // skip braces inside string/template/regex literals so they do not unbalance
    if (c === '`') { k = src.indexOf('`', k + 1); if (k < 0) break; continue }
    if (c === "'" || c === '"') {
      const q = c; k++
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++ }
      continue
    }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); if (k < 0) break; continue }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k); if (k < 0) break; k++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  return src.slice(i)
}
check('the threat scan is actually wired', /this\._threatScan = setInterval/.test(agentSrc))
check('startEvents (which starts the scan) is called', /this\.startEvents\(\)/.test(agentSrc))
check('the scan dispatches attackEntity on a fight', (() => {
  const b = branch(scanRegion, "if (r.action === 'fight' && r.target)")
  return b && /attackEntity\(this\.bot, r\.target, true\)/.test(b)
})())
// Anchor on the avoid branch itself, not anywhere in the scan body: a loose
// search passed while the dispatch was deleted outright.
// The bow check MUST sit inside the fight branch. Placed after the fight and
// avoid blocks it is unreachable dead code - both of those end in `return`, so
// the scan never reached it and she pathed into a 14-block zombie instead
// (measured: HP 20 -> 12, zero SHOOTING lines in the log). Ordering is the
// whole correctness property here, so assert the three positions.
check('the bow check is INSIDE the fight branch, before the melee dispatch',
  agentSrc.indexOf("r.action === 'fight' && r.target") <
  agentSrc.indexOf('_hasBowFor(r.target)') &&
  agentSrc.indexOf('_hasBowFor(r.target)') <
  agentSrc.indexOf('if (this._fightInFlight) return;'))
check('the bow path returns, so melee never also fires on the same target',
  /SHOOTING[\s\S]{0,700}?shootBow\(this\.bot, r\.target, 2, true\)[\s\S]{0,300}?return;/.test(agentSrc.replace(/\n\s*/g, ' ')))
// The bow must be UNREACHABLE for an avoid decision. The right invariant is
// not textual order - it is that the bow sits inside the `action === 'fight'`
// branch, so an avoid decision can never reach it regardless of line order.
// (The bow is textually before the avoid block, which is fine: the avoid branch
// is a sibling, and reaching the bow requires having passed the fight guard.)
const fightAt2 = agentSrc.indexOf("if (r.action === 'fight' && r.target)")
const bowAt2 = agentSrc.indexOf('_hasBowFor(r.target)')
const avoidAt2 = agentSrc.indexOf("if (r.action === 'avoid' && r.target)")
check('the bow is only reachable from the fight branch (an avoid decision can never shoot)',
  fightAt2 < bowAt2 && branch(agentSrc, "if (r.action === 'fight' && r.target)")
    .includes('_hasBowFor(r.target)') &&
  !branch(agentSrc, "if (r.action === 'avoid' && r.target)").includes('_hasBowFor'))
check('the scan dispatches avoidEnemies on avoid', (() => {
  const b = branch(scanRegion, "if (r.action === 'avoid' && r.target)")
  return b && /avoidEnemies\(this\.bot, 24,/.test(b)
})())
check('the scan still logs its decision', /\[threat\] \$\{r\.action\}: \$\{r\.reason\}/.test(scanRegion))
// narration alone was the bug: a self-prompt with no skill call is the defect
const narrateOnly = /console\.log\(\`\[threat\] \$\{r\.action\}: \$\{r\.reason\}\`\);\s*this\.self_prompter\.start\(r\.goal\);\s*\} catch/.test(scanRegion)
check('the scan is not narration-only', !narrateOnly)

// ── 5. one fight at a time ────────────────────────────────────────────────
// The 1s scan used to start a new attackEntity while one was still swinging.
// The action manager saw "action:attack trying to interrupt current action
// action:attack", raised interrupt_code, and the RUNNING fight returned
// done=false - measured live: 3 zombies -> 3 aborted fights, 0 kills, while
// she sat at full health being ignored. Fights must serialise.
check('the scan serialises fights', (() => {
  const b = branch(scanRegion, "if (r.action === 'fight' && r.target)")
  return b && /_fightInFlight/.test(b)
})())
check('a running fight blocks a new one', (() => {
  const b = branch(scanRegion, "if (r.action === 'fight' && r.target)")
  return b && /if \(this\._fightInFlight\) return;/.test(b)
})())
check('the in-flight flag is always cleared', (() => {
  const b = branch(scanRegion, "if (r.action === 'fight' && r.target)")
  return b && /\.finally\(\(\) => \{ this\._fightInFlight = false; \}\)/.test(b)
})())
check('the serialisation is documented in-file',
  /Never preempt a fight/.test(scanRegion) && /with a fight/.test(scanRegion))

// --- the scan's own identifiers must exist in agent.js ---------------------
// Same failure mode as MELEE_RANGE in skills.js: a constant used by the scan
// but not imported into agent.js throws every tick. Caught one on the way in
// - the bow gate was written with MELEE_RANGE before checking the import.
const declaredInAgent = new Set([
  ...[...agentSrc.matchAll(/^\s*(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
  ...[...agentSrc.matchAll(/^import\s+(?:\*\s+as\s+([\w$]+)|\{([^}]*)\}|([\w$]+))/gm)]
    .flatMap(m => m[1] ? [m[1]] : (m[2] ? m[2].split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : [m[3]])),
])
const scanBranch = (() => {
  const m = agentSrc.indexOf('this._threatScan = setInterval')
  return agentSrc.slice(m, agentSrc.indexOf('\n    }\n', m + 8000))
})()
// Strip comments AND template literals: log lines interpolate
// `... SHOOTING ${...}` and those shouty words are prose, not identifiers.
const scanCode = scanBranch
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '""')
const scanCaps = [...new Set([...scanCode.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map(m => m[1]))]
const scanBad = scanCaps.filter(c => !declaredInAgent.has(c))
check('every SCREAMING_CASE constant in the threat scan is declared in agent.js',
  scanBad.length === 0, scanBad.length ? 'undefined: ' + scanBad.join(', ') : undefined)

check('the scan reaches for the bow, not only the sword',
  /shootBow\(this\.bot, r\.target/.test(agentSrc) && /_hasBowFor/.test(agentSrc))
check('the bow gate checks for an actual bow, not just arrows',
  /const hasBow = items\.some\(i => i\.name === 'bow'\);/.test(agentSrc))
check('the bow gate refuses when EITHER is missing',
  /if \(!hasBow \|\| !hasArrow\) return false;/.test(agentSrc))
// Plain string containment, not regex: `items?.()` is `?` followed by `(`,
// which is easy to mis-escape into a pattern that silently matches nothing -
// and a check that quietly never matches is worse than no check.
const bowBody = (() => {
  const i = agentSrc.indexOf('_hasBowFor(entity)')
  const m = agentSrc.slice(i).match(/_hasBowFor\(entity\) \{[\s\S]*?\n    \}/)
  return m ? m[0] : ''
})()
check('the bow gate is defensive about a missing inventory',
  bowBody.includes('this.bot?.inventory?.items?.() || []') &&
  bowBody.includes('catch (_) { return false; }'))
check('the bow gate checks arrows too (not just a bow)',
  /_hasBowFor\(entity\)/.test(agentSrc) &&
  /hasArrow[\s\S]{0,220}arrow\|spectral_arrow/.test(agentSrc.replace(/\n\s*/g, ' ')))
check('the bow is only used OUTSIDE sword range',
  /return d > MELEE_RANGE;/.test(agentSrc))
check('MELEE_RANGE is imported into agent.js',
  /import \{[^}]*\bMELEE_RANGE\b[^}]*\} from '\.\.\/utils\/threat\.js'/.test(agentSrc))
check('the bow path returns, so it never also runs melee on the same target',
  /SHOOTING[\s\S]{0,700}return;/.test(agentSrc.replace(/\n\s*/g, ' ')))

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)