// Mutation check for tests/bow_shot_truth.test.mjs.
//
// Reintroduces the exact defect the test exists to catch: shootBow reading the
// CLIENT arrow count on both sides of the draw instead of the server count. On
// 26.3 the client decode is broken (it reports 64 through every draw), so the
// comparison can never be true and every shot is reported as "no arrow was
// consumed" — the live symptom.
//
// The original file is restored in a finally block and the restore is verified
// byte-for-byte, so a failure here cannot leave mutated source behind.
//
// Usage: node tools/verify_bow_shot_bites.mjs
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { execFileSync } from 'child_process'

const here = dirname(fileURLToPath(import.meta.url))
const skillsPath = resolve(here, '../src/agent/library/skills.js')
const testPath = resolve(here, '../tests/bow_shot_truth.test.mjs')
const original = readFileSync(skillsPath, 'utf8')

// Each mutant is one half of the same defect: put a side of the arrowSpent
// comparison back on the broken client count.
const mutants = [
  {
    name: 'arrowsBefore comes from the client, not the server',
    from: `let arrowsBefore = useServerCount ? serverArrows.total : countArrows(bot);
    if (arrowsBefore === null) arrowsBefore = countArrows(bot);`,
    to: `let arrowsBefore = countArrows(bot);`,
  },
  {
    name: 'arrowsAfter comes from the client, not the server',
    from: `let arrowsAfter = countArrows(bot);
        if (useServerCount) {
            try {
                const { rconCountAll } = await import('../../utils/rcon.js');
                const s = await rconCountAll(bot.username, 'arrow');
                if (s) arrowsAfter = s.total;
            } catch (_) {}
        }`,
    to: `let arrowsAfter = countArrows(bot);`,
  },
]

const run = () => {
  try {
    const out = execFileSync('node', [testPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

let allBite = true
try {
  // Baseline: with the real source the test must pass, or "it bites" means
  // nothing.
  const base = run()
  console.log(`baseline (unmutated): exit ${base.code}`)
  if (base.code !== 0) {
    console.error('baseline FAILED — the test does not pass against real source')
    console.error(base.out)
    process.exit(2)
  }

  for (const m of mutants) {
    if (!original.includes(m.from)) {
      console.error(`MUTATION TARGET NOT FOUND: ${m.name}`)
      console.error('The source changed shape; update this tool.')
      process.exit(2)
    }
    writeFileSync(skillsPath, original.replace(m.from, m.to))
    const r = run()
    const failing = r.out.split('\n').filter(l => /^NOT OK/.test(l))
    console.log(`\n${r.code !== 0 ? 'BITES' : 'DOES NOT BITE'}: ${m.name}`)
    console.log(`  exit ${r.code}, ${failing.length} failing check(s)`)
    for (const line of failing) console.log('  ' + line)
    if (r.code === 0) allBite = false
    writeFileSync(skillsPath, original)
  }
} finally {
  writeFileSync(skillsPath, original)
  const restored = readFileSync(skillsPath, 'utf8')
  if (restored !== original) {
    console.error('RESTORE FAILED — skills.js differs from the original. Fix it by hand.')
    process.exit(2)
  }
  console.log('\nrestored and byte-verified skills.js')
}

process.exit(allBite ? 0 : 1)