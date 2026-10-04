// Behavioural proof that shootBow counts a shot by the ARROW STACK, and takes
// both sides of that comparison from the SAME source.
//
// Measured live 2026-10-04: every threat-scan tick logged "scan shot result:
// fired=false" against a phantom that was never killed, and the phantom's
// server-side Health never moved. arrowSpent() was being fed the CLIENT
// count on both sides, and on 26.3 the client inventory decode is broken —
// it reported 64 arrows through every draw — so the comparison could never
// be true. The server stack is the one that actually decrements.
//
// The rule under test: when RCON is available the server count is read
// before AND after the draw, and a decrease there is what marks a shot as
// real. The client count is a fallback only.
//
// The real skills module is imported, not an extracted function: shootBow
// dynamically imports ../../utils/rcon.js, and a function rebuilt with
// new Function has no module context, so that relative specifier cannot
// resolve — the RCON path would never run and a stub would get no say. (That
// mistake made the empty-quiver case pass for the wrong reason once already.)
//
// The server verdict comes from rcon.js's own setCountAllOverride seam, which
// exists for exactly this purpose. Stubbing the file on disk instead would
// have to satisfy every export skills.js imports and carry the risk of leaving
// a stub behind if the test died.
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const { shootBow } = await import(resolve(here, '../src/agent/library/skills.js'))
const { setCountAllOverride } = await import(resolve(here, '../src/utils/rcon.js'))

let ok = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`ok - ${name}`) }
  else { failed++; console.log(`NOT OK - ${name}${extra ? ' :: ' + extra : ''}`) }
}
check('the real shootBow and the rcon seam are both loaded',
  typeof shootBow === 'function' && typeof setCountAllOverride === 'function')

// A Vector3 stand-in with the methods aim maths actually calls. A plain
// {x,y,z} quietly yields NaN instead of throwing, hiding bugs rather than
// surfacing them.
const vec = (x, y, z) => ({
  x, y, z,
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) },
  clone() { return vec(this.x, this.y, this.z) },
  offset(dx, dy, dz) { return vec(this.x + dx, this.y + dy, this.z + dz) },
  normalized() { const m = Math.hypot(this.x, this.y, this.z) || 1; return vec(this.x / m, this.y / m, this.z / m) },
  floored() { return vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) },
})

const target = { name: 'phantom', id: 1, height: 2, position: vec(8, 64, 0), velocity: vec(0, 0, 0) }

function makeBot(itemsFn) {
  return {
    username: 'UwU',
    inventory: { items: itemsFn },
    heldItem: { name: 'bow' },
    entity: { position: vec(0, 64, 0) },
    equip: async () => {},
    lookAt: async () => {},
    activateItem: async () => {},
    deactivateItem: async () => {},
    on: () => {},
  }
}

// The stale client inventory, as 26.3 actually reports it: a number that has
// nothing to do with the server's. It must DIFFER from the server count, or a
// mutation that reads the before-side from the client would coincidentally
// agree with the server and go unnoticed.
const STALE = () => [{ name: 'bow' }, { name: 'arrow', count: 10 }]

// An override that makes rconCountAll throw, which is how a survival server
// with no RCON behaves. shootBow must still fall back to the client count.
const rconBroken = () => { setCountAllOverride(() => { throw new Error('rcon off') }) }
const rconSays = (n) => setCountAllOverride(async () => ({ total: n, inv: n, worn: null, offhand: 0 }))

try {
  // 1. Nothing flew: a stale client count must not be able to claim a shot.
  rconSays(64)
  {
    const fired = await shootBow(makeBot(STALE), target, 1, true)
    check('a stale client count cannot claim a shot that did not happen',
      fired === false, `fired=${fired}`)
  }

  // 2. An arrow really left the bow: the server stack drops, so it counts.
  //    This is the regression — before the fix both sides came from the client,
  //    which sat at 64 throughout and so always reported no shot.
  {
    let arrows = 64
    rconSays(arrows)
    const bot = makeBot(STALE)
    bot.deactivateItem = async () => { arrows = 63; rconSays(63) }
    const fired = await shootBow(bot, target, 1, true)
    check('a real server-side decrease is counted as a shot',
      fired === true, `fired=${fired}`)
  }

  // 3. An empty quiver is refused up front, not attempted and silently missed.
  rconSays(0)
  {
    let drew = false
    const bot = makeBot(STALE)
    bot.activateItem = async () => { drew = true }
    const fired = await shootBow(bot, target, 1, true)
    check('an empty quiver refuses the draw',
      fired === false && !drew, `fired=${fired} drew=${drew}`)
  }

  // 4. With no RCON the client count is still consulted, so a server without
  //    RCON keeps working rather than never shooting at all.
  rconBroken()
  {
    let arrows = 64
    const bot = makeBot(() => [{ name: 'bow' }, { name: 'arrow', count: arrows }])
    bot.deactivateItem = async () => { arrows = 63 }
    const fired = await shootBow(bot, target, 1, true)
    check('the client fallback is still reachable', fired === true, `fired=${fired}`)
  }
} finally {
  // Overrides are opt-in and must be cleared, or every later RCON read in the
  // process silently reports this fake number.
  setCountAllOverride(null)
  console.log('cleared the rcon override')
}

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)