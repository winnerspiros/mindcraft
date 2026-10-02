// Regression: 26.3 player-action ordinals in mineflayer digging.js.
//
// Mineflayer's bare 0/1/2 literals are vanilla-correct, but 26.3 inserts
// CHANGE_DESTROY_DIRECTION at index 1, shifting ABORT to 2 and STOP to 3.
// Sending vanilla's "finish" (2) therefore sent ABORT_DESTROY_BLOCK, so the
// server accepted START then cancelled every dig and no block ever broke.
//
// The correct values are derived from the server jar's own bytecode, not from
// prose: ServerboundPlayerActionPacket$Action.<clinit> assigns
//   0 START_DESTROY_BLOCK, 1 CHANGE_DESTROY_DIRECTION,
//   2 ABORT_DESTROY_BLOCK, 3 STOP_DESTROY_BLOCK.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(
  resolve(here, '../node_modules/mineflayer/lib/plugins/digging.js'), 'utf8')

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}

// --- the constant must exist with the 26.3 ordinals ---
const frozen = src.match(/const\s+DIG_STATUS\s*=\s*Object\.freeze\(\s*\{([^}]*)\}\s*\)/)
check('DIG_STATUS constant is declared with Object.freeze', !!frozen)

const body = frozen ? frozen[1] : ''
const ord = (k) => {
  const m = body.match(new RegExp(k + '\\s*:\\s*(\\d+)'))
  return m ? Number(m[1]) : NaN
}

check('START is 0', ord('START') === 0, `got ${ord('START')}`)
check('ABORT is 2 (not vanilla 1)', ord('ABORT') === 2, `got ${ord('ABORT')}`)
check('STOP is 3 (not vanilla 2)', ord('STOP') === 3, `got ${ord('STOP')}`)

// --- no bare literals may survive in any block_dig write ---
const writes = [...src.matchAll(/write\(\s*'block_dig'\s*,\s*\{([\s\S]*?)\}\s*\)/g)]
check('all three block_dig writes are present', writes.length === 3,
  `found ${writes.length}`)

const usesNamed = writes.map(w => /status:\s*DIG_STATUS\./.test(w[1]))
check('every write uses DIG_STATUS.* for status', usesNamed.every(Boolean),
  `named-usage per write: ${JSON.stringify(usesNamed)}`)

// A bare digit anywhere in a status field is the exact regression. Strip line
// comments first: the DIG_STATUS derivation block deliberately quotes the old
// vanilla literals (`status: 2` "finish digging") to explain the bug, and that
// prose must not be mistaken for live code.
const codeOnly = src
  .split('\n')
  .map(l => l.replace(/^\s*\/\/.*$/, ''))
  .join('\n')
const bare = codeOnly.match(/status:\s*[012]\b/g)
check('no bare 0/1/2 status literals remain in code', !bare,
  bare ? `found ${JSON.stringify(bare)}` : '')

// --- each write must use the semantically right member ---
const startWrite = writes[0], stopWrite = writes[1], abortWrite = writes[2]
check('start write uses DIG_STATUS.START', !!startWrite && /status:\s*DIG_STATUS\.START/.test(startWrite[1]))
check('stop write uses DIG_STATUS.STOP', !!stopWrite && /status:\s*DIG_STATUS\.STOP/.test(stopWrite[1]))
check('abort write uses DIG_STATUS.ABORT', !!abortWrite && /status:\s*DIG_STATUS\.ABORT/.test(abortWrite[1]))

// --- STOP must not be ABORT: this is the bug that ate every block ---
check('STOP and ABORT are distinct values', ord('STOP') !== ord('ABORT'))
check('STOP is greater than ABORT (26.3 shifts both up)', ord('STOP') > ord('ABORT'))

// --- the sequence field requirement stays intact on all three writes ---
const seqCount = writes.filter(w => /sequence:/.test(w[1])).length
check('all three writes still carry a sequence field', seqCount === 3,
  `found ${seqCount}`)

// --- the derivation must be documented in-file so the next person
//     (or the next model) does not "fix" it back to vanilla literals ---
const docLines = src.split('\n').filter(l => /^\s*\/\//.test(l)).join('\n')
check('the 26.3 ordinal derivation is documented in-file',
  /CHANGE_DESTROY_DIRECTION/.test(docLines) &&
  /ABORT_DESTROY_BLOCK/.test(docLines) &&
  /STOP_DESTROY_BLOCK/.test(docLines) &&
  /26\.3/.test(docLines))

// Each of the four ordinals must be stated explicitly in the prose, so a
// doc-only mutation that drops one constant is still caught.
for (const n of ['START_DESTROY_BLOCK', 'CHANGE_DESTROY_DIRECTION',
  'ABORT_DESTROY_BLOCK', 'STOP_DESTROY_BLOCK']) {
  check(`doc names ${n}`, docLines.includes(n))
}

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)