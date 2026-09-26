#!/usr/bin/env python3
"""Idempotently fix the Complexity-ML 26.2 fork's two protocol bugs in node_modules.

Fixes (both required, both from pinning a fork whose minecraft-data was
version-bumped without bumping mineflayer's write code):

  8a  Write-shape drift  -> mineflayer lib writes OLD use_entity schema
  8b  Packet-ID drift    -> fork's 26.2/protocol.json serverbound table off-by-one

Run after ANY `npm install` (node_modules is volatile). Safe to re-run any
number of times: each fix is a guarded, idempotent string/JSON edit.

Usage:
    python3 fix-26.2-protocol.py              # fix the live node_modules
    python3 fix-26.2-protocol.py /some/base    # fix node_modules under /some/base
"""
import json
import os
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "node_modules")
DATA_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "minecraft-data-26.2")
DATA_SRC_263 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "minecraft-data-26.3")


def patch_protocol_json(path):
    """8b: restore spectate_entity + spectate, renumber everything after 0x3e."""
    p = json.load(open(path))
    ts = p["play"]["toServer"]
    types = ts["types"]
    mapper = types["packet"][1][0]["type"][1]["mappings"]
    fields = types["packet"][1][1]["type"][1]["fields"]

    already = mapper.get("0x3e") == "spectate_entity" and "spectate" in mapper.values()
    if already:
        print(f"[8b] {path}: already fixed (spectate split present) -> no-op")
        return False

    fix = {
        "0x3e": "spectate_entity",
        "0x3f": "arm_animation",
        "0x40": "spectate",
        "0x41": "test_instance_block_action",
        "0x42": "block_place",
        "0x43": "use_item",
        "0x44": "custom_click_action",
    }
    for k in list(mapper.keys()):
        if int(k, 16) >= 0x3E:
            del mapper[k]
    mapper.update(fix)

    fields.pop("spectator_action", None)
    fields["spectate_entity"] = "packet_spectate_entity"
    fields["spectate"] = "packet_spectate"

    types.pop("packet_spectator_action", None)
    types["packet_spectate_entity"] = ["container", [{"name": "entityId", "type": "varint"}]]
    types["packet_spectate"] = ["container", [{"name": "target", "type": "UUID"}]]

    json.dump(p, open(path, "w"), indent=2)
    print(f"[8b] {path}: FIXED serverbound table -> {len(mapper)} packets")
    return True


def patch_js(path, old, new, marker, label):
    src = open(path).read()
    if marker in src:
        print(f"[8a] {path} ({label}): already patched -> no-op")
        return False
    if old not in src:
        print(f"[8a] {path} ({label}): WARNING original text not found, skipped")
        return False
    open(path, "w").write(src.replace(old, new, 1))
    print(f"[8a] {path} ({label}): FIXED write shape")
    return True


# --- 8a entities.js: useEntity() ---
ENT_OLD = """  function useEntity (target, leftClick, x, y, z) {
    const sneaking = bot.getControlState('sneak')
    if (x && y && z) {
      bot._client.write('use_entity', {
        target: target.id,
        mouse: leftClick,
        x,
        y,
        z,
        sneaking
      })
    } else {
      bot._client.write('use_entity', {
        target: target.id,
        mouse: leftClick,
        sneaking
      })
    }
  }
"""

ENT_NEW = """  function useEntity (target, leftClick, x, y, z) {
    const sneaking = bot.getControlState('sneak')
    if (leftClick) {
      // 26.2 splits attack into its own packet (entityId only)
      bot._client.write('attack', { entityId: target.id })
    } else {
      const location = (x !== undefined && y !== undefined && z !== undefined)
        ? { x, y, z }
        : { x: 0, y: 0, z: 0 }
      bot._client.write('use_entity', {
        target: target.id,
        hand: 0,
        location,
        usingSecondaryAction: sneaking
      })
    }
  }
"""

# --- 8a entities.js: shared_flags key-0 fallback (elytra/crouch) ---
ENT_ELY_OLD = """      if (metas.shared_flags != null) {
        if (bot.supportFeature('hasElytraFlying')) {
          const elytraFlying = metas.shared_flags & 0x80
          setElytraFlyingState(entity, Boolean(elytraFlying))
        }

        if (metas.shared_flags & 2) {
          entity.crouching = true
          bot.emit('entityCrouch', entity)
        } else if (entity.crouching) { // prevent the initial entity_metadata packet from firing off an uncrouch event
          entity.crouching = false
          bot.emit('entityUncrouch', entity)
        }
      }
"""

ENT_ELY_NEW = """      // Fall back to the raw key-0 bitfield when the entity data lacks a name for
      // shared_flags (some forks omit metadataKeys). Fixes elytra/crouch detection.
      let sharedFlags = metas.shared_flags
      if (sharedFlags == null) {
        const bitField = packet.metadata.find(p => p.key === 0)
        if (bitField !== undefined) sharedFlags = bitField.value
      }
      if (sharedFlags != null) {
        if (bot.supportFeature('hasElytraFlying')) {
          const elytraFlying = sharedFlags & 0x80
          setElytraFlyingState(entity, Boolean(elytraFlying))
        }

        if (sharedFlags & 2) {
          entity.crouching = true
          bot.emit('entityCrouch', entity)
        } else if (entity.crouching) { // prevent the initial entity_metadata packet from firing off an uncrouch event
          entity.crouching = false
          bot.emit('entityUncrouch', entity)
        }
      }
"""

# --- 8a inventory.js: activateEntity() ---
INV_OLD = """  async function activateEntity (entity) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(entity.position.offset(0, 1, 0), false)
    bot._client.write('use_entity', {
      target: entity.id,
      mouse: 0, // interact with entity
      sneaking: false,
      hand: 0 // interact with the main hand
    })
  }
"""

INV_NEW = """  async function activateEntity (entity) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(entity.position.offset(0, 1, 0), false)
    bot._client.write('use_entity', {
      target: entity.id,
      hand: 0,
      location: { x: 0, y: 0, z: 0 },
      usingSecondaryAction: false
    })
  }
"""

# --- 8a inventory.js: activateEntityAt() ---
INV_AT_OLD = """  async function activateEntityAt (entity, position) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(position, false)
    bot._client.write('use_entity', {
      target: entity.id,
      mouse: 2, // interact with entity at
      sneaking: false,
      hand: 0, // interact with the main hand
      x: position.x - entity.position.x,
      y: position.y - entity.position.y,
      z: position.z - entity.position.z
    })
  }
"""

INV_AT_NEW = """  async function activateEntityAt (entity, position) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(position, false)
    bot._client.write('use_entity', {
      target: entity.id,
      hand: 0,
      location: { x: position.x - entity.position.x, y: position.y - entity.position.y, z: position.z - entity.position.z },
      usingSecondaryAction: false
    })
  }
"""

# --- 8a inventory.js: activateBlock() — force the look packet. The 26.2 server's
# reach/angle validation silently drops container-open (open_window never sent,
# windowOpen times out) unless the look is flushed BEFORE block_place. force=false
# defers the look to the next physics tick, racing the block_place write.
AB_OLD = """    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false)"""

AB_NEW = """    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)"""

# --- collectblock: auto-deposit discovers nearby chests instead of failing ---
# The collectBlock plugin only deposits into a pre-configured chestLocations list,
# which defaults EMPTY — so a full inventory always throws NoChests and the bot
# goes to craft/place a new chest even when a chest already sits nearby. Discover
# nearby chest/trapped_chest (32 blocks) so storage use is a natural routine.
COLINV_OLD = """        if (chestLocations.length === 0) {
            throw (0, Util_1.error)('NoChests', 'There are no defined chest locations!');
        }"""

COLINV_NEW = """        if (chestLocations.length === 0) {
            chestLocations = yield bot.findBlocks({ matching: (block) => block.name === 'chest' || block.name === 'trapped_chest', maxDistance: 32, count: 20 });
        }
        if (chestLocations.length === 0) {
            throw (0, Util_1.error)('NoChests', 'There are no defined chest locations!');
        }"""


def ensure_26_2_data(base):
    """Copy the bundled 26.2 game-data (19 files) into node_modules and register
    the '26.2' version block in minecraft-data's data.js. Idempotent."""
    dest = os.path.join(base, "minecraft-data", "minecraft-data", "data", "pc", "26.2")
    os.makedirs(dest, exist_ok=True)
    copied = 0
    for fn in os.listdir(DATA_SRC):
        if not fn.endswith(".json"):
            continue
        src = os.path.join(DATA_SRC, fn)
        dst = os.path.join(dest, fn)
        if not os.path.exists(dst) or os.path.getsize(src) != os.path.getsize(dst):
            open(dst, "wb").write(open(src, "rb").read())
            copied += 1
    print(f"[data] 26.2 game-data: {copied} copied, {len(os.listdir(dest))} present" if copied
          else f"[data] 26.2 game-data: all {len(os.listdir(dest))} present -> no-op")

    # Register '26.2' block in data.js (clone the '26.1' block).
    # NOTE: '26.1' is the LAST entry in the 'pc' object, so its block closes with
    # "    }" (NO trailing comma) — anchoring on "\n    }," grabs the wrong brace
    # and inserts the clone inside 'bedrock'. Anchor on the block's own close.
    data_js = os.path.join(base, "minecraft-data", "data.js")
    if not os.path.exists(data_js):
        print(f"[data.js] WARNING: {data_js} missing")
        return
    src = open(data_js).read()

    start = src.find("    '26.1': {")
    if start == -1:
        print("[data.js] WARNING: '26.1' block not found; cannot auto-register 26.2")
        return
    close = src.find("\n    }\n", start)   # '26.1' block's own close (no comma)
    if close == -1:
        print("[data.js] WARNING: '26.1' block close not found")
        return

    # Idempotency: done only if a '26.2' block sits inside 'pc' (before the "  },"
    # that closes 'pc' and opens 'bedrock'). A '26.2' string elsewhere is a stale
    # misplacement and must be repaired, not treated as a no-op.
    pc_close = src.find("\n  },\n  'bedrock': {", close)
    m2 = src.find("    '26.2': {")
    if m2 != -1 and (pc_close == -1 or m2 < pc_close):
        print("[data.js] '26.2' already registered in pc -> no-op")
        return

    block = src[start:close + len("\n    }\n")]
    block26 = block.replace("'26.1':", "'26.2':").replace("/pc/26.1/", "/pc/26.2/")

    # Defensively remove any misplaced '26.2' block before re-inserting.
    if m2 != -1:
        m2_close = src.find("\n    }\n", m2)
        if m2_close != -1:
            remove = m2_close + len("\n    }\n")
            if src[remove:remove + 1] == ",":
                remove += 1
            src = src[:m2] + src[remove:]
            start = src.find("    '26.1': {")
            close = src.find("\n    }\n", start)

    # Insert the clone right after '26.1' so it lands inside 'pc'.
    after26 = close + len("\n    }\n")
    src = src[:after26 - 1] + ",\n" + block26.rstrip("\n") + "\n" + src[after26:]
    open(data_js, "w").write(src)
    print("[data.js] registered '26.2' block (cloned from 26.1)")


def register_version_block(data_js, base_ver, new_ver):
    """Clone the base_ver block in a minecraft-data data.js as new_ver
    (paths /pc/<base>/ -> /pc/<new>/). Idempotent, repairs misplacements."""
    if not os.path.exists(data_js):
        print(f"[data.js] WARNING: {data_js} missing")
        return
    src = open(data_js).read()
    start = src.find(f"    '{base_ver}': {{")
    if start == -1:
        print(f"[data.js] WARNING: '{base_ver}' block not found in {data_js}")
        return
    close = src.find("\n    }\n", start)
    if close == -1:
        print(f"[data.js] WARNING: '{base_ver}' block close not found in {data_js}")
        return
    pc_close = src.find("\n  },\n  'bedrock': {", close)
    m2 = src.find(f"    '{new_ver}': {{")
    if m2 != -1 and (pc_close == -1 or m2 < pc_close):
        print(f"[data.js] '{new_ver}' already registered in {os.path.basename(os.path.dirname(data_js)) or data_js} -> no-op")
        return
    block = src[start:close + len("\n    }\n")]
    block_new = block.replace(f"'{base_ver}':", f"'{new_ver}':").replace(f"/pc/{base_ver}/", f"/pc/{new_ver}/")
    if m2 != -1:
        m2_close = src.find("\n    }\n", m2)
        if m2_close != -1:
            remove = m2_close + len("\n    }\n")
            if src[remove:remove + 1] == ",":
                remove += 1
            src = src[:m2] + src[remove:]
            start = src.find(f"    '{base_ver}': {{")
            close = src.find("\n    }\n", start)
    after = close + len("\n    }\n")
    src = src[:after - 1] + ",\n" + block_new.rstrip("\n") + "\n" + src[after:]
    open(data_js, "w").write(src)
    print(f"[data.js] registered '{new_ver}' block (cloned from {base_ver})")


def ensure_26_3_data(base):
    """Copy the bundled 26.3 game-data (19 files) into BOTH minecraft-data
    copies (top-level for mineflayer's registry, nested for
    minecraft-protocol's serialization), register the '26.3' version block in
    both data.js files + the nested protocolVersions.json row, and apply the
    8b packet-ID fix to both 26.3 protocol.json copies. Idempotent."""
    for dest in [
        os.path.join(base, "minecraft-data", "minecraft-data", "data", "pc", "26.3"),
        os.path.join(base, "minecraft-protocol", "node_modules", "minecraft-data",
                     "minecraft-data", "data", "pc", "26.3"),
    ]:
        os.makedirs(dest, exist_ok=True)
        copied = 0
        for fn in os.listdir(DATA_SRC_263):
            if not fn.endswith(".json"):
                continue
            src = os.path.join(DATA_SRC_263, fn)
            dst = os.path.join(dest, fn)
            if not os.path.exists(dst) or os.path.getsize(src) != os.path.getsize(dst):
                with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
                    fdst.write(fsrc.read())
                copied += 1
        print(f"[data] 26.3 game-data -> {dest}: {copied} copied, {len(os.listdir(dest))} present"
              if copied else f"[data] 26.3 game-data -> {dest}: all {len(os.listdir(dest))} present -> no-op")
    for data_js in [
        os.path.join(base, "minecraft-data", "data.js"),
        os.path.join(base, "minecraft-protocol", "node_modules", "minecraft-data", "data.js"),
    ]:
        register_version_block(data_js, "26.2", "26.3")
    pv_path = os.path.join(base, "minecraft-protocol", "node_modules", "minecraft-data",
                           "minecraft-data", "data", "pc", "common", "protocolVersions.json")
    if os.path.exists(pv_path):
        d = json.load(open(pv_path))
        if not any(e.get("minecraftVersion") == "26.3" for e in d):
            d.insert(0, {"minecraftVersion": "26.3", "version": 777, "dataVersion": 5023,
                         "usesNetty": True, "majorVersion": "26.3", "releaseType": "release"})
            json.dump(d, open(pv_path, "w"), indent=2)
            print("[data] nested protocolVersions.json: 26.3 row inserted")
        else:
            print("[data] nested protocolVersions.json: 26.3 row present -> no-op")
    for proto in [
        os.path.join(base, "minecraft-data", "minecraft-data", "data", "pc", "26.3", "protocol.json"),
        os.path.join(base, "minecraft-protocol", "node_modules", "minecraft-data",
                     "minecraft-data", "data", "pc", "26.3", "protocol.json"),
    ]:
        if os.path.exists(proto):
            patch_protocol_json(proto)
        else:
            print(f"[8b] WARNING: {proto} missing")


def ensure_chunk_26_3(base):
    """Register 26.3 -> 1.18 chunk impl (same wire format + 26.2 fluid-count
    short) in prismarine-chunk. Idempotent."""
    for cj in [os.path.join(base, "prismarine-chunk", "src", "index.js")]:
        if not os.path.exists(cj):
            print(f"[chunk] WARNING: {cj} missing")
            continue
        s = open(cj).read()
        if "26.3:" in s:
            print("[chunk] 26.3 impl present -> no-op")
            continue
        old = "    26.2: require('./pc/1.18/chunk')"
        if old not in s:
            print("[chunk] WARNING: 26.2 anchor not found")
            continue
        open(cj, "w").write(s.replace(old, old + ",\n    26.3: require('./pc/1.18/chunk')", 1))
        print("[chunk] registered 26.3 -> 1.18 impl")
    cc = os.path.join(base, "prismarine-chunk", "src", "pc", "1.18", "ChunkColumn.js")
    if os.path.exists(cc):
        s = open(cc).read()
        old = "  const hasFluidCount = mcData.version.majorVersion === '26.2'"
        if old in s:
            open(cc, "w").write(s.replace(old, old + " || mcData.version.majorVersion === '26.3'", 1))
            print("[chunk] 1.18 ChunkColumn: hasFluidCount extended to 26.3")
        elif "'26.3'" in s:
            print("[chunk] 1.18 ChunkColumn: 26.3 already present -> no-op")
        else:
            print("[chunk] WARNING: hasFluidCount anchor not found")


def ensure_physics_fallback(base):
    """Default liquid gravity when fork data has no gravity feature flags
    (verified: indep+prop false on 26.2/26.3/upstream 1.21.x) — vanilla
    proportional values instead of a login crash. Idempotent."""
    pj = os.path.join(base, "prismarine-physics", "index.js")
    if not os.path.exists(pj):
        print(f"[physics] WARNING: {pj} missing")
        return
    s = open(pj).read()
    marker = "Default to vanilla proportional values"
    if marker in s:
        print("[physics] liquid-gravity fallback present -> no-op")
        return
    old = "    throw new Error('No liquid gravity settings, have you made sure the liquid gravity features are up to date?')"
    if old not in s:
        print("[physics] WARNING: gravity anchor not found")
        return
    new = ("    // 26.3 fork data has no liquid-gravity feature flags at all (verified:\n"
           "    // both indep+prop false on 26.2 AND 26.3 AND upstream 1.21.x data) yet the\n"
           "    // server physics is vanilla water. Default to vanilla proportional values\n"
           "    // instead of crashing the bot at login.\n"
           "    physics.waterGravity = physics.gravity / 16\n"
           "    physics.lavaGravity = physics.gravity / 4")
    open(pj, "w").write(s.replace(old, new, 1))
    print("[physics] liquid-gravity fallback installed")


def ensure_pathfinder_prs(base):
    """Adopt 8 upstream pathfinder PRs + 3 gated fixes (df0324e) into
    node_modules/mineflayer-pathfinder. Marker-idempotent per hunk: each
    patch applies only if its marker comment/code is absent, and skips with
    a warning if the anchor text moved (never blind-writes). Covers:
    #394 swim-up+shore (method+wiring+executor), #384 water plants, #393
    no-corner-cut, #392 overhead reach, #385 drop-to-feet, #386 revision
    guard, #369 heap+sentinel, #357 goto order (+else fix), #371 placing
    reset, #387 enchants w/ NBT fallback."""
    import re
    pf = os.path.join(base, "mineflayer-pathfinder")
    edits = [
        # (file, marker, old, new, label)
        ("lib/heap.js", "if (smallerChild < size) {",
         "      if (smallerChild < size - 1) {",
         "      if (smallerChild < size) {", "#369 heap sift-down bound"),
        ("lib/goals.js", "let max = -Infinity",
         "  heuristic (node) {\n    let max = Number.MIN_VALUE",
         "  heuristic (node) {\n    // -Infinity is the correct identity for max-reduction (MIN_VALUE is +5e-324, wrongly clamps negative GoalInvert heuristics to 0).\n    let max = -Infinity", "#369 GoalCompositeAll sentinel"),
        ("lib/goals.js", "Measure reach from eyes to each visible face",
         "  isEnd (node) {\n    if (node.distanceTo(this.pos.offset(0, this.entityHeight, 0)) > this.reach) return false",
         "  isEnd (node) {\n    // Measure reach from eyes to each visible face (not feet-to-center-shifted), so overhead blocks within range aren't wrongly rejected.\n    const startPos = new Vec3(node.x + 0.5, node.y + this.entityHeight, node.z + 0.5)",
         "#392 overhead reach (1/2: hoist startPos, drop feet check)"),
        ("lib/goals.js", "if (startPos.distanceTo(targetPos) > this.reach) continue",
         "      const startPos = new Vec3(node.x + 0.5, node.y + this.entityHeight, node.z + 0.5)\n      const rayPos",
         "      if (startPos.distanceTo(targetPos) > this.reach) continue\n      const rayPos",
         "#392 overhead reach (2/2: per-face range gate)"),
        ("lib/goto.js", "} else if (results.path.length === 0) {",
         "    function noPathListener (results) {\n      if (results.path.length === 0) {\n        cleanup()\n      } else if (results.status === 'noPath') {",
         "    function noPathListener (results) {\n      if (results.status === 'noPath') {",
         "#357 goto noPath-first (1/2)"),
        ("lib/goto.js", "} else if (results.status === 'timeout') {\n        cleanup(error('Timeout', 'Took to long to decide path to goal!'))\n      } else if (results.path.length === 0) {",
         "} else if (results.status === 'noPath') {",
         "} else if (results.status === 'noPath') {",
         "#357 noop guard (structure check)"),
        ("lib/movements.js", "if (node.y - (blockLand.position.y + 1) <= this.maxDropDown)",
         "        if (node.y - blockLand.position.y <= this.maxDropDown) return this.getBlock(blockLand.position, 0, 1, 0)",
         "        // Measure drop to landing FEET (support top), not support base — else legal 1-block stairs are rejected at maxDropDown=1.\n        if (node.y - (blockLand.position.y + 1) <= this.maxDropDown) return this.getBlock(blockLand.position, 0, 1, 0)",
         "#385 drop-to-feet"),
        ("lib/movements.js", "if (y === 1) return",
         "    const blockC = this.getBlock(node, dir.x, 0, dir.z) // Landing block or standing on block when jumping up by 1\n    const y = blockC.physical ? 1 : 0\n\n    const block0",
         "    const blockC = this.getBlock(node, dir.x, 0, dir.z) // Landing block or standing on block when jumping up by 1\n    const y = blockC.physical ? 1 : 0\n    // A diagonal jump clips the corner of the raised block — route raised landings via a cardinal jump head-on instead.\n    if (y === 1) return\n\n    const block0",
         "#393 raised-diagonal guard"),
        ("lib/movements.js", "if (!blockB1.safe || !blockC1.safe) return",
         "    const blockD1 = this.getBlock(node, 0, y - 1, dir.z)\n    cost1 += this.safeOrBreak(blockB1, toBreak1)",
         "    const blockD1 = this.getBlock(node, 0, y - 1, dir.z)\n    if (!blockB1.safe || !blockC1.safe) return\n    cost1 += this.safeOrBreak(blockB1, toBreak1)",
         "#393 side-corridor guard (1/2)"),
        ("lib/movements.js", "if (!blockB2.safe || !blockC2.safe) return",
         "    const blockD2 = this.getBlock(node, dir.x, y - 1, 0)\n    cost2 += this.safeOrBreak(blockB2, toBreak2)",
         "    const blockD2 = this.getBlock(node, dir.x, y - 1, 0)\n    if (!blockB2.safe || !blockC2.safe) return\n    cost2 += this.safeOrBreak(blockB2, toBreak2)",
         "#393 side-corridor guard (2/2)"),
        ("lib/movements.js", "this.getMoveWaterExit(node, neighbors)",
         "    this.getMoveDown(node, neighbors)\n    this.getMoveUp(node, neighbors)\n\n    // Enhanced climbing moves",
         "    this.getMoveDown(node, neighbors)\n    this.getMoveUp(node, neighbors)\n    this.getMoveWaterExit(node, neighbors)\n\n    // Enhanced climbing moves",
         "#394 wire water-exit into move list"),
        ("index.js", "let pathRevision = 0",
         "  let path = []\n  let pathUpdated = false",
         "  let path = []\n  let pathRevision = 0 // bumped on every reset/stop so stale path_update results are discarded, not installed\n  let pathUpdated = false",
         "#386 revision counter decl"),
        ("index.js", "const enchants = tool?.enchants ??",
         "      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []",
         "      // Component API first (1.20.5+; legacy NBT second) so Efficiency etc. rank correctly.\n      const enchants = tool?.enchants ?? ((tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : [])",
         "#387 enchants via component API"),
        ("index.js", "Math.abs(dy) < (bot.entity.isInWater && dy > 0 ? 0.25 : 1)",
         "    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1",
         "    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < (bot.entity.isInWater && dy > 0 ? 0.25 : 1)",
         "#394 in-water arrival 0.25"),
        ("index.js", "Swim straight up when the next node is directly above",
         "    if (bot.entity.isInWater) {\n      bot.setControlState('jump', true)",
         "    if (bot.entity.isInWater) {\n      // Swim straight up when the next node is directly above (water-exit ascent) — forward would fight the column.\n      if (Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35) bot.setControlState('forward', false)\n      bot.setControlState('jump', true)",
         "#394 forward-off on vertical ascent"),
        ("index.js", "A useOne is the whole of this node's work",
         "          placingBlock = nextPoint.toPlace.shift()\n          if (!placingBlock) {\n            placing = false\n          }",
         "          placingBlock = nextPoint.toPlace.shift()\n          if (!placingBlock) {\n            // A useOne is the whole of this node's work — without this the next tick falls through to scaffolding with nothing to place.\n            placing = false\n            lastNodeTime = performance.now()\n          }",
         "#371 placing reset + lastNodeTime"),
    ]
    # #386 multi-site guard: handled as one block (decl above + 4 sites)
    rev_sites = [
        ("    pathRevision++\n    if (!stopPathing", "  function resetPath (reason, clearStates = true) {\n    if (!stopPathing", "  function resetPath (reason, clearStates = true) {\n    pathRevision++\n    if (!stopPathing", "resetPath bump"),
        ("    pathRevision++\n    stopPathing = false", "  function stop () {\n    stopPathing = false", "  function stop () {\n    pathRevision++\n    stopPathing = false", "stop() bump"),
        ("const revision = pathRevision\n      bot.emit('path_update', results)\n      if (revision !== pathRevision) return // a listener reset the goal/movements mid-tick — drop the stale path\n      path = results.path\n      astartTimedout = results.status === 'partial'\n    }\n\n    if (bot.pathfinder.LOSWhenPlacingBlocks", "bot.emit('path_update', results)\n      path = results.path\n      astartTimedout = results.status === 'partial'\n    }\n\n    if (bot.pathfinder.LOSWhenPlacingBlocks",
         "bot.emit('path_update', results)\n      path = results.path\n      astartTimedout = results.status === 'partial'\n    }\n\n    if (bot.pathfinder.LOSWhenPlacingBlocks",
         "#386 continued-search guard"),
        ("const revision = pathRevision\n          bot.emit('path_update', results)\n          if (revision !== pathRevision) return // a listener reset the goal/movements mid-tick — drop the stale path\n          path = results.path\n          astartTimedout = results.status === 'partial'\n          pathUpdated = true", "bot.emit('path_update', results)\n          path = results.path\n          astartTimedout = results.status === 'partial'\n          pathUpdated = true",
         "bot.emit('path_update', results)\n          path = results.path\n          astartTimedout = results.status === 'partial'\n          pathUpdated = true",
         "#386 fresh-search guard"),
    ]
    applied, skipped, warned = 0, 0, 0
    for rel, marker, old, new, label in edits:
        p = os.path.join(pf, rel)
        if not os.path.exists(p):
            print(f"[pf] WARNING: {rel} missing"); warned += 1; continue
        s = open(p).read()
        if marker in s:
            skipped += 1; continue
        if old not in s:
            print(f"[pf] WARNING: {label}: anchor moved, skipped"); warned += 1; continue
        open(p, "w").write(s.replace(old, new, 1))
        print(f"[pf] {label}: applied"); applied += 1
    for marker, old, new, label in rev_sites:
        p = os.path.join(pf, "index.js")
        s = open(p).read()
        if marker in s:
            skipped += 1; continue
        if old not in s:
            print(f"[pf] WARNING: {label}: anchor moved, skipped"); warned += 1; continue
        open(p, "w").write(s.replace(old, new, 1))
        print(f"[pf] {label}: applied"); applied += 1
    # #394 method body (large): apply only if absent
    mp = os.path.join(pf, "lib", "movements.js")
    s = open(mp).read()
    if "getMoveWaterExit (node, neighbors)" in s:
        skipped += 1
    else:
        anchor = "  // Jump up, down or forward over a 1 block gap"
        method = ("  // Swim up through water or climb out onto a shore block (#394)\n"
                  "  getMoveWaterExit (node, neighbors) {\n"
                  "    if (!this.getBlock(node, 0, 0, 0).liquid) return\n"
                  "    const above = this.getBlock(node, 0, 1, 0)\n"
                  "    if (above.physical || this.getBlock(node, 0, 2, 0).physical) return\n"
                  "    // Swimming upward needs no scaffolding, unlike the ordinary tower move.\n"
                  "    if (above.liquid) {\n"
                  "      neighbors.push(new Move(node.x, node.y + 1, node.z, node.remainingBlocks, 1 + this.liquidCost))\n"
                  "    }\n"
                  "    for (const dir of cardinalDirections) {\n"
                  "      const shore = this.getBlock(node, dir.x, 0, dir.z)\n"
                  "      if (!shore.physical || this.blocksToAvoid.has(shore.type)) continue\n"
                  "      const feet = this.getBlock(node, dir.x, 1, dir.z)\n"
                  "      const head = this.getBlock(node, dir.x, 2, dir.z)\n"
                  "      if (feet.liquid || head.liquid) continue\n"
                  "      const toBreak = []\n"
                  "      const cost = 2 + this.liquidCost + this.safeOrBreak(feet, toBreak) + this.safeOrBreak(head, toBreak)\n"
                  "      if (cost >= 100) continue\n"
                  "      neighbors.push(new Move(node.x + dir.x, node.y + 1, node.z + dir.z, node.remainingBlocks, cost, toBreak))\n"
                  "    }\n"
                  "  }\n\n")
        if anchor not in s:
            print("[pf] WARNING: #394 method anchor moved, skipped"); warned += 1
        else:
            open(mp, "w").write(s.replace(anchor, method + anchor, 1))
            print("[pf] #394 getMoveWaterExit method: applied"); applied += 1
    # #384 water-plant liquids (small, anchor on plain water add)
    if "bubble_column" in s:
        skipped += 1
    else:
        old = "    this.liquids.add(registry.blocksByName.lava.id)\n"
        new = (old + "    // Water-containing blocks that swim like water even though their ID is not water (#384)\n"
               "    for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']) {\n"
               "      if (registry.blocksByName[name]) this.liquids.add(registry.blocksByName[name].id)\n"
               "    }\n")
        s = open(mp).read()
        if old not in s:
            print("[pf] WARNING: #384 liquids anchor moved, skipped"); warned += 1
        else:
            open(mp, "w").write(s.replace(old, new, 1))
            print("[pf] #384 water-plant liquids: applied"); applied += 1
    print(f"[pf] done: {applied} applied, {skipped} already present, {warned} warnings")


def main():
    md26_2 = os.path.join(
        BASE, "minecraft-data", "minecraft-data", "data", "pc", "26.2", "protocol.json"
    )
    entities_js = os.path.join(BASE, "mineflayer", "lib", "plugins", "entities.js")
    inventory_js = os.path.join(BASE, "mineflayer", "lib", "plugins", "inventory.js")

    if not os.path.exists(BASE):
        print(f"BASE not found: {BASE}")
        sys.exit(1)

    # 0. Data + version registration (run before the protocol-ID fix, which
    #    lives inside that same protocol.json)
    ensure_26_2_data(BASE)

    if os.path.exists(md26_2):
        patch_protocol_json(md26_2)
    else:
        print(f"[8b] WARNING: {md26_2} missing (is the 26.2 data copied? see playbook section 3)")

    # 8b MUST also be applied to the NESTED minecraft-data copy that
    # minecraft-protocol actually resolves (node_modules/minecraft-protocol/
    # node_modules/minecraft-data). The top-level copy above feeds mineflayer's
    # registry (blocks/items), but packet *serialization* goes through the fork's
    # nested copy. Without this, block_place/use_item stay at 0x41/0x42 and the
    # vanilla server rejects them with "Failed to decode packet use_item_on".
    nested_md26_2 = os.path.join(
        BASE, "minecraft-protocol", "node_modules", "minecraft-data",
        "minecraft-data", "data", "pc", "26.2", "protocol.json",
    )
    if os.path.exists(nested_md26_2):
        patch_protocol_json(nested_md26_2)
    else:
        # Nested copy may be hoisted (npm dedupe); try the top-level path of the fork's data.
        print(f"[8b] INFO: nested fork data not present at {nested_md26_2} (hoisted? skipping; "
              f"serialization already uses top-level in that case)")

    if os.path.exists(entities_js):
        patch_js(entities_js, ENT_OLD, ENT_NEW, "26.2 splits attack into its own packet", "useEntity")
        patch_js(entities_js, ENT_ELY_OLD, ENT_ELY_NEW, "key-0 bitfield", "elytra shared_flags fallback")
    else:
        print(f"[8a] WARNING: {entities_js} missing")

    if os.path.exists(inventory_js):
        patch_js(inventory_js, INV_OLD, INV_NEW, "usingSecondaryAction: false", "activateEntity")
        patch_js(inventory_js, INV_AT_OLD, INV_AT_NEW, "hand: 0,\n      location: { x: position", "activateEntityAt")
        patch_js(inventory_js, AB_OLD, AB_NEW, "lookAt(block.position.offset(0.5, 0.5, 0.5), true)", "activateBlock lookAt force")
    else:
        print(f"[8a] WARNING: {inventory_js} missing")

    collectblock_inv = os.path.join(BASE, "mineflayer-collectblock", "lib", "Inventory.js")
    if os.path.exists(collectblock_inv):
        patch_js(collectblock_inv, COLINV_OLD, COLINV_NEW, "bot.findBlocks({ matching: (block) => block.name === 'chest'", "collectblock auto-deposit discover chests")
    else:
        print(f"[8a] WARNING: {collectblock_inv} missing")

    # 1. 26.3 game-data + registration + 8b (both data copies)
    if os.path.isdir(DATA_SRC_263):
        ensure_26_3_data(BASE)
    else:
        print(f"[data] WARNING: {DATA_SRC_263} missing (26.3 assets not present?)")

    # 2. chunk impl + fluid-count + physics fallback
    ensure_chunk_26_3(BASE)
    ensure_physics_fallback(BASE)

    # 3. upstream pathfinder PRs (idempotent — no-op when already present)
    ensure_pathfinder_prs(BASE)

    print("done.")


if __name__ == "__main__":
    main()