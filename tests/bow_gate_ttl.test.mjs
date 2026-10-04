// Pins the bow-gate cache TTL against the scan's own per-target dedupe window.
//
// Measured live 2026-10-04: a phantom spawned 7-12 blocks out, the scan logged
// "[threat] bow check: server says 64 arrows - bow is live." repeatedly and
// NEVER once logged "scan: SHOOTING phantom", while the phantom's server-side
// Health fell to 6.0/20 from arrows loosed by a different path.
//
// Two independent defects stacked here. arrowSpent read a stale client arrow
// count (covered by bow_shot_truth.test.mjs). This one is the gate itself:
//
//   - the gate is sync, the RCON answer is async, so the first tick answers
//     false ("unconfirmed") and caches the confirmed verdict for later;
//   - but the scan drops a repeat of the same target for 8s (_lastThreatKey),
//     while the cache TTL was 3s.
//
// So the tick that could read the confirmed `true` was never allowed to run:
// every engagement wrote "bow is live" and then threw it away. The TTL has to
// outlast the dedupe, or the cache is decorative.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const agentSrc = readFileSync(resolve(here, '../src/agent/agent.js'), 'utf8')

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}

// The scan's dedupe window, read from the source rather than restated here.
const dedupe = /_lastThreatKey === key && Date\.now\(\) - \(this\._lastThreatAt \|\| 0\) < (\d+)/.exec(agentSrc)
check('the per-target dedupe window was found', dedupe !== null)
const DEDUPE_MS = dedupe ? Number(dedupe[1]) : 0

// The gate's cache TTL.
const ttl = /const BOW_GATE_TTL = (\d+)/.exec(agentSrc)
check('the bow-gate TTL was found', ttl !== null)
const TTL = ttl ? Number(ttl[1]) : 0

console.log(`    dedupe window ${DEDUPE_MS}ms, gate TTL ${TTL}ms`)

// The actual stall condition: a TTL shorter than the dedupe means the cached
// verdict is always stale by the time the scan will next look.
check('the gate TTL outlasts the scan dedupe window',
  TTL > DEDUPE_MS,
  `TTL ${TTL} <= dedupe ${DEDUPE_MS}: the confirmed verdict is written but never read`)

// It must also be long enough to be read on the very next permitted tick.
check('the TTL is at least twice the dedupe window, leaving room for a slow RCON round trip',
  TTL >= DEDUPE_MS * 2,
  `TTL ${TTL} < 2x ${DEDUPE_MS}`)

// A named constant beats a bare literal, so this relationship is legible in
// the source rather than implied by two unrelated numbers.
check('the TTL is a named constant, not an inline literal',
  /const BOW_GATE_TTL = \d+/.test(agentSrc))
check('the cache read uses that constant',
  /Date\.now\(\) - cached\.t < BOW_GATE_TTL/.test(agentSrc))

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)