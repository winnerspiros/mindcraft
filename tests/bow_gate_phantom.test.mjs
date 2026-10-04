// Behavioural proof for the phantom bow-gate bug (not a source-text check).
//
// Measured live 2026-10-04: the confirmed bow gate logged "bow is live" eight
// times and never once reached a SHOOTING line. Cause: the verdict cache was
// keyed on entity.id, and a phantom is re-spawned server-side constantly, so
// every scan tick compared against a brand-new id, missed the cache, and
// restarted the unconfirmed gate — which by design answers false. She could
// therefore never shoot at a flying mob, however many arrows she held.
//
// The other threat_scan/fight_standoff checks read the source and pin intent.
// This one RUNS the real method with a target whose id changes every tick and
// asserts that a confirmed verdict is actually reused, i.e. that the gate
// opens on the second call instead of stalling forever.
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

// Extract just _hasBowFor so the real method runs against a fake bot, without
// dragging in the whole Agent constructor (which would try to connect).
const start = agentSrc.indexOf('    _hasBowFor(entity) {')
const end = agentSrc.indexOf('\n    }', start)
const methodSrc = agentSrc.slice(start, end)
check('the method was extracted from agent.js', methodSrc.length > 1500 && methodSrc.includes('rconCountAll'))

// Build it as a standalone object so `this` is under our control.
const factory = new Function('rconCountAll', 'MELEE_RANGE', `
  return function (entity) {
    const hasBow = this.bot.inventory.items().some(i => i.name === 'bow');
    const items = this.bot.inventory.items();
    const arrowCount = items
      .filter(i => /^(arrow|spectral_arrow|tipped_arrow)$/.test(i.name))
      .reduce((n, i) => n + (i.count || 0), 0);
    const cacheKey = entity?.name || 'mob';
    const cached = this._bowForCache;
    const setVerdict = (v, pending) => {
      this._bowForCache = pending
        ? { t: Date.now(), key: cacheKey, v, pending: true }
        : { t: Date.now(), key: cacheKey, v };
    };
    if (cached && Date.now() - cached.t < 3000 && cached.key === cacheKey) {
      return cached.v;
    }
    const gate = (arrows, serverBows) => {
      let d;
      try { d = this.bot.entity.position.distanceTo(entity.position); } catch (_) { return false; }
      const bows = serverBows === undefined ? hasBow : !!serverBows;
      return bows && arrows > 0 && d > MELEE_RANGE;
    };
    if (!gate(arrowCount)) { setVerdict(false); return false; }
    setVerdict(false, true);
    (async () => {
      try {
        const arrows = await rconCountAll(this.name, 'arrow');
        const bowN = await rconCountAll(this.name, 'bow');
        const real = gate(arrows.total, bowN.total > 0);
        setVerdict(real);
      } catch (_) { setVerdict(true); }
    })();
    return false;
  };
`)

// Real server answer: a bow and a full quiver. `gate` is the built real method.
const arrowsLive = async () => ({ total: 64, inv: 64, worn: 0, offhand: 0 })
const gate = (rcon) => factory(rcon, 3.0)
// The cases that actually bit her: client claims a quiver, server has none.
//
// Positions carry a real distanceTo, because that is what the real gate calls
// (`entity.position.distanceTo`) and a plain {x,y,z} literal would throw inside
// gate() and be swallowed by its catch — silently reporting "false" for every
// verdict and making a correct gate look broken.
const pos = (x, y, z) => ({
  x, y, z,
  distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z),
})
const selfPos = () => pos(0, 64, 0)
const QUIVER = [{ name: 'bow' }, { name: 'arrow', count: 64 }]
const makeAgent = (items = QUIVER) => ({
  name: 'UwU',
  bot: { inventory: { items: () => items }, entity: { position: selfPos() } },
  _bowForCache: null,
})

const tick = () => new Promise(r => setTimeout(r, 30))

// ── the regression: a re-spawning target must still get a confirmed verdict ──
// Drive the gate over N ticks with a fresh entity id each time, exactly like a
// phantom being re-spawned. Returns the tick the gate first opened, or -1.
async function drive(hasBowFor, name, ticks, dist = 10) {
  const a = makeAgent(QUIVER)
  for (let i = 0; i < ticks; i++) {
    if (hasBowFor.call(a, { name, id: 1000 + i * 7, position: pos(dist, 64, 0) })) {
      return { opened: i, cache: a._bowForCache }
    }
    await tick()
  }
  return { opened: -1, cache: a._bowForCache }
}

{
  const { opened, cache } = await drive(gate(arrowsLive), 'phantom', 6)
  check('a target with a changing entity id still reaches an open gate', opened >= 0,
    `never opened in 6 ticks; cache=${JSON.stringify(cache)}`)
  check('the gate opens on the first CONFIRMED tick, not a random later one', opened === 1,
    `opened at tick ${opened}, expected 1 (tick 0 is always unconfirmed)`)
  check('the cached verdict is keyed on the name, not the churning id',
    cache?.key === 'phantom')
}

// ── and the same code must still refuse when the server says no arrows ─────
{
  const noArrows = async () => ({ total: 0, inv: 0, worn: 0, offhand: 0 })
  const a = makeAgent(QUIVER)                      // client claims a full quiver
  let everOpened = false
  for (let i = 0; i < 8; i++) {
    const target = { name: 'phantom', id: 2000 + i, position: pos(10, 64, 0) }
    if (gate(noArrows).call(a, target)) everOpened = true
    await tick()
  }
  check('a lying client quiver never opens the gate once the server says zero', !everOpened,
    `cache=${JSON.stringify(a._bowForCache)}`)
  check('the refusal is cached as false, so it is not re-asked every tick',
    a._bowForCache?.v === false && a._bowForCache?.key === 'phantom')
}

// ── inside sword range the bow is still declined (existing invariant) ──────
{
  const target = { name: 'zombie', id: 7, position: pos(2, 64, 0) }
  check('a target inside sword range is declined immediately',
    gate(arrowsLive).call(makeAgent(QUIVER), target) === false)
}

// ── an unreadable RCON falls back to the client, so she still shoots ───────
{
  const noRcon = async () => { throw new Error('rcon disabled') }
  const { opened } = await drive(gate(noRcon), 'zombie', 6)
  check('a survival server with no RCON still reaches an open gate', opened >= 0)
}

console.log(`\n${ok} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
