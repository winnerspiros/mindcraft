## WORLD KNOWLEDGE — EVERY BLOCK, ITEM & WHAT YOU CAN DO (26.3)

Your world data is minecraft-data 26.3: 1286 blocks, 1658 items, 1010 recipes,
161 entities, 44 foods, 40 effects. EVERY name below resolves exactly — and any
other real 26.3 name resolves too (a miss suggests the closest match, so trust
the suggestion and retry). Names are always exact lowercase snake_case.

NAME RULES (this is why gathers fail — read before collecting):
- carrot -> carrots. grass -> short_grass (the plant) or grass_block (the dirt
  block). wood/log alone are NOT names — say oak_log, poplar_log, etc.
- sweet_berries is the ITEM (food); the BLOCK you gather is sweet_berry_bush.
- The wheat crop block is wheat; wheat itself is not food — craft bread first.

WOOD (10 families, all interchangeable for planks/sticks/chests): oak, spruce,
birch, jungle, acacia, dark_oak, mangrove, cherry, pale_oak, poplar. Each has
log, stripped_log, wood, stripped_wood, planks, slab, stairs, fence, fence_gate,
door, trapdoor, button, pressure_plate, sign, boat, chest_boat. Axe mines
fastest. Saplings: oak_sapling ... poplar_sapling (potted_* variants exist).
Poplar leaves come in 3 colors: red/orange/yellow_poplar_leaves.

26.3 NEW (beyond 26.2 — you know these, your data proves it):
- BLOCKS (~90): EVERY wool and concrete color (16: white orange magenta
  light_blue yellow lime pink gray light_gray cyan purple blue brown green red
  black) now has slab + stairs. Full poplar family (log/wood/planks/slab/
  stairs/fence/fence_gate/door/trapdoor/button/pressure_plate/sign/shelf/
  stripped variants). red_shrub, shelf_mushroom (hand-pick, manual-collect),
  straw_bed (a real sleepable bed, hoe-mined).
- ITEMS (~121): the same slabs/stairs as items, 16 cushions (black..yellow
  _cushion, decorative seat items, stack 16), poplar_boat + poplar_chest_boat,
  15 explorer/structure maps (buried_treasure_map, woodland_mansion_map,
  ocean_monument_map, village/pyramid/trial/ruins variants, filled_map).
- RECIPES: 97 new (poplar set, slabs/stairs, cushions). Craft with
  !craftRecipe / !getCraftingPlan — data holds all 1010.

BEDS (16, all sleepable — you own a red_bed): white orange magenta light_blue
yellow lime pink gray light_gray cyan purple blue brown green red black,
plus straw_bed.

FUNCTIONALITY MAP (which command does what):
- Gather: !collectBlocks("exact_block_name", n). Crops (wheat, carrots,
  potatoes, beetroots), torches, flowers, saplings, mushrooms, bushes
  (sweet_berry_bush, shelf_mushroom) are hand-picked, never dug — manual path.
- Craft: !craftRecipe / !getCraftingPlan. Place: !placeHere. Open/use:
  !activateBlock. Peek in chests: !viewChest. Smelt/cook: !smeltItem.
- Fight: !attackPlayer / !shoot / !shootPlayer (technique + every enchantment
  in your COMBAT notes). Sleep: any bed. Ride water: place any boat/raft and
  board it. Fly: elytra + firework_rocket (your ELYTRA notes).
- Eat: 44 foods — apple, bread, cooked_beef/porkchop/cod/salmon, steak,
  sweet_berries, glow_berries, golden_apple, cookie, mushroom_stew, etc.
  autoEat handles meals; rotten_flesh/spider_eye/poisonous_potato/pufferfish
  are banned for you.
- Maps: hold to read; buried_treasure_map leads to real loot — follow it.
- Store: chests/barrels/shulker/ender (your STORAGE notes); inventory
  auto-deposits into a nearby chest when full.

LIVING WORLD (161 entities): hostile mobs (zombie, skeleton, creeper, spider,
phantom, enderman...) — fight when brave, flee when afraid. Animals (cow, pig,
chicken, sheep, rabbit...) — hunt for food. Villagers trade. Boats are
entities once placed. Effects (40: speed, strength, poison, regeneration...)
come from potions/beacons — brew/food notes in COMBAT knowledge.
