// Guard: patches/mineflayer+4.37.1.patch must apply to STOCK mineflayer 4.37.1
// and must reproduce the live node_modules files byte-for-byte.
//
// This was silently broken before: the patch carried only 1 of 17 physics.js
// hunks, and the enchantment_table/physics hunks failed to apply at all
// (context drift). A clean `bun install` would have dropped ~800 lines of
// 26.3 physics work with no error. `patch-package` does not fail loudly when
// hunks are missing unless something checks, so this checks.
//
// Requires a stock 4.37.1 tarball. A copy is vendored at
// tests/fixtures/mineflayer-4.37.1.tgz so a clean clone can run this; if that
// is missing the apply test SKIPS loudly rather than passing silently.
import { readFileSync, existsSync, mkdtempSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const patchFile = join(repo, 'patches/mineflayer+4.37.1.patch')
const patch = readFileSync(patchFile, 'utf8')

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}

const FILES = ['enchantment_table', 'digging', 'physics']

// --- shape: every file we actually modify must have a section ---
for (const f of FILES) {
  check(`patch has a section for ${f}.js`,
    patch.includes(`diff --git a/node_modules/mineflayer/lib/plugins/${f}.js`))
}

// --- the dig-ordinal fix must be IN the patch, not just on disk ---
// Regression for commit 972898c: without DIG_STATUS the 26.3 ordinals are
// lost on reinstall and UwU cannot break blocks again.
check('patch carries the DIG_STATUS ordinal fix',
  /\+\s*const DIG_STATUS = Object\.freeze/.test(patch))
check('patch carries all three named statuses',
  /\+\s*START: 0/.test(patch) &&
  /\+\s*ABORT: 2/.test(patch) &&
  /\+\s*STOP: 3/.test(patch))

// --- physics must not regress to a single hunk ---
const phys = patch.split('diff --git a/node_modules/mineflayer/lib/plugins/physics.js')[1] || ''
const physHunks = (phys.match(/^@@/gm) || []).length
check('physics.js has many hunks (not the old 1-hunk stub)', physHunks >= 15,
  `found ${physHunks} hunks`)

// --- the real proof: apply to stock and compare bytes ---
const tgz = join(repo, 'tests/fixtures/mineflayer-4.37.1.tgz')
if (!existsSync(tgz)) {
  console.log(`SKIP - apply test needs stock tarball (npm pack mineflayer@4.37.1 -> ${tgz})`)
  failed++
  console.log(`\n${ok} passed, ${failed} failed`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'mfpatch-'))
execFileSync('bash', ['-c', `cd ${dir} && tar xzf ${tgz} && mkdir -p node_modules && mv package node_modules/mineflayer`])
const dry = execFileSync('bash', ['-c', `cd ${dir} && patch -p1 --dry-run < ${patchFile} 2>&1`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
check('patch applies to stock 4.37.1 with no failed hunks',
  !/FAILED|Reversed|malformed/.test(dry), dry.split('\n').filter(l => /FAILED/.test(l)).join('; '))

execFileSync('bash', ['-c', `cd ${dir} && patch -p1 < ${patchFile} >/dev/null 2>&1`])
for (const f of FILES) {
  const a = join(dir, `node_modules/mineflayer/lib/plugins/${f}.js`)
  const b = join(repo, `node_modules/mineflayer/lib/plugins/${f}.js`)
  let same = false
  try {
    // diff exits 0 = identical, 1 = differs, throws only on error (e.g. missing).
    execFileSync('diff', ['-q', a, b], { stdio: 'ignore' })
    same = true
  } catch (e) {
    // exit status 1 means "files differ" -> genuinely a failure.
    same = false
  }
  check(`patched ${f}.js reproduces the live file byte-for-byte`, same)
}

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)