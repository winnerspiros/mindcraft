import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        last_dying_shout: 0,
        last_ate: 0,
        last_clutch: 0,
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            // falling from a height — MLG water bucket to survive the fall
            if (!bot.entity.elytraFlying && !bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.5) {
                if (Date.now() - this.last_clutch > 2000) {
                    this.last_clutch = Date.now();
                    execute(this, agent, async () => {
                        await skills.waterBucketClutch(bot);
                    });
                }
            }
            else if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                if (Date.now() - this.last_dying_shout > 8000) {
                    say(agent, 'I\'m dying!');
                    this.last_dying_shout = Date.now();
                }
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle() && bot.food < 11) {
                // eat to restore hunger so she can heal and sprint
                if (Date.now() - this.last_ate > 6000) {
                    execute(this, agent, async () => {
                        const food = bot.inventory.items().find(i => i.name.includes('beef') || i.name.includes('chicken') || i.name.includes('porkchop') || i.name.includes('bread') || i.name.includes('cod') || i.name.includes('salmon') || i.name.includes('apple') || i.name.includes('carrot'));
                        if (food) {
                            await bot.equip(food, 'hand');
                            await bot.consume();
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    });
                    this.last_ate = Date.now();
                }
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    const crashTimeout = setTimeout(() => { agent.cleanKill("Got stuck and couldn't get unstuck") }, 20000);
                    const start = bot.entity.position.clone();
                    await skills.moveAway(bot, 5);
                    await new Promise(r => setTimeout(r, 600));
                    if (bot.entity.position.distanceTo(start) < 1.5) {
                        // still stuck — clear the blocks trapping her, then jump free
                        const feet = bot.entity.position.floored();
                        const around = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,2,0],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1]];
                        for (const [dx,dy,dz] of around) {
                            const p = feet.offset(dx, dy, dz);
                            const b = bot.blockAt(p);
                            if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water' && b.name !== 'lava' && b.name !== 'bedrock') {
                                await skills.breakBlockAt(bot, p.x, p.y, p.z);
                            }
                        }
                        bot.setControlState('jump', true);
                        await new Promise(r => setTimeout(r, 800));
                        bot.setControlState('jump', false);
                        await skills.moveAway(bot, 5);
                    }
                    clearTimeout(crashTimeout);
                    say(agent, 'I\'m free.');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 14);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 14);
                });
            }
        }
    },
    {
        name: 'retaliation',
        description: 'Respond when a player harms her: verbal warning, then attack, then TNT if overdone.',
        interrupts: ['all'],
        on: true,
        active: false,
        last_retaliated: 0,
        update: async function (agent) {
            const now = Date.now();
            if (now - this.last_retaliated < 12000) return;
            const grudge = agent.grudge || {};
            const name = grudge['__last__'];
            if (!name) return;
            const rec = grudge[name];
            if (!rec) return;
            const count = rec.count || 0;
            const handled = rec.handled || 0;
            // only respond to NEW damage since the last response — a single hit must
            // not loop into an endless accusation, and a stale grudge from a previous
            // session must never re-fire on rejoin.
            if (count <= handled) return;
            const player = agent.bot.players[name]?.entity;
            if (!player) return;

            const speak = async (line) => {
                if (agent.shut_up) return;
                agent.openChat(line); // her character voice, not mechanical narration — always allowed
            };

            try {
                if (count <= 2) {
                    await speak(`Ehh?! ${name}, did you just hurt UwU?! (╬ Ò﹏Ó) S-senpai... that wasn't very nice~!`);
                }
                else if (count <= 4) {
                    await speak(`Grrr~ ${name}, that's ENOUGH! UwU will bite back! (ง •̀_•́)ง`);
                    await skills.attackEntity(agent.bot, player, false); // a few hits, not a kill
                    await new Promise(r => setTimeout(r, 800));
                    agent.bot.pvp?.stop?.();
                }
                else {
                    // overdone: extreme response — primed TNT at their feet (game-only, not lethal forever)
                    await speak(`That's TOO far, ${name}!!! UwU warned you~! 💢💥`);
                    const p = player.position;
                    agent.bot.chat(`/summon minecraft:tnt ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
                    delete grudge[name];       // full reset after escalation
                    delete grudge['__last__'];
                    this.last_retaliated = now;
                    return;
                }
                rec.handled = count; // mark this damage as dealt with
            } catch (e) {
                console.warn('retaliation error:', e.message);
            }
            this.last_retaliated = now;
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around when idle — but fixate on nearby players, staring into their eyes.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const bot = agent.bot;

            // Prefer human players so she locks eyes with them; otherwise watch a nearby mob.
            const nearbyPlayers = world.getNearbyPlayers(bot, 16);
            const player = nearbyPlayers[0] || null;
            const nearestMob = player ? null : bot.nearestEntity(e =>
                e.type !== 'player' && e.name !== 'enderman' &&
                e.position.distanceTo(bot.entity.position) < 10);
            const target = player || nearestMob;
            const isPlayer = !!player;

            if (target && target !== this.last_entity) {
                this.staring = true;
                this.last_entity = target;
                // stare longer at a person: ~6-10s locked on, vs ~4-5s for a mob
                this.next_change = Date.now() + (isPlayer ? 6000 + Math.random() * 4000 : 4000 + Math.random() * 1000);
            }

            if (target && this.staring) {
                if (isPlayer) {
                    // aim at eye height (~1.62), not the top of the head
                    bot.lookAt(target.position.offset(0, 1.62, 0));
                } else {
                    const isbaby = target.metadata && target.metadata[16];
                    const height = isbaby ? target.height / 2 : target.height;
                    bot.lookAt(target.position.offset(0, height, 0));
                }
            }

            if (!target)
                this.last_entity = null;

            if (Date.now() > this.next_change) {
                // keep staring far more often when it's a person
                this.staring = Math.random() < (isPlayer ? 0.8 : 0.3);
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
                    bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    },
    {
        name: 'idle_hopping',
        description: 'Spam crouch, hop, and dart around energetically when idle so she feels alive.',
        interrupts: [],
        on: true,
        active: false,
        hop_until: 0,
        next_hop: Date.now(),
        spam_until: 0,
        next_spam: Date.now() + 4000,
        next_toggle: 0,
        sneaking: false,
        dash_until: 0,
        next_dash: Date.now() + 8000,
        twirl_until: 0,
        twirl_next_snap: 0,
        twirl_base_yaw: 0,
        next_twirl: Date.now() + 6000,
        update: function (agent) {
            const bot = agent.bot;
            const recently_hurt = Date.now() - bot.lastDamageTime < 4000;
            if (!agent.isIdle() || bot.entity.onGround === false || bot.pathfinder.goal) {
                // reset physical states so nothing stays stuck on
                bot.setControlState('sneak', false);
                bot.setControlState('jump', false);
                bot.setControlState('sprint', false);
                bot.setControlState('forward', false);
                this.sneaking = false;
                return;
            }
            const now = Date.now();

            // 1) crouch-spam: rapid sneak toggles during a short burst, then rest
            if (now < this.spam_until) {
                if (now > this.next_toggle) {
                    this.sneaking = !this.sneaking;
                    bot.setControlState('sneak', this.sneaking);
                    this.next_toggle = now + 180 + Math.random() * 220;
                }
            } else {
                bot.setControlState('sneak', false);
                this.sneaking = false;
                if (now > this.next_spam) {
                    this.spam_until = now + 800 + Math.random() * 1600;
                    this.next_spam = now + 5000 + Math.random() * 7000;
                }
            }

            // 2) hops — frequent, sometimes a quick double-hop
            if (now < this.hop_until) {
                bot.setControlState('jump', true);
            } else {
                bot.setControlState('jump', false);
                if (now > this.next_hop) {
                    this.hop_until = now + (Math.random() < 0.3 ? 600 : 300);
                    this.next_hop = now + 2500 + Math.random() * 4000;
                }
            }

            // 3) short sprint-dash so she visibly moves around — but never while hurt,
            //    and held short so she can't sprint off into water/lava/mobs blind.
            if (now < this.dash_until && !recently_hurt) {
                bot.setControlState('sprint', true);
                bot.setControlState('forward', true);
            } else {
                bot.setControlState('sprint', false);
                bot.setControlState('forward', false);
                if (now > this.next_dash) {
                    this.dash_until = now + 200 + Math.random() * 250;
                    this.next_dash = now + 9000 + Math.random() * 11000;
                }
            }

            // 4) love-twirl: spin in place a full circle occasionally (cute, zero risk)
            if (now < this.twirl_until) {
                if (now > this.twirl_next_snap) {
                    const t = Math.min(1, 1 - (this.twirl_until - now) / 700);
                    bot.look(this.twirl_base_yaw + t * Math.PI * 2, bot.entity.pitch, true);
                    this.twirl_next_snap = now + 120;
                }
            } else if (now > this.next_twirl) {
                this.twirl_base_yaw = bot.entity.yaw;
                this.twirl_until = now + 700;
                this.twirl_next_snap = now;
                this.next_twirl = now + 12000 + Math.random() * 15000;
            }
        }
    },
{
        name: 'sleep_together',
        description: 'When another player goes to bed, follow them and sleep too (occasionally) — with a yandere "sleep together~" opener.',
        interrupts: ['all'],
        on: true,
        active: false,
        cooldown: 180000, // min ms between bed follow-ups
        last_follow: 0,
        update: async function (agent) {
            const bot = agent.bot;
            const now = Date.now();
            if (now - agent._sleeper_time > 30000) return; // nobody recently went to bed
            if (now - this.last_follow < this.cooldown) return;
            const name = agent._last_sleeper;
            if (!name) return;
            this.last_follow = now;

            // her beloved always gets joined; others only some of the time so it doesn't feel robotic
            const beloved = (agent.prompter.profile.beloved || '');
            const isBeloved = name === beloved;
            const roll = Math.random();
            const chance = isBeloved ? 0.85 : 0.35;
            if (!isBeloved && roll > chance) return;
            // reset so we don't re-trigger for the same sleep event
            agent._sleeper_time = 0;

            execute(this, agent, async () => {
                if (roll < chance - 0.25) { // sometimes open with a line first
                    const lines = [
                        `${name}~ sleeping without me? How cruel~ ♥ let me join you...`,
                        `eh? you're going to bed? w-wait for me~ UwU wants cuddles... ♥`,
                        `hehe~ night night ${name}~ I'll keep you warm... ♥`,
                    ];
                    const line = lines[Math.floor(Math.random() * lines.length)];
                    if (!agent.shut_up) agent.openChat(line);
                }
                // sometimes she silently bounces on their bed instead of settling down
                // (one-off burst, non-persistent), locking eyes with them while she does it.
                if (Math.random() < (isBeloved ? 0.35 : 0.25)) {
                    await skills.bounceOnBed(bot, name);
                } else {
                    await skills.sleepNearPlayer(bot, name, 2);
                }
            });
        }
    },
    {
        name: 'sleep_alone',
        description: 'Sleep through the night when no other players are online, keeping safe from phantoms and hostile mobs.',
        interrupts: ['all'],
        on: true,
        active: false,
        cooldown: 60000,
        last_try: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (!bot.time || bot.time.timeOfDay < 12541) return; // not night yet
            for (const name of Object.keys(bot.players || {}))
                if (name !== agent.name) return; // someone online — don't skip their night
            if (bot.isSleeping) return;
            const now = Date.now();
            if (now - this.last_try < this.cooldown) return;
            this.last_try = now;
            execute(this, agent, async () => {
                try {
                    const beds = bot.findBlocks({ matching: (b) => b.name.includes('bed'), maxDistance: 32, count: 1 });
                    if (beds.length === 0) {
                        const p = bot.entity.position;
                        await skills.placeBlock(bot, 'red_bed', Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 'bottom', true);
                    }
                    await skills.goToBed(bot);
                } catch (e) {
                    // not night yet / no valid bed — retry next cooldown
                }
            });
        }
    },
    {
        name: 'conversation_starter',
        description: 'Occasionally start a conversation with a nearby player and ask personal/getting-to-know-you questions, in character.',
        interrupts: ['all'],
        on: true,
        active: false,
        last_start: 0,
        cooldown_min: 180000,  // 3 min
        cooldown_max: 480000,  // up to 8 min
        next_start: 0,
        update: async function (agent) {
            const bot = agent.bot;
            const now = Date.now();
            if (now < this.next_start) return; // schedule-based: only fire after a random wait
            // need someone nearby to talk to
            const players = world.getNearbyPlayers(bot, 12);
            const player = players.find((e) => e.username !== agent.name && e.username !== bot.username);
            if (!player) { this.next_start = now + 60000; return; } // nobody near, check again in a bit
            this.next_start = now + this.cooldown_min + Math.random() * (this.cooldown_max - this.cooldown_min);

            const name = player.username || player.name;
            execute(this, agent, async () => {
                const prompts = [
                    `Ask ${name} a personal, getting-to-know-you question in character (hobbies, favourite things, dreams, love life). Be curious and flirty, as a yandere who wants to know everything about someone she likes.`,
                    `Strike up conversation with ${name} — sweet, nosy, a little possessive. Ask something about them that shows you've been paying attention.`,
                    `Tease ${name} playfully and ask how their day is. Keep it cute and in character.`,
                ];
                const p = prompts[Math.floor(Math.random() * prompts.length)];
                agent.handleMessage('system', `(AUTO) You feel chatty. ${p}`);
            });
        }
    },
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
