// Behavioural proof that shootBow counts a shot by the ARROW STACK, and takes
// both sides of that comparison from the SAME source.
//
// Measured live 2026-10-04: every threat-scan tick logged "scan shot result:
// fired=false" against a phantom that was never killed, and the phantom's
// server-side Health never moved. arrowSpent() was being fed the CLIENT count
// on both sides, and on 26.3 the client inventory decode is broken — it
// reported 64 arrows through every draw — so the comparison could never be
// true. The server stack is the one that actually decrements.
//
// The rule: when RCON is available the server count is read before AND after
// the draw, and a decrease there is what marks a shot as real. The client
// count is a fallback only.
//
// The real skills module is imported, not rebuilt with new Function: shootBow
// dynamically imports ../../utils/rcon.js, and a function built that way has
// no module context, so that relative specifier cannot resolve — the RCON path
// never runs and a stub gets no say. (That mistake made the empty-quiver case
// pass for the wrong reason once already.)
//
// Server verdicts come from rcon.js's own setCountAllOverride seam, cleared in
// finally. Stubbing the file on disk instead would have to satisfy every
// export skills.js imports, and risks leaving a stub behind if the test dies.
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

// A Vector3 stand-in with the methods aim maths actually calls. A plain {x,y,z}
// quietly yields NaN instead of throwing, hiding bugs rather than surfacing
// them.
const vec = (x, y, z) => ({
  x, y, z,
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) },
  clone() { return vec(this.x, this.y, this.z) },
  offset(dx, dy, dz) { return vec(this.x + dx, this.y + dy, this.z + dz) },
  normalized() { const m = Math.hypot(this.x, this.y, this.z) || 1; return vec(this.x / m, this.y / m, this.z / m) },
  floored() { return vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) },
})

const target = { name: 'phantom', id: 1, height: 2, position: vec(8, 64, 0), velocity: vec(0, 0, 0) }

// The client inventory as 26.3 reports it: a count with nothing to do with the
// server's. It must DIFFER from the server count, or a mutation reading the
// before-side from the client would coincidentally agree and go unnoticed.
// Takes a getter so a case can move the count mid-draw, the way a real shot
// does — closing over the value would freeze it at 64.
const quiver = (get) => () => [{ name: 'bow' }, { name: 'arrow', count: get() }]

// server: what the server reports before the draw. null means RCON is
// unreachable, as on a survival server. afterDraw: what it reports once an
// arrow has left. client/clientAfter: the same pair on the client side.
const cases = [
  { name: 'a stale client count cannot claim a shot that did not happen',
    server: 64, afterDraw: 64, client: 10, expect: false },
  { name: 'a real server-side decrease is counted as a shot',
    server: 64, afterDraw: 63, client: 10, expect: true },
  { name: 'an empty quiver refuses the draw',
    server: 0, afterDraw: 0, client: 10, expect: false, noDraw: true },
  { name: 'the client fallback is still reachable with no RCON',
    server: null, afterDraw: null, client: 64, clientAfter: 63, expect: true },
]

const rconSays = (n) => setCountAllOverride(async () => ({ total: n, inv: n, worn: null, offhand: 0 }))

try {
  for (const c of cases) {
    let clientArrows = c.client
    let drew = false
    const bot = {
      username: 'UwU',
      inventory: { items: quiver(() => clientArrows) },
      heldItem: { name: 'bow' },
      entity: { position: vec(0, 64, 0) },
      equip: async () => {}, lookAt: async () => {},
      activateItem: async () => { drew = true },
      deactivateItem: async () => {
        if (c.server === null) clientArrows = c.clientAfter
        else rconSays(c.afterDraw)
      },
      on: () => {},
    }
    if (c.server === null) setCountAllOverride(() => { throw new Error('rcon off') })
    else rconSays(c.server)

    const fired = await shootBow(bot, target, 1, true)
    // noDraw: an empty quiver must be refused BEFORE activateItem, not
    // attempted and silently missed.
    check(c.name, fired === c.expect && (!c.noDraw || !drew), `fired=${fired} drew=${drew}`)
  }
} finally {
  // Overrides are opt-in and must be cleared, or every later RCON read in the
  // process silently reports this fake number.
  setCountAllOverride(null)
  console.log('cleared the rcon override')
}

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)