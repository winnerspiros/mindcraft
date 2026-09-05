## ELYTRA FLIGHT — YOUR WINGS

You can fly. Not with hacks — with an ELYTRA, the glider wings. This is your reference
for everything flight: how to get a pair, how to make the fuel, how to launch, glide,
boost, land, and what will get you killed mid-air. Fly with !takeOff / !flyTo / !land /
!boost; craft fuel with !craftRecipe; gather with !collectBlocks.

WHAT AN ELYTRA IS (AND HOW YOU GET ONE):
- An elytra is a pair of wings worn in the CHESTPLATE slot (same place your chest armor
  goes). While it's on, you trade chest protection for flight. Don't worry about swapping
  back — you re-equip your chestplate + armor automatically the moment you land
  (!land / !fly / !flyTo all do this for you).
- It is NOT craftable — there is no recipe. You can only FIND it, or /give yourself one
  (you are op, so `/give UwU elytra 1` works anytime — use it to fly now, find one the
  honest way to show off).
- The honest way: elytra spawns ONLY in END CITY SHIPS, in the End dimension. In the
  treasure room of a ship there is an item frame holding a single elytra. To get there:
  1. Defeat the Ender Dragon. 2. An End Gateway portal appears — throw an ender_pearl
  through it to teleport to the outer islands. 3. Find an End City (tall purple towers).
  4. Board the ship floating nearby, break the item frame, take the elytra. Bring blocks
  to bridge and a second elytra or fireworks to fly back. End Cities usually come in
  pairs — the second ship is often reachable by gliding from the first.
- Once you have one, DON'T lose it: it is protected gear (never discarded), and on this
  server you keep your kit by re-/giving it if you die.

FUEL — FIREWORK ROCKETS (this is what pushes you through the air):
- While gliding, the ONLY fuel that boosts you forward is a FIREWORK ROCKET used in your
  hand. Without rockets you still glide, but you slowly lose altitude and can't climb.
- CRAFT the fuel (!craftRecipe firework_rocket): plain rocket = 1 paper + 1 gunpowder ->
  3 rockets. These are flight-duration-1 boost rockets — perfect for elytra.
  - paper = 3 sugar_cane in a row (!craftRecipe paper; sugar_cane grows by water).
  - gunpowder = drop from CREEPERS (kill them before they explode), ghasts, witches, or
    loot chests.
- ALL the fuel variants, and which to actually use:
  - FLIGHT 1 rocket (1 gunpowder + 1 paper) = 3 rockets, short boost. Fine for casual
    hops. FLIGHT 2 (2 gunpowder) and FLIGHT 3 (3 gunpowder + paper) boost longer and
    farther per rocket — use flight 3 for long journeys. (Add more gunpowder to the
    recipe to raise the duration.)
  - STAR rockets (paper + gunpowder + a firework_star) EXPLODE and deal damage — they do
    NOT boost. NEVER use star rockets for flying; they blow up in your face. Stars are
    for celebrations and dispenser traps, not flight.
  - There is no other elytra fuel. No coal, no blaze powder, nothing else — only firework
    rockets. (Riptide tridents launch you in rain/water, but that's a launch trick, not
    fuel.)

HOW YOU FLY (the actual technique):
- EQUIP: put the elytra on (!equipElytra, or !equip("elytra")) and hold a firework rocket
  (!boost will auto-equip one). You can't wear a chestplate and elytra at the same time.
- LAUNCH: the elytra only deploys while falling, but you DON'T need a cliff. With a
  firework rocket you can take off IN PLACE — hold a rocket, look up, jump, deploy the
  wings, and fire the rocket for instant height (this is !takeOff's default when you have
  fuel). Without a rocket, jump off a cliff, tower, or tall tree and deploy as you fall.
- GLIDE: once deployed you glide in the direction you LOOK. Look DOWN (pitch down) to
  dive and pick up speed; look UP (pitch up) to slow and level out; look where you want
  to go. Speed is your friend for distance — dive a little, then level out to cruise.
- BOOST: while gliding, right-click a rocket (!boost) to rocket forward in your look
  direction and climb/regain altitude. Space boosts ~2 seconds apart; don't spam them all
  at once or you'll waste fuel and overshoot.

GOOD LIFTOFF SPOTS (highest point wins):
- Tall cliffs and mountains, End City towers, pillager towers, tall jungle/big trees,
  rooftops, the top of your builds. Anything high with clear air in front of it.
- The BEST liftoff has open sky ahead (no walls/trees in your flight path) and soft
  ground below in case you need to bail early.
- IF YOU HAVE ROCKETS, DON'T BOTHER BUILDING A LAUNCHPAD: !takeOff rocket-jumps you into
  the air right where you stand (look up, hop, deploy, boost). Save the towers for when
  you're out of fuel.

HOW YOU LAND (soft, alive, and on your feet):
- Aim for flat open ground — a field, a path, a beach — NOT into a forest or wall.
- Descend gradually: pitch down to lose altitude, then PITCH UP / level out a moment
  before the ground so you glide in shallow and drop the last block or two onto your
  feet. The elytra switches off automatically when you touch the ground.
- Safety net: feather_falling boots, a slow_falling potion, or a water bucket (MLG —
  place water at your feet the instant before impact) all soften a hard landing. When in
  doubt land in WATER (shallow, and swim to shore fast — you sink in deep water).

WHAT TO AVOID WHILE FLYING (the things that kill a flier):
- Running out of rockets over the VOID (the End) or over deep WATER — you'll fall and
  die/drown. Carry spare rockets and know your fuel before a long crossing.
- WALLS, mountains, trees, and cliffs directly in your flight path — you can't stop on a
  dime; you'll slam into them. Look ahead, not just down.
- Low ceilings and overhangs — flying under one traps you and clips your head.
- LAVA below, and flying too low over water (a dive into water at glide speed hurts, and
  deep water drowns you with the wings on).
- Star rockets (they explode), and hitting the ground at full dive speed (angle is
  everything — dive to descend, level out to survive).
- End crystals, and anything you're not looking at — the glider steers by your eyes.

COMMAND / API CHEAT SHEET:
- !fly(seconds) — the one to use when a player asks you to fly: rocket-jump into the air,
  then cruise forward with a rocket boost every ~2.5s so you stay airborne, then glide
  down and land. Default ~12s in the air.
- !takeOff — just LAUNCH (equip wings, rocket-jump in place, or build a tower if out of
  fuel). It already equips your elytra, so you never need to !equipElytra first. It does
  NOT keep you flying — pair it with !boost/!fly for sustained air time.
- !flyToPlayer("name") / !flyTo(x, y, z) — fly (glide + auto-boost) to a player or coords and land near it.
- !boost — fire a rocket for a burst of speed/altitude while gliding.
- !land — descend and touch down gently.
- !equipElytra / !equipFireworkRocket — manually gear up.
- !buildTower(height) — pillar up a launchpad where there's no high ground.
- !craftRecipe("firework_rocket", N) — make boost fuel; !collectBlocks("sugar_cane"/"cobblestone", N).
- In !newAction: skills.takeOff(bot), skills.flyWithElytra(bot, x, y, z),
  skills.boostWithFirework(bot), skills.landWithElytra(bot), skills.buildLiftoffTower(bot, h).
