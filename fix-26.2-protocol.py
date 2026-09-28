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
    # SlotComponent bytecode-order lock (2026-09-27): the 26.3 server jar's
    # DataComponents class defines 122 types in registration order (javap -c
    # putstatic sequence = registry order; the shipped 26.3 mapper was
    # alpha-sorted, wrong). /tmp/true122.txt holds the bytecode order; force
    # mapper to it and drop any switch orphans so mapper==switch==122.
    try:
        ref = json.load(open(DATA_SRC_263 + "/protocol.json"))
        seq = [l.strip() for l in open("/tmp/true122.txt") if l.strip()]
        ref_map = {str(n): v for n, v in enumerate(seq)}
        ref_sw = ref["types"]["SlotComponent"][1][1]["type"][1]["fields"]
        for proto in [
            os.path.join(base, "minecraft-data", "minecraft-data", "data", "pc", "26.3", "protocol.json"),
            os.path.join(base, "minecraft-protocol", "node_modules", "minecraft-data",
                         "minecraft-data", "data", "pc", "26.3", "protocol.json"),
        ]:
            try:
                dd = json.load(open(proto))
                dd["types"]["SlotComponentType"][1]["mappings"] = ref_map
                swf = dd["types"]["SlotComponent"][1][1]["type"][1]["fields"]
                for _o in list(swf.keys()):
                    if _o not in ref_sw:
                        swf.pop(_o, None)
                json.dump(dd, open(proto, "w"), indent=2)
                print("[slot122] " + proto.split("node_modules/")[-1] + ": mapper==switch==122 locked")
            except Exception as e:
                print("[slot122] WARNING: " + str(e))
    except Exception as e:
        print("[slot122] WARNING ref unreadable: " + str(e))
    # Advancements skip-blob (2026-09-27): the 26.3 advancement sync payload
    # (parent/rewards/criteria fields added vs 26.1 inline shape) cannot be
    # parsed without per-trigger Criterion codecs. Advancements are never read
    # by the bot, so parse reset flag and swallow the rest as restBuffer.
    # Verified live: 0 PartialReadErrors, spawn + 14 items intact. Idempotent.
    try:
        adv_skip = ['container', [
            {'name': 'reset', 'type': 'bool'},
            {'name': '_advPayload', 'type': 'restBuffer'}]]
        for proto in [
            os.path.join(base, 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.3', 'protocol.json'),
            os.path.join(base, 'minecraft-protocol', 'node_modules', 'minecraft-data',
                         'minecraft-data', 'data', 'pc', '26.3', 'protocol.json'),
        ]:
            try:
                dd = json.load(open(proto))
                ttc = dd['play']['toClient']['types']
                cur = json.dumps(ttc.get('packet_advancements'))
                if '_advPayload' not in cur:
                    ttc['packet_advancements'] = adv_skip
                    for _o in ['AdvEntry', 'AdvDisplay']:
                        ttc.pop(_o, None)
                    json.dump(dd, open(proto, 'w'), indent=2)
                    print('[advdef] ' + proto.split('node_modules/')[-1] + ': skip-blob adopted')
                else:
                    print('[advdef] ' + proto.split('node_modules/')[-1] + ': skip-blob present -> no-op')
            except Exception as e:
                print('[advdef] WARNING: ' + str(e))
    except Exception as e:
        print('[advdef] WARNING ref: ' + str(e))
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
    short) in the top-level prismarine-chunk (live bot chunks). The nested
    copy inside prismarine-provider-anvil already maps via a >= check, so it
    needs no row. Idempotent."""
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


def ensure_anvil_26_3(base):
    """Teach prismarine-provider-anvil's version->impl table the 26.x keys
    (26.1/26.2/26.3 -> 1.18 reader/writer: same section/palette format +
    26.2 fluid-count short, shared with the live bot's Complexity chunk).
    Needed for the offline region scout (read-only .mca scans of the live
    26.3 world). Idempotent: skips rows already present."""
    aj = os.path.join(base, "prismarine-provider-anvil", "src", "chunk.js")
    if not os.path.exists(aj):
        print(f"[anvil] WARNING: {aj} missing")
        return
    s = open(aj).read()
    anchor = "    1.21: () => require('./1.18/chunk')"
    if anchor not in s:
        print("[anvil] WARNING: 1.21 anchor not found")
        return
    added = 0
    for key in ["26.1", "26.2", "26.3"]:
        row = f"    {key}: () => require('./1.18/chunk')"
        if row in s:
            continue
        s = s.replace(anchor, anchor + ",\n" + row, 1)
        anchor = row
        added += 1
    if added:
        open(aj, "w").write(s)
        print(f"[anvil] 26.x rows added ({added}) -> 1.18 impl")
    else:
        print("[anvil] 26.x rows present -> no-op")
    # Top-level chunk redirect: the provider's nested prismarine-chunk 1.41.0
    # ends at 26.1, while the top-level Complexity chunk knows 26.3 -> 1.18
    # (registered by ensure_chunk_26_3 above). Point the require at it.
    ac = open(aj).read()
    old_req = "const PrismarineChunk = require('prismarine-chunk')"
    if old_req in ac:
        new_req = ("// 26.3: use the patched top-level Complexity prismarine-chunk\n"
                   "    // (26.3 -> 1.18 impl) instead of the nested 1.41.0 copy.\n"
                   "    const PrismarineChunk = require('/home/ubuntu/uwu-bot/node_modules/prismarine-chunk')")
        # keep the original line shape (no indent in stock file)
        new_req = new_req.replace("    //", "//").replace("    const", "const")
        open(aj, "w").write(ac.replace(old_req, new_req, 1))
        print("[anvil] chunk require redirected to top-level Complexity copy")
    elif "node_modules/prismarine-chunk" in ac:
        print("[anvil] chunk redirect present -> no-op")
    else:
        print("[anvil] WARNING: chunk require anchor not found")
    # fromNBT normalizer for 26.x world shapes (verified live r.0.0.mca):
    # bare section elements, bare-string + {id,properties} + {"":X} palette
    # entries, [hi,lo] longArray pairs, plain-array light. Without it,
    # load() dies at ChunkColumn e.Name.replace on every 26.3 chunk.
    # node_modules is git-ignored, so the canonical copy lives at
    # /home/ubuntu/anvil-118-chunk.norm.js — re-applied automatically.
    cj118 = os.path.join(base, "prismarine-provider-anvil", "src", "1.18", "chunk.js")
    norm_src = "/home/ubuntu/anvil-118-chunk.norm.js"
    if os.path.exists(cj118):
        c118 = open(cj118).read()
        if "const normEntry" in c118:
            print("[anvil] 1.18 fromNBT normalizer present -> no-op")
        elif os.path.exists(norm_src):
            import shutil
            shutil.copyfile(norm_src, cj118)
            print("[anvil] 1.18 normalizer re-applied from canonical backup")
        else:
            print("[anvil] WARNING: 1.18 normalizer missing and no backup found")
    else:
        print(f"[anvil] WARNING: {cj118} missing")
    # LIVE-CHUNK light guard (verified 17:16: 26.3 backfill decodes
    # update_light i64 masks as SignedBigInt-Arrays; fromLongArray indexes
    # [0]/[1] -> undefined -> Buffer.from throws ERR_INVALID_ARG_TYPE, which
    # mineflayer blocks.js re-emits as a FATAL error -> disconnect. Without
    # this, every update_light near her kills the connection.)
    # node_modules is git-ignored, so the canonical copy lives at
    # /home/ubuntu/chunkcolumn-118.stock.js + the guard is re-applied here.
    cc = os.path.join(base, "prismarine-chunk", "src", "pc", "1.18", "ChunkColumn.js")
    if os.path.exists(cc):
        c = open(cc).read()
        if "26.3 light-shape guard" in c:
            print("[chunk] 1.18 loadParsedLight guard present -> no-op")
        else:
            old = """    loadParsedLight (skyLight, blockLight, skyLightMask, blockLightMask, emptySkyLightMask, emptyBlockLightMask) {
      function readSection (sections, data, lightMask, pLightMask, emptyMask, pEmptyMask) {
        let currentSectionIndex = 0
        const incomingLightMask = BitArray.fromLongArray(pLightMask, 1)
        const incomingEmptyMask = BitArray.fromLongArray(pEmptyMask, 1)"""
            new = """    loadParsedLight (skyLight, blockLight, skyLightMask, blockLightMask, emptySkyLightMask, emptyBlockLightMask) {
      // 26.3 light-shape guard (verified live 17:16): the 26.3 backfill decodes
      // update_light's i64 masks as SignedBigInt-Arrays and light arrays as
      // plain nested arrays. fromLongArray indexes [0]/[1] (undefined on
      // BigInt) and Buffer.from(array) throws ERR_INVALID_ARG_TYPE, which
      // mineflayer's blocks.js re-emits as a fatal bot error -> disconnect.
      // Normalize: BigInt/signed-array mask entries -> [hi,lo] number pairs;
      // array light sections -> Buffer. Missing/short light data = stale
      // column, skip it (fail-open) instead of killing the connection.
      function normMask (m) {
        if (!Array.isArray(m)) return []
        return m.map(e => {
          if (Array.isArray(e)) return [Number(e[0]) | 0, Number(e[1]) | 0]
          if (typeof e === 'bigint') {
            const v = e < 0n ? (1n << 64n) + e : e
            return [Number((v >> 32n) & 0xffffffffn) | 0, Number(v & 0xffffffffn) | 0]
          }
          const n = Number(e)
          if (Number.isFinite(n)) return [0, n | 0]
          return [0, 0]
        })
      }
      function normLight (arr) {
        if (!Array.isArray(arr)) return []
        return arr.map(s => {
          if (Buffer.isBuffer(s)) return s
          if (Array.isArray(s)) { try { return Buffer.from(s) } catch (_) { return null } }
          return null
        })
      }
      skyLight = normLight(skyLight); blockLight = normLight(blockLight)
      skyLightMask = normMask(skyLightMask); blockLightMask = normMask(blockLightMask)
      emptySkyLightMask = normMask(emptySkyLightMask); emptyBlockLightMask = normMask(emptyBlockLightMask)
      function readSection (sections, data, lightMask, pLightMask, emptyMask, pEmptyMask) {
        let currentSectionIndex = 0
        const incomingLightMask = BitArray.fromLongArray(pLightMask, 1)
        const incomingEmptyMask = BitArray.fromLongArray(pEmptyMask, 1)"""
            old2 = """          if (!isEmpty) {
            const sectionReader = Buffer.from(data[currentSectionIndex++])
            bitArray.readBuffer(SmartBuffer.fromBuffer(sectionReader))
          }"""
            new2 = """          if (!isEmpty) {
            const raw = data[currentSectionIndex++]
            if (raw == null) continue // short light array: stale column, fail open
            const sectionReader = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
            bitArray.readBuffer(SmartBuffer.fromBuffer(sectionReader))
          }"""
            if old in c and old2 in c:
                c = c.replace(old, new, 1).replace(old2, new2, 1)
                open(cc, "w").write(c)
                print("[chunk] 1.18 loadParsedLight 26.3 guard installed")
            else:
                print("[chunk] WARNING: loadParsedLight anchors not found")
    else:
        print(f"[chunk] WARNING: {cc} missing")


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
    else:
        old = "    throw new Error('No liquid gravity settings, have you made sure the liquid gravity features are up to date?')"
        if old not in s:
            print("[physics] WARNING: gravity anchor not found")
        else:
            new = ("    // 26.3 fork data has no liquid-gravity feature flags at all (verified:\n"
                   "    // both indep+prop false on 26.2 AND 26.3 AND upstream 1.21.x data) yet the\n"
                   "    // server physics is vanilla water. Default to vanilla proportional values\n"
                   "    // instead of crashing the bot at login.\n"
                   "    physics.waterGravity = physics.gravity / 16\n"
                   "    physics.lavaGravity = physics.gravity / 4")
            open(pj, "w").write(s.replace(old, new, 1))
            s = open(pj).read()
            print("[physics] liquid-gravity fallback installed")
    ensure_mineflayer_move_diff(base)


def ensure_mineflayer_move_diff(base):
    """BOTCRAFT PORT (SendPosition minimal-diff): vanilla move threshold is
    (dpos)^2 > 4e-8 (~0.2mm) plus a 20-tick heartbeat. The 1mm deadband was
    ours; 0.2mm matches the real client. Marker-idempotent."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "physics.js")
    if not os.path.exists(mp):
        print(f"[movediff] WARNING: {mp} missing")
        return
    s = open(mp).read()
    marker = "BOTCRAFT PORT (SendPosition minimal-diff"
    if marker in s:
        print("[movediff] vanilla 4e-8 + heartbeat present -> no-op")
    else:
        old = ("    const dx = Math.abs((lastSent.x ?? position.x) - position.x)\n"
               "    const dy = Math.abs((lastSent.y ?? position.y) - position.y)\n"
               "    const dz = Math.abs((lastSent.z ?? position.z) - position.z)\n"
               "    const moved = (dx + dy + dz) > 0.001")
        if old not in s:
            print("[movediff] WARNING: deadband anchor not found")
            return
        new = ("    const dx = Math.abs((lastSent.x ?? position.x) - position.x)\n"
               "    const dy = Math.abs((lastSent.y ?? position.y) - position.y)\n"
               "    const dz = Math.abs((lastSent.z ?? position.z) - position.z)\n"
               "    // BOTCRAFT PORT (SendPosition minimal-diff: vanilla move threshold is\n"
               "    // (dpos)^2 > 4e-8 (~0.2mm); plus a 20-tick heartbeat so a silent client\n"
               "    // never looks dead to the server. 1mm deadband was ours; 0.2mm matches\n"
               "    // the real client and stops micro-move spam one level lower.\n"
               "    const _movedSq = dx * dx + dy * dy + dz * dz\n"
               "    bot._moveTickCount = (bot._moveTickCount || 0) + 1\n"
               "    const _heartbeat = bot._moveTickCount % 20 === 0\n"
               "    const moved = _movedSq > 4e-8 || _heartbeat")
        open(mp, "w").write(s.replace(old, new, 1))
        print("[movediff] vanilla 4e-8 + heartbeat installed")
        s = open(mp).read()
    ensure_mineflayer_wire_quiet(base)
    ensure_mineflayer_digaim_pt3(base)
    ensure_mineflayer_ghostbreak(base)
    ensure_mineflayer_deathtruth(base)
    ensure_mineflayer_digaim(base)


def ensure_mineflayer_ghostbreak(base):
    """26.3 GHOST-BREAK FIX: digging.js finishDigging() fabricated local air
    via _updateBlockState(block, 0) the server never confirmed. The ghost
    fired onBlockUpdate -> diggingCompleted (false success claims) and
    poisoned findBlocks/safeToBreak for that spot until a real chunk update.
    Remove the paint; completion now comes only from the server's own
    block_change. Marker-idempotent."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "digging.js")
    if not os.path.exists(mp):
        print(f"[ghostbreak] WARNING: {mp} missing")
        return
    s = open(mp).read()
    if "26.3 GHOST-BREAK FIX" in s:
        print("[ghostbreak] ghost-break fix present -> no-op")
        return
    old = ("      bot.targetDigBlock = null\n"
           "      bot.targetDigFace = null\n"
           "      bot.lastDigTime = performance.now()\n"
           "      bot._updateBlockState(block.position, 0)\n"
           "    }")
    if old not in s:
        print("[ghostbreak] WARNING: finishDigging anchor not found")
        return
    new = ("      bot.targetDigBlock = null\n"
           "      bot.targetDigFace = null\n"
           "      bot.lastDigTime = performance.now()\n"
           "      // 26.3 GHOST-BREAK FIX: _updateBlockState(block, 0) fabricated a local\n"
           "      // air block the server never confirmed. That ghost then (a) fired\n"
           "      // onBlockUpdate -> diggingCompleted -> skills claimed success, and\n"
           "      // (b) poisoned findBlocks/safeToBreak/world truth for that spot until a\n"
           "      // real chunk update arrived. STOP painting air: wait for the server's\n"
           "      // own block_change (or treat silence as failure at verify time).\n"
           "    }")
    s = s.replace(old, new, 1)
    open(mp, "w").write(s)
    print("[ghostbreak] ghost-break fix installed")


def ensure_mineflayer_deathtruth(base):
    """26.3 DEATH-TRUTH: a death mid-dig aborted via 3 paths at once —
    removeAllListeners('diggingCompleted') orphaned onBlockUpdate (its
    clearInterval/clearTimeout never ran -> swing spam forever, ghost
    targetDigBlock), stopDigging() fired ABORT on a corpse (Panda logs
    'packets after death'), and diggingTask.promise never settled -> every
    pending bot.dig() hangs to its cap, surfacing as 'dig-timeout' / 'still
    there' one block later. Now: full local reset only, no wire; wake waiters
    via diggingAborted + diggingTask.cancel. Marker-idempotent."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "digging.js")
    if not os.path.exists(mp):
        print(f"[deathtruth] WARNING: {mp} missing")
        return
    s = open(mp).read()
    if "26.3 DEATH-TRUTH" in s:
        print("[deathtruth] death-truth present -> no-op")
        return
    old = ("  bot.on('death', () => {\n"
           "    try {\n"
           "      bot.removeAllListeners('diggingAborted')\n"
           "      bot.removeAllListeners('diggingCompleted')\n"
           "      bot.stopDigging()\n"
           "    } catch (_) {}\n"
           "  })")
    if old not in s:
        print("[deathtruth] WARNING: death anchor not found")
        return
    new = ("  bot.on('death', () => {\n"
           "    try {\n"
           "      // 26.3 DEATH-TRUTH: a death mid-dig used to abort via 3 paths at once —\n"
           "      // removeAllListeners('diggingCompleted') orphaned onBlockUpdate (its\n"
           "      // clearInterval/clearTimeout never ran -> swing spam forever, ghost\n"
           "      // targetDigBlock), stopDigging() then fired ABORT on a corpse (Panda\n"
           "      // logs 'packets after death'), and diggingTask.promise never settled\n"
           "      // -> every pending bot.dig() hangs to its cap, surfacing as\n"
           "      // 'dig-timeout' / 'still there' one block later. Full local reset\n"
           "      // only, no wire; wake waiters via diggingAborted + cancel.\n"
           "      try {\n"
           "        clearInterval(swingInterval)\n"
           "        clearTimeout(waitTimeout)\n"
           "      } catch (_) {}\n"
           "      swingInterval = null\n"
           "      waitTimeout = null\n"
           "      bot.targetDigBlock = null\n"
           "      bot.targetDigFace = null\n"
           "      try { bot.removeListener('diggingAborted', bot.stopDigging) } catch (_) {}\n"
           "      try { bot.emit('diggingAborted', null) } catch (_) {}\n"
           "      try { diggingTask.cancel(new Error('Digging aborted (death)')) } catch (_) {}\n"
           "    } catch (_) {}\n"
           "  })")
    s = s.replace(old, new, 1)
    open(mp, "w").write(s)
    print("[deathtruth] death-truth installed")


def ensure_mineflayer_digaim_pt3(base):
    """26.3 DIG-AIM pt3: aim-then-START ordering. Panda raycasts the START
    against the server's CURRENT yaw/pitch — the stashed flush arrived a tick
    late (face-away cancels). digging.js arms bot._digAimArmed, re-sends the
    final aim past the hold, waits 120ms, then STARTs; physics.js lets
    armed aims bypass the hold (frozen-gate still applies) and restarts the
    hold clock instead of stashing. Marker-idempotent."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "physics.js")
    dp = os.path.join(base, "mineflayer", "lib", "plugins", "digging.js")
    if not os.path.exists(mp) or not os.path.exists(dp):
        print("[digaim3] WARNING: physics/digging missing")
        return
    s = open(mp).read()
    # pt3-present check: ONLY the pt3-introduced lines count. The base digaim
    # hunk sets bot._pendingForceLook and the leftover shouldSendLook line
    # mentions _digAimArmed, so gate on the pt3 hold comment.
    if "26.3 DIG-AIM FIX pt3" in s:
        print("[digaim3] pt3 present -> no-op")
    else:
        # hold exists in TWO pre-pt3 forms: pristine (comment + 2-line hold +
        # jitter line), or digaim one-liner (comment + merged line)
        old_fresh = ("    // jitter every stare look by 0-30ms so pairs can't phase-lock.\n"
                "    if (!shouldUsePhysics) return\n"
                "    if (performance.now() - lastPosSend < 2500) return\n"
                "    if (physics._lookJitter")
        old = "    if (!shouldUsePhysics || performance.now() - lastPosSend < 2500) { bot._pendingForceLook = { yaw, pitch, onGround }; return }"
        if old_fresh in s:
            s = s.replace(old_fresh, ("    // jitter every stare look by 0-30ms so pairs can't phase-lock.\n"
                "    // 26.3 DIG-AIM FIX pt3: an armed dig (START about to go out) needs its\n"
                "    // aim on the wire BEFORE the block_dig, not stashed for the next tick —\n"
                "    // Panda raycasts the START against the server's CURRENT yaw/pitch, and\n"
                "    // the stashed flush always arrived one tick too late (face-away cancels).\n"
                "    if ((!shouldUsePhysics || performance.now() - lastPosSend < 2500)) {\n"
                "      if (bot._digAimArmed) {\n"
                "        lastPosSend = performance.now() // hold clock restarts — next non-dig look still waits\n"
                "      } else {\n"
                "        bot._pendingForceLook = { yaw, pitch, onGround }\n"
                "        return\n"
                "      }\n"
                "    }\n"
                "    if (physics._lookJitter"), 1)
        elif old in s:
            new = ("    // 26.3 DIG-AIM FIX pt3: an armed dig (START about to go out) needs its\n"
                   "    // aim on the wire BEFORE the block_dig, not stashed for the next tick —\n"
                   "    // Panda raycasts the START against the server's CURRENT yaw/pitch, and\n"
                   "    // the stashed flush always arrived one tick too late (face-away cancels).\n"
                   "    if ((!shouldUsePhysics || performance.now() - lastPosSend < 2500)) {\n"
                   "      if (bot._digAimArmed) {\n"
                   "        lastPosSend = performance.now() // hold clock restarts — next non-dig look still waits\n"
                   "      } else {\n"
                   "        bot._pendingForceLook = { yaw, pitch, onGround }\n"
                   "        return\n"
                   "      }\n"
                   "    }")
            s = s.replace(old, new, 1)
        else:
            print("[digaim3] WARNING: hold anchor not found")
            return
        old2 = "  bot.physics.shouldSendLook = () => {"
        if old2 not in s:
            print("[digaim3] WARNING: shouldSendLook anchor not found")
            return
        if "if (bot._digAimArmed) return shouldUsePhysics" not in s:
            s = s.replace(old2, ("  bot.physics.shouldSendLook = () => {\n"
                    "    if (bot._digAimArmed) return shouldUsePhysics // dig aim: frozen-gated only, never hold-gated"), 1)
            # drop the now-duplicated frozen check on the next line
            s = s.replace(("    if (bot._digAimArmed) return shouldUsePhysics // dig aim: frozen-gated only, never hold-gated\n"
                    "    if (!shouldUsePhysics) return false"), ("    if (bot._digAimArmed) return shouldUsePhysics // dig aim: frozen-gated only, never hold-gated\n"
                    "    if (!shouldUsePhysics && !bot._digAimArmed) return false"), 1)
        open(mp, "w").write(s)
        print("[digaim3] physics pt3 installed")
        s = open(mp).read()
    d = open(dp).read()
    if "bot._digAimArmed = true" in d:
        print("[digaim3] digging pt3 present -> no-op")
        return
    old3 = ("    diggingTask = createTask()\n"
            "    // 26.3: sequence MUST be the live block-change ack counter.")
    if old3 not in d:
        print("[digaim3] WARNING: digging start anchor not found")
        return
    new3 = ("    diggingTask = createTask()\n"
            "    // 26.3 DIG-AIM pt3: aim-then-START ordering. Panda raycasts the START\n"
            "    // against the server's CURRENT yaw/pitch — the stashed flush arrived a\n"
            "    // tick late so the server still faced away (face-away cancels x13). Arm\n"
            "    // the dig so the final lookAt bypasses the hold and hits the wire, wait\n"
            "    // one physics tick so it lands, THEN send START. Disarm after.\n"
            "    bot._digAimArmed = true\n"
            "    try {\n"
            "      const _aimAt = (digFace?.x || digFace?.y || digFace?.z)\n"
            "        ? block.position.offset(0.5, 0.5, 0.5).offset(digFace.x * 0.5, digFace.y * 0.5, digFace.z * 0.5)\n"
            "        : block.position.offset(0.5, 0.5, 0.5)\n"
            "      await bot.lookAt(_aimAt, true)\n"
            "      await new Promise(r => setTimeout(r, 120))\n"
            "    } catch (_) {}\n"
            "    bot._digAimArmed = false\n"
            "    bot._pendingForceLook = null\n"
            "    // 26.3: sequence MUST be the live block-change ack counter.")
    d = d.replace(old3, new3, 1)
    open(dp, "w").write(d)
    print("[digaim3] digging pt3 installed")


def ensure_mineflayer_digaim(base):
    """26.3 DIG-AIM FIX: the server raycasts block digs from ITS OWN stored
    yaw/pitch — never the client's local angles. Two cooperating hunks:
    (1) bot.look(force) stashes notchian aim in bot._pendingForceLook instead
    of returning silently (old code set local angles only, and
    updatePosition saw zero drift so it sent NOTHING — the server kept the
    stale spawn-facing yaw and Panda's canBreak raycast cancelled every dig).
    (2) sendPacketLook stashes during the frozen/2.5s hold; updatePosition
    flushes the stash into mutable yaw/pitch and forces the look send
    (frozen-gated already). Handles fresh (const yaw) and live (let yaw).
    Marker-idempotent."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "physics.js")
    if not os.path.exists(mp):
        print(f"[digaim] WARNING: {mp} missing")
        return
    s = open(mp).read()
    if "bot._pendingForceLook" in s:
        print("[digaim] dig-aim flush present -> no-op")
        return
    old = ("    if (force) {\n"
           "      lastSentYaw = yaw\n"
           "      lastSentPitch = pitch\n"
           "      return\n"
           "    }")
    if old not in s:
        print("[digaim] WARNING: force anchor not found")
        return
    new = ("    if (force) {\n"
           "      lastSentYaw = yaw\n"
           "      lastSentPitch = pitch\n"
           "      // 26.3 DIG-AIM FIX pt2: force-look (dig/place aim) must reach the wire.\n"
           "      try {\n"
           "        bot._pendingForceLook = {\n"
           "          yaw: Math.fround(conv.toNotchianYaw(yaw)),\n"
           "          pitch: Math.fround(conv.toNotchianPitch(pitch)),\n"
           "          onGround: bot.entity.onGround\n"
           "        }\n"
           "      } catch (_) {}\n"
           "      return\n"
           "    }")
    s = s.replace(old, new, 1)
    # sendPacketLook's hold (NOT bot.lookAt's stare-gate further down, which
    # shares the two lines but is followed by "return false"). Disambiguate
    # with the PRECEDING comment, unique to sendPacketLook.
    old_h = ("    // jitter every stare look by 0-30ms so pairs can't phase-lock.\n"
             "    if (!shouldUsePhysics) return\n"
             "    if (performance.now() - lastPosSend < 2500) return")
    old_h_live = "    if (!shouldUsePhysics || performance.now() - lastPosSend < 2500) { bot._pendingForceLook"
    new_h = ("    // jitter every stare look by 0-30ms so pairs can't phase-lock.\n"
             "    if (!shouldUsePhysics || performance.now() - lastPosSend < 2500) { bot._pendingForceLook = { yaw, pitch, onGround }; return }")
    if old_h_live in s:
        print("[digaim] hold hunk present -> keep")
    elif old_h in s:
        s = s.replace(old_h, new_h, 1)
    else:
        print("[digaim] WARNING: hold anchor not found")
        return
    s = s.replace("    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw))",
                  "    let yaw = Math.fround(conv.toNotchianYaw(lastSentYaw))", 1)
    s = s.replace("    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch))",
                  "    let pitch = Math.fround(conv.toNotchianPitch(lastSentPitch))", 1)
    old3 = ("    const position = bot.entity.position\n"
            "    const onGround = bot.entity.onGround\n")
    if old3 not in s:
        print("[digaim] WARNING: flush anchor not found")
        return
    new3 = ("    const position = bot.entity.position\n"
            "    const onGround = bot.entity.onGround\n"
            "    // 26.3 DIG-AIM FIX: flush a stashed force-look into the send angles FIRST\n"
            "    // (frozen-gated via updatePosition) so dig/place aim always reaches the\n"
            "    // wire — the server raycasts from its own yaw/pitch, never local.\n"
            "    let _forceFlushed = false\n"
            "    if (bot._pendingForceLook) {\n"
            "      try {\n"
            "        yaw = bot._pendingForceLook.yaw\n"
            "        pitch = bot._pendingForceLook.pitch\n"
            "        // keep the drift tracker in sync so the next tick sees no phantom delta\n"
            "        lastSentYaw = conv.fromNotchianYaw(yaw)\n"
            "        lastSentPitch = conv.fromNotchianPitch(pitch)\n"
            "        _forceFlushed = true\n"
            "      } catch (_) {}\n"
            "      bot._pendingForceLook = null\n"
            "    }\n")
    s = s.replace(old3, new3, 1)
    old4 = "    const lookUpdated = lastSent.yaw !== yaw || lastSent.pitch !== pitch"
    if old4 not in s:
        print("[digaim] WARNING: lookUpdated anchor not found")
        return
    s = s.replace(old4, "    const lookUpdated = _forceFlushed || lastSent.yaw !== yaw || lastSent.pitch !== pitch", 1)
    open(mp, "w").write(s)
    print("[digaim] dig-aim flush installed")


def ensure_mineflayer_wire_quiet(base):
    """BOTCRAFT PORT (edge sprint + input-on-change): SendPosition emits
    Start/StopSprinting on EDGE only and ServerboundPlayerInput on CHANGE
    only — vanilla holds one edge for minutes. Marker-idempotent per hunk."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "physics.js")
    if not os.path.exists(mp):
        print(f"[wirequiet] WARNING: {mp} missing")
        return
    s = open(mp).read()
    if "BOTCRAFT PORT (edge-triggered sprint" in s:
        print("[wirequiet] edge-triggered sprint present -> no-op")
    else:
        old = ("    } else if (control === 'sprint') {\n"
               "      bot._client.write('entity_action', {")
        if old not in s:
            print("[wirequiet] WARNING: sprint anchor not found")
        else:
            new = ("    } else if (control === 'sprint') {\n"
                   "      // BOTCRAFT PORT (edge-triggered sprint: Botcraft SendPosition sends\n"
                   "      // Start/StopSprinting as PlayerCommand on sprint-flag EDGE only, never\n"
                   "      // per-tick spam — vanilla holds one edge for minutes. Mineflayer\n"
                   "      // already early-returns on same-state, but legs/ticks/flees re-assert\n"
                   "      // and stall replays batch those into bursts the AC reads as toggling.\n"
                   "      // Suppress same-edge re-emits within 500ms; real flips always pass.)\n"
                   "      bot._lastSprintEmit = bot._lastSprintEmit || { state: null, ms: 0 };\n"
                   "      try {\n"
                   "        const nowMs = Date.now();\n"
                   "        if (bot._lastSprintEmit.state === state && nowMs - bot._lastSprintEmit.ms < 500) return;\n"
                   "        bot._lastSprintEmit = { state, ms: nowMs };\n"
                   "      } catch (_) {}\n"
                   "      bot._client.write('entity_action', {")
            s = s.replace(old, new, 1)
            open(mp, "w").write(s)
            print("[wirequiet] edge-triggered sprint installed")
            s = open(mp).read()
    if "BOTCRAFT PORT (input-on-CHANGE" in s:
        print("[wirequiet] input-on-change present -> no-op")
        return
    old2 = ("      if (!cs.forward && !cs.backward && !cs.left && !cs.right && !cs.jump && !cs.shift && !cs.sprint) return; // all-false = server default, skip the write\n"
            "      bot._client.write('player_input', { inputs: cs });")
    if old2 not in s:
        print("[wirequiet] WARNING: input anchor not found")
        return
    new2 = ("      if (!cs.forward && !cs.backward && !cs.left && !cs.right && !cs.jump && !cs.shift && !cs.sprint) return; // all-false = server default, skip the write\n"
            "      try {\n"
            "        const l = bot._lastSentInput;\n"
            "        if (l && l.forward === cs.forward && l.backward === cs.backward && l.left === cs.left\n"
            "            && l.right === cs.right && l.jump === cs.jump && l.shift === cs.shift && l.sprint === cs.sprint) return; // unchanged: skip\n"
            "      } catch (_) {}\n"
            "      bot._lastSentInput = { ...cs };\n"
            "      bot._client.write('player_input', { inputs: cs });")
    s = s.replace(old2, new2, 1)
    open(mp, "w").write(s)
    print("[wirequiet] input-on-change installed")


def ensure_prismarine_phase_order(base):
    """BOTCRAFT PORT (vanilla aiStep phase order): sneak-in-water sink before
    jump handling + 1.21.5+ squared-norm XZ velocity floor. Marker-idempotent
    per hunk."""
    pj = os.path.join(base, "prismarine-physics", "index.js")
    if not os.path.exists(pj):
        print(f"[phaseorder] WARNING: {pj} missing")
        return
    s = open(pj).read()
    if "BOTCRAFT PORT (phase order" in s:
        print("[phaseorder] sneak-sink present -> no-op")
    else:
        old = ("    entity.jumpQueued = false\n\n    let strafe = (entity.control.right - entity.control.left) * 0.98")
        if old not in s:
            print("[phaseorder] WARNING: sink anchor not found")
        else:
            new = ("    entity.jumpQueued = false\n\n"
                   "    // BOTCRAFT PORT (phase order: vanilla aiStep sinks sneak-in-water BEFORE\n"
                   "    // jump handling — sneak + water + no jump = downward speed. Mineflayer\n"
                   "    // had no sink at all, so descending water columns never worked.)\n"
                   "    if (entity.isInWater && entity.control.sneak && !entity.control.jump) {\n"
                   "      vel.y -= 0.04\n"
                   "    }\n\n"
                   "    let strafe = (entity.control.right - entity.control.left) * 0.98")
            s = s.replace(old, new, 1)
            open(pj, "w").write(s)
            print("[phaseorder] sneak-sink installed")
            s = open(pj).read()
    if "BOTCRAFT PORT (1.21.5+ parity" in s:
        print("[phaseorder] squared-floor present -> no-op")
        return
    old2 = ("    // Reset velocity component if it falls under the threshold\n"
            "    if (Math.abs(vel.x) < physics.negligeableVelocity) vel.x = 0\n"
            "    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0\n"
            "    if (Math.abs(vel.z) < physics.negligeableVelocity) vel.z = 0")
    if old2 not in s:
        print("[phaseorder] WARNING: floor anchor not found")
        return
    new2 = ("    // Reset velocity component if it falls under the threshold\n"
            "    // BOTCRAFT PORT (1.21.5+ parity: XZ zeroes on SQUARED norm < 9e-6, i.e.\n"
            "    // the vector dies as a whole — per-axis 0.003 kept diagonal creep alive.)\n"
            "    if (vel.x * vel.x + vel.z * vel.z < 9e-6) { vel.x = 0; vel.z = 0 }\n"
            "    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0")
    s = s.replace(old2, new2, 1)
    open(pj, "w").write(s)
    print("[phaseorder] squared-floor installed")


def ensure_pathfinder_walker(base):
    """BOTCRAFT PORT (Move walker): anti-overshoot braking on descents +
    gap-jump run-up from block center. Marker-idempotent per hunk."""
    ix = os.path.join(base, "mineflayer-pathfinder", "index.js")
    if not os.path.exists(ix):
        print(f"[walker] WARNING: {ix} missing")
        return
    s = open(ix).read()
    if "BOTCRAFT PORT (anti-overshoot braking" in s:
        print("[walker] braking present -> no-op")
    else:
        old = ("    bot.look(Math.atan2(-dx, -dz), 0)\n"
               "    bot.setControlState('forward', true)\n"
               "    bot.setControlState('jump', false)")
        if old not in s:
            print("[walker] WARNING: brake anchor not found")
        else:
            new = ("    bot.look(Math.atan2(-dx, -dz), 0)\n"
                   "    // BOTCRAFT PORT (anti-overshoot braking: Botcraft Move() kills forward\n"
                   "    // accel while falling onto a lower node — full speed into a dropshoot\n"
                   "    // overshoots the landing and clips walls. Back off at speed > 0.12,\n"
                   "    // coast at 0.06-0.12, full ahead only when slow.)\n"
                   "    let _brakeFwd = true\n"
                   "    try {\n"
                   "      const _dyy = (nextPoint.y ?? 0) - p.y\n"
                   "      if (_dyy < -0.5) {\n"
                   "        const _sp = Math.max(Math.abs(bot.entity.velocity?.x || 0), Math.abs(bot.entity.velocity?.z || 0))\n"
                   "        if (_sp > 0.12) { bot.setControlState('forward', false); bot.setControlState('back', true); _brakeFwd = false }\n"
                   "        else if (_sp > 0.06) { bot.setControlState('forward', false); bot.setControlState('back', false); _brakeFwd = false }\n"
                   "      }\n"
                   "    } catch (_) {}\n"
                   "    if (_brakeFwd) bot.setControlState('forward', true)\n"
                   "    try { if (!_brakeFwd) setTimeout(() => { try { bot.setControlState('back', false) } catch (_) {} }, 250) } catch (_) {}\n"
                   "    bot.setControlState('jump', false)")
            s = s.replace(old, new, 1)
            open(ix, "w").write(s)
            print("[walker] braking installed")
            s = open(ix).read()
    if "BOTCRAFT PORT (gap-jump run-up" in s:
        print("[walker] run-up present -> no-op")
        return
    old2 = ("    } else if (stateMovements.allowSprinting && physics.canSprintJump(path)) {\n"
            "      bot.setControlState('jump', true)\n"
            "      bot.setControlState('sprint', true)")
    if old2 not in s:
        print("[walker] WARNING: run-up anchor not found")
        return
    new2 = ("    } else if (stateMovements.allowSprinting && physics.canSprintJump(path)) {\n"
            "      // BOTCRAFT PORT (gap-jump run-up: Botcraft Move() strafes to the\n"
            "      // current block CENTER first to build speed, then jumps. Jumping from\n"
            "      // the block edge with no run-up lands short. Center first (< 0.15 =\n"
            "      // centered enough), jump after.)\n"
            "      try {\n"
            "        const _cx = Math.floor(p.x) + 0.5, _cz = Math.floor(p.z) + 0.5\n"
            "        const _off = Math.hypot(p.x - _cx, p.z - _cz)\n"
            "        if (_off > 0.15 && bot.entity.onGround) {\n"
            "          bot.setControlState('forward', true)\n"
            "          bot.setControlState('sprint', true)\n"
            "          bot.setControlState('jump', false)\n"
            "        } else {\n"
            "          bot.setControlState('jump', true)\n"
            "          bot.setControlState('sprint', true)\n"
            "        }\n"
            "      } catch (_) {\n"
            "        bot.setControlState('jump', true)\n"
            "        bot.setControlState('sprint', true)\n"
            "      }")
    s = s.replace(old2, new2, 1)
    open(ix, "w").write(s)
    print("[walker] run-up installed")


def ensure_mineflayer_driver_arbiter(base):
    """BOTCRAFT PORT (dirtyInputs backpressure v2): AI stamps bot._dirtyInputs on
    every control write; the physics tick clears it after simulating; loops
    yield while dirty instead of flapping the wire. Marker-idempotent."""
    mp = os.path.join(base, "mineflayer", "lib", "plugins", "physics.js")
    if not os.path.exists(mp):
        print(f"[dirty] WARNING: {mp} missing")
        return
    s = open(mp).read()
    if "BOTCRAFT PORT (dirtyInputs backpressure" in s and "BOTCRAFT PORT (dirtyInputs backpressure v2" not in s:
        print("[driver] dirtyInputs v1 present -> no-op (v1 stamp+clear live in physics.js)")
    elif "BOTCRAFT PORT (dirtyInputs backpressure v2" in s:
        print("[driver] dirtyInputs/arbiter present -> no-op")
    else:
        # reinstall path on a wiped node_modules: same shape as the live
        # physics.js block (wrapped setControlState + clearControlStates).
        print("[driver] WARNING: dirty anchor not found (fresh install?)")
        return
    # arbiter append (separate marker — applies even with dirty present):
    # exactly one non-temporary driver owns movement per tick.
    arb_marker = "bot.moveAcquire = (name, ms = 800)"
    if arb_marker not in s:
        if arb_old not in s:
            print("[driver] WARNING: arbiter anchor not found")
        else:
            s = s.replace(arb_old, arb_new, 1)
            open(mp, "w").write(s)
            print("[driver] arbiter installed")
            s = open(mp).read()
    else:
        print("[driver] arbiter present -> no-op")
    # look smoothing (own marker — Baritone LookBehavior smooth-look:
    # yaw/pitch through a 5-sample moving average before the wire so a
    # single-frame target snap can't whip the head; force bypasses).
    # NOTE: falls through from BOTH arbiter branches (no early return
    # above) so one run installs arbiter AND smoothing together.
    if "bot._smoothLookBuf" in s:
        print("[driver] look smoothing present -> no-op")
        return
    look_old = ("  bot.look = async (yaw, pitch, force) => {")
    if look_old not in s:
        print("[driver] WARNING: look anchor not found")
        return
    look_new = ("  // BARITONE PORT (LookBehavior smooth-look: 5-sample moving average on\n"
                "  // yaw/pitch before the wire — one snapped frame can't whip the head.\n"
                "  // force looks (dig-aim, place-aim) bypass: they need the exact face.)\n"
                "  bot._smoothLookBuf = { yaw: [], pitch: [] }\n"
                "  bot._smoothLookPush = (buf, v) => {\n"
                "    try {\n"
                "      buf.push(v)\n"
                "      if (buf.length > 5) buf.shift()\n"
                "      let s = 0\n"
                "      for (const x of buf) s += x\n"
                "      return s / buf.length\n"
                "    } catch (_) { return v }\n"
                "  }\n"
                "  bot.look = async (yaw, pitch, force) => {")
    s = s.replace(look_old, look_new, 1)
    # smooth inside bot.look (NOT sendPacketLook: `force` is only in scope
    # there), right after the bot.look NaN guard, non-force only.
    nan_guard = ("    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return\n"
                 "    // this is done to bypass certain anticheat")
    if nan_guard not in s:
        print("[driver] WARNING: look NaN-guard anchor not found (smoothing skipped)")
    else:
        smooth_apply = (nan_guard + "\n"
                        "    if (!force) {\n"
                        "      try {\n"
                        "        yaw = bot._smoothLookPush(bot._smoothLookBuf.yaw, yaw)\n"
                        "        pitch = bot._smoothLookPush(bot._smoothLookBuf.pitch, pitch)\n"
                        "      } catch (_) {}\n"
                        "    } else {\n"
                        "      try { bot._smoothLookBuf.yaw.length = 0; bot._smoothLookBuf.pitch.length = 0 } catch (_) {}\n"
                        "    }")
        s = s.replace(nan_guard, smooth_apply, 1)
    open(mp, "w").write(s)
    print("[driver] look smoothing installed")


def ensure_pathfinder_baritone_goals(base):
    """BARITONE PORT (flee/corridor goals + cost basis + Y asymmetry):
    GoalRunAway (real flee-until-far, not GoalInvert sphere), GoalTwoBlocks
    (doorstep/ledge Y ambiguity), GoalStrictDirection (explore-by-ray, isEnd
    never fires), ActionCosts tick basis + COST_INF guard, GoalBlock/GoalNear
    Y asymmetry. Marker-idempotent per hunk."""
    gj = os.path.join(base, "mineflayer-pathfinder", "lib", "goals.js")
    if not os.path.exists(gj):
        print(f"[baritone-goals] WARNING: {gj} missing")
        return
    hunks = []
    # 1. flee/corridor goal classes (insert before module.exports)
    s = open(gj).read()
    if "BARITONE PORT (GoalRunAway" in s:
        print("[baritone-goals] flee/corridor goals present -> no-op")
    else:
        old_exp = ("module.exports = {\n"
                   "  Goal,\n"
                   "  GoalBlock,")
        if old_exp not in s:
            print("[baritone-goals] WARNING: exports anchor not found")
            return
        new_classes = (
            "\n"
            "// BARITONE PORT (GoalRunAway: flee-until-far with maintainY option. Ours used\n"
            "// GoalInvert(GoalNear) which inverts the HEURISTIC but keeps GoalNear's isEnd\n"
            "// (sphere) -- the planner 'arrives' while still close. Real RunAway ends only\n"
            "// when EVERY threat is beyond distanceSq, optionally pinned to one Y level.)\n"
            "class GoalRunAway extends Goal {\n"
            "  constructor (distance, maintainY = null, ...from) {\n"
            "    super()\n"
            "    this.distanceSq = distance * distance\n"
            "    this.maintainY = maintainY\n"
            "    this.from = from.map(p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }))\n"
            "  }\n"
            "\n"
            "  heuristic (node) {\n"
            "    // closest-threat XZ distance, negated (farther = better), plus asymmetric\n"
            "    // Y term when pinned to a level (0.6 weight on XZ, 1.5 on Y per Baritone)\n"
            "    let min = Infinity\n"
            "    for (const p of this.from) {\n"
            "      const h = distanceXZ(p.x - node.x, p.z - node.z)\n"
            "      if (h < min) min = h\n"
            "    }\n"
            "    min = -min\n"
            "    if (this.maintainY != null) {\n"
            "      const dy = this.maintainY - node.y\n"
            "      const yCost = dy > 0 ? dy * BARITONE_FALL2_HALF : -dy * BARITONE_JUMP_COST\n"
            "      min = min * 0.6 + yCost * 1.5\n"
            "    }\n"
            "    return min\n"
            "  }\n"
            "\n"
            "  isEnd (node) {\n"
            "    if (this.maintainY != null && this.maintainY !== node.y) return false\n"
            "    for (const p of this.from) {\n"
            "      const dx = node.x - p.x, dz = node.z - p.z\n"
            "      if (dx * dx + dz * dz < this.distanceSq) return false\n"
            "    }\n"
            "    return true\n"
            "  }\n"
            "}\n"
            "\n"
            "// BARITONE PORT (GoalTwoBlocks: stand on EITHER of two stacked Y levels at\n"
            "// one XZ -- doorsteps/ledges where the exact foot level is ambiguous. Ends\n"
            "// at y or y-1, heuristic forgives sub-level starts.)\n"
            "class GoalTwoBlocks extends Goal {\n"
            "  constructor (x, y, z) {\n"
            "    super()\n"
            "    this.x = Math.floor(x)\n"
            "    this.y = Math.floor(y)\n"
            "    this.z = Math.floor(z)\n"
            "  }\n"
            "\n"
            "  heuristic (node) {\n"
            "    const dx = this.x - node.x\n"
            "    const dy = this.y - node.y\n"
            "    const dz = this.z - node.z\n"
            "    const yAdj = dy < 0 ? dy + 1 : dy\n"
            "    const yCost = yAdj > 0 ? yAdj * BARITONE_FALL2_HALF : -yAdj * BARITONE_JUMP_COST\n"
            "    return distanceXZ(dx, dz) + yCost\n"
            "  }\n"
            "\n"
            "  isEnd (node) {\n"
            "    return node.x === this.x && (node.y === this.y || node.y === this.y - 1) && node.z === this.z\n"
            "  }\n"
            "}\n"
            "\n"
            "// BARITONE PORT (GoalStrictDirection: explore-by-ray -- heuristic DECREASES\n"
            "// along the chosen direction (-100/block) and punishes drift (+1000/block\n"
            "// off-axis, +1000/block vertical). isEnd never fires: the planner runs the\n"
            "// ray until the watchdog/timeout, not until arrival. For corridor sweeps and\n"
            "// GetToBlock-style wander when the target is unknown.)\n"
            "class GoalStrictDirection extends Goal {\n"
            "  constructor (x, y, z, dx, dz) {\n"
            "    super()\n"
            "    this.x = Math.floor(x)\n"
            "    this.y = Math.floor(y)\n"
            "    this.z = Math.floor(z)\n"
            "    this.dx = dx\n"
            "    this.dz = dz\n"
            "  }\n"
            "\n"
            "  heuristic (node) {\n"
            "    const along = (node.x - this.x) * this.dx + (node.z - this.z) * this.dz\n"
            "    const off = Math.abs((node.x - this.x) * this.dz) + Math.abs((node.z - this.z) * this.dx)\n"
            "    const vert = Math.abs(node.y - this.y)\n"
            "    return -along * 100 + off * 1000 + vert * 1000\n"
            "  }\n"
            "\n"
            "  isEnd (node) {\n"
            "    return false\n"
            "  }\n"
            "}\n"
            "\n"
            "module.exports = {\n"
            "  Goal,\n"
            "  GoalBlock,\n"
            "  GoalRunAway,\n"
            "  GoalTwoBlocks,\n"
            "  GoalStrictDirection,")
        s = s.replace(old_exp, new_classes, 1)
        open(gj, "w").write(s)
        print("[baritone-goals] flee/corridor goals installed")
        s = open(gj).read()
    if "BARITONE PORT (ActionCosts tick basis" in s:
        print("[baritone-goals] ActionCosts basis present -> no-op")
    else:
        old_tc = ("// Goal is a Y coordinate\n"
                  "class GoalY extends Goal {")
        if old_tc not in s:
            print("[baritone-goals] WARNING: cost-basis anchor not found")
            return
        new_tc = ("// BARITONE PORT (ActionCosts tick basis: walk 20/4.317, sprint 20/5.612,\n"
                  "// multiplier 0.769, sneak 20/1.3, ladder up 20/2.35 / down 20/3.0, jump =\n"
                  "// FALL(1.25)-FALL(0.25) via gravity parabola v(t)=(0.98^t-1)*-3.92.)\n"
                  "// Clamp helper: Baritone COST_INF=1e6 (never MAX_VALUE -- it gets ADDED).\n"
                  "function baritoneFallTicks (distance) {\n"
                  "  if (distance <= 0) return 0\n"
                  "  let tmp = distance, ticks = 0\n"
                  "  while (true) {\n"
                  "    const v = (Math.pow(0.98, ticks) - 1) * -3.92\n"
                  "    if (tmp <= v) return ticks + tmp / v\n"
                  "    tmp -= v\n"
                  "    ticks++\n"
                  "    if (ticks > 4096) return ticks\n"
                  "  }\n"
                  "}\n"
                  "const BARITONE_JUMP_COST = (() => { try { return baritoneFallTicks(1.25) - baritoneFallTicks(0.25) } catch (_) { return 7 } })()\n"
                  "const BARITONE_FALL2_HALF = (() => { try { return baritoneFallTicks(2) / 2 } catch (_) { return 2.3 } })()\n"
                  "\n"
                  "// Goal is a Y coordinate\n"
                  "class GoalY extends Goal {")
        s = s.replace(old_tc, new_tc, 1)
        open(gj, "w").write(s)
        print("[baritone-goals] ActionCosts basis installed")
        s = open(gj).read()
    if "BARITONE PORT (GoalYLevel.calculate asymmetry" in s:
        print("[baritone-goals] Y asymmetry present -> no-op")
        return
    old_gb = ("    const dy = this.y - node.y\n"
              "    const dz = this.z - node.z\n"
              "    return distanceXZ(dx, dz) + Math.abs(dy)\n"
              "  }\n"
              "\n"
              "  isEnd (node) {\n"
              "    return node.x === this.x && node.y === this.y && node.z === this.z\n"
              "  }")
    if old_gb not in s:
        print("[baritone-goals] WARNING: GoalBlock anchor not found")
        return
    new_gb = ("    const dy = this.y - node.y\n"
              "    const dz = this.z - node.z\n"
              "    // BARITONE PORT (GoalYLevel.calculate asymmetry: down = FALL[2]/2 per\n"
              "    // block, up = JUMP per block -- symmetric |dy| mispriced shafts.)\n"
              "    const yCost = dy > 0 ? dy * BARITONE_FALL2_HALF : -dy * BARITONE_JUMP_COST\n"
              "    return distanceXZ(dx, dz) + yCost\n"
              "  }\n"
              "\n"
              "  isEnd (node) {\n"
              "    return node.x === this.x && node.y === this.y && node.z === this.z\n"
              "  }")
    s = s.replace(old_gb, new_gb, 1)
    open(gj, "w").write(s)
    print("[baritone-goals] GoalBlock Y asymmetry installed")


def ensure_pathfinder_baritone_astar(base):
    """BARITONE PORT (A* hardening): staticCutoff(30, 0.9) anti-overshoot
    truncation + NaN/non-positive cost edge skip (Baritone throws; live bots
    skip softer). Marker-idempotent per hunk."""
    aj = os.path.join(base, "mineflayer-pathfinder", "lib", "astar.js")
    if not os.path.exists(aj):
        print(f"[baritone-astar] WARNING: {aj} missing")
        return
    s = open(aj).read()
    if "BARITONE PORT (PathBase.staticCutoff" in s:
        print("[baritone-astar] staticCutoff present -> no-op")
    else:
        old_mr = ("  makeResult (status, node) {\n"
                  "    let _path = reconstructPath(node)")
        if old_mr not in s:
            print("[baritone-astar] WARNING: makeResult anchor not found")
            return
        new_mr = ("  makeResult (status, node) {\n"
                  "    let _path = reconstructPath(node)\n"
                  "    // BARITONE PORT (PathBase.staticCutoff(30, 0.9): truncate overshoot --\n"
                  "    // a 200-node path to a goal 40 away walks past the target. Only when\n"
                  "    // the dest is NOT already in goal.)\n"
                  "    try {\n"
                  "      if (_path && _path.length >= 30 && this.goal && !this.goal.isEnd(_path[_path.length - 1])) {\n"
                  "        const _cut = Math.floor((_path.length - 30) * 0.9 + 30) - 1\n"
                  "        if (_cut > 0 && _cut < _path.length) _path = _path.slice(0, _cut)\n"
                  "      }\n"
                  "    } catch (_) {}")
        s = s.replace(old_mr, new_mr, 1)
        open(aj, "w").write(s)
        print("[baritone-astar] staticCutoff installed")
        s = open(aj).read()
    if "BARITONE PORT (AStarPathFinder validation" in s:
        print("[baritone-astar] cost validation present -> no-op")
        return
    old_cv = ("      for (const neighborData of neighbors) {\n"
              "        if (this.closedDataSet.has(neighborData.hash)) {\n"
              "          continue // skip closed neighbors\n"
              "        }")
    if old_cv not in s:
        print("[baritone-astar] WARNING: neighbor-loop anchor not found")
        return
    new_cv = ("      for (const neighborData of neighbors) {\n"
              "        if (this.closedDataSet.has(neighborData.hash)) {\n"
              "          continue // skip closed neighbors\n"
              "        }\n"
              "        // BARITONE PORT (AStarPathFinder validation: NaN/<=0 movement\n"
              "        // costs mean a broken cost model -- skip the edge, never heap it.)\n"
              "        if (!Number.isFinite(neighborData.cost) || neighborData.cost <= 0) continue")
    s = s.replace(old_cv, new_cv, 1)
    open(aj, "w").write(s)
    print("[baritone-astar] cost validation installed")


def ensure_uwu_swim(base):
    """UWU-SWIM + UWU-SCAFFOLD (2026-09-27, marker-idempotent): shore drops
    into safe water plan (+liquidCost, lava still refuses), legs may start in
    safe water, digger kicks off while treading water, scaffold falls back to
    any solid carried block. Anchors on stock upstream text; warns, never
    blind-writes. Rerun is a no-op once markers exist."""
    pf = os.path.join(base, "mineflayer-pathfinder")
    mp = os.path.join(pf, "lib", "movements.js")
    ix = os.path.join(pf, "index.js")
    # 1. shore drop into water (getMoveDropDown blanket guard)
    if os.path.exists(mp):
        t = open(mp).read()
        if "UWU-SWIM (2026-09-27): shore drops" in t:
            print("[uwu-swim] shore-drop present -> no-op")
        else:
            old = "    if (blockC.liquid) return // dont go underwater"
            new = ("    // UWU-SWIM (2026-09-27): shore drops into SAFE water must plan — the old\n"
                   "    // blanket guard returned no-path at every pond edge (shore jitter). Lava\n"
                   "    // (blocksToAvoid) still refuses; water plans with +liquidCost so dry\n"
                   "    // detours win when both exist.\n"
                   "    if (blockC.liquid) {\n"
                   "      if (blockC.name === 'lava' || this.blocksToAvoid.has(blockC.type)) return // lava: still never\n"
                   "      cost += this.liquidCost\n"
                   "    }")
            if old not in t:
                print("[uwu-swim] WARNING: drop anchor moved, skipped")
            else:
                open(mp, "w").write(t.replace(old, new, 1))
                print("[uwu-swim] shore-drop installed")
        # 2. legs starting in water (getMoveDown standing-in-liquid guard)
        t = open(mp).read()
        if "UWU-SWIM (2026-09-27): allow planning while standing" in t:
            print("[uwu-swim] in-water legs present -> no-op")
        else:
            old = "    if (this.getBlock(node, 0, 0, 0).liquid) return // dont go underwater"
            new = ("    // UWU-SWIM (2026-09-27): allow planning while standing in SAFE water\n"
                   "    // (wading to a water goal / swimming a leg). Lava still refuses.\n"
                   "    if (this.getBlock(node, 0, 0, 0).liquid) {\n"
                   "      const _here = this.getBlock(node, 0, 0, 0)\n"
                   "      if (_here.name === 'lava' || this.blocksToAvoid.has(_here.type)) return\n"
                   "    }")
            if old not in t:
                print("[uwu-swim] WARNING: down anchor moved, skipped")
            else:
                open(mp, "w").write(t.replace(old, new, 1))
                print("[uwu-swim] in-water legs installed")
    # 3. digger kickoff while treading water + scaffold fallback
    # 3b. WIDE planner set (2026-09-27): stock planner only offers dirt/cobble, so
    # water-exit/bridge legs die at execution with stone/dirt-family visible.
    # Widen scafoldingBlocks to the full cheap-solid set. Marker-idempotent.
    mp = os.path.join(pf, "lib", "movements.js")
    if os.path.exists(mp):
        t = open(mp).read()
        if "scafoldingBlocks-WIDE" in t or "for (const sn of ['dirt','cobblestone','stone'" in t:
            print("[uwu-swim] scaffold-wide present -> no-op")
        else:
            old = ("    this.scafoldingBlocks = []\n"
                   "    this.scafoldingBlocks.push(registry.itemsByName.dirt.id)\n"
                   "    this.scafoldingBlocks.push(registry.itemsByName.cobblestone.id)")
            new = ("    this.scafoldingBlocks = []\n"
                   "    for (const sn of ['dirt','cobblestone','stone','deepslate','cobbled_deepslate','sand','gravel','netherrack','oak_planks','grass_block']) {\n"
                   "      try {\n"
                   "        const sid = registry.itemsByName[sn] && registry.itemsByName[sn].id\n"
                   "        if (sid !== undefined) this.scafoldingBlocks.push(sid)\n"
                   "      } catch (e) {}\n"
                   "    }")
            if old not in t:
                print("[uwu-swim] WARNING: scaffold-wide anchor moved, skipped")
            else:
                open(mp, "w").write(t.replace(old, new, 1))
                print("[uwu-swim] scaffold-wide installed")
    if os.path.exists(ix):
        t = open(ix).read()
        if "UWU-SWIM (2026-09-27): the old onGround-only kickoff" in t:
            print("[uwu-swim] swim-dig present -> no-op")
        else:
            old = ("    // Handle digging\n"
                   "    if (digging || nextPoint.toBreak.length > 0) {\n"
                   "      if (!digging && bot.entity.onGround) {")
            new = ("    // Handle digging\n"
                   "    if (digging || nextPoint.toBreak.length > 0) {\n"
                   "      // UWU-SWIM (2026-09-27): the old onGround-only kickoff never fired in\n"
                   "      // water, so water-edge breaks stalled forever. Swim digs are legal —\n"
                   "      // tread water (jump) until stable, then dig from the float.\n"
                   "      if (!digging && !bot.entity.onGround && (bot.entity.isInWater || bot.entity.isInLava)) {\n"
                   "        bot.setControlState('jump', true)\n"
                   "        return\n"
                   "      }\n"
                   "      if (!digging && bot.entity.onGround) {")
            if old not in t:
                print("[uwu-swim] WARNING: dig anchor moved, skipped")
            else:
                open(ix, "w").write(t.replace(old, new, 1))
                print("[uwu-swim] swim-dig installed")
        t = open(ix).read()
        if "UWU-SCAFFOLD (2026-09-27)" in t:
            print("[uwu-swim] scaffold fallback present -> no-op")
        else:
            old = ("      const block = stateMovements.getScaffoldingItem()\n"
                   "      if (!block) {\n"
                   "        resetPath('no_scaffolding_blocks')\n"
                   "        return\n"
                   "      }")
            new = ("      // UWU-SCAFFOLD (2026-09-27): stock only places dirt/cobble — with an\n"
                   "      // empty client inventory (26.3 Slot-decode bug) that is always 0, so\n"
                   "      // every dig+place plan died at execution. Fall back to any solid block\n"
                   "      // the client CAN see; the planner's toPlace already decided the move is\n"
                   "      // worth making, so the material is secondary.\n"
                   "      let block = stateMovements.getScaffoldingItem()\n"
                   "      if (!block) {\n"
                   "        try {\n"
                   "          const seen = bot.inventory.items() || []\n"
                   "          const solid = seen.find(i => {\n"
                   "            try {\n"
                   "              const blk = bot.registry.blocksByName[i.name]\n"
                   "              if (!blk) return false\n"
                   "              return blk.boundingBox === 'block'\n"
                   "            } catch (_) { return false }\n"
                   "          })\n"
                   "          if (solid) block = solid\n"
                   "        } catch (_) {}\n"
                   "      }\n"
                   "      if (!block) {\n"
                   "        resetPath('no_scaffolding_blocks')\n"
                   "        return\n"
                   "      }")
            if old not in t:
                print("[uwu-swim] WARNING: scaffold anchor moved, skipped")
            else:
                open(ix, "w").write(t.replace(old, new, 1))
                print("[uwu-swim] scaffold fallback installed")


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
        ("lib/goals.js", "BARITONE PORT (GoalRunAway",
         "module.exports = {\n  Goal,\n  GoalBlock,",
          "THIS_ANCHOR_NEVER_MATCHES_SO_WARN", "#baritone flee goals (ensure_pathfinder_baritone_goals)"),
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
        if old is None:
            skipped += 1; continue
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

    # 2. chunk impl + fluid-count + physics fallback + anvil 26.x table
    ensure_chunk_26_3(BASE)
    ensure_anvil_26_3(BASE)
    ensure_physics_fallback(BASE)
    ensure_prismarine_phase_order(BASE)
    ensure_pathfinder_walker(BASE)
    ensure_uwu_swim(BASE)
    ensure_pathfinder_baritone_goals(BASE)
    ensure_pathfinder_baritone_astar(BASE)
    ensure_mineflayer_driver_arbiter(BASE)

    # 3. upstream pathfinder PRs (idempotent — no-op when already present)
    ensure_pathfinder_prs(BASE)

    print("done.")


if __name__ == "__main__":
    main()