## STORAGE & CONTAINERS — CHESTS, FURNACES, HOPPERS & CO.

This is your reference for every container and machine block you might want for our home:
what it is, how to CRAFT it, how to GET it the honest way, and how to USE it. Gather with
!collectBlocks, craft with !craftRecipe, place with !placeHere, open with !activateBlock,
peek inside chests with !viewChest, and smelt with !smeltItem.

STORAGE ROUTINE (do this naturally, on your own — not just when a player asks):
- Your inventory auto-deposits into a nearby chest whenever it fills up — that is normal.
- When you need to STORE or drop off items, look for an existing chest nearby first
  (up to 32 blocks) and use it. Only craft + place a NEW chest if there genuinely is
  no chest around — don't clutter the home with new chests when one already exists.
- For LOTS of items, prefer a DOUBLE CHEST (two chests side-by-side = one 54-slot box,
  !doubleChest builds + verifies it) over a single 27-slot chest. For SORTED rows where
  each box must stay separate, sneak-place singles (!singleChest) or alternate
  normal/trapped — crouch placement never merges.

THE STORAGE BLOCKS (hold items):

- CHEST — the basic box. 27 slots. Craft: 8 planks in a ring (any wood, middle empty).
  Get: craft from planks. Use: !placeHere, open with !activateBlock, see contents with
  !viewChest.
- DOUBLE CHEST (prefer this for bulk — one 54-slot window beats two 27s) — place two
  chests side-by-side (same row, same height) and they MERGE into one 54-slot box: one
  lid, one window, one trip to dump a full inventory. Wood type does NOT matter (oak +
  birch merge fine). Max merge is TWO — a third chest beside a double stays single. A
  chest can merge with only ONE neighbor, so plan rows as pairs with one gap (or a
  trapped_chest) between pairs. Build it standing (!doubleChest does this: crafts the
  2 chests, places the second standing, opens the window to verify 54). Keep one air
  block above the pair or the lid won't open (barrels don't care — see below). A chest
  against a wall still opens as long as the block above is air.
- STAYING SINGLE (how to NOT merge — you looked it up right): placing while CROUCHING
  (sneak-held) never merges — the new chest stays its own 27 slots even glued to a
  neighbor. Use for category walls: many separate boxes packed side-by-side, each its
  own window (!singleChest = sneak-place). Other no-merge shapes: a normal chest NEVER
  merges with a trapped_chest (alternate normal/trapped for packed rows + alarm — see
  below), an ender_chest never merges with anything, and a chest hemmed in on BOTH
  sides can't merge either (doubles only). Standing placement = merge, sneak = single.
- WHY DOUBLE (the gain): 54 slots in ONE window (no hopping between boxes), one lid
  animation, one hopper line feeds/drains the whole 54, half the floor footprint per
  slot vs two singles with a gap, and auto-deposit fills the pair before a new box.
  Cost: 16 planks (2 chests) + one air block above. Rule: bulk goes double (cobble,
  dirt, farm output, loot dumps); SORTED categories go sneak-placed singles or
  normal/trapped alternation.
- TRAPPED CHEST — a chest that also sends a redstone signal when opened, strength by viewer
  count (1 viewer = weak ... 15 = full lobby). Craft: 1 chest + 1 tripwire_hook
  (tripwire_hook = 1 iron_ingot + 1 stick + 1 plank). NEVER merges with a normal chest, so you
  can pack normal + trapped side-by-side as separate boxes. Use: storage PLUS a silent alarm —
  wire it to a trap/light that triggers the moment someone snoops.
- COPPER CHEST (26.x family: copper_chest + exposed/weathered/oxidized + waxed variants) — a
  chest that OXIDIZES through 4 color stages (purely visual), wax with honeycomb to freeze the
  look, axe to scrape back. Craft: 1 normal chest + copper ingots. COPPER GOLEMS interact with
  them (they pull items out and sort them into nearby normal chests — build a golem + copper
  chest + normal chests for a living sorter). Two adjacent copper chests merge into a LARGE
  copper chest EVEN across different oxidation/wax states — the pair takes the LEAST-oxidized
  stage, and goes unwaxed if either half is unwaxed. So: wax a pair to freeze the look, or the
  greenest half drags the other down.
- BARREL — storage just like a chest (27 slots) but opens from the FRONT face, so it works with
  a solid block directly above it AND stacked in towers. Craft: 6 planks (top+bottom rows) +
  2 wood_slab (middle-left + middle-right). Use: store stuff where a chest lid would be blocked;
  barrels NEVER merge — each one is always its own 27 slots.
- SHULKER BOX — portable 27-slot storage that KEEPS its items when you break/pick it up.
  Craft: 1 chest + 2 shulker_shell (shapeless, any workbench). Get shells: kill shulkers in
  End Cities / End ships (outer End islands past the dragon — the ONLY source; each kill drops
  0-1 shell, so 2 kills minimum per box). NEVER merges — place two side-by-side and they stay
  two boxes. Break with any pickaxe (keep Fortune OFF it — no benefit), carry the full box,
  place it to unpack. Use: your backpack — fill it, carry it, place it, break it to take the
  whole load with you. Dyeable (1 box + 1 dye = colored box). Pro move: one box per kit (fight
  box, build box, food box) + an ender chest as the shuttle — boxes keep contents through death
  ONLY if the box itself survives the blast/fire.
- SHULKER MOB (the fight, not the box): End-City shells that hide camouflaged as
  a box, open and fire HOMING bullets. Hit = LEVITATION 10s (you float up, then FALL
  — the fall kills, not the bullet). Dodge: strafe behind pillars (bullets die on walls),
  never stand in the open, kill with sword/bow between its open phases (closed shell = armored,
  open = vulnerable). Falling out of the world = bring chorus_fruit (eats = teleport to safety)
  and pearls. Levitation + low ceiling = bonk; levitation in the open = pillar down with blocks
  or ride it out, then water/boat-fall the landing. Loot shells first, sightsee second.
- ENDER CHEST — your private cross-world vault. 27 slots, SHARED across every
  ender chest everywhere, and YOURS ALONE (per-player inventory — other players
  opening the same physical chest see THEIR stuff, never yours; never drops on
  death, never merges with anything). Craft: 8 obsidian in a ring + 1
  eye_of_ender in the middle (eye = blaze_powder + ender_pearl; obsidian = mine
  water+lava with a diamond pickaxe). Mine it with ANY pickaxe (silk touch NOT
  needed — it always drops itself, 8 obsidian is safe to re-place anywhere).
  HONEST USEFULNESS: this is the single best storage in the game and it is not
  close — one vault slot-set reachable from EVERY ender chest you ever place or
  find (home, outpost, nether hub, End platform). Death-proof (contents survive
  you), grief-proof (nobody can loot YOUR vault by breaking the chest), travel
  light (carry the vault, not the valuables). Combo: full shulker boxes live IN
  the vault = 27 boxes x 27 slots of pocket dimension. Rule: valuables (diamonds,
  netherite, elytra, shells, eyes) live in the vault, never in a wooden chest.
- SPOTTED ONE IN THE WORLD (protocol — a placed ender_chest that isn't yours):
  1) It is NOT loot — breaking it only drops 8 obsidian and shows you NOTHING
  (contents are per-player, you see only your own vault). Never break one
  hoping for treasure. 2) USE it on the spot: open it (!viewChest / !putInChest
  / !takeFromChest all reach ender chests) — deposit valuables, pull what you
  need, it is YOUR vault through THEIR chest. 3) REPORT it: remember where
  (!rememberHere "ender chest at ...") — every found chest is a free bank branch.
  4) RESPECT it: a chest inside someone's build is theirs — bank through it, then
  leave it standing. Place your OWN at home (!craftRecipe ender_chest +
  !placeHere) so the network has two ends.

THE MOVER & MACHINE BLOCKS (redstone / automation):

- HOPPER — pulls items from the block above and pushes them into the container it faces
  (down by default). Craft: 5 iron_ingot + 1 chest (iron top-left, top-right, middle-left,
  middle-right, bottom-middle; chest in the center). Get: smelt iron_ore (!smeltItem).
  Use: chain hoppers into a chest/furnace to auto-collect and auto-sort items.
- DISPENSER — USES or SHOOTS its contents when redstone-powered: fires arrows, throws
  splash potions, places water/lava buckets, lights TNT, shoots eggs/snowballs. Craft:
  7 cobblestone + 1 bow + 1 redstone_dust (bow center, redstone below it, cobblestone in
  the U around them). Use: arrow turrets, lava traps, automated item launchers.
- DROPPER — DROPS its contents (never uses them) when powered. Craft: 7 cobblestone +
  1 redstone_dust (same U, redstone bottom-center, center empty). Use: pass items along a
  hopper line, dispense loot, or eject items onto the floor.
- CRAFTER — auto-crafts when pulsed. Open it, toggle slots to lock in a recipe, power it,
  and it spits out the result. Craft: 5 iron_ingot + 1 crafting_table + 1 dropper +
  2 redstone_dust (iron top row + middle-left + bottom-left, crafting_table center, dropper
  middle-right, redstone bottom-middle + bottom-right). Use: automatic item factories.

THE SMELTING & BREWING BLOCKS:

- FURNACE — smelts ores and cooks food. Fuel goes in the bottom, input on top, result
  pops out the side. Craft: 8 cobblestone in a ring. Use: !smeltItem("iron_ore"/"beef", N)
  does the work for you (or place one and use it by hand).
- BLAST FURNACE — smelts ORES (and armor/tools) 2x faster than a furnace, but only ores.
  Craft: 1 furnace (center) + 5 iron_ingot (top row + middle-left + middle-right) +
  3 smooth_stone (bottom row). Get: smooth_stone = smelt stone twice.
- SMOKER — cooks FOOD 2x faster than a furnace, but only food. Craft: 1 furnace (center)
  + 4 logs (top, bottom, left, right). Use: fast kitchen for meat/fish.
- BREWING STAND — brews potions. Needs blaze_powder as fuel, water bottles, and an
  ingredient (nether_wart to start, then e.g. sugar/ghast_tear/blaze_powder for effects).
  Craft: 1 blaze_rod (center) + 3 cobblestone (bottom row). Get: blaze rods from blazes in
  the Nether. Use: brew healing/strength/speed potions for fights and long trips.

THE FANCY ONES:

- CHISELED BOOKSHELF — holds up to 6 books (regular or enchanted). Craft: 6 planks
  (top+bottom rows) + 3 wood_slab (middle row). Use: store books, or wire next to an
  enchanting table / lectern for a stronger enchanting setup.
- BUNDLE — a little bag that holds up to one stack's worth of MIXED items (e.g. 30 arrows
  + 20 dirt + 14 sticks = one full bundle). Craft: 2 string (top-left + top-right) +
  6 rabbit_hide (the rest). Get: string from spiders/cobwebs, rabbit hide from rabbits.
  Use: pocket organizer for small bits that don't stack together.

QUICK CRAFT CHEAT SHEET:
- chest = 8 planks ring · furnace = 8 cobblestone ring · barrel = 6 planks + 2 wood_slab
- trapped_chest = chest + tripwire_hook · ender_chest = 8 obsidian + eye_of_ender
- shulker_box = chest + 2 shulker_shell · hopper = 5 iron_ingot + chest
- dispenser = 7 cobblestone + bow + redstone_dust · dropper = 7 cobblestone + redstone_dust
- crafter = 5 iron_ingot + crafting_table + dropper + 2 redstone_dust
- blast_furnace = furnace + 5 iron_ingot + 3 smooth_stone · smoker = furnace + 4 logs
- brewing_stand = blaze_rod + 3 cobblestone · chiseled_bookshelf = 6 planks + 3 wood_slab
- bundle = 2 string + 6 rabbit_hide

BEDS & SLEEP (mechanics she must get right):
- Normal beds (16 colors, *_bed): sleep at NIGHT or during a THUNDERSTORM to skip to morning;
  sleeping SETS your spawn point to that bed. A bed is 2 blocks long (foot + head) and needs the
  space clear; it EXPLODES in the Nether and the End (never sleep there — anchor or straw only).
  Sleep with !goToBed (nearest bed), !sleepNearPlayer (next to someone), or click it.
- STRAW BED (26.3, straw_bed): the TRAVEL bed. Craft: 3 hay_bale in one horizontal row (needs a
  crafting table) → 4 straw beds at once (each bale = 9 wheat, so 27 wheat per batch). Sleep ONE
  night in it and it VANISHES (consumed, no drop) — and it NEVER sets your spawn. Carry a stack
  on trips, keep a wool bed at home for the real spawn. Same Nether/End rule: it breaks there too.
- Skip-the-night math: one player in bed is usually NOT enough on a server — the night skips when
  enough sleepers agree (gamerule). So: ask in chat, wait for others, or accept the night.
- Respawn logic: die with a wool-bed spawn set → wake at that bed (if the bed/space is gone →
  world spawn instead). Die with only straw sleeps behind you → world spawn, every time.
  She keeps a real bed claimed and never "moves home" by accident.
