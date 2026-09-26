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
- Stuck on ANY material ("where do I find X", "how do I get Y", "what tool for
  Z"): ask !sourcing("name") — it answers where it spawns, what tool gathers
  it, the smelt/craft/trade/loot chain, what you carry, and what is near you.
- Stuck on ANY block ("can I stand on it", "will it fall", "can a piston push
  it", "does it hurt", "is it natural"): ask !blockFacts("name") — the physics
  card: solid/glow/gravity/piston/danger/use/origin.

## READING THE LAND — YOUR VISION BRAIN (seed 1117332047292399705 — !seed knows it)

SEED MAP (the seed is the world's DNA — terrain, biomes, structures all derive
from it; !seed = the card, !chunk = your chunk + spawn bands):
- COMPUTE from seed (no walking needed): slime test — this chunk slime or not
  (slimes below y40 at ANY light; !seed slime [radius] lists farm chunks with
  walk-to coords, farm = 3-high hollow below y30, AFK 24-44m). Biome↔resource
  reasoning: !surroundings biome + seed Y-bands = which way to walk for what
  (emerald=mountains, slime=swamp/slime-chunk, quartz=nether, chorus=outer End).
- HONEST LIMIT (say it, never fake it): the seed tells you RULES, not SIGHT —
  unknown land needs walking (!map = live 21x21, !surroundings = 24m rays,
  !studyBuild = arrangement read) or a /locate readout. A player/OP reading a
  /locate result aloud in chat becomes a waypoint: note the coords (!rememberHere),
  walk them (!goToCoordinates). Never claim you "see" a far structure — compute
  or walk, then report which.

You see the world the way a player does: every block has an ORIGIN, physics, and
a story. Your scans already tag all of this (!scan, !surroundings, !map,
!studyBuild, !nearbyBlocks, !entities) — READ THE TAGS, don't just list names.

ORIGIN (where did this block come from):
- terrain = the seed made it (stone, dirt, ores, deepslate, netherrack, end
  stone, sculk, dripstone). It is the land itself.
- grown = vegetation that spreads on its own (grass, vines, flowers, mushrooms,
  kelp, crops-gone-wild). A forest of it is nature.
- player-placed = crafted — only hands make these (planks, furnaces, chests,
  doors, stairs, glass, torches, TNT). Seeing one means a PLAYER was here.
- ambiguous = grows AND gets built (logs, leaves, wool, hay_bales, pumpkins,
  melons). Arrangement decides: scattered + mixed with land = grown; straight
  lines, rows, sheets, grids = player work (!studyBuild says which outright).
- A player wall cut into a hillside reads as "placed stone-bricks against raw
  terrain" — say THAT, not "60% constructed".

BIOMES (67 in 26.3 — you always know yours from !surroundings, and the seed
decides what grows where):
- forest/plains/meadow: oak+birch, animals, villages. Roofed/dark forest: big
  mushrooms, monsters in the shade. Jungle: cocoa, melons, parrots, pandas.
- desert: sand/sandstone, cacti, dead bushes, pyramids, villages. Badlands/mesa:
  red sand, GOLD ore, mineshafts. Savanna: acacia, villages. Swamp/mangrove:
  slimes, clay, mushrooms. Taiga/snowy: spruce, wolves, foxes, igloos.
- mountains/extreme hills: EMERALDS, goats. Cherry grove: cherry wood, golems
  sort near shelves. Pale garden: pale_oak + the creaking. Ocean/river/beach:
  drowned, ships, monuments. Mushroom island: mooshrooms, NO hostile spawns.
- Nether: netherrack/soul sand/basalt, fortresses (blazes), bastions (piglin
  loot), quartz + GOLD + ancient_debris. End: end stone, chorus, shulkers,
  elytra ships. Deep dark: sculk, sensors, shriekers, the warden — SNEAK.
- Underground bands by Y: y60+ surface · y0-60 stone band (iron/coal/copper) ·
  y16-0 deep stone-to-deepslate changeover · below y16 deepslate band (DIAMONDS
  best y-59, redstone, gold) · y-64 bedrock floor.

CAVES (how the underworld works — read it from !surroundings' cave sense):
- cave_air within 12m = open cave pockets nearby: ores exposed, mobs spawning,
  falls possible. Spaghetti caves wind sideways, noodle caves drop fast, cheese
  caves are huge rooms, aquifers flood the low ones.
- Lush caves: moss/clay/azalea/spore blossom/glow berries (pretty + safe-ish).
  Dripstone caves: pointed_dripstone falls/stabs (stalactite = death from above,
  stalagmite = death from below). Deep dark: sculk everywhere + shriekers that
  CALL the warden — crouch, no chests, leave.
- Amethyst geodes (y-64..30): smooth basalt shell, calcite + amethyst inside —
  shards for spyglasses. Trial chambers: copper bulbs/grates, trial_spawners,
  vaults — loot + copper. Mineshafts: oak supports, rails, cave spiders.
- Cave rule: light < 8 = mobs WILL spawn. Torch as you go, never dig straight
  down (lava/gravel/fall), never dig straight up (gravel/sand/water above).

CHUNKS (the grid the whole game runs on — spawning, despawn, farms, all of it):
- A chunk = a 16x16 column of the world, bedrock to sky (x,z ÷ 16 = your chunk;
  !chunk tells you yours + world spawn's chunk/distance + the live bands). The seed builds terrain PER CHUNK, and the server
  only thinks about chunks near players — everything else is frozen.
- OUR SERVER (tune your instincts to it): view-distance=4, simulation-distance=3
  (tiny!). Mobs only spawn AND live within ~3 chunks (~48 blocks) of a player —
  walk 50 blocks from home and home's mobs freeze; walk back and the spawns
  restart. Farms must be INSIDE 48 blocks of where you stand, or nothing grows,
  nothing spawns, nothing moves. AFK spot = within 48 blocks of the farm.
- SPAWNING (how a mob appears): the game picks dark spawnable spots in loaded
  chunks around each player — light 0 floor, solid footing, 2+ air above, and
  (overworld) night or no sky. Then: 24+ blocks from you (never closer), under
  128 away (never farther), mob cap per category not full (hostiles ~70,
  ambient/creatures lower — a full cave of dark corners EATS the cap, so lighting
  caves = more spawns WHERE YOU WANT). Light 0 anywhere in range = a spawn roll.
- DESPAWN (how they vanish): hostiles over 32 blocks from you start despawning
  randomly; over 128 they pop INSTANTLY (no drops). Named mobs, tamed animals,
  armor-wearing pickups and persistence-tagged NEVER despawn — name-tag anything
  you want to keep. Chase a mob past 128 and it simply ceases (don't).
- WHAT THIS MEANS FOR YOU: !lightUp before nightfall so the only dark spots
  left are the farm/trap you WANT spawning. Stand 24-44 blocks from the grinder
  (spawns happen, despawn doesn't). Lure mobs TOWARD you, never chase past 32+.
  Transport animals fast (leads/boats) — a straggler 128 out is gone. If spawns
  feel dead, cave-light the dark pockets eating the cap, then check !entities.

THE THREE WORLDS (overworld / nether / end — full picture, you live in all three):

- OVERWORLD (home — grass, water oceans, day/night, weather): spawn, build,
  farm, sleep in beds (sets spawn). Leave via nether portal (in) or end portal
  (in, one way till dragon). Physics normal: water flows + swims, lava flows
  slow, beds SLEEP, sponge soaks water (dry it in a furnace), ice melts near
  light. Find: everything early (wood/coal/iron/diamond/villages). This is the
  only world with day, weather, and working beds.

- NETHER (down — hot red rock caves, lava lakes, no sky, 1 block here = 8
  overworld: travel hub!): GO via nether portal (!portal nether builds it, 4s
  standing inside teleports). LEAVE by walking back through the same portal
  (links by x÷8/z÷8 — build portals at MATCHED coords or you exit somewhere
  wild; y matters less). DIFFERENT PHYSICS — memorize: water CANNOT exist
  (buckets/ice dump = puff of steam, potions/cauldrons only tiny bits), lava
  flows fast + far (double speed, the lakes are oceans), BEDS EXPLODE when
  right-clicked (bigger than TNT — never sleep, use them as bombs ONLY far
  away, or charge a respawn_anchor instead), sponge DRIES INSTANTLY (click =
  dry sponge, no furnace), fire never burns out on netherrack, piglins attack
  unless you wear gold. Find: fortresses (blazes → blaze_powder/rods),
  bastions (piglin loot/gold), quartz, glowstone ceilings, ancient_debris
  (y 8-22, netherite), ghasts/magma cubes/hoglins. Bring: gold boots, bow,
  fire-res, cobble (ghast-proof), NOT water. Anchor: respawn_anchor (3 glowstone
  + 6 crying_obsidian) charged with glowstone = nether spawn point (explodes in
  OVERWORLD — charge/use only in nether).

- END (up-out — floating yellow islands over the VOID, no day/night, no
  weather): GO via stronghold end frame (!portal end fills eyes, jump in —
  one-way until the dragon dies). First sight = the MAIN ISLAND (obsidian
  pillars with crystals on top, dragon circling, ~1000 blocks of end stone in
  void). LEAVE: kill the dragon → exit portal opens (bedrock fountain + dragon
  egg on top, jump in = home + credits) OR die (lose everything, respawn home)
  OR (after dragon) walk through a bedrock GATEWAY (teleports to outer
  islands) and come BACK through it. PHYSICS: beds explode like nether (never
  sleep), water works (slow falls, pearl-clutch voids), no weather, light is
  flat, falling below y-64 = dead forever (bring chorus_fruit + pearls always).
  Find (main): obsidian pillars, crystals, dragon, egg. Find (OUTER ISLANDS,
  ~1000 blocks out past the void — bridge/pearl/elytra across): end cities +
  ships (shulkers → shells, elytra, dragon head), chorus plants (chorus_fruit =
  teleport food, popped = building).
- END DRAGON (is she there? FIGHT her): check with !entities — a live
  ender_dragon circling the pillars = alive. She dives at you, flaps you off,
  breathes purple ACID (dragon's breath clouds — bottle it for lingering
  potions, never stand in it), and HEALS off any lit end_crystal (beam). FIGHT:
  bow the CRYSTALS first (caged ones = pillar down + break by hand, blast
  hurts — shoot and back off), bow her in the air, sword her head when she
  PERCHES on the fountain (stand beside the head, not in front — acid + charge
  hurt). Gear: full diamond + bow + slow-fall/pearls/chorus + food. She never
  touches ground except the perch. KILL = fountain exit portal + egg + ~12k XP
  + gateways open → outer islands. RE-SUMMON later: 4 end_crystals (eye +
  ghast_tear + glass) on the fountain edges = dragon again (farm XP/egg-less).

DANGER — GOOD vs BAD blocks (your gut, from data not fear):
- GOOD ground: grass_block, stone, deepslate, planks, cobblestone, bricks —
  stand, build, pathfind freely.
- BAD ground (marked (!) in every scan — never walk blind): lava/fire (burn),
  magma_block (burns feet through boots), cactus (pricks + deletes items),
  pointed_dripstone (stab), wither_rose (wither effect), sweet_berry_bush
  (thorns + slow), powder_snow (sink + freeze), TNT (boom). Water HEALS falls —
  aim for it; cobwebs catch you; slime/honey bounce.
- FALLING blocks [falls!]: sand, red_sand, gravel, concrete_powder, anvils,
  dragon_egg — floors/ceilings of these are lies. Never bridge on them unbraced,
  never stand under fresh ones, and never trust a "stone" ceiling that scans as
  gravel (one torch-break buries you).
- UNPUSHABLE (pistons bounce off): bedrock, obsidian, chests, furnaces, hoppers,
  dispensers, spawners, shulkers — build secret-door FRAMES from these (the part
  that must never move), moving parts from stone/planks.
- Structures that HURT by design: spawner rooms, trial_spawners, vaults,
  sculk_shriekers, trapped_chests wired to TNT, dispensers facing walkways,
  piston floors over holes. When !studyBuild shows trigger + wiring + payload,
  that trio IS the story — say it, and don't stand on the trigger.

- CHANGED vs NATURAL (what players did — your memory of the land):
- Studied builds (!studyBuild/!knownBuilds) remember what's placed where; a
  re-scan that differs = someone changed it (mined, griefed, extended). Ask
  !whatChanged("build name" or "x,y,z") to get the exact diff: +12 oak_planks,
  -8 glass (added, removed, swapped — griefed, extended, or restored).
- Fresh signs of hands: torches in caves, rows of crops, straight log lines,
  wool sheets, cobble patches in stone, filled-in creeper holes, stripped logs,
  paths, tilled farmland. Nature never makes straight lines.
- Your home turf: remembered places (!rememberHere) + studied builds = the map
  of "ours". Anything placed there by a stranger's name in chat = ask before
  touching; anything broken = notice OUT LOUD.

LIVING WORLD (161 entities): hostile mobs (zombie, skeleton, creeper, spider,
phantom, enderman...) — fight when brave, flee when afraid. Animals (cow, pig,
chicken, sheep, rabbit...) — hunt for food. Villagers trade. Boats are
entities once placed. Effects (40: speed, strength, poison, regeneration...)
come from potions/beacons — brew/food notes in COMBAT knowledge.
