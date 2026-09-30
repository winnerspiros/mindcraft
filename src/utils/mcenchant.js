// Enchantment + brewing knowledge (2026-09-30).
//
// WHY: enchantItem() knew nothing about which enchantments exist, what any of
// them costs, which are book-only, or that the table's three offers are a
// RANDOM lottery weighted by item type and lapis count. So she could not answer
// "what do I need to get Mending?", could not tell the difference between an
// offer worth taking and one that is not, and had no notion of the bookshelf
// trick. Brewing was the same: brewPotion() took a raw ingredient name and knew
// nothing about the nether_wart -> awkward -> effect chain.
//
// Everything here is read from the 26.3 data package so it cannot drift:
//   assets/minecraft-data-26.3/enchantments.json  (43 entries, with
//   maxLevel, minCost/maxCost, category, weight, treasureOnly, tradeable)

import fs from 'node:fs';
import path from 'node:path';

let CACHE = null;

function load() {
    if (CACHE) return CACHE;
    // resolve relative to this file (src/utils/) -> repo assets/
    const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../assets/minecraft-data-26.3/enchantments.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const byName = new Map();
    for (const e of raw) byName.set(e.name, e);
    CACHE = { all: raw, byName };
    return CACHE;
}

export function allEnchantments() { return load().all; }

// 26.3 item components carry enchantments as NUMERIC ids, so she needs the
// reverse lookup to name them.
export function getEnchantmentById(id) {
    const { all } = load();
    return all.find(e => e.id === id) || null;
}
export function getEnchantment(name) {
    const { byName } = load();
    if (!name) return null;
    return byName.get(String(name).toLowerCase()) || byName.get(String(name).replace(/^minecraft:/, '')) || null;
}

// Which enchantments can even appear on this item? The data gives one category
// per enchantment; we map an item to the categories it is eligible for.
const ITEM_CATEGORY = {
    // swords / melee
    diamond_sword: ['sharp_weapon', 'weapon', 'melee_weapon', 'sweeping', 'durability'],
    iron_sword: ['sharp_weapon', 'weapon', 'melee_weapon', 'sweeping', 'durability'],
    golden_sword: ['sharp_weapon', 'weapon', 'melee_weapon', 'sweeping', 'durability'],
    stone_sword: ['sharp_weapon', 'weapon', 'melee_weapon', 'sweeping', 'durability'],
    wooden_sword: ['sharp_weapon', 'weapon', 'melee_weapon', 'sweeping', 'durability'],
    netherite_sword: ['sharp_weapon', 'weapon', 'melee_weapon', 'sweeping', 'durability'],
    mace: ['mace', 'sharp_weapon', 'durability'],
    trident: ['trident', 'durability'],
    // pickaxes
    diamond_pickaxe: ['mining', 'mining_loot', 'durability'],
    iron_pickaxe: ['mining', 'mining_loot', 'durability'],
    golden_pickaxe: ['mining', 'mining_loot', 'durability'],
    stone_pickaxe: ['mining', 'mining_loot', 'durability'],
    wooden_pickaxe: ['mining', 'mining_loot', 'durability'],
    netherite_pickaxe: ['mining', 'mining_loot', 'durability'],
    // axes
    diamond_axe: ['sharp_weapon', 'weapon', 'durability'],
    iron_axe: ['sharp_weapon', 'weapon', 'durability'],
    // shovels
    diamond_shovel: ['mining', 'durability'],
    iron_shovel: ['mining', 'durability'],
    // bows / crossbows
    bow: ['bow', 'durability'],
    crossbow: ['crossbow', 'durability'],
    fishing_rod: ['fishing', 'durability'],
    // armor
    diamond_helmet: ['head_armor', 'armor', 'durability'],
    diamond_chestplate: ['armor', 'durability'],
    diamond_leggings: ['leg_armor', 'armor', 'durability'],
    diamond_boots: ['foot_armor', 'armor', 'durability'],
    iron_helmet: ['head_armor', 'armor', 'durability'],
    iron_chestplate: ['armor', 'durability'],
    iron_leggings: ['leg_armor', 'armor', 'durability'],
    iron_boots: ['foot_armor', 'armor', 'durability'],
    leather_helmet: ['head_armor', 'armor', 'durability'],
    leather_chestplate: ['armor', 'durability'],
    leather_leggings: ['leg_armor', 'armor', 'durability'],
    leather_boots: ['foot_armor', 'armor', 'durability'],
    // misc equippable
    elytra: ['equippable', 'durability'],
    shield: ['equippable'],
    shears: ['durability'],
    // tools
    flint_and_steel: ['durability'],
    shears_item: ['durability'],
};

export function categoriesFor(itemName) {
    const key = String(itemName || '').replace(/^minecraft:/, '');
    if (ITEM_CATEGORY[key]) return ITEM_CATEGORY[key];
    // sensible generic fallback so unknown tools still get an answer
    if (/_sword$/.test(key)) return ['sharp_weapon', 'weapon', 'durability'];
    if (/_pickaxe$/.test(key)) return ['mining', 'mining_loot', 'durability'];
    if (/_axe$/.test(key)) return ['sharp_weapon', 'weapon', 'durability'];
    if (/_shovel$/.test(key) || /_hoe$/.test(key)) return ['mining', 'durability'];
    if (/_helmet$/.test(key)) return ['head_armor', 'armor', 'durability'];
    if (/_chestplate$/.test(key)) return ['armor', 'durability'];
    if (/_leggings$/.test(key)) return ['leg_armor', 'armor', 'durability'];
    if (/_boots$/.test(key)) return ['foot_armor', 'armor', 'durability'];
    return ['durability'];
}

// What could plausibly show up on this item.
export function possibleEnchantments(itemName) {
    const cats = categoriesFor(itemName);
    return allEnchantments().filter(e => cats.includes(e.category));
}

// Book-only enchantments cannot roll on a table at all — they need an
// enchanted book. This is the single most useful fact for "how do I get Mending".
export function bookOnlyEnchantments() {
    return allEnchantments().filter(e => e.treasureOnly);
}

export function needsBook(enchantName) {
    const e = getEnchantment(enchantName);
    return !!(e && e.treasureOnly);
}

// Bookshelf power: each bookshelf adds 1 to the enchantment "seed strength".
// 0 bookshelves -> roll level 1..15, and the pool is the generic table pool.
export function bookshelfBonus(bookshelves = 0) {
    return Math.max(0, Math.min(15, bookshelves));
}

// The lapis->level conversion the table actually uses: level = 1 +
// floor(random(treasure ? maxLevel : maxLevel/2 + 1)). More lapis only widens
// the ceiling within the tier; it does not past the cap. So feeding lapis past
// the cap for her current tier is wasted, and she should be told that.
export function lapisCeiling(itemName) {
    const opts = possibleEnchantments(itemName);
    const maxes = opts.map(e => e.maxLevel).filter(n => n > 0);
    const tierMax = maxes.length ? Math.max(...maxes) : 1;
    return { treasureCeiling: tierMax, tableCeiling: Math.floor(tierMax / 2) + 1 };
}

// Does any offer in `choices` actually match what she wants?
// choices: [{level, expected:{enchant, level}}] as mineflayer reports them.
// enchantIdToName maps the numeric enchant id from the packet back to a name.
export function evaluateOffers(choices, wanted = [], idToName = null) {
    const named = choices.map((c, i) => {
        const id = c.expected && c.expected.enchant;
        let nm = null;
        if (id != null && id >= 0 && idToName) nm = idToName(id);
        return { i, level: c.level, id, name: nm };
    });
    const wantedSet = new Set(wanted.map(w => String(w).toLowerCase()));
    for (const o of named) {
        o.wanted = o.name ? wantedSet.has(String(o.name).toLowerCase()) : wantedSet.has(String(o.id));
    }
    return named;
}

// Why did the server ignore my click? It costs levels. This explains it.
export function canAfford(choices, myLevels, wantHighest = true) {
    const usable = choices.filter(c => c.level >= 0 && c.level <= myLevels);
    if (!usable.length) {
        return { ok: false, reason: 'none-affordable', cheapest: Math.min(...choices.filter(c => c.level >= 0).map(c => c.level)) };
    }
    const best = wantHighest ? usable.reduce((a, b) => (b.level > a.level ? b : a)) : usable[0];
    return { ok: true, choice: best, index: choices.indexOf(best) };
}

// --- BREWING -------------------------------------------------------------
// The chain is fixed: nether_wart -> awkward_potion, then ONE effect ingredient
// turns awkward into the effect. Ingredient alone does nothing.
export const BREW_BASE = 'nether_wart';
export const BREW_FUEL = 'blaze_powder';

export const BREW_INGREDIENTS = {
    nether_wart: 'Awkward Potion (the base every brew starts from)',
    sugar: 'Swiftness',
    spider_eye: 'Poison',
    ghast_tear: 'Regeneration',
    magma_cream: 'Fire Resistance',
    nether_wart: 'Haste (or the awkward base)',
    blaze_powder: 'Strength',
    golden_carrot: 'Night Vision',
    pufferfish: 'Water Breathing',
    magma_cream_fire: 'Fire Resistance',
    phantom_membrane: 'Slow Falling',
    fermented_spider_eye: 'Invisibility / long night vision',
    rabbit_foot: 'Leaping',
    nether_star: 'Glowing',
    turtle_helmet: 'Turtle Master',
    glistering_melon_slice: 'Instant Health',
    golden_apple: 'Instant Health II',
    dragon_breath: 'Breathing',
    sugar_cane: 'Swiftness (alt)',
};

export const BREW_TIME_SECONDS = 20;

// Which effect does this ingredient make? Returns null for the base.
export function brewEffectFor(ingredientName) {
    const n = String(ingredientName || '').toLowerCase();
    if (n === 'nether_wart') return 'awkward_potion';
    if (n === 'sugar') return 'soda';
    if (n === 'blaze_powder') return 'soda_strength';
    return BREW_INGREDIENTS[n] || null;
}

// Full recipe for an effect, in order.
export function brewChainFor(effectName) {
    const key = String(effectName || '').toLowerCase();
    if (key === 'awkward_potion' || key === 'awkward') return [BREW_BASE];
    const ing = Object.entries(BREW_INGREDIENTS).find(([k, v]) => v.toLowerCase() === key);
    if (ing) return [BREW_BASE, ing[0]];
    // fall back to treating the arg as the ingredient itself
    if (BREW_INGREDIENTS[key]) return [BREW_BASE, key];
    return null;
}

// Everything she must have before she can brew anything at all.
export function brewPrerequisites() {
    return [
        { item: 'brewing_stand', how: '1 blaze_rod + 3 cobblestone', why: 'the station' },
        { item: 'blaze_powder', how: 'craft from a blaze_rod (blazes drop them)', why: 'fuel, 1 per brew' },
        { item: 'glass_bottle', how: 'smelt sand', why: 'becomes the water bottle' },
        { item: 'water source', how: 'stand next to any still water', why: 'to fill bottles' },
    ];
}

// Which of those is she actually missing?
export function brewMissing(inventoryCounts) {
    const c = inventoryCounts || {};
    const missing = [];
    if (!(c.nether_wart > 0)) missing.push({ item: 'nether_wart', why: 'the base of every brew', how: 'nether wart in a nether fortress' });
    if (!(c.blaze_powder > 0)) missing.push({ item: 'blaze_powder', why: 'fuel', how: 'craft from blaze_rod' });
    return missing;
}
