// Regression: 26.3 moved the absolute position out of flat x/y/z fields and
// into a nested `position` field (PositionPath ->
// { typeId, steppedSteps: [{ position: {x,y,z}, tickOffset }] }).
//
// mineflayer's sync_entity_position handler read packet.x / packet.y /
// packet.z, which are undefined on 26.3. Vec3.set(undefined, ...) wrote
// nulls into the entity, position.distanceTo(...) became NaN, and
// assessThreats() discarded the mob -- so she could not see, track or fight
// anything last touched by that packet.
//
// This checks the shipped handler, not a copy of it, so it fails if the
// patch is ever dropped or reverted.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(
  new URL('../node_modules/mineflayer/lib/plugins/entities.js', import.meta.url),
  'utf8'
)

// Pull the real helper out of the plugin source so we test shipped behaviour.
function helper (name) {
  const start = SRC.indexOf('function ' + name)
  assert.ok(start >= 0, `${name} missing from entities.js - the 26.3 position fix was lost`)
  // Walk braces to find the end of the function.
  let depth = 0, i = SRC.indexOf('{', start)
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1) }
  }
  throw new Error('unterminated ' + name)
}

// The handler closes over `bot`, so supply the minimal surface it touches.
function evalHelper (name) {
  const bot = { supportFeature: () => false }
  // eslint-disable-next-line no-new-func
  return new Function('bot', helper(name) + '; return ' + name)(bot)
}

test('absolutePositionOf: the fix is present in shipped mineflayer', () => {
  assert.ok(SRC.includes('absolutePositionOf'), 'helper must exist')
})

test('absolutePositionOf: reads 26.3 nested PositionPath', () => {
  const f = evalHelper('absolutePositionOf')
  const p = {
    entityId: 7,
    position: { typeId: 0, steppedSteps: [{ position: { x: 100.5, y: 64, z: -20.25 }, tickOffset: 0 }] },
    yaw: 1, pitch: 0, onGround: true
  }
  const r = f(p)
  assert.deepStrictEqual(r, { x: 100.5, y: 64, z: -20.25 })
})

test('absolutePositionOf: picks the LAST step when several are batched', () => {
  const f = evalHelper('absolutePositionOf')
  const p = {
    position: {
      typeId: 0,
      steppedSteps: [
        { position: { x: 1, y: 2, z: 3 }, tickOffset: 0 },
        { position: { x: 10, y: 20, z: 30 }, tickOffset: 1 }
      ]
    }
  }
  assert.deepStrictEqual(f(p), { x: 10, y: 20, z: 30 })
})

test('absolutePositionOf: still handles legacy flat x/y/z', () => {
  const f = evalHelper('absolutePositionOf')
  const r = f({ x: 5, y: 6, z: 7 })
  assert.deepStrictEqual(r, { x: 5, y: 6, z: 7 })
})

test('absolutePositionOf: returns null rather than NaN coords', () => {
  const f = evalHelper('absolutePositionOf')
  // The exact failure mode: undefined flat fields and no nested position.
  assert.strictEqual(f({ entityId: 1, yaw: 0, pitch: 0 }), null)
  assert.strictEqual(f({ x: undefined, y: undefined, z: undefined }), null)
  assert.strictEqual(f({ position: { steppedSteps: [] } }), null)
  assert.strictEqual(f({ position: { typeId: 0 } }), null)
})

test('sync_entity_position never writes nulls into entity.position', () => {
  // The handler must guard its assignment, otherwise a malformed packet
  // re-introduces {x:null,y:null,z:null} and NaN distances.
  let h = SRC.slice(SRC.indexOf("bot._client.on('sync_entity_position'"))
  h = h.slice(0, h.indexOf('})') + 2)
  assert.ok(/const abs = absolutePositionOf\(packet\)/.test(h), 'must compute abs')
  assert.ok(/if \(abs\) entity\.position\.set\(/.test(h), 'must guard the set()')
  assert.ok(!/entity\.position\.set\(packet\.x, packet\.y, packet\.z\)/.test(h),
    'must not read flat packet.x/y/z unguarded')
  // 26.3 dropped dx/dy/dz from this packet. Applying them unconditionally
  // would write undefined velocities, so the guard must be present.
  assert.ok(/if \(packet\.dx !== undefined\)/.test(h),
    'must guard velocity: 26.3 sends no dx/dy/dz here')
})
