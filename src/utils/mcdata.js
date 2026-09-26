import minecraftData from 'minecraft-data';
import settings from '../agent/settings.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import { plugin as tool } from 'mineflayer-tool';
import plugin from 'mineflayer-armor-manager';
const armorManager = plugin;
// 3rd-party bot plugins (develop): CJS-only packages → createRequire so bun ESM can load them.
// death-event is ESM (named export deathEventPlugin). statemachine is CJS named exports.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { deathEventPlugin } from 'mineflayer-death-event';
const tpsInit = require('mineflayer-tps'); // factory: init() -> inject(bot)
const { GuiPlugin } = require('mineflayer-gui/src/plugin'); // class, NOT a plugin fn — vendor pattern: bot.gui = new GuiPlugin(bot)
const hawkEyeMod = require('minecrafthawkeye'); // { default: plugin } + utils
const hawkEyePlugin = hawkEyeMod.default || hawkEyeMod;
const { plugin: movementPlugin } = require('mineflayer-movement');
const statemachine = require('mineflayer-statemachine');
let mc_version = null; // resolved lazily — settings are injected via setSettings() AFTER module imports, so reading settings here always yields undefined
function resolvedVersion() {
    return settings.minecraft_version || mc_version || '26.3';
}
let mcdata = null;
let Item = null;

/**
 * @typedef {string} ItemName
 * @typedef {string} BlockName
*/

export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar'];
export const MATCHING_WOOD_BLOCKS = [
    'log',
    'planks',
    'sign',
    'boat',
    'fence_gate',
    'door',
    'fence',
    'slab',
    'stairs',
    'button',
    'pressure_plate',
    'trapdoor'
]
export const WOOL_COLORS = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black'
]


export function initBot(username) {
    const options = {
        username: username,
        host: settings.host,
        port: settings.port,
        auth: settings.auth,
        version: resolvedVersion(),
        checkTimeoutInterval: 60000,  // 60s keep-alive check (default 30s) — reduces disconnects on slow servers
        viewDistance: 'short',        // bot loads a small area; default 'far' spikes server heap on join
        clientSettings: {
            viewDistance: 4,          // tell server to send only a 9x9 chunk area around the bot
        },
    }
    if (!options.version || options.version === "auto") {
        delete options.version;
    }

    const bot = createBot(options);

    // The collectblock plugin's cancelTask() waits on 'collectBlock_finished' via
    // events.once each time collect() runs; repeated collects accumulate those
    // one-shot listeners and trip the default 10-listener warning (and hold the
    // event emitter open during shutdown). Bump the ceiling so heavy gathering
    // stays silent and doesn't wedge process exit.
    bot.setMaxListeners(0);

    // 26.3: NO position throttle. ServerboundClientTickEnd (0xd) pairs with
    // each position/look send per-tick (receivedPositionThisTick); delaying
    // position 50ms while tick_end goes out immediately desyncs the gate and
    // the server kicks "Invalid move player packet received" ~2s after spawn.
    // physics.js sendTickEnd() already paces sends correctly.
    // Spawn hold: block ALL movement writes for 6s after every spawn so the
    // client never streams falling positions before the server acks spawn.
    // (mineflayer's physicsEnabled flag doesn't stop updatePosition sends.)
    // 26.3: teleport_confirm is NOT movement — the server REQUIRES it to
    // finish spawn/teleport placement (awaitingTeleport). Blocking it leaves
    // the spawn teleport unacked; the server keeps her at the stale pre-join
    // spot while the client simulates ahead -> moved-wrongly kick on join.
    const MOVE_PKTS = new Set(['position', 'position_look', 'look', 'flying', 'tick_end']);
    const _write = bot._client.write.bind(bot._client);
    let spawnHoldUntil = 0;
    let spawnedOnce = false;
    // 26.3: the spawn-hold MUST cover EasyAuth /login (chat_command goes out
    // ~280ms after config-finish) plus the post-login placement burst.
    // Re-arming on every 'spawn' event is wrong: mineflayer fires 'spawn' at
    // login, but the server's placement burst (2 teleports + chunk storm)
    // runs AFTER — and worse, the hold was BLIND to physics.js's own
    // burst-quiet/look-hold clocks, so the three gates disagreed and the
    // first look always leaked at the worst moment (18:30:52: 2 looks 36ms
    // apart after an 8s hold -> kick). Single 25s hold from the FIRST spawn
    // covers login + burst + settle; physics.js gates handle the rest.
    bot.on('spawn', () => { if (!spawnedOnce) { spawnedOnce = true; spawnHoldUntil = Date.now() + 25000; } });
    // 26.3 walk-death logger: ring-buffer of last 40 sends of ANY kind.
    // Position-only logging exonerated movement (kicks with d0.00 stand-still);
    // the killer is a non-position packet in the fatal window — log all names
    // so the dump shows block_dig/punch/use_item/click interleaving.
    const POSBUF = [];
    bot._posBuf = POSBUF;
    bot._client.write = function (name, data) {
        if (MOVE_PKTS.has(name) && Date.now() < spawnHoldUntil) return;
        try {
            let extra = '';
            if (data) {
                if (data.status !== undefined) extra = ' st=' + data.status;
                else if (data.slot !== undefined) extra = ' slot=' + data.slot;
                else if (data.hand !== undefined) extra = ' hand=' + data.hand;
            }
            const isPos = (name === 'position' || name === 'position_look');
            POSBUF.push({ t: Date.now(), n: name + extra, x: isPos ? +data.x.toFixed(2) : 0, y: isPos ? +data.y.toFixed(2) : 0, z: isPos ? +data.z.toFixed(2) : 0, g: data && data.onGround ? 1 : 0 });
            if (POSBUF.length > 40) POSBUF.shift();
        } catch (e) {}
        return _write(name, data);
    };

    // Suppress PartialReadError for non-critical packets
    // Paper servers sometimes send packets that node-minecraft-protocol
    // can't fully parse (scoreboard, resource_pack, custom_payload, etc.)
    // These errors crash the bot but the packets aren't needed for gameplay
    const originalEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = function(event, ...args) {
        if (event === 'error' && args[0]) {
            const err = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            if (errStr.includes('PartialReadError')) {
                console.warn('[mcdata] Suppressed PartialReadError:', errStr.substring(0, 120));
                return true; // Swallow the error
            }
        }
        return originalEmit(event, ...args);
    };

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    try { bot.loadPlugin(tool); } catch (_) {} // explicit: collectblock pulls it anyway, but direct calls need it registered first
    bot.loadPlugin(armorManager); // auto equip armor

    // ---- 3rd-party bot plugins (all passive/low-CPU; nothing starts loops by itself) ----
    try { bot.loadPlugin(deathEventPlugin()); } catch (e) { console.warn('[mcdata] death-event load failed:', e.message); } // 'playerDeath' chat event
    try { bot.loadPlugin(tpsInit()); } catch (e) { console.warn('[mcdata] tps load failed:', e.message); } // bot.getTps()
    try { bot.gui = new GuiPlugin(bot); } catch (e) { console.warn('[mcdata] gui attach failed:', e.message); } // vendored GUI query (villager trades): bot.gui.Query()
    try { bot.loadPlugin(hawkEyePlugin); } catch (e) { console.warn('[mcdata] hawkEye load failed:', e.message); } // bot.hawkEye.oneShot/autoAttack ONLY — NEVER startRadar on 1 OCPU
    try { bot.loadPlugin(movementPlugin); } catch (e) { console.warn('[mcdata] movement load failed:', e.message); } // bot.movement: short-range follow/strafe ONLY, pathfinder stays primary
    bot.statemachine = statemachine; // NOT a bot plugin — class lib, used on-demand by !guardMode (never auto-started)
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        mcdata = minecraftData(mc_version);
        Item = prismarine_items(mc_version);

        // Never let auto-deposit stash survival gear into a chest (bow, arrows, elytra,
        // rockets, spare chests) — extend collectblock's default armor/tool guard, which
        // only protects helmet/chestplate/leggings/boots/shield/sword/pickaxe/axe/shovel/hoe.
        const _gearParts = ['helmet', 'chestplate', 'leggings', 'boots', 'shield', 'sword',
            'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'arrow', 'elytra', 'firework_rocket', 'chest'];
        bot.collectBlock.itemFilter = (item) => !_gearParts.some((p) => item.name.includes(p));
    });

    return bot;
}

export function isHuntable(mob) {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16 is not baby
}

export function isHostile(mob) {
    if (!mob || !mob.name) return false;
    return  (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem';
}

// blocks that don't work with collectBlock, need to be manually collected
export function mustCollectManually(blockName) {
    // all crops (that aren't normal blocks), torches, buttons, levers, redstone,
    const full_names = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass', 'bamboo',
        'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose', 'lily_of_the_valley', 'wither_rose',
        'lever', 'redstone_wire', 'lantern']
    const partial_names = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern']
    return full_names.includes(blockName.toLowerCase()) || partial_names.some(partial => blockName.toLowerCase().includes(partial));
}

export function getItemId(itemName) {
    let item = mcdata.itemsByName[itemName];
    if (item) {
        return item.id;
    }
    return null;
}

export function getItemName(itemId) {
    let item = mcdata.items[itemId]
    if (item) {
        return item.name;
    }
    return null;
}

export function getBlockId(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (block) {
        return block.id;
    }
    return null;
}

export function getBlockName(blockId) {
    let block = mcdata.blocks[blockId]
    if (block) {
        return block.name;
    }
    return null;
}

export function getEntityId(entityName) {
    let entity = mcdata.entitiesByName[entityName];
    if (entity) {
        return entity.id;
    }
    return null;
}

// Levenshtein edit distance (bounded to reasonable name lengths).
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

// Suggest close matches for an invalid block/item name so the LLM's retry can
// actually succeed ("did you mean: ..."). neuro-sdk best-practice: actionable errors.
function suggestNames(target, nameMap, limit = 4) {
    const t = String(target || '').toLowerCase();
    if (!t || !nameMap) return [];
    const scored = [];
    for (const name of Object.keys(nameMap)) {
        const n = name.toLowerCase();
        if (n === t) continue;
        const dist = levenshtein(t, n);
        if (dist <= Math.max(2, Math.floor(t.length / 3))) scored.push({ name, dist });
    }
    scored.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));
    return scored.slice(0, limit).map(s => s.name);
}

export function suggestBlockNames(name) { return suggestNames(name, mcdata && mcdata.blocksByName); }
export function suggestItemNames(name) { return suggestNames(name, mcdata && mcdata.itemsByName); }
export function suggestBlockOrItemNames(name) {
    const b = suggestNames(name, mcdata && mcdata.blocksByName);
    const i = suggestNames(name, mcdata && mcdata.itemsByName);
    return [...new Set([...b, ...i])].slice(0, 4);
}

export function getAllItems(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let items = []
    for (const itemId in mcdata.items) {
        const item = mcdata.items[itemId];
        if (!ignore.includes(item.name)) {
            items.push(item);
        }
    }
    return items;
}

export function getAllItemIds(ignore) {
    const items = getAllItems(ignore);
    let itemIds = [];
    for (const item of items) {
        itemIds.push(item.id);
    }
    return itemIds;
}

export function getAllBlocks(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let blocks = []
    for (const blockId in mcdata.blocks) {
        const block = mcdata.blocks[blockId];
        if (!ignore.includes(block.name)) {
            blocks.push(block);
        }
    }
    return blocks;
}

export function getAllBlockIds(ignore) {
    const blocks = getAllBlocks(ignore);
    let blockIds = [];
    for (const block of blocks) {
        blockIds.push(block.id);
    }
    return blockIds;
}

export function getAllBiomes() {
    return mcdata.biomes;
}

export function getItemCraftingRecipes(itemName) {
    let itemId = getItemId(itemName);
    if (!mcdata.recipes[itemId]) {
        return null;
    }

    let recipes = [];
    for (let r of mcdata.recipes[itemId]) {
        let recipe = {};
        let ingredients = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (let ingredient of ingredients) {
            let ingredientName = getItemName(ingredient);
            if (ingredientName === null) continue;
            if (!recipe[ingredientName])
                recipe[ingredientName] = 0;
            recipe[ingredientName]++;
        }
        recipes.push([
            recipe,
            {craftedCount : r.result.count}
        ]);
    }
    // sort recipes by if their ingredients include common items
    const commonItems = ['oak_planks', 'oak_log', 'coal', 'cobblestone'];
    recipes.sort((a, b) => {
        let commonCountA = Object.keys(a[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + a[0][key], 0);
        let commonCountB = Object.keys(b[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + b[0][key], 0);
        return commonCountB - commonCountA;
    });

    return recipes;
}

// True when a recipe fits the 2x2 player inventory grid (no crafting table
// needed). Shaped recipes fit iff the bounding box of filled cells is <=2x2;
// shapeless recipes fit iff they use <=4 ingredients total. Reads the RAW
// recipe rows (shape data getItemCraftingRecipes deliberately drops), so this
// is the only function that answers the table question — call it before
// telling her (or a player) where to craft.
export function recipeNeedsTable(itemName) {
    // Returns true (needs table) | false (2x2 works) | null (no recipe / unknown).
    // Shape rule: fits iff SOME recipe row has a filled-cell bbox <=2x2
    // (shaped) or <=4 total units (shapeless) — EXCEPT the crafting table
    // itself, which bootstraps from 2x2 planks by hand (4 planks -> table is a
    // 2x2 recipe; the table is what UNLOCKS 3x3, so calling it table-gated is
    // a lie that strands her). Same exemption logic covers nothing else: every
    // other 2x2-fitter genuinely crafts in the inventory grid.
    let itemId = null;
    try { itemId = getItemId(itemName); } catch (_) { return null; }
    if (itemId == null || !mcdata.recipes[itemId]) return null;
    if (String(itemName).toLowerCase().replace(/^minecraft:/, '') === 'crafting_table') return false;
    for (let r of mcdata.recipes[itemId]) {
        if (r.ingredients) {
            // shapeless: count total ingredient units
            let total = 0;
            for (let ing of r.ingredients) if (ing != null) total++;
            if (total <= 4) return false;
        } else if (r.inShape) {
            let minR = 9, maxR = -1, minC = 9, maxC = -1;
            r.inShape.forEach((row, ri) => row.forEach((c, ci) => {
                if (c != null) { minR = Math.min(minR, ri); maxR = Math.max(maxR, ri); minC = Math.min(minC, ci); maxC = Math.max(maxC, ci); }
            }));
            if (maxR >= 0 && (maxR - minR) < 2 && (maxC - minC) < 2) return false;
        }
        // else: unknown shape kind — keep looking at other rows
    }
    return true; // no 2x2 row found on any recipe
}

export function isSmeltable(itemName) {
    const misc_smeltables = ['beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
    return itemName.includes('raw') || itemName.includes('log') || misc_smeltables.includes(itemName);
}

export function getSmeltingFuel(bot) {
    let fuel = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod')
    if (fuel)
        return fuel;
    fuel = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks'))
    if (fuel)
        return fuel;
    return bot.inventory.items().find(i => i.name === 'coal_block' || i.name === 'lava_bucket');
}

export function getFuelSmeltOutput(fuelName) {
    if (fuelName === 'coal' || fuelName === 'charcoal')
        return 8;
    if (fuelName === 'blaze_rod')
        return 12;
    if (fuelName.includes('log') || fuelName.includes('planks'))
        return 1.5
    if (fuelName === 'coal_block')
        return 80;
    if (fuelName === 'lava_bucket')
        return 100;
    return 0;
}

export function getItemSmeltingIngredient(itemName) {
    return {    
        baked_potato: 'potato',
        steak: 'raw_beef',
        cooked_chicken: 'raw_chicken',
        cooked_cod: 'raw_cod',
        cooked_mutton: 'raw_mutton',
        cooked_porkchop: 'raw_porkchop',
        cooked_rabbit: 'raw_rabbit',
        cooked_salmon: 'raw_salmon',
        dried_kelp: 'kelp',
        iron_ingot: 'raw_iron',
        gold_ingot: 'raw_gold',
        copper_ingot: 'raw_copper',
        glass: 'sand'
    }[itemName];
}

export function getItemBlockSources(itemName) {
    let itemId = getItemId(itemName);
    let sources = [];
    for (let block of getAllBlocks()) {
        if (block.drops.includes(itemId)) {
            sources.push(block.name);
        }
    }
    return sources;
}

export function getItemAnimalSource(itemName) {
    return {
        raw_beef: 'cow',
        raw_chicken: 'chicken',
        raw_cod: 'cod',
        raw_mutton: 'sheep',
        raw_porkchop: 'pig',
        raw_rabbit: 'rabbit',
        raw_salmon: 'salmon',
        leather: 'cow',
        wool: 'sheep'
    }[itemName];
}

// Villager profession trades (emerald price = typical range). Static curated
// table — minecraft-data has no trade offers, so this is hand-maintained.
// Returns { profession, price } or null when no villager sells it.
const VILLAGER_TRADES = {
    // librarian (enchanted books: emeralds + book)
    mending: { profession: 'librarian', price: '~10-38 emeralds + book' },
    // cleric
    ender_pearl: { profession: 'cleric', price: '~5 emeralds' },
    redstone: { profession: 'cleric', price: '1 emerald' },
    lapis_lazuli: { profession: 'cleric', price: '1 emerald' },
    glowstone: { profession: 'cleric', price: '4 emeralds' },
    // farmer
    bread: { profession: 'farmer', price: '1 emerald' },
    golden_carrot: { profession: 'farmer', price: '3 emeralds' },
    // fletcher
    arrow: { profession: 'fletcher', price: '1 emerald' },
    bow: { profession: 'fletcher', price: '2-3 emeralds' },
    // toolsmith / weaponsmith / armorer
    diamond_pickaxe: { profession: 'toolsmith', price: '~12+ emeralds' },
    diamond_axe: { profession: 'toolsmith', price: '~12+ emeralds' },
    diamond_sword: { profession: 'weaponsmith', price: '~12+ emeralds' },
    diamond_chestplate: { profession: 'armorer', price: 'high emerald cost' },
    // leatherworker (saddle = uncraftable tack, master trade)
    saddle: { profession: 'leatherworker', price: '~6 emeralds (master trade)' },
    // cartographer
    woodland_explorer_map: { profession: 'cartographer', price: '~12+ emeralds + compass' },
    ocean_explorer_map: { profession: 'cartographer', price: '~12+ emeralds + compass' },
    // wandering trader (no profession block — appears randomly)
    nautilus_shell: { profession: 'wandering trader', price: '~5 emeralds' },
    small_dripleaf: { profession: 'wandering trader', price: 'emeralds' },
    moss_block: { profession: 'wandering trader', price: 'emeralds' },
    melon: { profession: 'wandering trader', price: 'emerald' },
};
export function getItemVillagerTrade(itemName) {
    return VILLAGER_TRADES[String(itemName || '').toLowerCase()] || null;
}
export const VILLAGER_TRADE_KEYS = new Set(Object.keys(VILLAGER_TRADES));

// Loot-only / boss-gated items: no recipe, no mob drop, no villager sells them.
// minecraft-data can't tell us this (it only knows drops + recipes), so this is
// a hand-maintained set: full Netherite gear, trims, music discs, boss drops,
// smithing templates, and structure-exclusive loot.
const LOOT_ONLY = new Set([
    // netherite gear (upgrade at a smithing table, never crafted/looted whole)
    'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
    'netherite_sword', 'netherite_pickaxe', 'netherite_axe', 'netherite_shovel', 'netherite_hoe',
    // smithing templates
    'netherite_upgrade_smithing_template',
    'sentry_armor_trim_smithing_template', 'dune_armor_trim_smithing_template',
    'coast_armor_trim_smithing_template', 'wild_armor_trim_smithing_template',
    'ward_armor_trim_smithing_template', 'tide_armor_trim_smithing_template',
    'vex_armor_trim_smithing_template', 'rib_armor_trim_smithing_template',
    'snout_armor_trim_smithing_template', 'eye_armor_trim_smithing_template',
    'spire_armor_trim_smithing_template', 'flow_armor_trim_smithing_template',
    'bolt_armor_trim_smithing_template', 'host_armor_trim_smithing_template',
    'shaper_armor_trim_smithing_template', 'silence_armor_trim_smithing_template',
    // music discs
    'music_disc_13', 'music_disc_cat', 'music_disc_blocks', 'music_disc_chirps',
    'music_disc_far', 'music_disc_mall', 'music_disc_mellohi', 'music_disc_stal',
    'music_disc_strad', 'music_disc_ward', 'music_disc_11', 'music_disc_wait',
    'music_disc_otherside', 'music_disc_relic', 'music_disc_5', 'music_disc_pigstep',
    // boss / structure-exclusive
    'dragon_egg', 'dragon_head', 'elytra', 'totem_of_undying', 'heart_of_the_sea',
    'trident', 'mace', 'heavy_core', 'wind_charge', 'ominous_trial_key',
    'trial_key', 'vault', 'ominous_vault', 'trial_spawner',
    'recovery_compass', 'echo_shard', 'disc_fragment_9', 'turtle_helmet',
]);
export function getItemLootOnly(itemName) {
    return LOOT_ONLY.has(String(itemName || '').toLowerCase()) ? 'loot-only' : null;
}
export const LOOT_ONLY_KEYS = LOOT_ONLY;

export function getBlockTool(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (!block || !block.harvestTools) {
        return null;
    }
    return getItemName(Object.keys(block.harvestTools)[0]);  // Double check first tool is always simplest
}

// Every tool that can harvest this block (not just the simplest). Used to answer
// "do I have something that can gather this?" rather than "do I have the wooden
// version specifically".
export function getBlockHarvestTools(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (!block || !block.harvestTools) {
        return null;
    }
    return Object.keys(block.harvestTools)
        .map(id => getItemName(id))
        .filter(Boolean);
}

// ---- block vision: physics, classes, hazard ----
// Gravity: falls when unsupported (sand/gravel/concrete powder/anvil/dragon egg).
// Pistons, string and "canPlaceOn" plans must treat these as moving ground.
export const GRAVITY_BLOCKS = new Set([
    'sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg',
    'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder',
    'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder',
    'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder',
    'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder',
    'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder', 'black_concrete_powder',
]);

// Tile-entity / utterly-hard blocks a piston can NEVER push or pull. Secret doors,
// pitfalls and push-traps must be planned around these (use them as the frame that
// never moves, or keep them out of the moving part entirely).
export const UNPUSHABLE = new Set([
    'bedrock', 'obsidian', 'crying_obsidian', 'reinforced_deepslate',
    'spawner', 'trial_spawner', 'vault', 'end_portal_frame', 'command_block',
    'structure_block', 'barrier', 'chest', 'trapped_chest', 'ender_chest',
    'copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest',
    'furnace', 'blast_furnace', 'smoker', 'hopper', 'dropper', 'dispenser', 'crafter',
    'brewing_stand', 'enchanting_table', 'beacon', 'jukebox', 'lectern', 'chiseled_bookshelf',
    'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
    'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
    'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
    'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
]);

// Blocks that hurt, burn, freeze or blow up. Vision marks these with (!) so she
// never pathfinds through them blindly and reads them as danger in others' builds.
export const HAZARD_BLOCKS = new Set([
    'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'pointed_dripstone',
    'wither_rose', 'sweet_berry_bush', 'powder_snow', 'tnt',
]);

const _INTERACTIVE_SUFFIX = ['_door', '_trapdoor', '_fence_gate', '_button', '_pressure_plate', '_bed', '_boat'];

// Right-clickable / usable blocks: doors, hatches, switches, beds, boats,
// workstations, containers, note/bell/bulb. Used to spot "mechanic" blocks in a
// scan and as pointing-target candidates (someone gesturing at one means something).
export function isInteractiveBlock(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return false;
    for (const s of _INTERACTIVE_SUFFIX) if (n.endsWith(s)) return true;
    return ['lever', 'chest', 'trapped_chest', 'copper_chest', 'exposed_copper_chest',
        'weathered_copper_chest', 'oxidized_copper_chest', 'ender_chest', 'barrel',
        'note_block', 'bell', 'copper_bulb', 'daylight_detector', 'jukebox', 'lectern',
        'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'brewing_stand',
        'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'grindstone',
        'stonecutter', 'loom', 'cartography_table', 'smithing_table', 'composter',
        'cauldron', 'beacon', 'shulker_box', 'crafter', 'dispenser', 'dropper',
        'hopper', 'respawn_anchor'].includes(n);
}

// Terrain: generates with the land itself (stone/dirt/deepslate/netherrack/end
// rock, ores, natural ice/snow, sculk, dripstone...). Seeing these = the world as
// the seed made it.
export const NATURAL_TERRAIN = new Set([
    'air', 'cave_air', 'void_air', 'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt',
    'podzol', 'mycelium', 'mud', 'muddy_mangrove_roots', 'clay',
    'stone', 'cobblestone', 'mossy_cobblestone', 'gravel', 'sand', 'red_sand', 'water',
    'lava', 'bedrock', 'deepslate', 'cobbled_deepslate', 'tuff', 'diorite', 'andesite',
    'granite', 'calcite', 'dripstone_block', 'pointed_dripstone', 'smooth_basalt', 'basalt',
    'blackstone', 'netherrack', 'soul_sand', 'soul_soil', 'glowstone', 'nether_quartz_ore',
    'nether_gold_ore', 'ancient_debris', 'end_stone', 'obsidian',
    'snow', 'snow_block', 'ice', 'packed_ice', 'blue_ice', 'frosted_ice', 'powder_snow',
    'sandstone', 'red_sandstone', 'smooth_sandstone', 'smooth_red_sandstone',
    'cut_sandstone', 'cut_red_sandstone', 'chiseled_sandstone', 'chiseled_red_sandstone',
    'sculk', 'sculk_vein', 'sculk_catalyst', 'sculk_sensor', 'sculk_shrieker', 'reinforced_deepslate',
    'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'copper_ore',
    'lapis_ore', 'emerald_ore', 'deepslate_coal_ore', 'deepslate_iron_ore',
    'deepslate_gold_ore', 'deepslate_diamond_ore', 'deepslate_redstone_ore',
    'deepslate_copper_ore', 'deepslate_lapis_ore', 'deepslate_emerald_ore',
    'infested_stone', 'infested_cobblestone', 'infested_deepslate',
]);

// Vegetation: grows on its own (trees, flowers, crops-gone-wild, vines, moss...).
// A forest of these is nature; a PERFECT ROW of them is a player farm.
export const NATURAL_VEG = new Set([
    'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush', 'vine',
    'glow_lichen', 'moss_block', 'moss_carpet', 'hanging_roots', 'spore_blossom',
    'azalea', 'flowering_azalea', 'azalea_leaves', 'flowering_azalea_leaves',
    'cactus', 'sugar_cane', 'bamboo', 'bamboo_sapling', 'kelp', 'kelp_plant',
    'seagrass', 'tall_seagrass', 'sea_pickle', 'lily_pad', 'frogspawn',
    'red_mushroom', 'brown_mushroom', 'red_mushroom_block', 'brown_mushroom_block',
    'mushroom_stem', 'nether_sprouts', 'crimson_roots', 'warped_roots', 'crimson_fungus',
    'warped_fungus', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
    'shroomlight', 'glow_berries', 'glow_berry_bush', 'sweet_berry_bush', 'cave_vines',
    'cave_vines_plant', 'dripleaf', 'small_dripleaf', 'big_dripleaf', 'big_dripleaf_stem',
    'chorus_plant', 'chorus_flower', 'cocoa', 'wheat', 'carrots', 'potatoes', 'beetroots',
    'melon_stem', 'pumpkin_stem', 'torchflower_crop', 'pitcher_crop',
]);

// Generates naturally AND gets built/farmed by players: logs, leaves, wool
// (mansions), pumpkins/melons (patches + farms), hay bales (villages), glass-free
// structures... vision must read ARRANGEMENT, not just the name.
export const AMBIGUOUS_ORIGIN = new Set([
    'hay_block', 'pumpkin', 'carved_pumpkin', 'jack_o_lantern', 'melon',
    'bookshelf', 'lodestone', 'tinted_glass',
]);

function _isWoodOrLeaf(n) {
    if (n.endsWith('_log') || n.endsWith('_wood') || n.includes('_leaves') || n.endsWith('_sapling')) return true;
    if (n === 'bamboo' || n === 'bamboo_sapling') return true;
    return false;
}

function _isWool(n) { return n.endsWith('_wool') || n === 'wool'; }

function _isDoorish(n) {
    return n.endsWith('_door') || n.endsWith('_trapdoor') || n.endsWith('_fence_gate') ||
        n.endsWith('_button') || n.endsWith('_pressure_plate') || n.endsWith('_stairs') ||
        n.endsWith('_slab') || n.endsWith('_fence') || n.endsWith('_sign') || n.endsWith('_boat');
}

// Where did this block most likely come from: terrain (seed-made land),
// vegetation (grown), crafted (only players make/place these), ambiguous (both —
// read the arrangement), air, or unknown. The single function behind "natural vs
// player-placed" vision.
//
// Headless-safe: mcdata is null until the bot logs in, so the sets above decide
// everything they can on their own; the recipe cross-check is a bonus, not the
// gate. Crafted = explicit set (every recipe output the registry knows) PLUS the
// recipe-lookup when data is live — so furnace/oak_planks answer even headless.
const CRAFTED_EXTRA = new Set([
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks', 'poplar_planks',
    'bamboo_planks', 'crimson_planks', 'warped_planks',
    'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest',
    'barrel', 'hopper', 'dropper', 'dispenser', 'crafter', 'brewing_stand',
    'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'grindstone',
    'stonecutter', 'loom', 'cartography_table', 'smithing_table', 'composter',
    'cauldron', 'jukebox', 'lectern', 'beacon', 'bookshelf', 'chiseled_bookshelf',
    'torch', 'redstone_torch', 'soul_torch', 'copper_torch', 'lantern', 'copper_lantern',
    'soul_lantern', 'redstone_lamp', 'copper_bulb', 'redstone_block', 'tnt',
    'glass', 'glass_pane', 'tinted_glass', 'white_stained_glass',
    'brick', 'bricks', 'stone_bricks', 'deepslate_bricks', 'deepslate_tiles',
    'nether_bricks', 'red_nether_bricks', 'end_stone_bricks', 'prismarine',
    'prismarine_bricks', 'dark_prismarine', 'sea_lantern', 'conduit',
    'sponge', 'wet_sponge', 'bookshelf',
]);
export function blockOrigin(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return 'air';
    if (n === 'air' || n === 'cave_air' || n === 'void_air') return 'air';
    if (NATURAL_TERRAIN.has(n)) return 'terrain';
    if (NATURAL_VEG.has(n)) return 'vegetation';
    if (CRAFTED_EXTRA.has(n)) return 'crafted';
    if (_isDoorish(n)) return 'crafted'; // doors/stairs/slabs/fences/signs/boats only exist placed
    if (AMBIGUOUS_ORIGIN.has(n) || _isWoodOrLeaf(n) || _isWool(n)) return 'ambiguous';
    try {
        if (mcdata && mcdata.blocksByName && mcdata.blocksByName[n]) {
            if (mcdata.recipes) {
                for (const id of Object.keys(mcdata.recipes)) {
                    const item = mcdata.items && mcdata.items[id];
                    if (item && item.name === n) return 'crafted';
                }
            }
            return 'ambiguous';
        }
    } catch (_) { /* registry not ready — fall through */ }
    return 'unknown';
}

// Full physics card for one block: solidity, light, gravity, piston-pushable,
// hazard, interactive. Powers !blockFacts and the "movable / good / bad" answers.
// Headless-safe: falls back to the static tables above when the registry isn't
// loaded yet (bot offline), so answers stay correct, just less complete.
const _STATIC_FACTS = {
    sand: { solid: true, transparent: false, emitLight: 0, gravity: true, pushable: true, hazard: false, interactive: false, material: 'mineable/shovel' },
    red_sand: { solid: true, transparent: false, emitLight: 0, gravity: true, pushable: true, hazard: false, interactive: false, material: 'mineable/shovel' },
    gravel: { solid: true, transparent: false, emitLight: 0, gravity: true, pushable: true, hazard: false, interactive: false, material: 'mineable/shovel' },
    stone: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: false, material: 'mineable/pickaxe' },
    oak_planks: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: false, material: 'mineable/axe' },
    furnace: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: false, hazard: false, interactive: true, material: 'mineable/pickaxe' },
    chest: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: false, hazard: false, interactive: true, material: 'mineable/axe' },
    obsidian: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: false, hazard: false, interactive: false, material: 'mineable/pickaxe' },
    bedrock: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: false, hazard: false, interactive: false, material: null },
    tnt: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: true, hazard: true, interactive: false, material: null },
    water: { solid: false, transparent: true, emitLight: 0, gravity: false, pushable: false, hazard: false, interactive: false, material: null },
    lava: { solid: false, transparent: true, emitLight: 15, gravity: false, pushable: false, hazard: true, interactive: false, material: null },
    glass: { solid: true, transparent: true, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: false, material: null },
    torch: { solid: false, transparent: true, emitLight: 14, gravity: false, pushable: false, hazard: false, interactive: false, material: null },
    white_wool: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: false, material: null },
    diamond_ore: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: false, material: 'mineable/pickaxe' },
    oak_log: { solid: true, transparent: false, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: false, material: 'mineable/axe' },
    oak_door: { solid: true, transparent: true, emitLight: 0, gravity: false, pushable: true, hazard: false, interactive: true, material: 'mineable/axe' },
    wheat: { solid: false, transparent: true, emitLight: 0, gravity: false, pushable: false, hazard: false, interactive: false, material: null },
};
export function getBlockFacts(name) {
    const n = String(name || '').toLowerCase();
    let b = null;
    try { b = mcdata && mcdata.blocksByName ? mcdata.blocksByName[n] : null; } catch (_) { b = null; }
    if (b) {
        return {
            name: n,
            solid: b.boundingBox === 'block',
            transparent: !!b.transparent,
            emitLight: b.emitLight || 0,
            gravity: GRAVITY_BLOCKS.has(n),
            pushable: b.boundingBox === 'block' && !UNPUSHABLE.has(n),
            hazard: HAZARD_BLOCKS.has(n) || n === 'tnt',
            interactive: isInteractiveBlock(n),
            origin: blockOrigin(n),
            material: b.material || null,
        };
    }
    // static fallback: correct for the common blocks, honest about the rest.
    const s = _STATIC_FACTS[n];
    if (!s) return null;
    return { name: n, ...s, origin: blockOrigin(n) };
}

// Light movement: which blocks let sky/block light PASS THROUGH vs which
// BLOCK it (cast shadow). Rule from the registry: transparent=true passes
// (glass, leaves, water, ice, trapdoor, ladder, vine, torch...), false blocks
// (stone, planks, wool, slabs, stairs, carpet, fences, chests, glowstone...).
// Cushions are entities (not blocks) — they never block light, same as air.
// Slabs/stairs/carpets do NOT pass light despite their shape (registry says
// opaque) — the classic spawn-proofing trap. Powers !lightPasses + the brain.
const _LIGHT_PASS_CACHE = new Map();
// Registry-verified transparent (light passes) vs opaque (blocks) for the
// common blocks — static so answers stay correct even headless/offline.
// Verified against minecraft-data 1.21.4 transparent flags 2026-09-26.
const _LIGHT_PASS_YES = new Set(['glass', 'glass_pane', 'white_stained_glass', 'oak_leaves',
    'water', 'ice', 'oak_trapdoor', 'ladder', 'vine', 'weeping_vines', 'twisting_vines',
    'cave_vines', 'torch', 'wall_torch', 'lantern', 'rail', 'detector_rail', 'cobweb',
    'air', 'cave_air', 'void_air', 'snow', 'short_grass', 'tall_grass', 'fern',
    'redstone_wire', 'lever', 'button', 'repeater', 'comparator', 'daylight_detector']);
const _LIGHT_PASS_NO = new Set(['cobblestone', 'stone', 'oak_planks', 'white_wool',
    'oak_slab', 'cobblestone_slab', 'oak_stairs', 'white_carpet', 'oak_fence',
    'chest', 'barrel', 'glowstone', 'dirt', 'grass_block', 'sand', 'gravel',
    'diamond_ore', 'coal_ore', 'iron_ore', 'obsidian', 'furnace', 'tnt', 'bedrock']);
export function lightPasses(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    if (/cushion$/.test(n)) return true; // entity seat — light passes like air
    if (_LIGHT_PASS_CACHE.has(n)) return _LIGHT_PASS_CACHE.get(n);
    let v = null;
    try {
        const b = mcdata && mcdata.blocksByName ? mcdata.blocksByName[n] : null;
        if (b) v = !!b.transparent;
    } catch (_) { v = null; }
    if (v === null) {
        if (_LIGHT_PASS_YES.has(n)) v = true;
        else if (_LIGHT_PASS_NO.has(n)) v = false;
    }
    _LIGHT_PASS_CACHE.set(n, v);
    return v;
}

// Substitute candidates for a block: the rest of its material family (same shape,
// different wood/colour/stone). Returns an array of other block names, or null if
// the block has no obvious family. Lets the bot adapt a schematic to what is
// actually gatherable nearby (oak_planks -> spruce_planks, red_wool -> white_wool,
// stone_bricks -> cobblestone).
const STONE_FAMILY = ['stone', 'cobblestone', 'mossy_cobblestone', 'stone_bricks', 'mossy_stone_bricks',
    'cracked_stone_bricks', 'smooth_stone', 'andesite', 'diorite', 'granite',
    'polished_andesite', 'polished_diorite', 'polished_granite', 'tuff',
    'deepslate', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_bricks'];
const SAND_FAMILY = ['sand', 'red_sand', 'sandstone', 'red_sandstone', 'smooth_sandstone', 'smooth_red_sandstone'];

export function getBlockSubstitutes(blockName) {
    const n = String(blockName || '');
    if (!n) return null;

    // wood: <variant>_<base>
    for (const base of MATCHING_WOOD_BLOCKS) {
        if (n.endsWith('_' + base)) {
            const variant = n.slice(0, -(base.length + 1));
            if (WOOD_TYPES.includes(variant)) return WOOD_TYPES.filter(w => w !== variant).map(w => `${w}_${base}`);
            break; // matched the base shape but not a wood prefix (e.g. 'iron_pressure_plate')
        }
    }
    // wool: <colour>_wool
    if (n.endsWith('_wool')) {
        const color = n.slice(0, -5);
        if (WOOL_COLORS.includes(color)) return WOOL_COLORS.filter(c => c !== color).map(c => `${c}_wool`);
    }
    if (STONE_FAMILY.includes(n)) return STONE_FAMILY.filter(s => s !== n);
    if (SAND_FAMILY.includes(n)) return SAND_FAMILY.filter(s => s !== n);
    return null;
}

export function makeItem(name, amount=1) {
    return new Item(getItemId(name), amount);
}

/**
 * Returns the number of ingredients required to use the recipe once.
 * 
 * @param {Recipe} recipe
 * @returns {Object<mc.ItemName, number>} an object describing the number of each ingredient.
 */
export function ingredientsFromPrismarineRecipe(recipe) {
    let requiredIngedients = {};
    if (recipe.inShape)
        for (const ingredient of recipe.inShape.flat()) {
            if(ingredient.id<0) continue; //prismarine-recipe uses id -1 as an empty crafting slot
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] += ingredient.count;
        }
    if (recipe.ingredients)
        for (const ingredient of recipe.ingredients) {
            if(ingredient.id<0) continue;
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] -= ingredient.count;
            //Yes, the `-=` is intended.
            //prismarine-recipe uses positive numbers for the shaped ingredients but negative for unshaped.
            //Why this is the case is beyond my understanding.
        }
    return requiredIngedients;
}

/**
 * Calculates the number of times an action, such as a crafing recipe, can be completed before running out of resources.
 * @template T - doesn't have to be an item. This could be any resource.
 * @param {Object.<T, number>} availableItems - The resources available; e.g, `{'cobble_stone': 7, 'stick': 10}`
 * @param {Object.<T, number>} requiredItems - The resources required to complete the action once; e.g, `{'cobble_stone': 3, 'stick': 2}`
 * @param {boolean} discrete - Is the action discrete?
 * @returns {{num: number, limitingResource: (T | null)}} the number of times the action can be completed and the limmiting resource; e.g `{num: 2, limitingResource: 'cobble_stone'}`
 */
export function calculateLimitingResource(availableItems, requiredItems, discrete=true) {
    let limitingResource = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        if (availableItems[itemType] < requiredItems[itemType] * num) {
            limitingResource = itemType;
            num = availableItems[itemType] / requiredItems[itemType];
        }
    }
    if(discrete) num = Math.floor(num);
    return {num, limitingResource}
}

let loopingItems = new Set();

export function initializeLoopingItems() {

    loopingItems = new Set(['coal',
        'wheat',
        'bone_meal',
        'diamond',
        'emerald',
        'raw_iron',
        'raw_gold',
        'redstone',
        'blue_wool',
        'packed_mud',
        'raw_copper',
        'iron_ingot',
        'dried_kelp',
        'gold_ingot',
        'slime_ball',
        'black_wool',
        'quartz_slab',
        'copper_ingot',
        'lapis_lazuli',
        'honey_bottle',
        'rib_armor_trim_smithing_template',
        'eye_armor_trim_smithing_template',
        'vex_armor_trim_smithing_template',
        'dune_armor_trim_smithing_template',
        'host_armor_trim_smithing_template',
        'tide_armor_trim_smithing_template',
        'wild_armor_trim_smithing_template',
        'ward_armor_trim_smithing_template',
        'coast_armor_trim_smithing_template',
        'spire_armor_trim_smithing_template',
        'snout_armor_trim_smithing_template',
        'shaper_armor_trim_smithing_template',
        'netherite_upgrade_smithing_template',
        'raiser_armor_trim_smithing_template',
        'sentry_armor_trim_smithing_template',
        'silence_armor_trim_smithing_template',
        'wayfinder_armor_trim_smithing_template']);
}


/**
 * Gets a detailed plan for crafting an item considering current inventory
 */
export function getDetailedCraftingPlan(targetItem, count = 1, current_inventory = {}) {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem)) {
        return "Invalid input. Please provide a valid item name and positive count.";
    }

    if (isBaseItem(targetItem)) {
        const available = current_inventory[targetItem] || 0;
        if (available >= count) return "You have all required items already in your inventory!";
        return `${targetItem} is a base item, you need to find ${count - available} more in the world`;
    }

    const inventory = { ...current_inventory };
    const leftovers = {};
    const plan = craftItem(targetItem, count, inventory, leftovers);
    return formatPlan(targetItem, plan);
}

function isBaseItem(item) {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

function craftItem(item, count, inventory, leftovers, crafted = { required: {}, steps: [], leftovers: {} }) {
    // Check available inventory and leftovers first
    const availableInv = inventory[item] || 0;
    const availableLeft = leftovers[item] || 0;
    const totalAvailable = availableInv + availableLeft;

    if (totalAvailable >= count) {
        // Use leftovers first, then inventory
        const useFromLeft = Math.min(availableLeft, count);
        leftovers[item] = availableLeft - useFromLeft;
        
        const remainingNeeded = count - useFromLeft;
        if (remainingNeeded > 0) {
            inventory[item] = availableInv - remainingNeeded;
        }
        return crafted;
    }

    // Use whatever is available
    const stillNeeded = count - totalAvailable;
    if (availableLeft > 0) leftovers[item] = 0;
    if (availableInv > 0) inventory[item] = 0;

    if (isBaseItem(item)) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = getItemCraftingRecipes(item)?.[0];
    if (!recipe) {
        crafted.required[item] = stillNeeded;
        return crafted;
    }

    const [ingredients, result] = recipe;
    const craftedPerRecipe = result.craftedCount;
    const batchCount = Math.ceil(stillNeeded / craftedPerRecipe);
    const totalProduced = batchCount * craftedPerRecipe;

    // Add excess to leftovers
    if (totalProduced > stillNeeded) {
        leftovers[item] = (leftovers[item] || 0) + (totalProduced - stillNeeded);
    }

    // Process each ingredient
    for (const [ingredientName, ingredientCount] of Object.entries(ingredients)) {
        const totalIngredientNeeded = ingredientCount * batchCount;
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted);
    }

    // Add crafting step
    const stepIngredients = Object.entries(ingredients)
        .map(([name, amount]) => `${amount * batchCount} ${name}`)
        .join(' + ');
    crafted.steps.push(`Craft ${stepIngredients} -> ${totalProduced} ${item}`);

    return crafted;
}

function formatPlan(targetItem, { required, steps, leftovers }) {
    const lines = [];

    if (Object.keys(required).length > 0) {
        lines.push('You are missing the following items:');
        Object.entries(required).forEach(([item, count]) =>
            lines.push(`- ${count} ${item}`));
        lines.push('\nOnce you have these items, here\'s your crafting plan:');
    } else {
        lines.push('You have all items required to craft this item!');
        lines.push('Here\'s your crafting plan:');
    }

    lines.push('');
    lines.push(...steps);

    // Crafting-table verdict: computed from the raw recipe shape (2x2 bbox or
    // <=4 shapeless units = inventory grid, else table). Say it plainly so she
    // knows WHERE to stand before she starts.
    try {
        const need = recipeNeedsTable(targetItem);
        if (need === true) lines.push('\nNeeds a crafting table (3x3) — place or find one first.');
        else if (need === false) lines.push('\nNo table needed — fits the 2x2 inventory grid.');
    } catch (_) {}

    if (Object.keys(required).some(item => item.includes('oak')) && !targetItem.includes('oak')) {
        lines.push('Note: Any varient of wood can be used for this recipe.');
    }

    if (Object.keys(leftovers).length > 0) {
        lines.push('\nYou will have leftover:');
        Object.entries(leftovers).forEach(([item, count]) =>
            lines.push(`- ${count} ${item}`));
    }

    return lines.join('\n');
}
