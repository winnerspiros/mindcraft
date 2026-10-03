// Regression: 26.3 shifted ServerboundPlayerActionPacket$Action, so the literal
// `status: 5` mineflayer sent to release a bow was DROP_ITEM, not
// RELEASE_USE_ITEM.
//
// Verified against the server jar we actually run
// (/home/ubuntu/kenoi-fabric/versions/26.3/server-26.3.jar),
// ServerboundPlayerActionPacket$Action.<clinit>:
//
//   0 START_DESTROY_BLOCK   1 CHANGE_DESTROY_DIRECTION  2 ABORT_DESTROY_BLOCK
//   3 STOP_DESTROY_BLOCK    4 DROP_ALL_ITEMS            5 DROP_ITEM
//   6 RELEASE_USE_ITEM      7 SWAP_ITEM_WITH_OFFHAND    8 STAB
//
// Symptom: the draw was accepted (use_item went out, arrows satisfied
// BowItem.use -> startUsingItem) but the release dropped the held item instead
// of loosing the arrow. Arrows never left the bow, no projectile ever spawned,
// and shootBow still reported fired=true because it only checked that the bow
// was still in hand.
//
// This asserts against the shipped files, so a lost patch fails here.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const INVENTORY = readFileSync(
  new URL('../node_modules/mineflayer/lib/plugins/inventory.js', import.meta.url),
  'utf8'
)
const SKILLS = readFileSync(
  new URL('../src/agent/library/skills.js', import.meta.url),
  'utf8'
)

// The enum, transcribed from the jar's <clinit> with each ordinal's bytecode
// argument. REUSE_DIG_STATUS is the already-fixed ordinal set; RELEASE joins it.
const ACTION = {
  START_DESTROY_BLOCK: 0,
  CHANGE_DESTROY_DIRECTION: 1,
  ABORT_DESTROY_BLOCK: 2,
  STOP_DESTROY_BLOCK: 3,
  DROP_ALL_ITEMS: 4,
  DROP_ITEM: 5,
  RELEASE_USE_ITEM: 6,
  SWAP_ITEM_WITH_OFFHAND: 7,
  STAB: 8
}

function deactivateItemBody () {
  const start = INVENTORY.indexOf('function deactivateItem ()')
  assert.ok(start >= 0, 'deactivateItem missing from inventory.js')
  let depth = 0
  for (let j = INVENTORY.indexOf('{', start); j < INVENTORY.length; j++) {
    if (INVENTORY[j] === '{') depth++
    else if (INVENTORY[j] === '}') {
      depth--
      if (depth === 0) return INVENTORY.slice(start, j + 1)
    }
  }
  throw new Error('unterminated deactivateItem')
}

test('deactivateItem releases with RELEASE_USE_ITEM (6), not DROP_ITEM (5)', () => {
  const body = deactivateItemBody()
  const m = body.match(/status:\s*(\d+)/)
  assert.ok(m, 'deactivateItem must set an explicit status ordinal')
  const sent = Number(m[1])
  assert.strictEqual(
    sent, ACTION.RELEASE_USE_ITEM,
    `release sends status ${sent}; 26.3 needs ${ACTION.RELEASE_USE_ITEM} (RELEASE_USE_ITEM). ` +
    `${ACTION.DROP_ITEM} is DROP_ITEM and silently drops the held item instead of firing.`
  )
  assert.notStrictEqual(sent, ACTION.DROP_ITEM)
})

test('the ordinals we depend on match the jar', () => {
  // Guards against the transcription drifting from the bytecode.
  assert.strictEqual(ACTION.RELEASE_USE_ITEM, 6)
  assert.strictEqual(ACTION.DROP_ITEM, 5)
  assert.strictEqual(ACTION.STOP_DESTROY_BLOCK, 3)
  assert.strictEqual(ACTION.ABORT_DESTROY_BLOCK, 2)
})

test('the release ordinal is documented, not a bare literal', () => {
  const body = deactivateItemBody()
  // Only the comment block attached to deactivateItem counts. RELEASE_USE_ITEM
  // and DROP_ITEM appear elsewhere in inventory.js for unrelated reasons, so a
  // whole-file contains() check would pass even with this comment deleted - the
  // exact silent-failure shape this test exists to prevent.
  const start = body.indexOf('function deactivateItem')
  const block = body.slice(start)
  const comments = block.split('\n').filter(l => l.trim().startsWith('//'))
  assert.ok(comments.length >= 8,
    `expected an explanatory comment block, found ${comments.length} comment lines`)
  const text = comments.join('\n')
  for (const name of ['RELEASE_USE_ITEM', 'DROP_ITEM', 'STOP_DESTROY_BLOCK', 'START_DESTROY_BLOCK']) {
    assert.ok(text.includes(name),
      `${name} must be named in deactivateItem's own comment so the next enum ` +
      'shift is obvious from the file alone')
  }
  // The trap must be named WITH its wrong ordinal, or the note is not actionable.
  assert.ok(/5 DROP_ITEM/.test(text),
    'must name DROP_ITEM next to its ordinal 5 - that is the value we wrongly sent')
  assert.ok(/6 RELEASE_USE_ITEM/.test(text),
    'must name RELEASE_USE_ITEM next to its ordinal 6')
})

test('shootBow counts a shot only when an arrow is actually consumed', () => {
  const start = SKILLS.indexOf('export async function shootBow')
  assert.ok(start >= 0, 'shootBow missing')
  const end = SKILLS.indexOf('\nexport ', start + 10)
  const body = SKILLS.slice(start, end > 0 ? end : start + 9000)
  // Holding the bow afterwards is not evidence a projectile was loosed.
  assert.ok(!/if \(bot\.heldItem && bot\.heldItem\.name === 'bow'\) fired\+\+/.test(body),
    'must not infer a shot from the bow still being held')
  assert.ok(/const spent =/.test(body) && /arrowsAfter < arrowsBefore/.test(body),
    'must gate fired++ on the arrow stack decreasing')
})

test('hawkeyeShot also reports a real shot, not an unconditional true', () => {
  const start = SKILLS.indexOf('export async function hawkeyeShot')
  assert.ok(start >= 0, 'hawkeyeShot missing')
  const body = SKILLS.slice(start, start + 6000)
  // No "release then straight to `return true`" - that shape is the bug.
  assert.ok(
    !/deactivateItem\(\);\s*\}\s*catch[^\n]*\n\s*return true;/.test(body),
    'hawkeyeShot must not return true unconditionally straight after the release'
  )
  assert.ok(/Hawkeye: drew and released, but no arrow was consumed/.test(body),
    'hawkeyeShot must report an unconsumed arrow')
  assert.ok(/arrowsAfter < arrowsBefore/.test(body),
    'hawkeyeShot must gate its result on the arrow stack decreasing')
})

test('countArrows totals every arrow stack and distinguishes unknown from zero', () => {
  const start = SKILLS.indexOf('function countArrows(bot)')
  assert.ok(start >= 0, 'countArrows helper missing')
  const body = SKILLS.slice(start, start + 500)
  for (const t of ['arrow', 'spectral_arrow', 'tipped_arrow']) {
    assert.ok(body.includes(`'${t}'`), `must count ${t}`)
  }
  // "Unknown" must stay distinguishable from "no arrows": collapsing them makes
  // an unreadable inventory look like an empty one, and every shot is then
  // silently reported as not-fired.
  assert.ok(/catch[\s\S]*?return null/.test(body),
    'must return null in the catch so "unknown" != "no arrows"')
  assert.ok(!/catch[\s\S]*?return 0;/.test(body.slice(body.indexOf('catch'))),
    'must not collapse an unreadable inventory to 0')
})