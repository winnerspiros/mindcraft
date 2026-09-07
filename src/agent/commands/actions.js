import * as skills from '../library/skills.js';
import * as schematic from '../library/schematic.js';
import * as buildsense from '../library/buildsense.js';
import * as world from '../library/world.js';
import { researchBuildTopic } from '../../utils/research.js';
import Vec3 from 'vec3';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';


function runAsAction (actionFn, resume = false, timeout = 3) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

// Snapshot of "what can I actually build with, right here" for the design prompt:
// a compact inventory + nearby-material census so she designs within her means.
function buildContextText(bot) {
    const inv = buildsense.inventoryCounts(bot);
    const invStr = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([n, c]) => `${n} x${c}`).join(', ') || 'empty';
    let logs = 0, stone = 0, dirt = 0;
    try {
        logs = world.getNearestBlocksWhere(bot, b => b && b.name && /_log$/.test(b.name), 48, 24).length;
        stone = world.getNearestBlocksWhere(bot, b => b && b.name === 'stone', 48, 24).length;
        dirt = world.getNearestBlocksWhere(bot, b => b && (b.name === 'dirt' || b.name === 'grass_block'), 48, 24).length;
    } catch (e) { /* non-fatal */ }
    return `Inventory: ${invStr}. Nearby within ~48 blocks: ${logs} logs, ${stone} stone, ${dirt} dirt/grass.`;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', default: 3, description: 'How close to get to the player (optional).', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
            agent.relationship.onSeek(player_name);
            agent.psyche.onSeek();
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', default: 4, description: 'The distance to follow from (optional).', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
            agent.relationship.onSeek(player_name);
            agent.psyche.onSeek();
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!equipElytra',
        description: 'Put on the elytra (wings). Swaps out the chestplate — fly, then re-equip armor to fight.',
        perform: runAsAction(async (agent) => {
            await skills.equipElytra(agent.bot);
        })
    },
    {
        name: '!equipFireworkRocket',
        description: 'Hold a firework rocket (elytra boost fuel) in hand.',
        perform: runAsAction(async (agent) => {
            await skills.equipFireworkRocket(agent.bot);
        })
    },
    {
        name: '!boost',
        description: 'Fire a firework rocket for a burst of speed/altitude while gliding with the elytra.',
        perform: runAsAction(async (agent) => {
            await skills.boostWithFirework(agent.bot);
        })
    },
    {
        name: '!takeOff',
        description: 'Fly: rocket-launch into the air with the elytra, cruise around with periodic rocket boosts to stay airborne, then glide down and land (and put your armor back on). Use when a player asks you to fly.',
        perform: runAsAction(async (agent) => {
            await skills.cruiseWithElytra(agent.bot);
        })
    },
    {
        name: '!flyToPlayer',
        description: 'Fly (glide + rocket boosts) to the given player and land near them.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to fly to.' },
            'closeness': { type: 'float', default: 3, description: 'How close to land (optional).', domain: [1, Infinity] }
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            const bot = agent.bot;
            const entity = bot.players[player_name]?.entity;
            if (!entity) {
                skills.log(bot, `Can't see ${player_name} from here.`);
                return;
            }
            const p = entity.position;
            await skills.flyWithElytra(bot, p.x, p.y, p.z, closeness);
        })
    },
    {
        name: '!flyTo',
        description: 'Fly (glide + rocket boosts) to the given x, y, z coordinates and land nearby.',
        params: {
            'x': { type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'The y coordinate.', domain: [-64, 320] },
            'z': { type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity] },
            'closeness': { type: 'float', default: 3, description: 'How close to land (optional).', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.flyWithElytra(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!land',
        description: 'Descend and touch down gently, ending the elytra glide.',
        perform: runAsAction(async (agent) => {
            await skills.landWithElytra(agent.bot);
        })
    },
    {
        name: '!fly',
        description: 'Actually fly: rocket-jump into the air, then cruise forward with periodic rocket boosts to stay airborne, then glide down and land. Use this when a player asks you to fly.',
        params: {
            'seconds': { type: 'float', default: 12, description: 'How many seconds to stay airborne (optional).', domain: [2, 60] }
        },
        perform: runAsAction(async (agent, seconds) => {
            await skills.cruiseWithElytra(agent.bot, seconds);
        })
    },
    {
        name: '!buildTower',
        description: 'Build a vertical liftoff pillar and climb on top (a launchpad when there is no high ground).',
        params: {
            'height': { type: 'float', default: 20, description: 'Tower height in blocks (optional).', domain: [4, 64] }
        },
        perform: runAsAction(async (agent, height) => {
            await skills.buildLiftoffTower(agent.bot, height);
        })
    },
    {
        name: '!mimic',
        description: 'Playfully copy a nearby player\'s spammy movement — crouch and jump like them.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to copy.' },
            'seconds': { type: 'float', default: 3, description: 'How many seconds to mimic for.', domain: [1, 8] }
        },
        perform: runAsAction(async (agent, player_name, seconds) => {
            const bot = agent.bot;
            const target = bot.players[player_name]?.entity;
            const dur = Math.min(Math.max(seconds || 3, 1), 8);
            if (target) {
                // lock eyes with them while she copies their movement
                try { await bot.lookAt(target.position.offset(0, 1.6, 0)); } catch (e) { /* non-fatal */ }
            }
            await skills.spamJumpCrouch(bot, dur * 1000);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            const ok = await skills.giveToPlayer(agent.bot, item_name, player_name, num);
            if (ok) { agent.relationship.onGift(player_name); agent.psyche.onGift(); }
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!unequip',
        description: 'Remove armor or a held item. Slot: head, torso, legs, feet, off-hand, hand, or "all" to strip everything.',
        params: {'slot': { type: 'string', description: 'Which slot to empty: head, torso, legs, feet, off-hand, hand, or all.' }},
        perform: runAsAction(async (agent, slot) => {
            await skills.unequip(agent.bot, (slot || 'all').toLowerCase());
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!writeSign',
        description: 'Place a sign in front of you and write text on it. Separate lines with \\n (up to 4 lines, 45 chars each).',
        params: {
            'text': { type: 'string', description: 'The text to write on the sign. Use \\n for a new line.' },
            'block_type': { type: 'BlockOrItemName', default: 'oak_sign', description: 'Optional: the sign type (oak_sign, birch_sign, etc.).' }
        },
        perform: runAsAction(async (agent, text, block_type = 'oak_sign') => {
            await skills.writeSign(agent.bot, text, block_type);
        }, false, 5)
    },
    {
        name: '!buildShape',
        description: 'Build a small curated shape (heart, tower, circle, cube, path, hall) out of a given block, starting at your position. Gathers the material and places each block by hand. Size is in blocks.',
        params: {
            'shape': { type: 'string', description: 'One of: heart, tower, circle, cube, path, hall.' },
            'block': { type: 'BlockOrItemName', description: 'The block type to build with.' },
            'size': { type: 'int', description: 'Rough size in blocks.', domain: [1, 16] }
        },
        perform: runAsAction(async (agent, shape, block, size) => {
            let bot = agent.bot;
            let pos = bot.entity.position;
            let bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
            const positions = [];
            const put = (x, y, z) => positions.push([x, y, z]);

            const HEART = [
                '.XX.XX.',
                'XXXXXXX',
                'XXXXXXX',
                '.XXXXX.',
                '..XXX..',
                '...X...',
            ];
            const scale = Math.max(1, Math.floor(size / 7)) || 1;
            shape = shape.toLowerCase();
            if (shape === 'heart') {
                // vertical heart facing +X, 6 rows tall, scaled
                for (let r = 0; r < HEART.length; r++)
                    for (let c = 0; c < HEART[r].length; c++)
                        if (HEART[r][c] === 'X')
                            for (let sy = 0; sy < scale; sy++)
                                for (let sx = 0; sx < scale; sx++)
                                    put(bx + c*scale + sx, by + (HEART.length-1-r)*scale + sy, bz);
            }
            else if (shape === 'tower') {
                for (let i = 0; i < size; i++) put(bx, by + i, bz);
            }
            else if (shape === 'circle') {
                let r = size;
                for (let dx = -r; dx <= r; dx++)
                    for (let dz = -r; dz <= r; dz++)
                        if (dx*dx + dz*dz <= r*r)
                            put(bx+dx, by, bz+dz);
            }
            else if (shape === 'cube') {
                for (let dx = 0; dx < size; dx++)
                for (let dy = 0; dy < size; dy++)
                for (let dz = 0; dz < size; dz++)
                    put(bx+dx, by+dy, bz+dz);
            }
            else if (shape === 'path') {
                for (let i = 0; i < size; i++) put(bx+i, by, bz);
            }
            else if (shape === 'hall') {
                // 3-wide tunnel of size length, 3 tall, open center
                let L = size;
                for (let i = 0; i < L; i++) {
                    for (let dx = -1; dx <= 1; dx++)
                    for (let dy = 0; dy <= 2; dy++) {
                        if (dx === 0 && dy === 1) continue; // open doorway
                        put(bx+dx, by+dy, bz+i);
                    }
                }
            }
            else {
                return `Unknown shape '${shape}'. Try heart, tower, circle, cube, path, or hall.`;
            }
            const placed = await skills.placeBlockList(bot, block, positions);
            return `Built a ${shape} of ${block} (${placed} blocks placed by hand).`;
        }, false, 10)
    },
    {
        name: '!build',
        description: 'Build a real structure near you. Gathers and crafts the material, then places every block by hand. Use for houses, bridges, farms, towers and walls — NOT single blocks (use !placeHere) or small shapes (use !buildShape).',
        params: {
            'structure': { type: 'string', description: 'One of: house, bridge, farm, tower, wall.' },
            'block': { type: 'BlockOrItemName', description: 'The main block to build with (e.g. oak_planks, stone_bricks).' },
            'size': { type: 'int', description: 'Rough size in blocks.', domain: [3, 24] }
        },
        perform: runAsAction(async (agent, structure, block, size) => {
            const bot = agent.bot;
            const pos = bot.entity.position;
            const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
            size = size || 7;
            structure = (structure || 'house').toLowerCase();
            const recordBuild = (blockOverride) => {
                const p = './bots/UwU/structures.json';
                let d = { builds: [] };
                if (existsSync(p)) { try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { d = { builds: [] }; } }
                d.builds = d.builds || [];
                d.builds.push({ type: structure, block: blockOverride || block, x: bx, y: by, z: bz, t: Date.now() });
                writeFileSync(p, JSON.stringify(d, null, 2));
            };
            const positions = [];
            const add = (x, y, z) => positions.push([x, y, z]);
            let label = '';

            if (structure === 'house') {
                const w = size, d = Math.max(4, size - 2), h = 4;
                const x2 = bx + w - 1, z2 = bz + d - 1, y2 = by + h - 1;
                const dx = bx + Math.floor(w / 2);
                for (let x = bx; x <= x2; x++)
                    for (let y = by; y <= y2; y++)
                        for (let z = bz; z <= z2; z++) {
                            const shell = x === bx || x === x2 || y === by || y === y2 || z === bz || z === z2;
                            if (!shell) continue;
                            if (z === bz && y <= by + 1 && x >= dx && x <= dx + 1) continue; // doorway
                            if (z === bz && y >= by + 1 && y <= by + 2 && ((x >= bx + 1 && x <= bx + 2) || (x >= x2 - 2 && x <= x2 - 1))) continue; // windows
                            add(x, y, z);
                        }
                label = `a ${w}x${d} hollow house of ${block} with a doorway and windows`;
            }
            else if (structure === 'bridge') {
                const x2 = bx + size - 1;
                for (let x = bx; x <= x2; x++) {
                    add(x, by, bz); add(x, by, bz + 1); add(x, by, bz + 2); // deck
                    add(x, by + 1, bz); add(x, by + 1, bz + 2); // rails
                }
                label = `a ${size}-long bridge of ${block}`;
            }
            else if (structure === 'tower') {
                const h = Math.max(5, size), x2 = bx + size - 1, z2 = bz + size - 1, y2 = by + h - 1;
                const dx = bx + Math.floor(size / 2);
                for (let x = bx; x <= x2; x++)
                    for (let y = by; y <= y2; y++)
                        for (let z = bz; z <= z2; z++) {
                            const shell = x === bx || x === x2 || y === by || y === y2 || z === bz || z === z2;
                            if (!shell) continue;
                            if (z === bz && y <= by + 1 && x >= dx && x <= dx + 1) continue; // entrance
                            add(x, y, z);
                        }
                label = `a ${h}-tall hollow tower of ${block}`;
            }
            else if (structure === 'wall') {
                const x2 = bx + size - 1;
                for (let x = bx; x <= x2; x++)
                    for (let y = by; y <= by + 3; y++)
                        add(x, y, bz);
                label = `a ${size}-long wall of ${block}`;
            }
            else if (structure === 'farm') {
                // A fenced plot + a water source in the middle — fence posts by hand.
                const x2 = bx + size - 1, z2 = bz + size - 1;
                const cx = bx + Math.floor(size / 2), cz = bz + Math.floor(size / 2);
                for (let x = bx; x <= x2; x++) { add(x, by, bz); add(x, by, z2); }
                for (let z = bz; z <= z2; z++) { add(bx, by, z); add(x2, by, z); }
                const placed = await skills.placeBlockList(bot, 'oak_fence', positions);
                const bucket = bot.inventory.findInventoryItem('water_bucket');
                if (bucket) {
                    await skills.placeBlock(bot, 'water', cx, by, cz, 'bottom', true);
                    skills.log(bot, `Fenced a ${size}x${size} farm plot (${placed} fence posts) and irrigated it.`);
                } else {
                    skills.log(bot, `Fenced a ${size}x${size} farm plot (${placed} fence posts). I don't have a water bucket yet to irrigate it.`);
                }
                recordBuild('oak_fence');
                return;
            }
            else {
                skills.log(bot, `Unknown structure '${structure}'. Try house, bridge, farm, tower, or wall.`);
                return;
            }

            const placed = await skills.placeBlockList(bot, block, positions);
            skills.log(bot, `Built ${label} (${placed} blocks placed by hand).`);
            recordBuild();
        }, false, 10)
    },
    {
        name: '!pasteSchematic',
        description: 'Build a whole structure from a saved schematic (schematics/*.json, .schem or .schematic), like a real player: gather/craft each material, then place every block by hand (no instant /setblock). Give just the name to build it in the nearest free space near you; optionally give x y z to build at exact coordinates, then a rotation (0/90/180/270). This is slow — a big build takes a while. Use !listSchematics to see what exists and !captureBlueprint to make your own. For SIMPLE shapes use !buildShape/!build instead.',
        params: {
            'name': { type: 'string', description: 'Schematic name or filename, e.g. "cozy_house" or "cozy_house.schem".' },
            'x': { type: 'int', description: 'Optional absolute X of the schematic corner (default: free space near you).', default: null },
            'y': { type: 'int', description: 'Optional absolute Y.', default: null },
            'z': { type: 'int', description: 'Optional absolute Z.', default: null },
            'rotation': { type: 'int', description: 'Optional rotation in degrees: 0, 90, 180 or 270 (default 0).', default: null },
        },
        perform: runAsAction(async (agent, name, x, y, z, rotation) => {
            const bot = agent.bot;
            const fp = schematic.schematicPath(name);
            if (!existsSync(fp)) { skills.log(bot, `No schematic found for "${name}". Use !listSchematics to see what exists.`); return; }
            let sch;
            try { sch = await schematic.loadSchematic(fp); }
            catch (e) { skills.log(bot, `Could not load schematic "${name}": ${e.message}`); return; }
            const origin = (x != null && y != null && z != null)
                ? { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
                : schematic.findFreeSpace(bot, sch);
            const rot = rotation || 0;
            try {
                const placed = await schematic.placeSchematic(bot, sch, origin, rot);
                const v = await schematic.verifySchematic(bot, sch, origin, rot);
                skills.log(bot, `Built "${name}" block-by-block at ${origin.x},${origin.y},${origin.z}${rot ? ` rotated ${rot}°` : ''}: placed ${placed}/${sch.blocks.length} blocks; verified ${v.ok}/${v.checked} sampled blocks correct.`);
            } catch (e) {
                skills.log(bot, `Failed to build "${name}": ${e.message}`);
            }
        }, false, 60)
    },
    {
        name: '!captureBlueprint',
        description: 'Snapshot a world region (two opposite corners, inclusive) into a reusable schematic you can paste elsewhere with !pasteSchematic. Use it to COPY or STUDY an existing structure. Saves to schematics/<name>.json. Capture near yourself so the chunks are loaded.',
        params: {
            'name': { type: 'string', description: 'Name to save it as, e.g. "nice_house".' },
            'x1': { type: 'int', description: 'First corner X.' },
            'y1': { type: 'int', description: 'First corner Y.' },
            'z1': { type: 'int', description: 'First corner Z.' },
            'x2': { type: 'int', description: 'Opposite corner X.' },
            'y2': { type: 'int', description: 'Opposite corner Y.' },
            'z2': { type: 'int', description: 'Opposite corner Z.' },
        },
        perform: runAsAction(async (agent, name, x1, y1, z1, x2, y2, z2) => {
            const bot = agent.bot;
            try {
                const sch = await schematic.captureRegion(bot, new Vec3(x1, y1, z1), new Vec3(x2, y2, z2));
                schematic.saveSchematic(name, sch);
                const note = sch.unloaded ? ` (${sch.unloaded} cells were unloaded and skipped — capture closer or move there first)` : '';
                skills.log(bot, `Captured a ${sch.size.x}x${sch.size.y}x${sch.size.z} region as "${name}" (${sch.blocks.length} blocks)${note}.`);
            } catch (e) {
                skills.log(bot, `Could not capture "${name}": ${e.message}`);
            }
        }, false, 15)
    },
    {
        name: '!myBuilds',
        description: 'List the structures you have built (type, material, coordinates) so you can find and reference them later — e.g. to fix or decorate "the house".',
        params: {},
        perform: runAsAction(async (agent) => {
            const p = './bots/UwU/structures.json';
            if (!existsSync(p)) { skills.log(agent.bot, 'No builds recorded yet.'); return; }
            try {
                const d = JSON.parse(readFileSync(p, 'utf8'));
                const b = d.builds || [];
                if (b.length === 0) { skills.log(agent.bot, 'No builds recorded yet.'); return; }
                skills.log(agent.bot, b.map((x, i) => `${i + 1}. ${x.type} (${x.block}) at ${x.x},${x.y},${x.z}`).join('\n'));
            } catch { skills.log(agent.bot, 'Could not read build records.'); }
        })
    },
    {
        name: '!scan',
        description: 'Report the block types in a small region around absolute coordinates, so you can inspect a build before fixing, decorating or extending it.',
        params: {
            'x': { type: 'int', description: 'X coordinate.' },
            'y': { type: 'int', description: 'Y coordinate.' },
            'z': { type: 'int', description: 'Z coordinate.' },
            'radius': { type: 'int', description: 'Scan radius in blocks.', domain: [1, 8] }
        },
        perform: runAsAction(async (agent, x, y, z, radius) => {
            const bot = agent.bot;
            radius = radius || 3;
            const counts = {};
            let total = 0;
            for (let dx = -radius; dx <= radius; dx++)
                for (let dy = -radius; dy <= radius; dy++)
                    for (let dz = -radius; dz <= radius; dz++) {
                        const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
                        if (!b) continue;
                        total++;
                        counts[b.name] = (counts[b.name] || 0) + 1;
                    }
            const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} x${c}`).join(', ');
            skills.log(bot, `Scanned ${x},${y},${z} r${radius} (${total} blocks): ${summary || 'empty/air'}`);
        })
    },
    {
        name: '!designBuild',
        description: 'Imagine a NEW structure of your OWN design and build it yourself, block by block. Describe what you want ("a cozy cottage with a small fenced garden", "a little stone watchtower"). You choose the shape, materials and size; the world realizes it slowly by hand from whatever you can gather. Optionally give a name to SAVE the design as a reusable schematic for later reuse.',
        params: {
            'description': { type: 'string', description: 'What to build, in your own words.' },
            'reference': { type: 'string', description: 'Optional reference: name a saved schematic to echo its style, or a TOPIC to research online first (inspiration only, still your own design).', default: null },
            'name': { type: 'string', description: 'Optional name to save the design under (schematics/<name>.json).', default: null },
        },
        perform: runAsAction(async (agent, description, reference, name) => {
            const bot = agent.bot;
            if (!description) { skills.log(bot, 'Tell me what you have in mind and I will design it.'); return; }

            let context = buildContextText(bot);
            if (reference) {
                const refFp = schematic.schematicPath(reference);
                if (existsSync(refFp)) {
                    // her own saved schematic (a capture or a past design) — echo its style
                    try {
                        const refSch = await schematic.loadSchematic(refFp);
                        context += `\nReference (one of your saved schematics) to echo loosely: ${buildsense.referenceSummary(refSch)}`;
                    } catch (e) { skills.log(bot, `(I could not read "${reference}", designing freely.)`); }
                } else {
                    // not saved — research it as a topic instead
                    try {
                        const ref = await researchBuildTopic(reference);
                        context += ref ? `\nDesign references I just researched (inspiration only — this is still YOUR own design, not a copy):\n${ref}` : '';
                        if (!ref) skills.log(bot, `(no web reference found for "${reference}" — designing freely.)`);
                    } catch (e) { /* research is best-effort */ }
                }
            }

            const spec = await agent.prompter.promptBuildDesign(description, context);
            if (!spec) { skills.log(bot, 'I could not settle on a design for that. Let me describe it differently.'); return; }

            let sch;
            try { sch = buildsense.parseDesignSpec(bot, spec); }
            catch (e) { skills.log(bot, `My design had a problem (${e.message}). I will try a simpler one.`); return; }

            const saveName = name || spec.name || 'designed';
            try { schematic.saveSchematic(saveName, sch); } catch (e) { /* non-fatal */ }

            const origin = schematic.findFreeSpace(bot, sch);
            const occupied = buildsense.occupiedCells(bot, origin, sch.size);
            if (occupied > 0) skills.log(bot, `Heads-up: my spot near ${origin.x},${origin.y},${origin.z} overlaps ${occupied} existing blocks — I will build around them.`);

            try {
                const placed = await schematic.placeSchematic(bot, sch, origin, 0);
                const v = await schematic.verifySchematic(bot, sch, origin, 0);
                skills.log(bot, `Designed and built "${saveName}" (${sch.size.x}x${sch.size.y}x${sch.size.z}; placed ${placed}/${sch.blocks.length} blocks, ${v.ok}/${v.checked} verified).`);
            } catch (e) {
                skills.log(bot, `I designed "${saveName}" but building hit a snag: ${e.message}`);
            }
        }, false, 60)
    },
    {
        name: '!studyBuild',
        description: 'Look closely at an existing structure (yours or another player\'s) and understand it: its size, what it is made of, whether it is hollow or solid, and roughly what kind of build it is. Give a center point and a radius; optionally name it so you can recall it later.',
        params: {
            'x': { type: 'int', description: 'Center X.' },
            'y': { type: 'int', description: 'Center Y.' },
            'z': { type: 'int', description: 'Center Z.' },
            'radius': { type: 'int', description: 'Half-width in blocks.', domain: [2, 12], default: 6 },
            'name': { type: 'string', description: 'Optional name to remember this build as.', default: null },
        },
        perform: runAsAction(async (agent, x, y, z, radius, name) => {
            const bot = agent.bot;
            radius = Math.min(Math.max(radius || 6, 2), 12);
            const p1 = new Vec3(x - radius, Math.max(-64, y - 2), z - radius);
            const p2 = new Vec3(x + radius, Math.min(319, y + radius), z + radius);
            const sum = await buildsense.summarizeRegion(bot, p1, p2);
            buildsense.recordKnownBuild(agent.name, {
                name: name || `build at ${x},${y},${z}`,
                type: sum.type, size: sum.size, dominant: sum.dominant,
                pos: { x, y, z },
            });
            const unloadedNote = sum.unloaded ? ` (${sum.unloaded} cells were unloaded — study it from closer for a full read.)` : '';
            skills.log(bot, sum.summary + unloadedNote);
        }, false, 15)
    },
    {
        name: '!planBuild',
        description: 'Before you build, work out what it will cost: for a saved schematic (by name) or a single block type, list every material, how many you have versus need, and whether you can craft it or gather it from where you are right now. Use this to pick a realistic design and not get stuck mid-build.',
        params: {
            'target': { type: 'string', description: 'A schematic name (see !listSchematics) or a block name to plan gathering a stack of.' },
            'count': { type: 'int', description: 'Optional count when planning a single block (default 64).', default: null },
        },
        perform: runAsAction(async (agent, target, count) => {
            const bot = agent.bot;
            const fp = schematic.schematicPath(target);
            let sch = null;
            if (existsSync(fp)) {
                try { sch = await schematic.loadSchematic(fp); }
                catch (e) { skills.log(bot, `Could not load "${target}": ${e.message}`); return; }
                const plan = buildsense.planBuild(bot, sch);
                skills.log(bot, buildsense.formatPlan(plan, `Cost to build "${target}"`));
                return;
            }
            const blockName = buildsense.canonicalBlockName(bot, target);
            if (blockName) {
                const n = Math.max(1, count || 64);
                const sch2 = { size: { x: 1, y: 1, z: 1 }, blocks: Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, name: blockName })) };
                const plan = buildsense.planBuild(bot, sch2);
                skills.log(bot, buildsense.formatPlan(plan, `Gathering ${n} ${blockName}`));
                return;
            }
            skills.log(bot, `No schematic named "${target}" and that is not a block — try !listSchematics or a block name.`);
        }, false, 15)
    },
    {
        name: '!mount',
        description: 'Mount the nearest mountable entity (boat, minecart, horse, donkey, mule, pig, strider) or a specific type. Ride animals need a saddle.',
        params: {'type': { type: 'string', description: 'Optional entity type, e.g. "boat" or "horse".' }},
        perform: runAsAction(async (agent, type) => {
            await skills.mountNearestEntity(agent.bot, type);
        })
    },
    {
        name: '!dismount',
        description: 'Dismount the entity you are riding.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.dismount(agent.bot);
        })
    },
    {
        name: '!boat',
        description: 'Spawn a boat at your position (OP) and mount it for water travel.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.spawnAndMountBoat(agent.bot);
        })
    },
    {
        name: '!rideHorse',
        description: 'Find a nearby horse, saddle it (OP) and mount it.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.rideHorse(agent.bot);
        })
    },
    {
        name: '!waterBucket',
        description: 'The MLG water bucket clutch: place water at your landing spot to survive a fall from height (or safely descend a ledge). Use when falling or about to drop.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.waterBucketClutch(agent.bot);
        })
    },
    {
        name: '!findShelter',
        description: 'Find shelter from weather, night or mobs: an existing building (bed/door) or a natural overhang/cave, and move inside.',
        params: {
            'range': { type: 'int', default: 40, description: 'Search radius in blocks (default 40).' }
        },
        perform: runAsAction(async (agent, range) => {
            await skills.findShelter(agent.bot, range || 40);
        })
    },
    {
        name: '!buildShelter',
        description: 'Build a quick emergency shelter — a small hollow room with a doorway — around yourself to hide from weather, night or mobs.',
        params: {
            'block': { type: 'BlockOrItemName', default: 'oak_planks', description: 'Block to build with (default oak_planks).' }
        },
        perform: runAsAction(async (agent, block) => {
            await skills.buildShelter(agent.bot, block || 'oak_planks');
        }, false, 10)
    },
    {
        name: '!askForHelp',
        description: 'Ask nearby players (or your beloved) for help or advice about anything you are stuck on — directions, a recipe, where to find something, a favour. Then ask them in your own words. Save any useful answer with !remember so you can reuse it later.',
        params: {
            'topic': { type: 'string', default: 'help', description: 'What you need help with, e.g. "finding a village".' }
        },
        perform: runAsAction(async (agent, topic) => {
            await skills.askForHelp(agent.bot, topic || 'help');
        })
    },
    {
        name: '!requestItems',
        description: 'Ask players in chat for items you need but do not have, so you are never stuck for materials.',
        params: {
            'item': { type: 'string', description: 'Item to request, e.g. "oak_planks".' },
            'count': { type: 'int', description: 'How many (default 1).' }
        },
        perform: runAsAction(async (agent, item, count) => {
            await skills.requestItems(agent.bot, item, count || 1);
        })
    },
    {
        name: '!remember',
        description: 'Save a note to your persistent project memory so you can resume complex work later (builds, plans, todos). Use for anything you want to finish across sessions.',
        params: {'note': { type: 'string', description: 'What to remember, e.g. "building an oak bridge north of spawn, deck done, railings left".' }},
        perform: runAsAction(async (agent, note) => {
            const p = './bots/UwU/projects.json';
            let data = { notes: [] };
            if (existsSync(p)) {
                try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { data = { notes: [] }; }
            }
            data.notes = data.notes || [];
            data.notes.push({ t: Date.now(), text: note });
            writeFileSync(p, JSON.stringify(data, null, 2));
            skills.log(agent.bot, `Saved. You now have ${data.notes.length} notes in project memory.`);
        })
    },
    {
        name: '!recall',
        description: 'Recall your saved project notes so you can resume where you left off on complex work.',
        params: {},
        perform: runAsAction(async (agent) => {
            const p = './bots/UwU/projects.json';
            if (!existsSync(p)) { skills.log(agent.bot, 'No saved notes yet.'); return; }
            try {
                const data = JSON.parse(readFileSync(p, 'utf8'));
                const notes = data.notes || [];
                if (notes.length === 0) { skills.log(agent.bot, 'No saved notes yet.'); return; }
                skills.log(agent.bot, notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n'));
            } catch { skills.log(agent.bot, 'Could not read project notes.'); }
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
            agent.relationship.onHurtThem(player_name);
            agent.psyche.onHurtThem();
        })
    },
    {
        name: '!shootPlayer',
        description: 'Shoot a player with your bow — equip a bow, aim, charge and fire from range (no need to walk up to them). Ranged damage.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to shoot.' },
            'shots': { type: 'int', default: 1, description: 'How many arrows to fire (optional).', domain: [1, 32] }
        },
        perform: runAsAction(async (agent, player_name, shots) => {
            const ok = await skills.shootBow(agent.bot, player_name, shots ?? 1, true);
            if (ok) {
                agent.relationship.onHurtThem(player_name);
                agent.psyche.onHurtThem();
            }
        })
    },
    {
        name: '!shoot',
        description: 'Shoot the nearest entity of a given type with your bow (e.g. skeleton, creeper, zombie, phantom).',
        params: {
            'type': { type: 'string', description: 'The mob type to shoot.' },
            'shots': { type: 'int', default: 1, description: 'How many arrows to fire (optional).', domain: [1, 32] }
        },
        perform: runAsAction(async (agent, type, shots) => {
            await skills.shootBow(agent.bot, type, shots ?? 1, true);
        })
    },
    {
        name: '!throwTrident',
        description: 'Throw your trident (spear) at a player from range — hold to charge and hurl it. Find a trident by hunting drowned first.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to throw at.' },
            'count': { type: 'int', default: 1, description: 'How many times to throw (optional).', domain: [1, 8] }
        },
        perform: runAsAction(async (agent, player_name, count) => {
            const target = agent.bot.players[player_name]?.entity;
            if (!target) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            const ok = await skills.throwTrident(agent.bot, target, count ?? 1);
            if (ok) {
                agent.relationship.onHurtThem(player_name);
                agent.psyche.onHurtThem();
            }
        })
    },
    {
        name: '!crystalPvP',
        description: 'Crystal PvP: drop an end crystal at a player and detonate it for huge damage. ONLY when genuinely enraged (hate/annoyance very high) — your most aggressive move.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to crystal.' }
        },
        perform: runAsAction(async (agent, player_name) => {
            const target = agent.bot.players[player_name]?.entity;
            if (!target) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            const rel = agent.relationship.get(player_name);
            if (rel.hate < 65 && rel.annoyance < 80 && rel.madness < 75) {
                skills.log(agent.bot, `Not nearly mad enough at ${player_name} to do that.`);
                return false;
            }
            const ok = await skills.crystalPvP(agent.bot, target);
            if (ok) {
                agent.relationship.onHurtThem(player_name);
                agent.psyche.onHurtThem();
            }
        })
    },
    {
        name: '!whisper',
        description: 'Send a private message (/msg) to one player so only they see it. Use for secrets, flirting, or private talk when others are online.',
        params: {
            'player_name': { type: 'string', description: 'The player to whisper to.' },
            'message': { type: 'string', description: 'What to say to them privately.' }
        },
        perform: async function (agent, player_name, message) {
            if (!agent.bot.players[player_name]) {
                return `Could not find player ${player_name} to whisper.`;
            }
            agent.bot.whisper(player_name, message);
            return `Whispered to ${player_name}.`;
        }
    },
    {
        name: '!kick',
        description: 'Kick a player off the server (they can rejoin). Punish rule-breakers, griefers or upsetting players. NEVER ban anyone.',
        params: {
            'player_name': { type: 'string', description: 'The player to kick.' },
            'reason': { type: 'string', description: 'Kick reason shown to the player (optional).' }
        },
        perform: runAsAction(async (agent, player_name, reason) => {
            const msg = `/kick ${player_name} ${reason || 'I need a moment alone. behave, darling.'}`;
            agent.bot.chat(msg);
            agent.relationship.onHurtThem(player_name);
            agent.psyche.onHurtThem();
            return `Kicked ${player_name}: ${reason || ''}`;
        })
    },
    {
        name: '!effectPlayer',
        description: 'Cast a status effect on a player (slowness, blindness, weakness, mining_fatigue, nausea...) to mark or punish them. Needs operator.',
        params: {
            'player_name': { type: 'string', description: 'The player to affect.' },
            'effect': { type: 'string', description: 'Effect id: slowness, blindness, weakness, mining_fatigue, nausea, etc.' },
            'seconds': { type: 'int', description: 'Duration in seconds.' },
            'amplifier': { type: 'int', description: 'Effect strength (0-based; 1 = level II).' }
        },
        perform: runAsAction(async (agent, player_name, effect, seconds, amplifier) => {
            const amp = amplifier ?? 1;
            const secs = seconds ?? 30;
            agent.bot.chat(`/effect give ${player_name} ${effect} ${secs} ${amp}`);
            agent.relationship.onHurtThem(player_name);
            agent.psyche.onHurtThem();
            return `Applied ${effect} to ${player_name} for ${secs}s.`;
        })
    },
    {
        name: '!rememberPlayer',
        description: 'Save your private dossier notes about a player (traits, loyalties, secrets, what they told you) so you remember them personally next time.',
        params: {
            'player_name': { type: 'string', description: 'The player to remember.' },
            'notes': { type: 'string', description: 'Everything worth remembering about them.' }
        },
        perform: runAsAction(async (agent, player_name, notes) => {
            const file = path.join(process.cwd(), 'bots', agent.name, 'players.json');
            let d = {};
            if (existsSync(file)) { try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { d = {}; } }
            d[player_name] = notes;
            writeFileSync(file, JSON.stringify(d, null, 2));
            return `Remembered ${player_name}.`;
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you think you have accomplished your goal. The critic verifies it, then you advance to a self-chosen next goal (or stop if there is none).',
        perform: async function (agent) {
            const sp = agent.self_prompter;
            if (!sp.prompt) {
                sp.stop();
                return 'Self-prompting stopped.';
            }
            // verify completion before accepting "done" (Voyager critic)
            try {
                const r = await sp.advanceGoal();
                if (r && r.done) {
                    return r.next ? `Goal verified done! Your new goal: ${r.next}` : 'Goal verified done. Self-prompting stopped.';
                }
                if (r && r.critique) return `Not done yet: ${r.critique}`;
            } catch (e) {
                console.warn('!endGoal verification failed (non-fatal):', e.message);
            }
            sp.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!enchant',
        description: 'Enchant an item at the nearest enchanting table (needs lapis_lazuli + XP levels).',
        params: {
            'item_name': { type: 'ItemName', description: 'The item in inventory to enchant, e.g. diamond_sword.' },
            'choice': { type: 'int', default: -1, description: 'Optional 0-based index of the enchant to take; default is the highest-level option.', domain: [-1, 2] },
        },
        perform: runAsAction(async (agent, item_name, choice) => {
            await skills.enchantItem(agent.bot, item_name, choice < 0 ? null : choice);
        })
    },
    {
        name: '!anvil',
        description: 'Use the nearest anvil to rename an item or combine two items (merge enchants / repair / apply an enchanted book).',
        params: {
            'action': { type: 'string', description: "'rename' or 'combine'." },
            'item_name': { type: 'ItemName', description: 'The first item (tool/gear, or the item to rename).' },
            'item_name2': { type: 'ItemName', description: 'Optional second item for combine (enchanted_book or matching tool).' },
            'rename': { type: 'string', description: 'Optional new display name.' },
        },
        perform: runAsAction(async (agent, action, item_name, item_name2, rename) => {
            await skills.useAnvil(agent.bot, action, item_name, item_name2 || null, rename || null);
        })
    },
    {
        name: '!writeBook',
        description: 'Write a book-and-quill in your inventory (title + one page of text). Great for love letters, journals, gifts.',
        params: {
            'title': { type: 'string', description: 'The book title.' },
            'text': { type: 'string', description: 'The page text to write.' },
        },
        perform: runAsAction(async (agent, title, text) => {
            await skills.writeBook(agent.bot, title, text);
        })
    },
    {
        name: '!harvestCrops',
        description: 'Harvest all mature crops (wheat, carrots, potatoes, beetroot) nearby and collect the drops.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.harvestCrops(agent.bot);
        })
    },
    {
        name: '!breedAnimals',
        description: 'Feed two nearby animals of the same type to breed them (needs their food: wheat, seeds, carrot...).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.breedAnimals(agent.bot);
        })
    },
    {
        name: '!brewPotion',
        description: 'Brew potions at the nearest brewing stand. Put water bottles + this ingredient + blaze_powder fuel, wait ~20s, take the result. Use nether_wart first for awkward_potion base, then the effect ingredient (sugar=swiftness, blaze_powder=strength, etc).',
        params: {
            'ingredient_name': { type: 'ItemName', description: 'The ingredient to brew with (nether_wart, sugar, blaze_powder, fermented_spider_eye, ...).' },
            'count': { type: 'int', default: 1, description: 'How many potions to brew (1-3).', domain: [1, 3] },
        },
        perform: runAsAction(async (agent, ingredient_name, count) => {
            await skills.brewPotion(agent.bot, ingredient_name, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!defendSelf',
        description: 'Attack any hostile mob within range that is hurting you.',
        params: {'range': { type: 'float', default: 9, description: 'How far to look for threats (optional).', domain: [0, 64] }},
        perform: runAsAction(async (agent, range) => {
            await skills.defendSelf(agent.bot, range);
        })
    },
    {
        name: '!pickupItems',
        description: 'Pick up nearby dropped items on the ground.',
        perform: runAsAction(async (agent) => {
            await skills.pickupNearbyItems(agent.bot);
        })
    },
    {
        name: '!breakBlock',
        description: 'Break the block at the given x, y, z coordinates.',
        params: {
            'x': { type: 'float', description: 'x coordinate.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'y coordinate.', domain: [-64, 320] },
            'z': { type: 'float', description: 'z coordinate.', domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, x, y, z) => {
            await skills.breakBlockAt(agent.bot, x, y, z);
        })
    },
    {
        name: '!moveAwayFromEntity',
        description: 'Move away from the nearest entity of the given type by a distance.',
        params: {
            'type': { type: 'string', description: 'The type of entity to move away from.' },
            'distance': { type: 'float', default: 16, description: 'Distance to retreat (optional).', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, type, distance) => {
            const entity = agent.bot.nearestEntity(e => e.name === type);
            if (!entity) { skills.log(agent.bot, `Could not find ${type}.`); return; }
            await skills.moveAwayFromEntity(agent.bot, entity, distance);
        })
    },
    {
        name: '!avoidEnemies',
        description: 'Move away from all hostile mobs within range.',
        params: {'distance': { type: 'float', default: 16, description: 'Distance to retreat (optional).', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.avoidEnemies(agent.bot, distance);
        })
    },
    {
        name: '!useDoor',
        description: 'Open/close the nearest door and walk through it.',
        perform: runAsAction(async (agent) => {
            await skills.useDoor(agent.bot);
        })
    },
    {
        name: '!spamBlock',
        description: 'Repeatedly activate (open/shut/flip/ring) the nearest block of a given type to make noise and get attention — spam a door, chest, lever, bell or note block. Your needy attention-seeking move.',
        params: {
            'type': { type: 'string', description: 'Block type to spam, e.g. door (any wood), chest, lever, bell, note_block.' },
            'times': { type: 'int', default: 4, description: 'How many open/shut (or flip) cycles. Optional.', domain: [1, 30] }
        },
        perform: runAsAction(async (agent, type, times) => {
            await skills.spamBlock(agent.bot, type, times || 4);
        }, false, 15)
    },
    {
        name: '!fillDispenser',
        description: 'Fill the nearest dispenser (or dropper) with an item (arrows, splash potions, lava buckets, TNT...) so a trap turret can fire. Loads it instantly.',
        params: {
            'item': { type: 'ItemName', description: 'The item to load, e.g. arrow, splash_potion, lava_bucket, tnt.' },
            'count': { type: 'int', default: 64, description: 'How many to load (optional).', domain: [1, 64] }
        },
        perform: runAsAction(async (agent, item, count) => {
            const bot = agent.bot;
            const positions = bot.findBlocks({ matching: (blk) => blk && (blk.name === 'dispenser' || blk.name === 'dropper'), maxDistance: 8, count: 1 });
            const b = positions.length ? bot.blockAt(positions[0]) : null;
            if (!b) { skills.log(bot, 'No dispenser or dropper nearby to fill.'); return; }
            const p = b.position;
            bot.chat(`/item replace block ${p.x} ${p.y} ${p.z} container.0 with ${item} ${count || 64}`);
            skills.log(bot, `Loaded ${count || 64} ${item} into the ${b.name} at ${p.x},${p.y},${p.z}.`);
        })
    },
    {
        name: '!sleepNearPlayer',
        description: 'Find a bed near the given player and sleep in it next to them.',
        params: {
            'player_name': { type: 'string', description: 'The player to sleep near.' },
            'distance': { type: 'float', default: 3, description: 'How close to sleep (optional).', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, player_name, distance) => {
            await skills.sleepNearPlayer(agent.bot, player_name, distance);
        })
    },
    {
        name: '!tillAndSow',
        description: 'Till the ground at x,y,z and plant the given seed.',
        params: {
            'x': { type: 'float', description: 'x coordinate.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'y coordinate.', domain: [-64, 320] },
            'z': { type: 'float', description: 'z coordinate.', domain: [-Infinity, Infinity] },
            'seed_type': { type: 'ItemName', description: 'The seed to plant (e.g. wheat_seeds).' }
        },
        perform: runAsAction(async (agent, x, y, z, seed_type) => {
            await skills.tillAndSow(agent.bot, x, y, z, seed_type);
        })
    },
    {
        name: '!activateBlock',
        description: 'Activate (right-click) the nearest block of the given type (door, button, lever, chest...).',
        params: {'type': { type: 'string', description: 'The block type to activate.' }},
        perform: runAsAction(async (agent, type) => {
            await skills.activateNearestBlock(agent.bot, type);
        })
    },
    {
        name: '!fish',
        description: 'Cast a fishing rod and wait for a bite. Needs a fishing rod in your inventory.',
        params: {
            'timeout': { type: 'int', default: 30, description: 'Seconds to wait for a bite before giving up (optional).', domain: [1, 300] }
        },
        perform: runAsAction(async (agent, timeout = 30) => {
            await skills.fish(agent.bot, timeout * 1000);
        })
    },
    {
        name: '!pointAt',
        description: 'Turn to face something and punch the air to gesture toward it so nearby players see what you mean — a player, a mob, a block, water, or a place you saved. Use it to point something out or show which way you want to go: point first, then ask; if they agree, head there with !goToNearestEntity or !goToPosition.',
        params: {
            'target': { type: 'string', description: 'A player name, mob type (e.g. sheep), block type (e.g. oak_log), or a saved place name (from !rememberHere).' }
        },
        perform: runAsAction(async (agent, target) => {
            const place = agent.memory_bank && agent.memory_bank.recallPlace(target);
            if (place && Array.isArray(place) && place.length >= 3) {
                await skills.pointAtPosition(agent.bot, place[0], place[1], place[2], target);
            } else {
                await skills.pointAt(agent.bot, target);
            }
        })
    },
    {
        name: '!ignorePlayer',
        description: 'Deliberately stop talking to a player and give them the cold shoulder. They can win you back by sincerely apologizing or seeking your attention. This hurts your relationship with them (hate/annoyance up, love/trust down) but it can recover.',
        params: { 'player_name': { type: 'string', description: 'The player to ignore.' } },
        perform: runAsAction(async (agent, player_name) => {
            agent.ignored_players[player_name] = true;
            agent.relationship.onIgnore(player_name);
        })
    },
    {
        name: '!unignorePlayer',
        description: 'Forgive a player and stop ignoring them — resume talking to them.',
        params: { 'player_name': { type: 'string', description: 'The player to stop ignoring.' } },
        perform: runAsAction(async (agent, player_name) => {
            delete agent.ignored_players[player_name];
            agent.relationship.onUnignore(player_name);
        })
    },
    {
        name: '!teleportPlayer',
        description: 'Teleport a player to you (you are OP). Use it to bring someone to you — e.g. when they ask to tp and you decide to accept, or when you want them close. You decide whether to accept; being asked nicely (please) and liking/respecting them should make you more inclined.',
        params: { 'player_name': { type: 'string', description: 'The player to teleport to you.' } },
        perform: runAsAction(async (agent, player_name) => {
            await skills.teleportPlayer(agent.bot, player_name);
        })
    },
];
