// Mutation check: does bow_gate_phantom.test.mjs actually FAIL when the
// phantom cache bug is reintroduced? A regression test that passes against the
// broken code is worse than no test, so prove the test bites before trusting it.
//
// It reads the cacheKey line OUT of the real test file, so it stays honest if
// that file is ever reformatted. The original bytes are restored in a finally
// block and re-verified afterwards, so a failure mid-run cannot leave the
// mutated test behind.
//
// Run: node tools/verify_test_bites.mjs
import { readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'node:child_process'

const TEST = '/home/ubuntu/uwu-bot/tests/bow_gate_phantom.test.mjs'
const ANCHOR = "const cacheKey = entity?.name || 'mob';"

const original = readFileSync(TEST, 'utf8')

// The mutation: cache on entity.id again, exactly as before the fix.
const mutated = original.replace(ANCHOR, "const cacheKey = String(entity?.id);")
if (mutated === original) {
  console.error(`MUTATION DID NOT APPLY — no line matching: ${ANCHOR}`)
  process.exit(2)
}

let code = 0
let out = ''
console.log('mutation applied: cacheKey is now entity.id (the pre-fix behaviour)')
try {
  writeFileSync(TEST, mutated)
  try {
    out = execFileSync('node', [TEST], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) { out = String(e.stdout || ''); code = e.status ?? 1 }
  console.log(`\nexit code against the BROKEN code: ${code} (want non-zero)`)
  console.log(out.trim())
  if (code === 0) {
    console.error('\nTEST DOES NOT BITE — it passes against the bug it claims to catch.')
    process.exit(1)
  }
  console.log('\nOK: the test fails against the broken code, so it is a real regression guard.')
} finally {
  writeFileSync(TEST, original)
  const restored = readFileSync(TEST, 'utf8')
  if (restored !== original) {
    console.error('RESTORE FAILED — the mutated test file is still on disk. Fix it by hand.')
    process.exit(2)
  }
  console.log('restored and byte-verified the original test file')
}
