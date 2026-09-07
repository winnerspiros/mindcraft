import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

export function log(bot, message) {
    bot.output += message + '\n';
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function acquireBlocks(bot, blockType, count, _depth = 0) {
    /**
     * Ensure the bot has at least `count` of `blockType` in inventory by gathering
     * raw materials and crafting, survival-style (no /give, no /fill). Returns the
     * number of `blockType` now held (may be less than requested if materials ran out).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} blockType - the block/item to acquire, e.g. 'oak_planks'.
     * @param {number} count - how many are wanted.
     * @returns {Promise<number>} the number of blocks now in inventory.
     * @example
     * await skills.acquireBlocks(bot, 'oak_planks', 64);
     **/
    count = Math.max(1, Math.floor(count));
    const haveCount = () => world.getInventoryCounts(bot)[blockType] || 0;

    let have = haveCount();
    if (have >= count) return have;

    if (_depth > 6) {
        log(bot, `Recipe chain too deep for ${blockType}.`);
        return have;
    }

    const recipes = mc.getItemCraftingRecipes(blockType);
    if (recipes && recipes.length > 0) {
        // recipes[0] = [ {ingredientName: countPerCraft, ...}, {craftedCount} ]
        const [ingredients, out] = recipes[0];
        const craftedCount = (out && out.craftedCount) || 1;
        const need = count - have;
        const crafts = Math.ceil(need / craftedCount);
        for (const [ing, perCraft] of Object.entries(ingredients)) {
            if (bot.interrupt_code) return haveCount();
            await acquireBlocks(bot, ing, crafts * perCraft, _depth + 1);
        }
        await craftRecipe(bot, blockType, crafts);
        have = haveCount();
        if (have >= count) return have;
        log(bot, `Couldn't gather enough ${blockType} (have ${have}, need ${count}).`);
        return have;
    }

    // Not craftable — collect it directly from the world.
    await collectBlock(bot, blockType, count - have);
    return haveCount();
}

export async function placeBlockList(bot, block, positions) {
    /**
     * Place a list of [x, y, z] positions one block at a time, survival-style
     * (real placement that consumes inventory — no /fill or /setblock cheat).
     * Gathers and crafts the material first, then places bottom-up so every block
     * has support. Returns the number of blocks actually placed.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type to build with, e.g. 'oak_planks'.
     * @param {number[][]} positions - array of [x, y, z] integer coordinates.
     * @returns {Promise<number>} blocks placed.
     * @example
     * await skills.placeBlockList(bot, 'oak_planks', [[0,64,0],[1,64,0]]);
     **/
    if (!positions.length) return 0;

    // Bottom-up (y asc) so lower layers are placed first; within a layer, place
    // edge blocks before interior so ceiling blocks always have a neighbour to
    // build off of.
    const xs = positions.map(p => p[0]), zs = positions.map(p => p[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const edgeDist = (p) => Math.min(p[0] - minX, maxX - p[0], p[2] - minZ, maxZ - p[2]);
    positions = [...positions].sort((a, b) => a[1] - b[1] || edgeDist(a) - edgeDist(b));

    const have = await acquireBlocks(bot, block, positions.length);
    if (have < positions.length) {
        log(bot, `Only gathered ${have}/${positions.length} ${block} — building with what I have.`);
    }

    let placed = 0;
    for (const [x, y, z] of positions) {
        if (bot.interrupt_code) break;
        if (await placeBlock(bot, block, x, y, z, 'bottom', true)) placed++;
    }
    log(bot, `Placed ${placed}/${positions.length} ${block} blocks.`);
    return placed;
}

export async function hollowBox(bot, block, width, depth, height) {
    /**
     * Build a hollow box — floor, 4 walls and a ceiling — with an empty walkable
     * interior. Use this to build houses and rooms (NOT a solid cube). Carve a
     * doorway afterwards if you need to walk inside.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type to build with, e.g. 'oak_planks'.
     * @param {number} width - x size in blocks (min 3 for a hollow interior).
     * @param {number} depth - z size in blocks (min 3).
     * @param {number} height - y size in blocks (min 3).
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.hollowBox(bot, 'oak_planks', 7, 7, 4);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + width; x++)
        for (let y = by; y < by + height; y++)
            for (let z = bz; z < bz + depth; z++) {
                const shell = x === bx || x === bx + width - 1 || y === by ||
                    y === by + height - 1 || z === bz || z === bz + depth - 1;
                if (shell) positions.push([x, y, z]);
            }
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built hollow ${block} box ${width}x${depth}x${height} (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function buildFloor(bot, block, width, depth) {
    /**
     * Build a flat floor of a given block, width x depth, at your feet.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type, e.g. 'oak_planks'.
     * @param {number} width - x size in blocks.
     * @param {number} depth - z size in blocks.
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.buildFloor(bot, 'stone_bricks', 10, 8);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + width; x++)
        for (let z = bz; z < bz + depth; z++)
            positions.push([x, by, z]);
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built ${block} floor ${width}x${depth} (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function buildWalls(bot, block, length, height = 4) {
    /**
     * Build a straight 1-block-thick wall, `length` long and `height` tall, along +X
     * from your position.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type, e.g. 'stone_bricks'.
     * @param {number} length - wall length in blocks.
     * @param {number} height - wall height in blocks (default 4).
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.buildWalls(bot, 'cobblestone', 12, 4);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + length; x++)
        for (let y = by; y < by + height; y++)
            positions.push([x, y, bz]);
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built ${block} wall ${length}x${height} (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function buildBridge(bot, block, length, width = 3) {
    /**
     * Build a flat bridge with two side railings, `length` long and `width` wide,
     * extending along +X from your position.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type, e.g. 'oak_planks'.
     * @param {number} length - bridge length in blocks.
     * @param {number} width - bridge width in blocks (default 3).
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.buildBridge(bot, 'oak_planks', 8, 3);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + length; x++) {
        for (let z = bz; z < bz + width; z++) positions.push([x, by, z]); // deck
        positions.push([x, by + 1, bz]); // rail
        positions.push([x, by + 1, bz + width - 1]); // rail
    }
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built ${block} bridge ${length} long x ${width} wide (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function mountNearestEntity(bot, type) {
    /**
     * Mount the nearest mountable entity — a boat, minecart, horse, donkey, mule,
     * pig or strider — or a specific type if given. Ride animals need a saddle.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} type - optional entity type, e.g. 'horse' or 'boat'.
     * @returns {Promise<boolean>} true if mounted.
     * @example
     * await skills.mountNearestEntity(bot, 'boat');
     **/
    const mountable = ['boat', 'minecart', 'horse', 'donkey', 'mule', 'pig', 'strider', 'camel'];
    const entity = world.getNearestEntityWhere(bot, type ? (e) => e.name === type : (e) => mountable.includes(e.name), 8);
    if (!entity) {
        log(bot, `No ${type || 'mountable entity'} nearby.`);
        return false;
    }
    try {
        await bot.mount(entity);
        log(bot, `Mounted ${entity.name}.`);
        return true;
    } catch (e) {
        log(bot, `Could not mount ${entity.name}: ${e.message}`);
        return false;
    }
}

export async function dismount(bot) {
    /**
     * Dismount the entity you are riding (boat, horse, minecart, etc).
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if dismounted.
     * @example
     * await skills.dismount(bot);
     **/
    if (!bot.vehicle) {
        log(bot, 'Not riding anything.');
        return false;
    }
    bot.dismount();
    log(bot, 'Dismounted.');
    return true;
}

export async function spawnAndMountBoat(bot) {
    /**
     * Spawn an oak boat at your position (you are OP) and mount it for water travel.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if mounted.
     * @example
     * await skills.spawnAndMountBoat(bot);
     **/
    const pos = bot.entity.position;
    bot.chat(`/summon oak_boat ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`);
    await new Promise(r => setTimeout(r, 350));
    const boat = world.getNearestEntityWhere(bot, (e) => e.name === 'boat' || e.name === 'oak_boat', 6);
    if (!boat) {
        log(bot, 'Could not find the spawned boat.');
        return false;
    }
    try { await bot.mount(boat); log(bot, 'Mounted the boat.'); return true; }
    catch (e) { log(bot, `Could not mount boat: ${e.message}`); return false; }
}

export async function rideHorse(bot) {
    /**
     * Find a nearby horse, give yourself a saddle (OP), saddle it and mount it.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if mounted.
     * @example
     * await skills.rideHorse(bot);
     **/
    const horse = world.getNearestEntityWhere(bot, (e) => ['horse', 'donkey', 'mule'].includes(e.name), 16);
    if (!horse) { log(bot, 'No horse nearby.'); return false; }
    bot.chat('/give @s saddle 1');
    await new Promise(r => setTimeout(r, 200));
    const saddle = bot.inventory.items().find(i => i.name === 'saddle');
    if (saddle) { await bot.equip(saddle, 'hand'); try { await bot.activateEntity(horse); } catch {} }
    await new Promise(r => setTimeout(r, 200));
    try { await bot.mount(horse); log(bot, 'Mounted the horse.'); return true; }
    catch (e) { log(bot, `Could not mount horse: ${e.message}`); return false; }
}

export async function waterBucketClutch(bot) {
    /**
     * The classic "MLG water bucket" — survive a fall from height by placing a
     * water source at your landing spot so you splash down safely instead of
     * taking fall damage. Works while falling or standing above a big drop.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if water was placed, false if not needed.
     * @example
     * await skills.waterBucketClutch(bot);
     **/
    const pos = bot.entity.position;
    const solid = (b) => b && b.boundingBox === 'block' && !['leaves', 'water', 'lava'].includes(b.name);
    // find the first solid landing block straight down
    let landing = null;
    for (let y = Math.floor(pos.y); y >= Math.floor(pos.y) - 96; y--) {
        const b = bot.blockAt(new Vec3(Math.floor(pos.x), y, Math.floor(pos.z)));
        if (!b) continue;
        if (b.name === 'water') {
            log(bot, 'There is already water below to land in — no clutch needed.');
            return false;
        }
        if (solid(b)) { landing = b; break; }
    }
    if (!landing) { log(bot, 'No ground below to clutch onto.'); return false; }
    const drop = Math.floor(pos.y) - landing.position.y;
    if (drop <= 3) { log(bot, 'Not high enough to hurt — no water bucket needed.'); return false; }
    // place a water source one block above the landing surface so it does not replace the ground
    const waterPos = new Vec3(landing.position.x, landing.position.y + 1, landing.position.z);
    const placed = await placeBlock(bot, 'water', waterPos.x, waterPos.y, waterPos.z);
    if (!placed) return false;
    log(bot, `Placed water to break a ${drop}-block fall.`);

    // Splash down, then scoop the water back up with a bucket so no source is left
    // behind and she keeps the water bucket for next time.
    const start = Date.now();
    while (!bot.interrupt_code && Date.now() - start < 8000) {
        if (bot.entity.position.y <= waterPos.y + 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 300)); // settle after landing
    const waterBlock = bot.blockAt(waterPos);
    if (waterBlock && waterBlock.name === 'water') {
        // Ensure she has an empty bucket. Clear a cheap item first if the bag is
        // full, otherwise the /give drops the bucket on the ground instead of into
        // her inventory.
        if (!bot.inventory.findInventoryItem('bucket') && bot.modes && bot.modes.isOn('cheat')) {
            const junk = bot.inventory.items().find(i => i.name === 'cobblestone' || i.name === 'dirt');
            if (junk) await discard(bot, junk.name, 1);
            bot.chat('/give @s bucket 1');
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        if (bot.inventory.findInventoryItem('bucket')) {
            await useToolOnBlock(bot, 'bucket', waterBlock);
        } else {
            log(bot, "Couldn't get a bucket to scoop the water back up.");
        }
    }
    return true;
}

export async function findShelter(bot, range = 40) {
    /**
     * Find shelter from weather, night or mobs: an existing building (a bed or
     * door) or a natural overhang/cave with a roof overhead, and move inside.
     * @param {MinecraftBot} bot - the bot.
     * @param {number} range - search radius in blocks (default 40).
     * @returns {Promise<boolean>} true if shelter was found and reached.
     * @example
     * await skills.findShelter(bot);
     **/
    const pos = bot.entity.position;
    const solid = (b) => b && b.boundingBox === 'block' && b.name !== 'leaves';
    const airy = (b) => b && ['air', 'cave_air', 'void_air'].includes(b.name);
    // 1) an existing structure: a bed or a door nearby
    const markers = bot.findBlocks({
        matching: (b) => b.name.includes('bed') || b.name.includes('door'),
        maxDistance: range,
        count: 10,
    });
    if (markers.length) {
        const m = markers[0];
        await goToPosition(bot, m.x, m.y, m.z, 1.5);
        log(bot, `Found an existing shelter at (${m.x}, ${m.y}, ${m.z}) and went inside.`);
        return true;
    }
    // 2) natural cover: a solid roof over a spot she can stand on
    const fy = Math.floor(pos.y);
    const radius = Math.min(12, Math.floor(range / 2));
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const x = Math.floor(pos.x) + dx, z = Math.floor(pos.z) + dz;
            for (let y = fy + 3; y >= fy - 6; y--) {
                const floor = bot.blockAt(new Vec3(x, y, z));
                const head = bot.blockAt(new Vec3(x, y + 1, z));
                const roof = bot.blockAt(new Vec3(x, y + 2, z));
                if (solid(floor) && airy(head) && solid(roof)) {
                    await goToPosition(bot, x + 0.5, y, z + 0.5, 1);
                    log(bot, `Found a covered spot at (${x}, ${y}, ${z}) and took shelter under it.`);
                    return true;
                }
            }
        }
    }
    log(bot, 'No shelter found nearby.');
    return false;
}

export async function buildShelter(bot, block = 'oak_planks') {
    /**
     * Build a quick emergency shelter — a small hollow room with a doorway —
     * around yourself, to hide from weather, night or mobs.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block to build with, e.g. 'oak_planks'.
     * @returns {Promise<boolean>} true if built.
     * @example
     * await skills.buildShelter(bot);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x) - 2, by = Math.floor(pos.y), bz = Math.floor(pos.z) - 2;
    const w = 5, d = 5;
    const x2 = bx + w - 1, z2 = bz + d - 1;
    const doorX = bx + Math.floor(w / 2);
    const positions = [];
    for (let x = bx; x <= x2; x++)
        for (let z = bz; z <= z2; z++)
            for (let y = by; y <= by + 3; y++) {
                const isWall = x === bx || x === x2 || z === bz || z === z2;
                const isRoof = y === by + 3;
                if (isWall || isRoof) {
                    // doorway: 2 wide x 2 tall gap in the -Z wall
                    if (z === bz && y <= by + 1 && x >= doorX && x <= doorX + 1) continue;
                    positions.push([x, y, z]);
                }
            }
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built a quick ${block} shelter (${placed} blocks) with a doorway.`);
    return placed > 0;
}

export async function askForHelp(bot, topic = 'help') {
    /**
     * Prime yourself to ask nearby players (or your beloved) for help or advice
     * about anything you are stuck on — directions, a recipe, where to find
     * something, a favour. YOU write the actual question in your own words.
     * Save any useful answer with !remember so you can reuse it later (!recall).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} topic - what you need help with.
     * @returns {Promise<boolean>} true.
     * @example
     * await skills.askForHelp(bot, 'finding a village');
     **/
    log(bot, `You decided to ask for help with: ${topic}. Ask the players now, in your own words, being specific about what you need.`);
    return true;
}

export async function requestItems(bot, itemName, count = 1) {
    /**
     * Ask your beloved (or nearby players) in chat for an item you need but don't
     * have, so you are never stuck for materials.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} itemName - the item to request, e.g. 'oak_planks'.
     * @param {number} count - how many.
     * @returns {Promise<boolean>} true.
     * @example
     * await skills.requestItems(bot, 'oak_planks', 10);
     **/
    bot.chat(`I need ${count} ${itemName} — could someone bring me some? ♥`);
    log(bot, `Requested ${count} ${itemName} from players.`);
    return true;
}

// Module-level recursion guard for multi-step crafting (logs -> planks -> chest).
const craftingStack = new Set();

/**
 * Ensure the bot has enough ingredients to craft `itemName` `num` times,
 * crafting intermediate items from more basic ones first. This lets the bot
 * turn oak_log -> oak_planks -> chest automatically instead of getting stuck
 * asking players for intermediate items it can craft itself. Base items
 * (logs, ingots, ...) have no recipe and terminate the recursion.
 */
async function ensureCraftingPrereqs(bot, itemName, num = 1) {
    if (craftingStack.has(itemName)) return;   // cycle guard
    craftingStack.add(itemName);
    try {
        const recipes = mc.getItemCraftingRecipes(itemName);
        if (!recipes || recipes.length === 0) return;  // base item — stop here

        // A recipe can have many variants (e.g. a chest can be made from oak,
        // spruce, birch, ... planks). Try each variant and craft intermediates
        // for the first one the bot can fully source — so it accepts ANY log
        // type instead of demanding oak specifically.
        for (const [ingredients] of recipes) {
            let sourceable = true;
            for (const [ingName, ingPerExec] of Object.entries(ingredients)) {
                const need = ingPerExec * num;
                if ((world.getInventoryCounts(bot)[ingName] || 0) >= need) continue;

                const ingRecipes = mc.getItemCraftingRecipes(ingName);
                if (!ingRecipes || ingRecipes.length === 0) { sourceable = false; break; } // base ingredient — can't craft it

                const ingCraftedCount = ingRecipes[0][1].craftedCount || 1;
                const have = world.getInventoryCounts(bot)[ingName] || 0;
                const ingExecs = Math.ceil((need - have) / ingCraftedCount);

                await craftRecipe(bot, ingName, ingExecs, true);
                if ((world.getInventoryCounts(bot)[ingName] || 0) < need) { sourceable = false; break; }
            }
            if (sourceable) return;  // this variant is fully sourced
        }
    } finally {
        craftingStack.delete(itemName);
    }
}

export async function craftRecipe(bot, itemName, num=1, quiet=false) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        if (!quiet) log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // Multi-step crafting: make sure intermediate ingredients exist (e.g.
    // oak_log -> oak_planks) before we check the recipe, so the bot can craft
    // a chest from raw logs instead of getting stuck asking for planks.
    await ensureCraftingPrereqs(bot, itemName, num);

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                // No crafting table handy — craft one from planks (multi-step),
                // then place it and use it.
                await craftRecipe(bot, 'crafting_table', 1);
                if (world.getInventoryCounts(bot)['crafting_table'] > 0) {
                    let pos = world.getNearestFreeSpace(bot, 1, 6);
                    await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                    craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                    if (craftingTable) {
                        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                        placedTable = true;
                    }
                }
                if (!craftingTable) {
                    if (!quiet) log(bot, `Crafting ${itemName} requires a crafting table.`);
                    return false;
                }
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        // Generalize wood variants so the bot asks for "any log/planks" instead
        // of fixating on "oak" — a chest (and most wood recipes) accept ANY wood type.
        if (!quiet) {
            const required = Object.entries(mc.getItemCraftingRecipes(itemName)[0][0])
                .map(([key, value]) => {
                    const generic = key.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_/, '');
                    return generic !== key ? `${generic} (any wood): ${value}` : `${key}: ${value}`;
                })
                .join(', ');
            log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${required}. Ask your beloved or nearby players for these materials if you need them.`);
        }
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);

    // Opening volley: a couple arrows at a distant enemy ONCE, before closing to
    // melee. Never inside the loop below — looping arrows at something she can't
    // reach is how she burned through (and spam-/gave) stacks of arrows.
    if (enemy && bot.entity.position.distanceTo(enemy.position) >= 6) {
        try { await shootBow(bot, enemy, 2, true); } catch (e) { console.warn('bow opening failed:', e.message); }
    }

    while (enemy) {
        bot.armorManager.equipAll(); // keep armor on every fight, don't fight naked
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}

export async function shootBow(bot, target, shots=1, fullCharge=true) {
    /**
     * Shoot a bow at a target. Equips a bow (auto-/giving one if she lacks it — she's OP),
     * aims at the target's eyes (leading moving targets by their velocity), draws and fires.
     * Arrows are consumed from inventory/off-hand by the server automatically.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string|Entity} target, a player name, mob type, or an Entity object to shoot.
     * @param {number} shots, how many arrows to fire (default 1).
     * @param {boolean} fullCharge, true = full power draw (~1s), false = rapid weak taps.
     * @returns {Promise<boolean>} true if at least one arrow was loosed.
     * @example
     * await skills.shootBow(bot, "skeleton", 2);
     * await skills.shootBow(bot, "Steve", 1, true);
     **/
    shots = Math.max(1, Math.min(32, Math.floor(shots || 1)));

    // resolve the target to a live entity
    let entity = null;
    if (typeof target === 'string') {
        const player = bot.players && bot.players[target];
        if (player && player.entity) entity = player.entity;
        else entity = world.getNearestEntityWhere(bot, e => e.name === target, 48);
    } else if (target && target.position) {
        entity = target;
    }
    if (!entity || !entity.position) {
        log(bot, typeof target === 'string' ? `No ${target} nearby to shoot.` : 'No target to shoot.');
        return false;
    }

    // ensure a bow — she's OP, but /give only resolves into inventory when there's a
    // free slot. With a full bag the /give DROPS the bow on the ground, the re-check
    // still finds none, and every self-defense/hunting tick /gives another → a pile of
    // bows on the floor. Only /give when there's room; otherwise tell her to make space.
    let bow = bot.inventory.items().find(i => i.name === 'bow');
    if (!bow) {
        if (bot.inventory.items().length < 36) {
            bot.chat(`/give ${bot.username} bow 1`);
            await new Promise(r => setTimeout(r, 350));
            bow = bot.inventory.items().find(i => i.name === 'bow');
        }
    }
    if (!bow) {
        log(bot, 'No bow to shoot with — inventory full (a /give would only drop it on the ground). Free a slot, or craft one: 3 string + 3 sticks.');
        return false;
    }

    // arrows must be in inventory (main or off-hand both feed the bow). Out of
    // arrows = don't shoot — fall back to melee or craft more; never /give-spam
    // (with a full inventory the /give drops arrows on the ground and loops).
    const arrowTypes = ['arrow', 'spectral_arrow', 'tipped_arrow'];
    if (!bot.inventory.items().some(i => arrowTypes.includes(i.name))) {
        log(bot, 'No arrows to shoot with.');
        return false;
    }

    await bot.equip(bow, 'hand');

    let fired = 0;
    for (let i = 0; i < shots; i++) {
        if (bot.interrupt_code) break;
        const pos = entity.position;
        if (!pos) break;
        const dist = bot.entity.position.distanceTo(pos);
        // aim at the eyes; lead a moving target by its velocity so the arrow meets it
        const eyeY = entity.height ? entity.height * 0.85 : 1.0;
        let aim = pos.offset(0, eyeY, 0);
        if (entity.velocity && (entity.velocity.x || entity.velocity.y || entity.velocity.z)) {
            const lead = Math.min(0.7, dist / 55);
            aim = aim.offset(entity.velocity.x * lead, entity.velocity.y * lead, entity.velocity.z * lead);
        }
        await bot.lookAt(aim, true);
        await new Promise(r => setTimeout(r, 100));   // let the view settle on target
        await bot.activateItem();                     // start drawing the bow
        await new Promise(r => setTimeout(r, fullCharge ? 1000 : 320));
        try { await bot.deactivateItem(); } catch {}  // release -> arrow flies
        fired++;
        await new Promise(r => setTimeout(r, fullCharge ? 220 : 130));
    }
    log(bot, `Fired ${fired} arrow${fired === 1 ? '' : 's'}.`);
    return fired > 0;
}

export async function throwTrident(bot, target, count=1) {
    /**
     * Throw a trident (spear) at a target — hold to charge, release to hurl.
     * @returns {Promise<boolean>} true if it threw at least once.
     */
    const trident = bot.inventory.items().find(i => i.name === 'trident');
    if (!trident) {
        log(bot, 'No trident. Find one by hunting drowned, or from ocean ruin chests.');
        return false;
    }
    await bot.equip(trident, 'hand');
    let thrown = 0;
    for (let i = 0; i < count; i++) {
        const v = target.velocity || { x: 0, y: 0, z: 0 };
        const dist = bot.entity.position.distanceTo(target.position);
        const lead = Math.min(0.6, dist * 0.05);
        const aim = target.position.offset(v.x * lead, v.y * lead, v.z * lead)
            .offset(0, (target.height || 1.8) * 0.7, 0);
        await bot.lookAt(aim, true);
        await new Promise(r => setTimeout(r, 120));
        await bot.activateItem();                     // start the throw charge
        await new Promise(r => setTimeout(r, 720));   // ~full charge for a hard throw
        try { await bot.deactivateItem(); thrown++; } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    log(bot, `Threw trident ${thrown} time${thrown === 1 ? '' : 's'} (if it doesn't fly back, go pick it up).`);
    return thrown > 0;
}

export async function crystalPvP(bot, target) {
    /**
     * Crystal PvP: set obsidian at the target's feet, place an end crystal on it,
     * then detonate it. Aggressive and self-damaging — the !crystalPvP command
     * gates this behind genuine rage (high hate/annoyance) before it reaches here.
     * @returns {Promise<boolean>} true if the crystal was placed and detonated.
     */
    const crystal = bot.inventory.items().find(i => i.name === 'end_crystal');
    if (!crystal) {
        log(bot, 'No end crystal. Craft one: 7 glass + 1 eye_of_ender + 1 ghast_tear.');
        return false;
    }
    const support = bot.inventory.items().find(i => i.name === 'obsidian' || i.name === 'bedrock');
    if (!support) {
        log(bot, 'Need obsidian (or bedrock) to set the crystal on. Obsidian = water poured over lava.');
        return false;
    }
    const feet = target.position.floored();
    if (!(await placeBlock(bot, support.name, feet.x, feet.y, feet.z, 'bottom'))) {
        log(bot, 'Could not place the support block at their feet.');
        return false;
    }
    await new Promise(r => setTimeout(r, 250)); // let the world state settle
    const base = bot.blockAt(feet);
    if (!base || (base.name !== 'obsidian' && base.name !== 'bedrock')) {
        log(bot, 'Support block did not land as obsidian/bedrock.');
        return false;
    }
    let crystalEntity;
    try {
        await bot.equip(crystal, 'hand');
        crystalEntity = await bot.placeEntity(base, { x: 0, y: 1, z: 0 });
    } catch (e) {
        log(bot, `Could not place the crystal: ${e.message}`);
        return false;
    }
    // step back so the blast doesn't kill us, then detonate
    try {
        if (bot.entity.position.distanceTo(feet) < 5) {
            bot.pathfinder.setMovements(new pf.Movements(bot));
            await bot.pathfinder.goto(new pf.goals.GoalInvert(new pf.goals.GoalFollow(target, 5)), true).catch(() => {});
        }
    } catch {}
    bot.attack(crystalEntity);
    log(bot, 'Detonated end crystal.');
    return true;
}


export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Inventory full and no chest nearby to auto-deposit into. If you have a chest, place it with !placeHere (collecting will then auto-deposit); if not, craft one from 8 planks with !craftRecipe("chest") and place it.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        await pickupNearbyItems(bot);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function writeSign(bot, text, blockType='oak_sign') {
    /**
     * Place a standing sign in front of the bot and write text on it.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} text, the sign text; use \n to separate up to 4 lines (max 45 chars each).
     * @param {string} blockType, the standing sign block name (default 'oak_sign').
     * @returns {Promise<boolean>} true if the sign was placed and written.
     * @example await skills.writeSign(bot, "UwU was here\n<3");
     **/
    try {
        const p = bot.entity.position;
        const yaw = bot.entity.yaw || 0;
        // one block directly in front of the bot, at her feet level
        const x = Math.floor(p.x - Math.sin(yaw));
        const z = Math.floor(p.z - Math.cos(yaw));
        const y = Math.floor(p.y);
        if (!(await placeBlock(bot, blockType, x, y, z, 'bottom', false))) {
            log(bot, `Couldn't place a ${blockType} sign to write on.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 300)); // let the sign register server-side
        const pos = new Vec3(x, y, z);
        const sign = bot.blockAt(pos) || { position: pos };
        bot.updateSign(sign, String(text));
        log(bot, `Wrote sign: ${String(text).replace(/\n/g, ' / ')}`);
        return true;
    } catch (e) {
        log(bot, `writeSign failed: ${e.message}`);
        return false;
    }
}

export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    // World-edit /setblock placement is disabled — she places every block by hand
    // (no instant shortcuts), so blocks are actually consumed from inventory. The
    // real place-by-hand logic below handles the placement.
    if (false && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        // six-way facing blocks (pistons, observers, dispensers, ...) — up/down when
        // placed against the top/bottom face, else a horizontal facing.
        if (['piston', 'sticky_piston', 'observer', 'dispenser', 'dropper', 'hopper'].includes(blockType)) {
            const vertical = placeOn === 'top' ? 'up' : placeOn === 'bottom' ? 'down' : null;
            blockType += `[facing=${vertical || face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
}

export async function placeBlockState(bot, blockType, props, x, y, z) {
    /**
     * Place a block with an exact block-state (facing, powered, extended, delay...)
     * using /setblock. For redstone and other orientation-sensitive builds where a
     * wrong facing breaks the whole circuit. Requires operator (cheat mode).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} blockType - the block name, e.g. 'repeater'.
     * @param {object} props - block-state properties, e.g. { facing: 'north', delay: 2 }.
     * @param {number} x, y, z - absolute coordinates.
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.placeBlockState(bot, 'repeater', { facing: 'north', delay: 2 }, 10, 64, 10);
     **/
    let block = blockType;
    const keys = props ? Object.keys(props) : [];
    if (keys.length)
        block += '[' + keys.map(k => `${k}=${props[k]}`).join(',') + ']';
    bot.chat(`/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${block}`);
    if (useDelay) await new Promise(resolve => setTimeout(resolve, blockPlaceDelay));
    return true;
}

export async function spamBlock(bot, type, times = 4, intervalMs = 350) {
    /**
     * Repeatedly activate (open/shut/flip/ring) the nearest block of a given type to
     * make noise and get attention — spam a door, a chest, a lever, a bell, a note block.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} type - block type to spam, e.g. 'door', 'chest', 'lever', 'bell' (substring-matched, so 'door' hits any wood door).
     * @param {number} times - how many activate cycles (default 4).
     * @param {number} intervalMs - ms between toggles (default 350).
     * @returns {Promise<boolean>} true if something was spammed.
     * @example
     * await skills.spamBlock(bot, 'door', 6);
     **/
    const blocks = world.getNearestBlocksWhere(bot, b => b && b.name && b.name.includes(type), 8, 1);
    const block = blocks[0];
    if (!block) { log(bot, `No ${type} nearby to spam.`); return false; }
    for (let i = 0; i < times; i++) {
        if (bot.interrupt_code) break;
        try { await bot.activateBlock(block); } catch (e) { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    log(bot, `Spammed ${type} ${times} times.`);
    return true;
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function unequip(bot, destination) {
    /**
     * Remove armor / held items so she can actually "strip" or change outfit.
     * destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' | 'all'
     * @param {MinecraftBot} bot
     * @param {string} destination - which equipment slot to empty, or 'all'.
     * @returns {Promise<boolean>}
     */
    const slots = ['head', 'torso', 'legs', 'feet', 'off-hand', 'hand'];
    if (destination === 'all') {
        for (const p of slots) {
            try { await bot.unequip(p); } catch (e) { /* ignore */ }
        }
        log(bot, 'Removed all armor and equipment.');
        return true;
    }
    if (!slots.includes(destination)) {
        log(bot, `Unknown equipment slot: ${destination}.`);
        return false;
    }
    try {
        await bot.unequip(destination);
        log(bot, `Unequipped ${destination}.`);
        return true;
    } catch (e) {
        log(bot, `Could not unequip ${destination}: ${e.message}`);
        return false;
    }
}

// The spawn survival kit is NEVER droppable: no discard, no giving away, no
// tossing. Guards both by name and by "is it currently equipped".
const PROTECTED_GEAR = new Set([
    'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
    'diamond_sword', 'shield',
    'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe',
    'bow', 'arrow', 'spectral_arrow', 'tipped_arrow', 'chest',
    'elytra', 'firework_rocket',
]);

function isProtectedGear(bot, itemName) {
    if (PROTECTED_GEAR.has(itemName)) return true;
    // mineflayer inventory slot layout: 5-8 armor (head/torso/legs/feet), 45 off-hand.
    // NOTE: hand slot 36 is DELIBERATELY EXCLUDED — she holds blocks (dirt, wood, etc.)
    // in hand while placing/digging, and those must stay discardable so she can free
    // inventory space. Real gear held in hand (sword/tools/bow) is already in PROTECTED_GEAR.
    const equippedSlots = [5, 6, 7, 8, 45];
    return equippedSlots.some(s => bot.inventory.slots[s] && bot.inventory.slots[s].name === itemName);
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the name of the item to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    if (isProtectedGear(bot, itemName)) {
        log(bot, `I can't drop ${itemName} — it's part of my kit, never droppable!`);
        return false;
    }
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        // Fuzzy fallback: the LLM names items loosely ("stone" for cobblestone,
        // "wood"/"log" for oak_log). Match a non-gear item whose name contains (or
        // is contained by) the request — but never auto-match survival gear, so
        // "diamond" won't grab her diamond_sword/helmet.
        const q = itemName.toLowerCase();
        item = bot.inventory.items().find(i =>
            !isProtectedGear(bot, i.name) &&
            (i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase())));
    }
    if (!item) {
        const have = bot.inventory.items()
            .filter(i => !isProtectedGear(bot, i.name))
            .map(i => `${i.name} (${i.count})`)
            .slice(0, 12).join(', ');
        log(bot, `You do not have any ${itemName} to put in the chest.` + (have ? ` You have: ${have}.` : ''));
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToBlockAdjacent(bot, chest);
    const chestContainer = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToBlockAdjacent(bot, chest);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest (exact, then loose-name fallback)
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        const q = itemName.toLowerCase();
        matchingItems = chestContainer.containerItems().filter(item =>
            item.name.toLowerCase().includes(q) || q.includes(item.name.toLowerCase()));
    }
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToBlockAdjacent(bot, chest);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}

export async function fish(bot, timeoutMs = 30000) {
    /**
     * Cast a fishing rod and reel in when a fish bites. Uses mineflayer's built-in
     * fishing loop (auto-casts and auto-reels on a bite).
     * @param {MinecraftBot} bot - the bot.
     * @param {number} timeoutMs - how long to wait for a bite before giving up.
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.fish(bot, 30000);
     **/
    const rod = bot.inventory.findInventoryItem('fishing_rod');
    if (!rod) {
        log(bot, 'No fishing rod in inventory.');
        return 'No fishing rod in inventory.';
    }
    await bot.equip(rod, 'hand');

    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    });
    const fishing = bot.fish();
    fishing.catch(() => {}); // swallow the late rejection from reeling in on timeout

    try {
        await Promise.race([fishing, timeout]);
        log(bot, 'Caught a fish.');
        return 'Caught a fish.';
    } catch (err) {
        const msg = (err && err.message === 'timed out')
            ? 'Fishing timed out — no bite.'
            : `Fishing failed: ${err.message}`;
        log(bot, msg);
        return msg;
    } finally {
        clearTimeout(timer);
        try { bot.deactivateItem(); } catch {}
    }
}

export async function pointAt(bot, target, range = 48) {
    /**
     * Turn to look at something and swing the arm (punch air) to gesture toward it,
     * so nearby players can see what you're pointing at.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} target - a player name, mob type (e.g. 'sheep'), or block type (e.g. 'oak_log').
     * @param {number} range - how far to search for mobs/blocks (default 48).
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.pointAt(bot, 'sheep');
     **/
    let pos = null;
    let what = target;

    // 1) a player by name — aim at their eyes
    const player = bot.players && bot.players[target];
    if (player && player.entity) {
        pos = player.entity.position.offset(0, 1.62, 0);
    }

    // 2) nearest mob of that type
    if (!pos) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === target, range);
        if (entity) {
            pos = entity.position.offset(0, entity.height || 1, 0);
            what = entity.name;
        }
    }

    // 3) nearest block of that type
    if (!pos) {
        const block = world.getNearestBlock(bot, target, range);
        if (block) {
            pos = block.position.offset(0.5, 0.5, 0.5);
            what = block.name;
        }
    }

    if (!pos) {
        log(bot, `Couldn't find ${target} to point at.`);
        return `Couldn't find ${target} to point at.`;
    }

    await bot.lookAt(pos);
    for (let i = 0; i < 2; i++) {
        bot.swingArm();
        await wait(bot, 250);
    }
    log(bot, `Pointed at ${what}.`);
    return `Pointed at ${what}.`;
}

export async function pointAtPosition(bot, x, y, z, what = 'there') {
    /**
     * Turn to face a coordinate and swing the arm (punch air) to gesture toward it.
     * @param {MinecraftBot} bot - the bot.
     * @param {number} x - x coordinate.
     * @param {number} y - y coordinate (ground level).
     * @param {number} z - z coordinate.
     * @param {string} what - human-readable label for the target.
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.pointAtPosition(bot, 120, 64, -450, 'home');
     **/
    await bot.lookAt(new Vec3(x, y + 1.62, z)); // aim at head height over the spot
    for (let i = 0; i < 2; i++) {
        bot.swingArm();
        await wait(bot, 250);
    }
    log(bot, `Pointed at ${what}.`);
    return `Pointed at ${what}.`;
}

export async function teleportPlayer(bot, playerName) {
    /**
     * Teleport a player to your current position (you are OP, so /tp works).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} playerName - the player to bring to you.
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.teleportPlayer(bot, 'Steve');
     **/
    const p = bot.entity.position;
    bot.chat(`/tp ${playerName} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    log(bot, `Teleported ${playerName} to you.`);
    return `Teleported ${playerName} to you.`;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    if (isProtectedGear(bot, itemType)) {
        log(bot, `I can't give away ${itemType} — it's part of my kit, never droppable!`);
        return false;
    }
    // OP cheat-give: spawn the item directly into the target's inventory via /give.
    // She's op (level 4) so the command resolves; this avoids (a) needing the item
    // in her own backpack and (b) walking over + tossing, both of which failed here.
    if (bot.modes.isOn('cheat')) {
        bot.chat(`/give ${username} ${itemType} ${num}`);
        log(bot, `Gave ${username} ${num} ${itemType} via /give.`);
        return true;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = new pf.Movements(bot);

    let final_movements = destructiveMovements;

    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToBlockAdjacent(bot, block, min_distance=2) {
    /**
     * Walk (pathfind) to a spot adjacent to a block — never teleport, and never
     * path INTO the block (which breaks container opening). The cheat /tp in
     * goToPosition lands the bot inside the block, so chests/furnaces must walk.
     */
    try {
        await goToGoal(bot, new pf.goals.GoalNear(block.position.x, block.position.y, block.position.z, min_distance));
        return true;
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    let player = bot.players[username];
    const playerEntity = player && player.entity;
    // Cheat mode: `/tp @s <name>` resolves on the SERVER, so it works even when
    // the player's entity isn't loaded in this client (out of chunk range /
    // different dimension). Without the entity we can't pathfind or measure
    // distance, so fall back to the name-based server teleport directly.
    if (bot.modes.isOn('cheat')) {
        if (playerEntity) {
            const dist = bot.entity.position.distanceTo(playerEntity.position);
            // Near the player → walk/run over like a person. Only teleport when far
            // away so she still arrives promptly.
            const WALK_LIMIT = 32;
            if (dist > WALK_LIMIT) {
                bot.chat('/tp @s ' + username);
                log(bot, `Teleported to ${username}.`);
                return true;
            }
            log(bot, `Only ${dist.toFixed(1)} blocks away — walking over instead of teleporting.`);
        } else {
            // Entity not loaded but cheat is on: teleport by name anyway. The
            // server tells us if the player can't be found.
            bot.chat('/tp @s ' + username);
            log(bot, `Entity for ${username} not in view — teleported by name.`);
            return true;
        }
    }

    if (!playerEntity) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(playerEntity, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

// ============================================================================
// ELYTRA FLIGHT — glide, boost with firework rockets, and land.
// mineflayer exposes bot.elytraFly() (deploy), bot.entity.elytraFlying (state),
// and rocket boost = hold a firework_rocket in hand + bot.activateItem().
// ============================================================================

export function countFireworkRockets(bot) {
    return bot.inventory.items().filter(i => i.name === 'firework_rocket').reduce((a, i) => a + i.count, 0);
}

export function isElytraEquipped(bot) {
    const torso = bot.getEquipmentDestSlot('torso');
    const worn = bot.inventory.slots[torso];
    return !!worn && worn.name === 'elytra';
}

export async function equipElytra(bot) {
    if (isElytraEquipped(bot)) {
        log(bot, 'Already wearing elytra.');
        return true;
    }
    const elytra = bot.inventory.items().find(i => i.name === 'elytra');
    if (!elytra) {
        log(bot, "I don't have an elytra. I can find one in an End City ship, or /give myself one since I'm op.");
        return false;
    }
    await bot.equip(elytra, 'torso');
    log(bot, 'Elytra equipped.');
    return true;
}

export async function equipFireworkRocket(bot) {
    const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket');
    if (!rocket) {
        log(bot, "I don't have any firework rockets — I need to craft some (paper + gunpowder).");
        return false;
    }
    await bot.equip(rocket, 'hand');
    log(bot, 'Firework rocket in hand.');
    return true;
}

export async function boostWithFirework(bot) {
    // Boost while gliding: right-click a firework rocket. Requires elytra flying.
    if (!bot.entity.elytraFlying) {
        log(bot, "Can't boost — not currently gliding.");
        return false;
    }
    if (countFireworkRockets(bot) === 0) {
        log(bot, 'Out of firework rockets.');
        return false;
    }
    const held = bot.heldItem;
    if (!held || held.name !== 'firework_rocket') {
        if (!await equipFireworkRocket(bot)) return false;
    }
    bot.activateItem();
    log(bot, 'Boosted with a firework rocket.');
    return true;
}

export async function buildLiftoffTower(bot, height = 20) {
    // Build a vertical pillar at her feet and get on top — a ready-made launch
    // point when there's no cliff or tower nearby.
    height = Math.max(4, Math.min(64, Math.floor(height)));
    const feet = Math.floor(bot.entity.position.y);
    const bx = Math.floor(bot.entity.position.x);
    const bz = Math.floor(bot.entity.position.z);
    const block = 'cobblestone';

    const baseY = feet - 1;          // ground block she's standing on
    const topBlockY = baseY + height; // highest block of the pillar
    const standY = topBlockY + 1;     // her feet once standing on top

    let placed = 0;
    for (let y = baseY + 1; y <= topBlockY; y++) {
        if (bot.interrupt_code) break;
        try {
            if (await placeBlock(bot, block, bx, y, bz, 'bottom')) placed++;
        } catch (e) { break; }
    }
    if (placed < 3) {
        log(bot, "Couldn't build a liftoff tower.");
        return false;
    }

    if (bot.modes.isOn('cheat')) {
        bot.chat(`/tp @s ${bx} ${standY} ${bz}`);
        await new Promise(resolve => setTimeout(resolve, 120));
    } else {
        // Survival: pillar-jump up by placing a block under our feet each step.
        for (let i = 0; i < height && !bot.interrupt_code; i++) {
            const f = bot.entity.position.floored();
            await placeBlock(bot, block, f.x, f.y - 1, f.z, 'bottom');
            bot.setControlState('jump', true);
            await new Promise(resolve => setTimeout(resolve, 160));
            bot.setControlState('jump', false);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    log(bot, `Built a ${height}-block liftoff tower and climbed on top.`);
    return true;
}

export async function getAirborne(bot, height = 10) {
    // Get her airborne with real falling velocity, which the server needs before it
    // will accept an elytra deploy. In cheat mode, teleport straight up — the server
    // processes the /tp itself, so this is reliable (a client-side pillar-jump is
    // flaky and often leaves her onGround). Survival falls back to a simple hop.
    if (bot.modes && bot.modes.isOn('cheat')) {
        const p = bot.entity.position;
        bot.chat(`/tp @s ${Math.floor(p.x)} ${Math.floor(p.y) + height} ${Math.floor(p.z)}`);
        await new Promise(resolve => setTimeout(resolve, 300)); // let gravity build downward velocity
    } else {
        bot.setControlState('jump', true);
        bot.setControlState('jump', false);
        await new Promise(resolve => setTimeout(resolve, 260));
    }
    return true;
}

export async function takeOff(bot) {
    // Deploy the elytra and start gliding. Preferred launch is the vanilla
    // rocket-hop (no teleport): hop, look up, then use a firework rocket to launch
    // and auto-deploy the wings. Falls back to a teleport-up + explicit deploy when
    // there are no rockets or the rocket-hop doesn't engage.
    if (bot.entity.elytraFlying) {
        log(bot, 'Already flying.');
        return true;
    }
    if (!await equipElytra(bot)) return false;

    const hasRockets = countFireworkRockets(bot) > 0;
    const fail = async (msg) => { log(bot, msg); bot.modes.unpause('self_preservation'); bot.modes.unpause('unstuck'); await rearmorAfterFlight(bot); return false; };
    bot.modes.pause('self_preservation'); // don't MLG-clutch while falling to deploy the elytra
    bot.modes.pause('unstuck');

    const confirmEngaged = async (ms) => {
        const deadline = Date.now() + ms;
        while (!bot.entity.elytraFlying && !bot.interrupt_code && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return bot.entity.elytraFlying;
    };

    if (hasRockets) {
        // Vanilla flat takeoff: hop, look up, use a rocket to launch + auto-deploy.
        await equipFireworkRocket(bot);
        bot.setControlState('jump', true);
        bot.setControlState('jump', false);
        await new Promise(resolve => setTimeout(resolve, 150)); // airborne
        await bot.look(bot.entity.yaw, 45 * Math.PI / 180);
        bot.activateItem(); // rocket launches her up and opens the wings
        if (!await confirmEngaged(1500)) {
            log(bot, 'Rocket-hop did not engage — teleporting up to retry.');
            await getAirborne(bot);
            try { await bot.elytraFly(); } catch (e) { return fail(`Take-off failed: ${e.message}`); }
        }
    } else {
        log(bot, 'No rockets — teleporting up to glide.');
        await getAirborne(bot);
        try { await bot.elytraFly(); } catch (e) { return fail(`Take-off failed: ${e.message}`); }
    }

    if (!await confirmEngaged(2000)) {
        return fail('Elytra never engaged — the server did not accept the take-off.');
    }

    // Boost up before she loses altitude. A gentle 30° climb gives the rocket lift.
    if (hasRockets) {
        await bot.look(bot.entity.yaw, 30 * Math.PI / 180);
        for (let i = 0; i < 3 && countFireworkRockets(bot) > 0 && !bot.interrupt_code; i++) {
            bot.activateItem();
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }

    log(bot, 'Took off — elytra deployed, gliding!');
    bot.modes.unpause('self_preservation'); // flying now; elytra glide is fall-safe
    bot.modes.unpause('unstuck');
    return true;
}

export async function rearmorAfterFlight(bot) {
    // Swap the elytra back for a chestplate now that she's on the ground, then
    // top up any other missing armor. Keeps her from wandering around without
    // chest protection after flying.
    if (isElytraEquipped(bot)) {
        const chest = bot.inventory.items().find(i => i.name.includes('chestplate'));
        if (chest) {
            await bot.equip(chest, 'torso');
            log(bot, 'Re-equipped chestplate after flight.');
        }
    }
    if (bot.armorManager) {
        try { bot.armorManager.equipAll(); } catch (e) { /* non-fatal */ }
    }
}

export async function landWithElytra(bot) {
    // Descend and touch down gently. The elytra deactivates when she hits ground.
    if (!bot.entity.elytraFlying) {
        log(bot, 'Already on the ground.');
        await rearmorAfterFlight(bot);
        return true;
    }
    const start = Date.now();
    while (bot.entity.elytraFlying && !bot.interrupt_code && Date.now() - start < 30000) {
        const pos = bot.entity.position;
        const below = bot.blockAt(pos.offset(0, -3, 0));
        const groundDist = below ? pos.y - below.position.y : 99;
        // Dive (45° down) while high, level out when close so we land on our feet.
        const pitch = groundDist > 6 ? Math.PI / 4 : 0;
        await bot.look(bot.entity.yaw, pitch);
        if (bot.entity.onGround) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    bot.clearControlStates();
    await rearmorAfterFlight(bot);
    log(bot, 'Landed.');
    return true;
}

export async function flyWithElytra(bot, x, y, z, min_distance = 3) {
    // Fly (glide + auto-boost) to a destination and land near it.
    if (x == null || y == null || z == null) {
        log(bot, 'Missing destination coordinates.');
        return false;
    }
    if (!bot.entity.elytraFlying && !await takeOff(bot)) return false;

    const target = new Vec3(x, y, z);
    const hasRockets = countFireworkRockets(bot) > 0;
    const start = Date.now();
    const MAX_MS = 120000;
    let lastBoost = 0;

    if (hasRockets) await equipFireworkRocket(bot);

    while (!bot.interrupt_code) {
        if (Date.now() - start > MAX_MS) {
            log(bot, 'Flight timed out — landing.');
            break;
        }
        const pos = bot.entity.position;
        const horizontal = Math.hypot(pos.x - x, pos.z - z);
        if (horizontal <= min_distance) break; // overhead the target

        if (!bot.entity.elytraFlying) {
            log(bot, 'Elytra deactivated mid-flight.');
            break;
        }

        // Face the destination (pitch aims us at it, which also controls descent).
        try { await bot.lookAt(target.offset(0, 1.5, 0), true); } catch (e) { /* ignore */ }

        // Keep speed/altitude with a rocket every ~2.5s when we have them.
        if (hasRockets && Date.now() - lastBoost > 2500) {
            await boostWithFirework(bot);
            lastBoost = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    bot.clearControlStates();
    await landWithElytra(bot);
    log(bot, `Flew to ${x}, ${y}, ${z}.`);
    return true;
}

export async function cruiseWithElytra(bot, seconds = 12) {
    // Sustained no-destination flight: launch, then cruise forward firing a
    // rocket every ~2.5s to hold altitude, then glide down and land. Makes "fly"
    // actually look like flying instead of a single rocket-hop.
    seconds = Math.max(2, Math.min(60, Math.floor(seconds)));
    if (!bot.entity.elytraFlying && !await takeOff(bot)) return false;

    const hasRockets = countFireworkRockets(bot) > 0;
    if (hasRockets) await equipFireworkRocket(bot);

    // Pitch slightly down so she keeps forward speed and never stalls; the
    // periodic rockets buy the altitude back.
    await bot.look(bot.entity.yaw, -10 * Math.PI / 180);

    const start = Date.now();
    const maxMs = seconds * 1000;
    let lastBoost = 0;

    while (!bot.interrupt_code && Date.now() - start < maxMs) {
        if (!bot.entity.elytraFlying) {
            log(bot, 'Elytra deactivated mid-cruise.');
            break;
        }
        if (hasRockets && Date.now() - lastBoost > 2500) {
            await boostWithFirework(bot);
            lastBoost = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    await landWithElytra(bot);
    log(bot, `Cruised for ~${Math.round((Date.now() - start) / 1000)}s.`);
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function sleepNearPlayer(bot, playerName, distance=3) {
    /**
     * Follow a player into bed: go to them, sleep in a nearby empty bed, or place one if needed.
     * @param {MinecraftBot} bot
     * @param {string} playerName
     * @param {number} distance - how close to get to the player
     * @returns {Promise<boolean>} true if she got in a bed, false otherwise.
     **/
    const player = bot.players[playerName]?.entity;
    if (!player) {
        log(bot, `Cannot find player ${playerName} to sleep next to.`);
        return false;
    }
    await goToPlayer(bot, playerName, distance);

    // prefer an existing empty bed near the player
    const beds = bot.findBlocks({
        matching: (block) => block.name.includes('bed'),
        maxDistance: 16,
        count: 8,
    });
    for (const loc of beds) {
        const bed = bot.blockAt(loc);
        if (!bed) continue;
        try {
            await bot.sleep(bed);
            log(bot, `Sleeping next to ${playerName}.`);
            bot.modes.pause('unstuck');
            while (bot.isSleeping) await new Promise(resolve => setTimeout(resolve, 500));
            log(bot, `Woke up.`);
            return true;
        } catch {
            // bed occupied / not night / already sleeping — try the next one
            continue;
        }
    }

    // no empty bed: place one next to her (cheat mode = /setblock, she's OP)
    const pos = bot.entity.position.floored();
    const offsets = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dz] of offsets) {
        const x = pos.x + dx, y = pos.y, z = pos.z + dz;
        const placed = await placeBlock(bot, 'red_bed', x, y, z, 'bottom', true);
        if (!placed) continue;
        await new Promise(resolve => setTimeout(resolve, 400));
        const bed = bot.blockAt(new Vec3(x, y, z));
        if (!bed) continue;
        try {
            await bot.sleep(bed);
            log(bot, `Placed a bed and sleeping next to ${playerName}.`);
            bot.modes.pause('unstuck');
            while (bot.isSleeping) await new Promise(resolve => setTimeout(resolve, 500));
            log(bot, `Woke up.`);
            return true;
        } catch {
            continue;
        }
    }
    return false;
}

// Bounded burst of alternating sneak + jump — reads as playful copy/excitement.
// Self-terminating (never a persistent loop): clears control states when done.
export async function spamJumpCrouch(bot, durationMs = 3000) {
    const end = Date.now() + durationMs;
    let crouch = true;
    while (Date.now() < end) {
        bot.setControlState('sneak', crouch);
        if (crouch) {
            bot.setControlState('jump', true);
            await new Promise(resolve => setTimeout(resolve, 180));
            bot.setControlState('jump', false);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        crouch = !crouch;
    }
    bot.setControlState('sneak', false);
    bot.setControlState('jump', false);
}

export async function bounceOnBed(bot, playerName, durationMs = 3500) {
    /**
     * Cheeky yandere gesture: hop over to a sleeping player and bounce on their bed
     * with a short jump + spam-crouch burst. One-off by design (non-persistent).
     * @param {MinecraftBot} bot
     * @param {string} playerName
     * @param {number} durationMs
     * @returns {Promise<boolean>} true if she went over and bounced, false otherwise.
     **/
    const player = bot.players[playerName]?.entity;
    if (!player) return false;
    await goToPlayer(bot, playerName, 1);
    try { await bot.lookAt(player.position.offset(0, 1, 0)); } catch (e) { /* non-fatal */ }
    await spamJumpCrouch(bot, durationMs);
    log(bot, `Bounced on ${playerName}'s bed.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

// ===== ENCHANTING / ANVIL / BOOK / FARMING (normal-player depth) =====

export async function enchantItem(bot, itemName, choice=null) {
    /**
     * Enchant an item at the nearest enchanting table. Puts the item + lapis,
     * waits for the enchantment choices, picks one (highest level by default, or
     * the 0-based `choice` index), and takes the enchanted item back.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item in inventory to enchant (e.g. diamond_sword).
     * @param {number} [choice], optional 0-based index of which enchant to take; defaults to the highest-level option.
     * @returns {Promise<boolean>} true if enchanted, false otherwise.
     * @example await skills.enchantItem(bot, "diamond_sword");
     **/
    const tableBlock = world.getNearestBlock(bot, 'enchanting_table', 32);
    if (!tableBlock) {
        log(bot, 'No enchanting table nearby. Craft one (4 obsidian + 2 diamond + 1 book) and place it.');
        return false;
    }
    await goToNearestBlock(bot, 'enchanting_table', 4, 32);

    const item = bot.inventory.items().find(i => i.name === itemName)
        || bot.inventory.items().find(i => i.name.includes(itemName));
    if (!item) {
        log(bot, `No ${itemName} in inventory to enchant.`);
        return false;
    }
    const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli');
    if (!lapis) {
        log(bot, 'No lapis_lazuli to spend on enchanting (mine it, or trade with a cleric villager).');
        return false;
    }

    try {
        const table = await bot.openEnchantmentTable(tableBlock);
        await table.putTargetItem(item);
        await table.putLapis(lapis);

        // wait until the server sends real enchantment levels (the 'ready' event
        // fires once all three choices have a level >= 0)
        if (!table.enchantments || table.enchantments[0].level < 0) {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('timed out waiting for enchantments')), 5000);
                table.once('ready', () => { clearTimeout(t); resolve(); });
            });
        }

        const choices = table.enchantments || [];
        if (!choices.length) {
            log(bot, 'No enchantments available — place bookshelves around the table for better options.');
            table.close();
            return false;
        }
        let idx = choice != null ? parseInt(choice) : choices.reduce((best, c, i) => (c.level > choices[best].level ? i : best), 0);
        if (idx < 0 || idx >= choices.length) idx = 0;

        await table.enchant(idx);
        await table.takeTargetItem();
        table.close();
        log(bot, `Enchanted ${itemName} (cost ${choices[idx].level} levels).`);
        return true;
    } catch (err) {
        log(bot, `Enchanting failed: ${err.message}`);
        return false;
    }
}

export async function useAnvil(bot, action, itemName1, itemName2=null, rename=null) {
    /**
     * Use the nearest anvil to rename an item or combine two items (merge
     * enchantments / repair / apply an enchanted book).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} action, 'rename' or 'combine'.
     * @param {string} itemName1, first item (the tool/gear, or the item to rename).
     * @param {string} [itemName2], second item (enchanted book or matching tool) for 'combine'.
     * @param {string} [rename], new display name (optional).
     * @returns {Promise<boolean>} true if the anvil action succeeded.
     * @example await skills.useAnvil(bot, "combine", "diamond_sword", "enchanted_book");
     **/
    const anvilBlock = world.getNearestBlock(bot, 'anvil', 16)
        || world.getNearestBlock(bot, 'chipped_anvil', 16)
        || world.getNearestBlock(bot, 'damaged_anvil', 16);
    if (!anvilBlock) {
        log(bot, 'No anvil nearby. Craft one (3 iron_block + 4 iron_ingot) and place it.');
        return false;
    }
    await goToPosition(bot, anvilBlock.position.x, anvilBlock.position.y, anvilBlock.position.z, 3);

    const item1 = bot.inventory.items().find(i => i.name === itemName1)
        || bot.inventory.items().find(i => i.name.includes(itemName1));
    if (!item1) {
        log(bot, `No ${itemName1} in inventory.`);
        return false;
    }

    try {
        const anvil = await bot.openAnvil(anvilBlock);
        if (action === 'rename') {
            if (!rename) {
                log(bot, 'Rename needs a new name. Use !anvil(rename, <item>, , "<new name>").');
                anvil.close();
                return false;
            }
            await anvil.rename(item1, rename);
        } else {
            const item2 = bot.inventory.items().find(i => i.name === itemName2)
                || bot.inventory.items().find(i => i.name.includes(itemName2));
            if (!item2) {
                log(bot, `No ${itemName2} in inventory to combine with.`);
                anvil.close();
                return false;
            }
            await anvil.combine(item1, item2, rename || null);
        }
        anvil.close();
        log(bot, `Anvil ${action} done for ${itemName1}.`);
        return true;
    } catch (err) {
        log(bot, `Anvil failed: ${err.message}`);
        return false;
    }
}

export async function writeBook(bot, title, pages) {
    /**
     * Write a book-and-quill in inventory. `pages` is a string or array of
     * strings (one per page). After writing it becomes a signed written_book.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} title, the book's title.
     * @param {string|string[]} pages, page text (string) or array of page strings.
     * @returns {Promise<boolean>} true if written, false otherwise.
     * @example await skills.writeBook(bot, "For my beloved", "I love you ~ nya ♥");
     **/
    const book = bot.inventory.items().find(i => i.name === 'writable_book');
    if (!book) {
        log(bot, 'No writable_book in inventory. Craft one (book + ink_sac + feather -> book_and_quill / writable_book).');
        return false;
    }
    const pageList = Array.isArray(pages) ? pages : [pages];
    try {
        // signBook writes AND signs, so she produces a titled, signed written_book
        await bot.signBook(book.slot, pageList, bot.username, title);
        log(bot, `Wrote and signed "${title}".`);
        return true;
    } catch (err) {
        log(bot, `Book writing failed: ${err.message}`);
        return false;
    }
}

const MATURE_CROP_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
function _cropAge(block) {
    if (!block) return -1;
    const props = typeof block.getProperties === 'function' ? block.getProperties() : null;
    if (props && props.age != null) return props.age;
    return block.metadata ?? -1;
}

export async function harvestCrops(bot, maxDistance=16) {
    /**
     * Find and harvest all mature crops (wheat, carrots, potatoes, beetroot)
     * within maxDistance, collecting the drops. Only digs fully-grown crops.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [maxDistance], search radius (default 16).
     * @returns {Promise<number>} number of crops harvested.
     * @example await skills.harvestCrops(bot);
     **/
    let harvested = 0;
    for (const crop of Object.keys(MATURE_CROP_AGE)) {
        const maxAge = MATURE_CROP_AGE[crop];
        const mature = world.getNearestBlocksWhere(
            bot,
            (b) => b && b.name === crop && _cropAge(b) >= maxAge,
            maxDistance,
            10000
        );
        for (const block of mature) {
            try {
                await bot.dig(block, true);
                harvested++;
            } catch (e) {
                log(bot, `Failed to harvest ${crop}: ${e.message}`);
                break;
            }
        }
    }
    if (harvested) {
        await pickupNearbyItems(bot);
        log(bot, `Harvested ${harvested} mature crops.`);
    } else {
        log(bot, 'No mature crops nearby to harvest.');
    }
    return harvested;
}

export async function breedAnimals(bot, maxDistance=16) {
    /**
     * Feed two nearby animals of the same type their breeding food to breed them.
     * Handles sheep/cows (wheat), pigs/carrots, chickens/seeds, etc.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [maxDistance], search radius (default 16).
     * @returns {Promise<boolean>} true if a pair was fed, false otherwise.
     * @example await skills.breedAnimals(bot);
     **/
    const BREED_FOOD = {
        sheep: 'wheat', cow: 'wheat', mooshroom: 'wheat', goat: 'wheat',
        pig: 'carrot', rabbit: 'carrot',
        chicken: 'wheat_seeds',
        horse: 'golden_apple', donkey: 'golden_apple',
        cat: 'cod', wolf: 'bone',
        turtle: 'seagrass', axolotl: 'tropical_fish', panda: 'bamboo',
    };
    const animals = Object.keys(bot.entities)
        .map(id => bot.entities[id])
        .filter(e => e && e.type === 'mob' && BREED_FOOD[e.name])
        .filter(e => bot.entity.position.distanceTo(e.position) <= maxDistance);

    // find two of the same type
    const byType = {};
    for (const a of animals) (byType[a.name] ||= []).push(a);
    for (const [type, list] of Object.entries(byType)) {
        if (list.length < 2) continue;
        const foodName = BREED_FOOD[type];
        const food = bot.inventory.items().find(i => i.name === foodName);
        if (!food) {
            log(bot, `Would breed ${type}s but have no ${foodName}.`);
            continue;
        }
        await bot.equip(food, 'hand');
        for (const a of list.slice(0, 2)) {
            await bot.lookAt(a.position.offset(0, 1, 0));
            await bot.useOn(a);
            await new Promise(r => setTimeout(r, 400));
        }
        log(bot, `Fed two ${type}s to breed.`);
        return true;
    }
    log(bot, 'No breedable pair of animals nearby (need 2 of the same type + their food).');
    return false;
}
