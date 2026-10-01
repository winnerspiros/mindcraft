#!/usr/bin/env python3
"""Repair the 26.3 support that a dependency install silently removes.

WHY THIS EXISTS
---------------
`bun install` / `npm install` in this repo DESTROYS UwU's ability to connect
to the 26.3 server. Two independent failures, both silent until the bot
crash-loops with "unsupported protocol version: 26.3":

1. A NESTED `minecraft-protocol/node_modules/minecraft-data` gets installed.
   That nested copy is the 26.2 fork (3.111.0+complexity.26.2.5) and it
   SHADOWS the top-level minecraft-data (3.116.0) which is the one carrying
   the generated 26.3 protocol data. createClient() then resolves mcData for
   '26.3' as undefined and throws.

2. `prismarine-chunk` maps only up to 26.2. Mineflayer asks for
   majorVersion '26.3', so `chunkImplementations.pc['26.3']` is undefined
   and every chunk packet throws "No chunk implementation for pc 26.3".

Fix 1 = delete the shadowing nested directory.
Fix 2 = add the 26.3 key, pointing at the same pc/1.18 implementation 26.2
uses (they are the same chunk format for our purposes).

Run after ANY install, before starting the service:

    python3 tools/repair-26-3-support.py

Idempotent: safe to run repeatedly. Verifies its own work and exits non-zero
if either repair fails.
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NM = os.path.join(ROOT, "node_modules")


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def mc_data_knows_26_3(path):
    """Ask a minecraft-data install whether it can resolve 26.3."""
    probe = (
        "const md=require(process.argv[1]);"
        "process.exit(md('26.3')?0:1)"
    )
    r = subprocess.run(
        ["node", "-e", probe, path],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


# ---- Fix 1: remove shadowing nested minecraft-data -------------------------
nested = os.path.join(NM, "minecraft-protocol", "node_modules", "minecraft-data")
if os.path.isdir(nested):
    shutil.rmtree(nested)
    print("fix1: removed shadowing node_modules/minecraft-protocol/node_modules/minecraft-data")
else:
    print("fix1: no shadowing nested minecraft-data (already clean)")

resolved = subprocess.run(
    ["node", "-e",
     "console.log(require.resolve('minecraft-data',"
     "{paths:['node_modules/minecraft-protocol']}))"],
    cwd=ROOT, capture_output=True, text=True,
).stdout.strip()
if not mc_data_knows_26_3(resolved):
    fail(f"minecraft-data still cannot resolve 26.3 (resolves to {resolved})")
print(f"fix1: minecraft-data at {os.path.relpath(resolved, ROOT)} resolves 26.3")


# ---- Fix 2: register the 26.3 chunk implementation -----------------------
chunk_src = os.path.join(NM, "prismarine-chunk", "src", "index.js")
if not os.path.isfile(chunk_src):
    fail("prismarine-chunk/src/index.js not found")

src = open(chunk_src).read()
if "26.3:" in src:
    print("fix2: 26.3 chunk implementation already registered")
else:
    old = "    26.2: require('./pc/1.18/chunk')\n"
    if src.count(old) != 1:
        fail(f"expected exactly one 26.2 mapping line, found {src.count(old)}")
    new = "    26.2: require('./pc/1.18/chunk'),\n    26.3: require('./pc/1.18/chunk')\n"
    open(chunk_src, "w").write(src.replace(old, new))
    print("fix2: registered 26.3 -> pc/1.18/chunk in prismarine-chunk")

# verify
src = open(chunk_src).read()
if "26.3:" not in src:
    fail("26.3 mapping missing after edit")
print("fix2: verified 26.3 chunk implementation present")

print("\n26.3 support OK - safe to start uwu-bot.service")