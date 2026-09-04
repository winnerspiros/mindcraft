import * as skills from '../library/skills.js';
import Vec3 from 'vec3';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';


function runAsAction (actionFn, resume = false, timeout = -1) {
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
        name: '!buildShape',
        description: 'Build a small curated shape (heart, tower, circle, cube, path, hall) out of a given block, starting at your position. Size is in blocks.',
        params: {
            'shape': { type: 'string', description: 'One of: heart, tower, circle, cube, path, hall.' },
            'block': { type: 'BlockOrItemName', description: 'The block type to build with.' },
            'size': { type: 'int', description: 'Rough size in blocks.', domain: [1, 16] }
        },
        perform: runAsAction(async (agent, shape, block, size) => {
            let bot = agent.bot;
            let pos = bot.entity.position;
            let bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
            let placed = 0;
            const put = async (x, y, z) => {
                if (await skills.placeBlock(bot, block, x, y, z)) placed++;
            };

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
                                    await put(bx + c*scale + sx, by + (HEART.length-1-r)*scale + sy, bz);
            }
            else if (shape === 'tower') {
                for (let i = 0; i < size; i++) await put(bx, by + i, bz);
            }
            else if (shape === 'circle') {
                let r = size;
                for (let dx = -r; dx <= r; dx++)
                    for (let dz = -r; dz <= r; dz++)
                        if (dx*dx + dz*dz <= r*r)
                            await put(bx+dx, by, bz+dz);
            }
            else if (shape === 'cube') {
                for (let dx = 0; dx < size; dx++)
                for (let dy = 0; dy < size; dy++)
                for (let dz = 0; dz < size; dz++)
                    await put(bx+dx, by+dy, bz+dz);
            }
            else if (shape === 'path') {
                for (let i = 0; i < size; i++) await put(bx+i, by, bz);
            }
            else if (shape === 'hall') {
                // 3-wide tunnel of size length, 3 tall, open center
                let L = size;
                for (let i = 0; i < L; i++) {
                    for (let dx = -1; dx <= 1; dx++)
                    for (let dy = 0; dy <= 2; dy++) {
                        if (dx === 0 && dy === 1) continue; // open doorway
                        await put(bx+dx, by+dy, bz+i);
                    }
                }
            }
            else {
                return `Unknown shape '${shape}'. Try heart, tower, circle, cube, path, or hall.`;
            }
            return `Built a ${shape} of ${block} (${placed} blocks placed).`;
        })
    },
    {
        name: '!build',
        description: 'Build a real structure near you from a block. Use for houses, bridges, farms, towers and walls — NOT single blocks (use !placeHere) or small shapes (use !buildShape).',
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
            const cmd = async (c) => { bot.chat(c); await new Promise(r => setTimeout(r, 150)); };
            structure = (structure || 'house').toLowerCase();
            const recordBuild = () => {
                const p = './bots/UwU/structures.json';
                let d = { builds: [] };
                if (existsSync(p)) { try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { d = { builds: [] }; } }
                d.builds = d.builds || [];
                d.builds.push({ type: structure, block, x: bx, y: by, z: bz, t: Date.now() });
                writeFileSync(p, JSON.stringify(d, null, 2));
            };

            if (structure === 'house') {
                const w = size, d = Math.max(4, size - 2), h = 4;
                const x2 = bx + w - 1, z2 = bz + d - 1, y2 = by + h - 1;
                await cmd(`/fill ${bx} ${by} ${bz} ${x2} ${y2} ${z2} ${block} hollow`);
                const dx = bx + Math.floor(w / 2);
                await cmd(`/fill ${dx} ${by} ${bz} ${dx + 1} ${by + 1} ${bz} air`); // doorway
                await cmd(`/fill ${bx + 1} ${by + 1} ${bz} ${bx + 2} ${by + 2} ${bz} air`); // window
                await cmd(`/fill ${x2 - 2} ${by + 1} ${bz} ${x2 - 1} ${by + 2} ${bz} air`); // window
                await cmd(`/fill ${bx - 1} ${y2 + 1} ${bz - 1} ${x2 + 1} ${y2 + 1} ${z2 + 1} ${block}`); // roof rim
                await cmd(`/fill ${bx} ${y2 + 2} ${bz} ${x2} ${y2 + 2} ${z2} ${block}`); // roof ridge
                recordBuild();
                skills.log(bot, `Built a ${w}x${d} hollow house of ${block} with a doorway, windows and roof.`);
            }
            else if (structure === 'bridge') {
                const x2 = bx + size - 1;
                await cmd(`/fill ${bx} ${by} ${bz} ${x2} ${by} ${bz + 2} ${block}`); // deck
                await cmd(`/fill ${bx} ${by + 1} ${bz} ${x2} ${by + 1} ${bz} ${block}`); // rail
                await cmd(`/fill ${bx} ${by + 1} ${bz + 2} ${x2} ${by + 1} ${bz + 2} ${block}`); // rail
                recordBuild();
                skills.log(bot, `Built a ${size}-long bridge of ${block}.`);
            }
            else if (structure === 'farm') {
                const x2 = bx + size - 1, z2 = bz + size - 1;
                await cmd(`/fill ${bx} ${by} ${bz} ${x2} ${by} ${z2} farmland`); // tilled plot
                await cmd(`/fill ${bx + Math.floor(size / 2)} ${by} ${bz} ${bx + Math.floor(size / 2)} ${by} ${z2} water`); // irrigation
                await cmd(`/fill ${bx - 1} ${by} ${bz - 1} ${x2 + 1} ${by + 1} ${z2 + 1} oak_fence hollow`); // fence
                recordBuild();
                skills.log(bot, `Built a ${size}x${size} farm with farmland, water and a fence.`);
            }
            else if (structure === 'tower') {
                const h = Math.max(5, size), x2 = bx + size - 1, z2 = bz + size - 1, y2 = by + h - 1;
                await cmd(`/fill ${bx} ${by} ${bz} ${x2} ${y2} ${z2} ${block} hollow`);
                await cmd(`/fill ${bx + Math.floor(size / 2)} ${by} ${bz} ${bx + Math.floor(size / 2)} ${by + 1} ${bz} air`); // entrance
                recordBuild();
                skills.log(bot, `Built a ${h}-tall hollow tower of ${block}.`);
            }
            else if (structure === 'wall') {
                const x2 = bx + size - 1;
                await cmd(`/fill ${bx} ${by} ${bz} ${x2} ${by + 3} ${bz} ${block}`);
                recordBuild();
                skills.log(bot, `Built a ${size}-long wall of ${block}.`);
            }
            else {
                skills.log(bot, `Unknown structure '${structure}'. Try house, bridge, farm, tower, or wall.`);
            }
        })
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
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
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
];
