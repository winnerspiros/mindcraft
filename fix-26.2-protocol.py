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

    if os.path.exists(entities_js):
        patch_js(entities_js, ENT_OLD, ENT_NEW, "26.2 splits attack into its own packet", "useEntity")
    else:
        print(f"[8a] WARNING: {entities_js} missing")

    if os.path.exists(inventory_js):
        patch_js(inventory_js, INV_OLD, INV_NEW, "usingSecondaryAction: false", "activateEntity")
        patch_js(inventory_js, INV_AT_OLD, INV_AT_NEW, "hand: 0,\n      location: { x: position", "activateEntityAt")
    else:
        print(f"[8a] WARNING: {inventory_js} missing")

    print("done.")


if __name__ == "__main__":
    main()