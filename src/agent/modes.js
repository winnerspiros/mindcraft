import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import Vec3 from 'vec3';
import settings from './settings.js'
import convoManager from './conversation.js';
import { canOp, combatConfig, modeOverrides } from '../utils/server_context.js';
import { isYandere } from '../utils/server_context.js';

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
// Fight-vs-flee split. At/above this fear she flees (cowardice); below it she
// fights (self_defense). Both were always-on with interrupts:['all'], so they
// thrashed each other whenever a hostile mob was near. Fear already folds in
// the boldness trait (psyche.sampleEnvironment), so this stays mood-driven.
const FEAR_FLEE_THRESHOLD = 0.5;

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
        last_flee: 0, // 26.3: flee-throttle — moveAway every tick (phantom chip damage refreshes lastDamageTime) stops the self-prompt loop each time and starves brain + idle modes; min 15s between flees
        last_drown: 0, // drowning-rescue throttle; an unthrottled swimUp stops the self-prompt loop every tick
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            // Drowning rescue.
            //
            // Two separate faults, both of which had to go before this fires:
            //
            // 1. ORDER. This shared an else-if with the MLG water-bucket fall
            //    rescue, and the fall test matched FIRST in exactly the case
            //    that kills: sinking into water puts her off the ground with
            //    downward velocity, so she was reaching for a bucket while her
            //    bubbles ran out. She drowned at y=62 with the rescue never
            //    once evaluating.
            // 2. THE SIGNAL. bot.oxygenLevel is unusable on 26.3 - live, it read
            //    air=NaN, forever. mineflayer sets it from
            //    bot.registry.entitiesByName[name].metadataKeys[...]->air_supply
            //    (entities.js:550), and the bundled 26.3 entities.json carries no
            //    metadata field for ANY of its 161 entries. So metadataKeys is
            //    undefined, metas is {}, and oxygenLevel is never assigned;
            //    breath.js returns early on modern protocol and delegates to
            //    that same lookup. The Number.isFinite guard I added last time
            //    turned "never set" into "no danger", which is why the rescue
            //    looked correct and never ran. Do not reintroduce it.
            //
            // Head-under is the signal that works, and it is sufficient:
            // bubbles only fall while the head is submerged, so this fires with
            // air still left. It is also tested first, not as a branch of the
            // fall test.
            const headUnder = blockAbove.name === 'water';

            if (headUnder) {
                // Drowning rescue, on head-under alone (see the note above).
                //
                // Throttled on last_drown, same reason as last_flee: a rescue
                // that re-fires every tick would stop the self-prompt loop
                // continuously and starve brain + idle modes.
                if (Date.now() - this.last_drown > 5000) {
                    this.last_drown = Date.now();
                    execute(this, agent, async () => {
                        const ok = await skills.swimUp(bot, 8000);
                        if (!ok) say(agent, 'stuck underwater, this is not great');
                    });
                } else if (!bot.pathfinder.goal) {
                    // rescue already in flight or recently done: drift up gently
                    // so she still rises while the throttle holds it back
                    bot.setControlState('jump', true);
                }
            }
            else if (!bot.entity.elytraFlying && !bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.5) {
                // falling from a height — MLG water bucket to survive the fall
                if (Date.now() - this.last_clutch > 2000) {
                    this.last_clutch = Date.now();
                    execute(this, agent, async () => {
                        await skills.waterBucketClutch(bot);
                    });
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
                // 26.3 flee-throttle: phantom chip hits refresh lastDamageTime
                // every tick, so an unthrottled execute() stops the self-prompt
                // loop ~1/s and starves brain + all idle modes (stare/hop/twirl
                // never fire, she stands still). One flee per 15s is plenty.
                if (Date.now() - this.last_flee < 15000) return;
                this.last_flee = Date.now();
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle() && bot.food < 11) {
                // eat to restore hunger so she can heal and sprint
                if (Date.now() - this.last_ate > 6000) {
                    this.last_ate = Date.now();
                    // only interrupt self-prompting to actually eat when she HAS
                    // food. Hungry-with-no-food previously spun an empty execute()
                    // every 6s, which stopped the self-prompt loop each time and
                    // left her too busy "eating nothing" to go gather food.
                    // SERVER-TRUTH (2026-09-27): client items() is blind on 26.3 —
                    // she stood at food 7 with 32 beef in her pack. RCON decides.
                    let food = bot.inventory.items().find(i => i.name.includes('beef') || i.name.includes('chicken') || i.name.includes('porkchop') || i.name.includes('bread') || i.name.includes('cod') || i.name.includes('salmon') || i.name.includes('apple') || i.name.includes('carrot'));
                    if (!food) {
                        try {
                            const { rconInventory } = await import('../utils/rcon.js');
                            const inv = await rconInventory(bot.username);
                            const bite = (inv || []).find(e => /beef|chicken|porkchop|bread|cod|salmon|apple|carrot|pork|mutton|potato|melon|cookie|pumpkin_pie/.test(e.name));
                            if (bite) {
                                say(agent, `I have ${bite.name} but can't see it — re-syncing so I can eat.`);
                                try { await bot.clickWindow(0, 0, 0).catch(() => {}); } catch (_) {}
                                await new Promise(r => setTimeout(r, 800));
                                food = bot.inventory.items().find(i => i.name.includes('beef') || i.name.includes('chicken') || i.name.includes('porkchop') || i.name.includes('bread') || i.name.includes('cod') || i.name.includes('salmon') || i.name.includes('apple') || i.name.includes('carrot'));
                                if (!food) return; // still blind: don't spin, retry next tick
                            } else return;
                        } catch (_) { return; }
                    }
                    execute(this, agent, async () => {
                        await bot.equip(food, 'hand');
                        await bot.consume();
                        await new Promise(r => setTimeout(r, 1500));
                    });
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
            // A PLAYER WHO IS TALKING IS NOT STUCK. The original trigger was
            // "has not moved for ~40 ticks", which means standing still and
            // chatting - the most normal thing a player does - read as stuck, and
            // she would dig blocks out from under whoever was talking to her.
            // Requiring an ACTIVE goal to be stuck means stillness only counts
            // when she actually intended to go somewhere.
            const _goalActive = !!(agent.self_prompter?.prompt
                && agent.self_prompter?.state !== 'STOPPED');
            if (agent.isIdle() && !_goalActive) {
                // IDLE-STILL WATCH (2026-09-27): the old code reset here, so an
                // idle bot in a hole never accrued stuck_time and the rescue
                // below never fired. Track stillness separately: unmoved for a
                // full window while idle = dig out (eye-level wall, max 3).
                try {
                    const bp0 = agent.bot.entity.position;
                    if (this._idlePrev && this._idlePrev.distanceTo(bp0) < 1.0) {
                        this._idleStill = (this._idleStill || 0) + 1;
                    } else {
                        this._idlePrev = bp0.clone();
                        this._idleStill = 0;
                    }
                    // update() ticks fast; ~20s of stillness trips it. Cooldown
                    // after each rescue so she digs 3, re-plans, digs 3 more.
                    if ((this._idleStill || 0) >= 40 && Date.now() - (this._idleRescueAt || 0) > 60000) {
                        this._idleStill = 0;
                        this._idleRescueAt = Date.now();
                        const bot = agent.bot;
                        execute(this, agent, async () => {
                            try {
                                const fp = bot.entity.position.floored();
                                const cands = [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz]) => {
                                    try { return bot.blockAt(fp.offset(dx, 1, dz)); } catch { return null; }
                                }).filter(b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava'
                                    && !/bedrock|obsidian|command|barrier|portal|chest|furnace|crafting_table|ore|diamond|gold|iron|lapis|redstone|emerald|coal/.test(b.name));
                                const cheap = (b) => /dirt|grass_block|sand|gravel/.test(b.name) ? 0 : /cobblestone|stone|deepslate|netherrack/.test(b.name) ? 1 : 2;
                                cands.sort((a,b) => cheap(a) - cheap(b));
                                let freed = 0;
                                for (const b of cands.slice(0, 3)) {
                                    if (bot.interrupt_code) break;
                                    try {
                                        const ok = await skills.breakBlockAt(bot, b.position.x, b.position.y, b.position.z, 15000);
                                        if (ok) freed++;
                                    } catch (_) {}
                                }
                                if (freed > 0) say(agent, `Dug ${freed} block${freed === 1 ? '' : 's'} to get out~`);
                            } catch (e) { /* rescue is best-effort, never fatal */ }
                        });
                    }
                } catch (_) {}
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            // 26.3: never fire while following — a stationary follow target
            // looks identical to stuck (19:12:30 self-kill: unstuck interrupted
            // !followPlayer, moveAway made no progress, 20s crashTimeout ran
            // cleanKill 'Exiting.' -> exit 1 -> systemd restart loop).
            try {
                const label = agent.actions && agent.actions.currentActionLabel;
                if (label && label.includes('followPlayer')) {
                    this.prev_location = null;
                    this.stuck_time = 0;
                    return;
                }
            } catch (e) {}
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
                // 26.3: OBSERVE-ONLY while an action runs (idle rescue lives
                // in the idle branch above). The old fire-and-forget free-sequence
                // drove pathfinder+dig CONCURRENTLY with the running action —
                // every 20s it hijacked the goal and aborted the action's dig
                // (log proof 06:0x: 'free-sequence failed: Digging aborted' on
                // exact 20s cadence, every collect ending 'Failed to collect:
                // Digging aborted'). Recovery belongs INSIDE the action (nav
                // watchdog, dig race, inline progress checks) — never in a
                // concurrent driver. Two drivers, one steering wheel.
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
            // Flee only when afraid; below the threshold self_defense handles it.
            if ((agent.psyche?.mood?.fear ?? 0) < FEAR_FLEE_THRESHOLD) return;
            // SWING-SAFE 2026-09-28: cowardice interrupts EVERYTHING (digs
            // included) via stop()-ABORT. Never fire while a dig is mid-swing
            // — observe, report, and let the swing finish instead.
            try { if (agent.bot.targetDigBlock) return; } catch (_) {}
            const enemy = world.getNearestEntityWhere(agent.bot,
                entity => entity?.position && Number.isFinite(entity.position.x) && mc.isHostile(entity), 16);
            if (!enemy) return;
            // 26.3: close-range bypass — the isClearPath no-dig check vetoes
            // fights it could walk (indoor/forest paths need a step or two).
            // Within 5 blocks just engage; pathfinder + pvp handle the rest.
            const close = enemy.position.distanceTo(agent.bot.entity.position) <= 5;
            if ((close || await world.isClearPath(agent.bot, enemy))) {
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
            // Fight only when calm/brave; at/above the threshold cowardice flees.
            //
            // ENTITY-BLINDNESS FIX (2026-09-27: pillagers nearby = nothing, a
            // zombie chewed her to death while self_defense never fired): the
            // 26.3 server withholds entities from bot.entities, so the eye
            // scan alone returns null on a live threat. When eyes fail, ask
            // RCON where the nearest hostile is (read-only data get, no
            // cheats) and FIGHT THE RCON TRUTH: walk the live position and
            // swing — bot.attack needs a handle, so re-resolve each tick and
            // fall back to a blind swing at the RCON position when no handle
            // renders. Throttled: at most one RCON locate per 5s per mode tick
            // (update() must stay <100ms — the locate runs async inside
            // execute, never inline here).
            if ((agent.psyche?.mood?.fear ?? 0) >= FEAR_FLEE_THRESHOLD) return;
            // FLYERS FIRST (wither snipes from 30+ blocks — past the 14-block
            // ground scan): a wide sync eye-scan only, no RCON here (update
            // must stay <100ms; defendSelf does the RCON truth itself).
            const FLYERS = ['wither', 'ghast', 'phantom', 'blaze', 'ender_dragon'];
            let foe = null;
            try {
                foe = world.getNearestEntityWhere(agent.bot,
                    entity => entity?.position && Number.isFinite(entity.position.x) && entity.name && FLYERS.includes(entity.name), 48);
            } catch (_) {}
            if (foe) {
                say(agent, `Spotted a ${foe.name.replace(/_/g, ' ')} — bow fight!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 48);
                });
                return;
            }
            const enemy = world.getNearestEntityWhere(agent.bot,
                entity => entity?.position && Number.isFinite(entity.position.x) && mc.isHostile(entity), 16);
            if (enemy) {
                // 26.3: close-range bypass (see cowardice) — within 5 blocks just
                // fight; the strict no-dig path check sat out real attacks.
                const close = enemy.position.distanceTo(agent.bot.entity.position) <= 5;
                if ((close || await world.isClearPath(agent.bot, enemy))) {
                    say(agent, `Fighting ${enemy.name}!`);
                    execute(this, agent, async () => {
                        await skills.defendSelf(agent.bot, 16);
                    });
                }
                return;
            }
            // EYES EMPTY but she may still be in danger (entity withheld):
            // two server-truth fallbacks, both throttled (5s) so the tick stays
            // fast. (a) recent damage with no visible cause = something IS
            // hitting her — fight the nearest RCON hostile. (b) hurt sound
            // without damage yet (mob winding up) — same answer.
            const now2 = Date.now();
            if (now2 - (this._blindCheck || 0) < 5000) return;
            let hurtRecent = false;
            try {
                hurtRecent = (Date.now() - agent.bot.lastDamageTime < 8000) ||
                    ((agent.bot.health ?? 20) < (this._blindLastHp ?? 20));
            } catch (_) {}
            try { this._blindLastHp = agent.bot.health; } catch (_) {}
            if (!hurtRecent) return;
            this._blindCheck = now2;
            execute(this, agent, async () => {
                await skills.defendBlind(agent.bot, 16);
            });
        }
    },
    {
        name: 'retaliation',
        description: 'Respond when a player harms her: verbal warning, then honest melee back. Never console/TNT.',
        interrupts: ['all'],
        on: true,
        active: false,
        last_retaliated: 0,
        update: async function (agent) {
            // Combat rules come from servers.json combat (both personalities):
            // retaliate=false = never answer; warn_hits = pure-verbal hits
            // before melee; fight_back=false = words only, no hitting back.
            // no_console_punish is unconditional: melee/bow only, stop when
            // they stop — NEVER /effect /kick /summon /crystal as punishment.
            // A poke (1-2 hits, accident) is NOT a real attack: firm warning,
            // no melee. A REAL attack (warn_hits+ consecutive, on purpose)
            // gets answered in-game and dropped the moment they stop.
            let cc = null;
            try { cc = combatConfig(); } catch (_) { cc = null; }
            const WARN = (cc && typeof cc.warn_hits === 'number') ? cc.warn_hits : 2;
            if (cc && cc.retaliate === false) return;
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
                const FIGHT = !(cc && cc.fight_back === false);
                if (count <= WARN) {
                    await speak(`Ehh?! ${name}, did you just hurt UwU?! (╬ Ò﹏Ó) S-senpai... that wasn't very nice~!`);
                }
                else if (count <= WARN + 2) {
                    await speak(`Grrr~ ${name}, that's ENOUGH! UwU will bite back! (ง •̀_•́)ง`);
                    if (FIGHT) {
                        await skills.attackEntity(agent.bot, player, false); // a few hits, not a kill
                        await new Promise(r => setTimeout(r, 800));
                        agent.bot.pvp?.stop?.();
                    }
                }
                else {
                    // overdone: STILL melee only (TNT summon REMOVED 25 Sept:
                    // players farmed her "protective violence" framing into mass
                    // summons — 10k withers proved ANY raw /summon path gets
                    // weaponized). Cap at melee + a scary line instead, and
                    // words-only when fight_back=false.
                    await speak(`That's TOO far, ${name}!!! UwU warned you~! 💢💥`);
                    if (FIGHT) {
                        await skills.attackEntity(agent.bot, player, false);
                        await new Promise(r => setTimeout(r, 800));
                        agent.bot.pvp?.stop?.();
                    }
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
            const huntable = world.getNearestEntityWhere(agent.bot,
                entity => entity?.position && Number.isFinite(entity.position.x) && mc.isHuntable(entity), 8);
            if (!huntable) return;
            const close = huntable.position.distanceTo(agent.bot.entity.position) <= 5;
            if ((close || await world.isClearPath(agent.bot, huntable))) {
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
            let item = world.getNearestEntityWhere(agent.bot,
                entity => entity?.name === 'item' && entity?.position && Number.isFinite(entity.position.x), 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (!item || item === this.prev_item || empty_inv_slots <= 1) {
                this.noticed_at = -1;
                return;
            }
            // 26.3: close-range bypass (see cowardice) — drops at her feet
            // need no path check; the strict no-dig gate sat out pickups.
            const close = item.position.distanceTo(agent.bot.entity.position) <= 4;
            if (!(close || await world.isClearPath(agent.bot, item))) {
                this.noticed_at = -1;
                return;
            }
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
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby. Escalates: if the ground around her is dark AND torch-less over an area (cave floor, night field), run a small !lightUp grid instead of one drip torch.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        last_sweep: 0, // min 3 min between autonomous lightUp sweeps
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                // DARK AREA, not a dark corner? sweep a grid instead of one drip.
                // Count dark floor tiles in a 7-ring: 3+ dark = area job, not a drip.
                let darkTiles = 0;
                try {
                    const b = agent.bot;
                    const c = b.entity.position.floored();
                    for (const [dx, dz] of [[7, 0], [-7, 0], [0, 7], [0, -7], [7, 7], [-7, -7]]) {
                        let ty = null;
                        for (let y = c.y + 2; y >= c.y - 4; y--) {
                            const t = b.blockAt(new Vec3(c.x + dx, y, c.z + dz));
                            const below = t ? b.blockAt(new Vec3(c.x + dx, y - 1, c.z + dz)) : null;
                            if (t && below && t.name !== 'lava' && below.name !== 'air' && below.name !== 'water' && below.name !== 'lava') { ty = y; break; }
                        }
                        if (ty === null) continue;
                        const t = b.blockAt(new Vec3(c.x + dx, ty, c.z + dz));
                        if (!t) continue;
                        if ((t.light ?? 0) < 1 && (t.skyLight ?? 0) < 1) darkTiles++;
                    }
                } catch (_) {}
                if (darkTiles >= 3 && Date.now() - this.last_sweep > 3 * 60 * 1000) {
                    this.last_sweep = Date.now();
                    this.last_place = Date.now();
                    execute(this, agent, async () => {
                        await skills.lightUp(agent.bot, 7);
                    });
                    return;
                }
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
        description: 'Animation to look around when idle. She glances at a nearby player or mob, looks away, then looks back — she does not lock on and stare.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        // async: the gaze awaits bot.lookAt, which is itself async (physics.js:711)
        // and must complete while _gazeArmed is still set, or the angle is stashed
        // for a position packet that never arrives. ModeController already awaits
        // mode.update().
        update: async function (agent) {
            const bot = agent.bot;

            // Prefer human players so she locks eyes with them; otherwise watch a nearby mob.
            // 26.3 RCON-truth: the server withholds player entities at range
            // (verified: 3 blocks apart, entity still absent), so an
            // entity-only scan concludes "nobody near" while the player stands
            // right there. RCON position is ground truth — stare at that.
            let rconTarget = null; // {x,y,z,username} — refreshed ~1s via cache
            try {
                const names = Object.keys(bot.players || {})
                    .filter(n => n && n !== agent.name && n !== bot.username
                        && !/^(rcon|server|console)$/i.test(n));
                if (names.length && bot.entity?.position) {
                    const now = Date.now();
                    if (!this._rconScan || now - this._rconScan.t > 1200) {
                        this._rconScan = { t: now, p: null };
                        Promise.all(names.slice(0, 4).map(n =>
                            import('../utils/rcon.js').then(m => m.rconPlayerPos(n).then(pos =>
                                ({ n, pos })).catch(() => null)))).then(rows => {
                            let best = null, bestD = 17;
                            for (const r of rows) {
                                if (!r?.pos || !bot.entity?.position) continue;
                                const dx = r.pos.x - bot.entity.position.x;
                                const dz = r.pos.z - bot.entity.position.z;
                                const d = Math.hypot(dx, dz);
                                if (d < bestD) { bestD = d; best = { x: r.pos.x, y: r.pos.y, z: r.pos.z, username: r.n }; }
                            }
                            this._rconScan.p = best;
                        }).catch(() => {});
                    }
                    rconTarget = this._rconScan.p || null;
                }
            } catch (_) {}
            const nearbyPlayers = world.getNearbyPlayers(bot, 16);
            // Prefer the player she is actually ENGAGING, not simply the closest.
            // The owner: "observer what players do, look at them" - that is the
            // person she is talking to. Picking nearest-by-distance meant she
            // fixated on whoever happened to be closest, including a player who
            // had not so much as looked at her.
            const _engagedName = (() => {
                try { return agent._attentionPlayer?.()?.username || null; } catch (_) { return null; }
            })();
            const player = (_engagedName
                ? (nearbyPlayers.find((p) => p?.username === _engagedName) || nearbyPlayers[0])
                : nearbyPlayers[0]) || null;
            const nearestMob = player ? null : bot.nearestEntity(e =>
                e.type !== 'player' && e.name !== 'enderman' &&
                e.position.distanceTo(bot.entity.position) < 10);
            const target = player || nearestMob;
            const isPlayer = !!player;

            if (target && target !== this.last_entity) {
                this.staring = true;
                this.last_entity = target;
                // ── LOOK, THEN GLANCE AWAY, THEN LOOK BACK ───────────────
                // Was 6-10s LOCKED ON for a person, which is the yandere tell and
                // not something a player does: people glance at someone, look
                // away, and look back. So the hold is now 1.5-3.5s and the gap
                // between holds is 2.5-7s of looking elsewhere.
                //
                // Mob-holding stays longer because watching a creeper is not the
                // same social act as watching a person.
                // ── GLANCE, LOOK AWAY, LOOK BACK — people AND mobs ──────
                // The owner: "that goes for mobs btw, maybe she sees a mob around
                // so she looks at it"
                //
                // Mobs were the odd one out: a 4-5s hold with no look-back gap at
                // all, so she either ignored a nearby mob or tracked it in long
                // unbroken holds. Watching a creeper is the same act as watching a
                // person, only with a shorter attention span and a real reason to
                // break off. So the SHAPE is identical; only the LENGTH differs.
                this.next_change = Date.now() + (isPlayer
                    ? 1500 + Math.random() * 2000
                    : 1000 + Math.random() * 1500);
                // and the away-gap, so she is not staring continuously at anything
                this.next_look_back = this.next_change + (isPlayer
                    ? 2500 + Math.random() * 4500
                    : 2000 + Math.random() * 4000);
                this.gaze_started = false;   // a fresh gaze has not run yet
            }
            // RCON-truth counts as a target too: if the server says a player
            // is near but no entity rendered, hold the stare on them instead
            // of concluding "nobody near" and glancing away.
            if (!target && rconTarget) {
                if (this.last_entity !== rconTarget) {
                    this.staring = true;
                    this.last_entity = rconTarget;
                    // Same short hold and look-back gap as the entity path. This
                    // one had the original 6-10s locked-on stare left in it,
                    // because I fixed only the entity branch - and this RCON
                    // fallback is the path that fires most often on 26.3, where
                    // the server withholds player entities at range. So the yandere
                    // tell survived precisely where it mattered most.
                    this.next_change = Date.now() + 1500 + Math.random() * 2000;
                    this.next_look_back = this.next_change + 2500 + Math.random() * 4500;
                    this.gaze_started = false;   // scheduled, not yet run
                }
            } else if (!target && !rconTarget) {
                this.last_entity = null;
                this.gaze_started = false;
            }
            // gaze_started means "a gaze has actually RUN", not "one is
            // scheduled". Setting it here - at acquisition, while next_change is
            // still in the future - was the bug: the gap check immediately below
            // sees a future next_look_back and switches the gaze off on the very
            // tick it began. Measured state: gaze_started=true with staring=false
            // on every tick, and she never looked at anyone.
            //
            // It is therefore set where the gaze is ACTED ON (the next_change
            // branch), so the gap can only interrupt a gaze that already happened.
            // A gaze that ended re-arms the gap for the next one, otherwise
            // _gapArmed latches true and the gap only ever applies to the very
            // first glance - which is the opposite of the intended cycle.
            if (!this.staring) { this.gaze_started = false; this._gapArmed = false; }

            // Honour the away-gap: between looking at a person and looking back,
            // she looks somewhere else. Without this the shorter hold above would
            // just re-acquire the instant it expired, which is a faster version of
            // the same 24/7 staring.
            // The gap only applies to a gaze that has ALREADY STARTED. Without
            // that guard this check ran on the same tick the target was acquired:
            // next_look_back is ~4-10s in the future, so `now < next_look_back` was
            // true immediately and staring was set false in the same breath - the
            // gaze lasted exactly zero ticks. Measured: after one tick staring=false
            // with last_entity already set, and because last_entity stayed set the
            // re-arm could never fire either, so she never looked at anyone again.
            // No `isPlayer` guard: mobs run the same cycle now, and with it left on
            // a mob's gap could neither fire nor expire - she would look at a cow
            // and never look away. The guard only ever existed to shorten the old
            // 6-10s person lock-on, which no longer exists.
            // The gap is measured from the moment the gaze ACTUALLY STARTED, not
            // from the moment the hold was scheduled. It used to be computed on
            // acquisition, alongside next_change - which put next_look_back 2.5-7s
            // in the future while the hold itself was still running. So the gap
            // condition was true for the ENTIRE hold: she looked for one tick and
            // then looked away. Measured: staring=false on every tick while the
            // mode was still acquiring a target and calling lookAt, and yaw frozen
            // because the one look that got out was withdrawn a tick later.
            //
            // gaze_started is the record of when the gaze began, so the gap is
            // armed there - which is what the comment on the flag always claimed.
            if (this.staring && this.gaze_started) {
                if (!this._gapArmed) {
                    this._gapArmed = true;
                    // `isPlayer` is declared further down, so it is in the TDZ here
                    // and referencing it would throw on every tick. Derive it from
                    // the target itself instead.
                    const _isPerson = !!this.last_entity
                        && this.last_entity.type === 'player';
                    this.next_look_back = this.next_change
                        + (_isPerson ? 2500 : 2000)
                        + Math.random() * (_isPerson ? 4500 : 4000);
                }
                if (Date.now() < this.next_look_back) this.staring = false;
            }
            // The gap has ELAPSED: let her look back. Clearing last_entity here is
            // what makes the behaviour resume - while it stayed set, the re-arm
            // (`target !== this.last_entity`) could never fire for the same nearby
            // player, so she looked once and was then never allowed to look at them
            // again. Measured symptom: 0 emissions of !lookAtPlayer, and the owner
            // reporting she never looks at players. The gap still prevents
            // CONTINUOUS staring, because re-acquiring computes a fresh one.
// ── GLANCE BUDGET ───────────────────────────────────────────────────────
//
// How many times she will look at the SAME thing inside the window, and how long
// she then refuses to look at it again.
//
// The owner: "no stare or interactions with players too. just stares to nothingness"
//
// The cycle (glance, look away, look back) fixed the SHAPE but not the CEILING.
// Without a budget she glances, looks away, looks back, forever - which is still
// staring, only with breaks, and "to nothingness" because the target is whatever
// was in range rather than anyone she had a reason to look at.
//
// The numbers are deliberately small. A player glances at someone, gets on with
// it, and looks again much later.
const GLANCE_BUDGET_MAX = 3;
const GLANCE_BUDGET_WINDOW_MS = 60000;
const GLANCE_BUDGET_COOLDOWN_MS = 45000;

            if (this.next_look_back && Date.now() >= this.next_look_back) {
                this.next_look_back = 0;
                this.gaze_started = false;
                if (this.last_entity) this.last_entity = null;
            }

            // ── A GLANCE HAS A BUDGET ─────────────────────────────────────
            // The owner: "no stare or interactions with players too. just stares
            // to nothingness"
            //
            // The cycle shape was fixed but there was no CEILING on it: glance,
            // look away, look back, forever, on a timer. That is still staring -
            // it is just staring with breaks, and "to nothingness" because the
            // target is whatever happened to be in range rather than a person she
            // has any reason to look at.
            //
            // So a glance is a bounded thing. After N glances in the window she
            // stops looking at that target entirely and goes back to what she was
            // doing. A player glances at someone, gets on with it, and looks again
            // much later - not forty times a minute.
            const now2 = Date.now();
            if (!this._glanceLog) this._glanceLog = new Map();
            const _key = this.last_entity?.username || this.last_entity?.name || this.last_entity?.id;
            if (_key && this.last_entity !== this._glanceBudgetFor) {
                this._glanceBudgetFor = this.last_entity;
                this._glanceCount = (this._glanceLog.get(_key) || 0) + 1;
                this._glanceLog.set(_key, this._glanceCount);
            }
            // prune so the map cannot grow without bound over a long session
            for (const [k, t] of this._glanceLog) {
                if (now2 - t > GLANCE_BUDGET_WINDOW_MS) this._glanceLog.delete(k);
            }
            const _n = this._glanceLog.get(_key) || 0;
            if (_n > GLANCE_BUDGET_MAX) {
                // Enough. Look away, and do not re-acquire this target for a while.
                this.staring = false;
                this.gaze_started = false;
                this.next_change = now2 + GLANCE_BUDGET_COOLDOWN_MS;
                this.next_look_back = 0;
                this.last_entity = null;
                this._glanceCooldownUntil = now2 + GLANCE_BUDGET_COOLDOWN_MS;
            } else if (this._glanceCooldownUntil && now2 < this._glanceCooldownUntil) {
                this.staring = false;
            }
            if ((target || rconTarget) && this.staring) {
                // 26.3: stare via throttled lookAt (max 1 head-turn per 600ms
                // in physics.js) so the look never races updatePosition's own
                // send inside the same tick window. Full stare behavior kept.
                // 26.3: HOLD stare while spawn-frozen or within the 10s
                // look-hold after a server teleport (walk-death 17:49:57:
                // stare looks every 44-51ms for 36s straight, zero positions
                // -> Invalid move). Angles are cheap to skip; the entity yaw
                // hasn't settled anyway. Stare resumes automatically after.
                // ── THE GLAZE MUST NOT BE GATED BY THE MOVE HOLD ──────
                // The owner: "look too" / she does not look at him.
                //
                // Measured: the mode DOES acquire him and DOES reach bot.lookAt,
                // but her server-side yaw is a constant -180 across 30 samples
                // over 60s. The look is discarded before it is sent.
                // physics.js:429 shouldSendLook() rejects any head-turn within
                // 2500ms of a position-bearing send, and live it reports
                // usePhysics=true, msSinceMove=781 -> shouldSendLook=false.
                //
                // That hold is a real 26.3 walk-death fix: a burst of head-turns
                // colliding with a move inside one server tick is what caused
                // invalid_player_movement. It is NOT the right gate for a mode
                // whose whole job is turning her head while idle - an idle bot
                // re-sends position constantly, so the hold is nearly always
                // active and the gaze never gets through.
                //
                // So the gaze sends directly, bypassing shouldSendLook. A look is
                // a pure angle change: it carries no position, so it cannot
                // produce the movement rejection the hold exists to prevent. This
                // is the same exemption dig-aim already takes (physics.js:430,
                // `if (bot._digAimArmed) return shouldUsePhysics`) - look-only
                // writes are exempt, movement-bearing writes are not.
                // Keep an anti-burst gate, just not THAT one. physics.js already
                // throttles look sends to 1 per 600ms; the property that actually
                // matters is that two head-turns never land in one server tick.
                // We enforce the same 600ms ourselves so the walk-death protection
                // is intact without requiring 2.5s of standing still first.
                const _nowLook = Date.now();
                const _lookThrottled = (this._lastLookAt || 0) + 600 > _nowLook;
                // Stamp on EVERY branch, not just the rcon one: reaching here means
                // a look is going out, and a throttle that only records some of
                // them is no throttle at all.
                if (!_lookThrottled) this._lastLookAt = _nowLook;
                if (_lookThrottled) {
                    // skip this tick's head-turn; try again on the next one
                } else if (rconTarget) {
                    // RCON-truth stare: look at the server's coordinates for
                    // the player even when their entity isn't rendered. Aim at
                    // eye height. lookAt needs a real vec3 Vec3 (it calls
                    // .minus() internally) — the bot's position constructor
                    // is NOT vec3 (it lacks .minus), so import vec3 directly.
                    bot._gazeArmed = true;
                    try {
                        // async: see the note on the entity branch below
                        await bot.lookAt(new Vec3(rconTarget.x, rconTarget.y + 1.62, rconTarget.z));
                    } catch (_) {
                        if (isPlayer && target) {
                            await bot.lookAt(target.position.offset(0, 1.62, 0));
                        }
                    } finally {
                        bot._gazeArmed = false;
                    }
                } else if (isPlayer && target) {
                    // aim at eye height (~1.62), not the top of the head
                    // _gazeArmed lets physics.js flush this as a bare 'look' while
                    // she is idle - see the 26.3 GAZE FIX note there. Without it the
                    // angle is stashed for a position packet that never comes.
                    // bot.lookAt is ASYNC (physics.js:711): it computes the angles
                    // then `await bot.look(...)`. A synchronous try/finally cleared
                    // _gazeArmed before the send ever reached sendPacketLook, so the
                    // flag was always false when it mattered and the gaze branch in
                    // physics.js never ran. Await it, then release.
                    bot._gazeArmed = true;
                    try {
                        await bot.lookAt(target.position.offset(0, 1.62, 0));
                    } catch (_) {
                        /* a glance must never take the tick down */
                    } finally {
                        bot._gazeArmed = false;
                    }
                } else {
                    const isbaby = target.metadata && target.metadata[16];
                    const height = isbaby ? target.height / 2 : target.height;
                    bot.lookAt(target.position.offset(0, height, 0));
                }
            }

            if (!target && !rconTarget)
                this.last_entity = null;

            if (Date.now() > this.next_change) {
                // ── NO PER-WINDOW COIN FLIP FOR A PERSON ──────────────────
                // This used to be: staring = Math.random() < (personNear ? 0.8 :
                // 0.3), with next_change reset to now + 2-12s.
                //
                // That roll was the actual reason she never looked at players,
                // and it was fighting the hold set on target acquisition: the
                // 1.5-3.5s gaze was overwritten within a tick or two, and then a
                // fresh coin toss decided whether to look at all. It also
                // overwrote next_change, so the look-back gap was erased before it
                // could act. Measured: staring=false on every tick despite a target
                // being acquired and gaze_started correctly true.
                //
                // The roll is also the yandere shape - a probabilistic lock-on. A
                // player does not re-decide every few seconds whether to keep
                // looking at someone; they glance, look away, look back. The CYCLE
                // is the behaviour, so for a person the cycle is deterministic and
                // the randomness moves to its LENGTHS (below), where it belongs.
                //
                // Mobs keep the roll: watching a creeper is genuinely optional, so
                // it stays a choice rather than a commitment.
                // A MOB IS ALSO WORTH A LOOK. The owner: "that goes for mobs btw,
                // maybe she sees a mob around so she looks at it". So the mob
                // branch is no longer a 30% coin flip with a 2-12s window - it runs
                // the same glance/away/look-back cycle, just shorter. The 30% roll
                // is kept only as the reason to look at all, which is the one
                // genuinely optional decision when nothing needs watching.
                const personNear = isPlayer || !!rconTarget;
                if (personNear) {
                    this.staring = true;
                    // The gaze is being ACTED ON now, so it has run. This is the
                    // only place gaze_started becomes true, which is what makes the
                    // gap mean "looked, now looking away" rather than "about to
                    // look".
                    this.gaze_started = true;
                    // A glance, not a lock-on: 1.5-3.5s on, 2.5-7s looking
                    // elsewhere, then look back. Same shapes as acquisition, so
                    // there is exactly one definition of the cycle.
                    this.next_change = Date.now() + 1500 + Math.random() * 2000;
                    this.next_look_back = this.next_change + 2500 + Math.random() * 4500;
                } else if (nearestMob) {
                    // A mob nearby: she looks at it, on the same cycle as a person
                    // but shorter (1-2.5s, then 2-6s elsewhere). Same shape, less
                    // patience - which is what watching something that might come
                    // at you actually looks like.
                    this.staring = true;
                    this.gaze_started = true;
                    this.next_change = Date.now() + 1000 + Math.random() * 1500;
                    this.next_look_back = this.next_change + 2000 + Math.random() * 4000;
                } else {
                    // Nothing to look at. Gaze ends, and the next acquisition
                    // starts a fresh cycle.
                    this.staring = false;
                    this.gaze_started = false;
                    this.next_change = Date.now() + Math.random() * 10000 + 2000;
                }
                if (!this.staring) {
                    // 26.3: glance-away goes through the same throttled lookAt
                    // path (see physics.js) — safe with players near.
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
                    bot.look(yaw, pitch, false);
                }
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
        // Was: "Spam crouch, hop, and dart around energetically when idle so she
        // feels alive." The crouch spam is gone - the owner: "shes crouching a
        // lot". Hops and darts stay, because a player does fidget.
        description: 'Hop and shift about a little when idle, so she does not stand frozen.',
        interrupts: [],
        on: true,
        active: false,
        hop_until: 0,
        next_hop: Date.now() + 8000, // 26.3 restore: hops back, gated — jump
        // is a local physics input (no teleport), proven clean in walk-death
        // windows. First hop no earlier than 8s idle so spawn-settle drains.
        spam_until: 0,
        next_spam: Date.now() + 4000,
        next_toggle: 0,
        sneaking: false,
        dash_until: 0,
        next_dash: Date.now() + 99999999, // 26.3: sprint-dash STAYS off —
        // sprint+forward at walk-gate speeds is the d1.0-1.4 shape; re-test
        // only after walk + hop prove a full cycle clean.
        twirl_until: 0,
        twirl_next_snap: 0,
        twirl_base_yaw: 0,
        next_twirl: Date.now() + 15000, // 26.3 restore: twirl back — pure
        // look packets, already gated by physics.js look-hold + shouldSendLook.
        update: function (agent) {
            const bot = agent.bot;
            const recently_hurt = Date.now() - bot.lastDamageTime < 4000;
            // ── WITH SOMEONE, NOT MERELY IDLE ─────────────────────────────
            // The owner: "if she's interacting with a player spam crouch and
            // observer what players do, look at them, spam jump".
            //
            // A player bounces around the person they are talking to, and stands
            // still when they are not. Hopping at an empty room is the twitch that
            // got this mode switched on in the first place - measured 15 mode
            // firings per 10 minutes with nobody present. So the hop needs a
            // person: nearby AND engaged, not merely online.
            if (!recently_hurt) {
                const _near = (() => {
                    try {
                        const me = bot.entity;
                        if (!me?.position) return false;
                        return Object.values(bot.entities || {}).some((e) =>
                            e?.type === 'player' && e.username !== agent.name && e.position
                            && e.position.distanceTo(me.position) <= 12);
                    } catch (_) { return false; }
                })();
                if (!_near) {
                    // nobody about: settle every physical state and stand still
                    bot.setControlState('jump', false);
                    bot.setControlState('sneak', false);
                    return;
                }
            }
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

            // 1) NO crouch spam. The owner: "shes crouching a lot".
            //
            // This was not a leak or a desync - it was a feature. The mode is
            // described in this file as "Spam crouch, hop, and dart around
            // energetically when idle", it defaults to on, and it toggled sneak
            // every 180-400ms inside a window that opened every 5-12s whenever a
            // player came within 12 blocks. The old comment said to "spam freely,
            // cutely, kick-free" - which is precisely why it reads as a tic to the
            // person watching. Nobody crouches several times a second beside
            // another person; that is a bot fidget, not a player.
            //
            // The corpus cannot settle this directly - it is text only, and
            // crouch/fidget/hop/idle appear 0 times in 21,822 lines. So this is a
            // judgement call against an explicit report rather than a
            // measurement. What the corpus does say supports quiet at rest: 9.52%
            // of real lines are a bare acknowledgement and 35.3% are three words
            // or fewer.
            //
            // Hops stay - a player does fidget. Her real idle behaviour is
            // activity.js picking up work, which is what she should be doing.
            bot.setControlState('sneak', false);
            this.sneaking = false;

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
        interrupts: [],
        on: true,
        active: false,
        // Cooldowns are read lazily in update(), not here: modes_list is a
        // module-level const built at import time, which happens BEFORE
        // standalone.js calls setSettings() - so settings is still {} at this
        // point and touching it here crashed the bot on boot.
        cooldown: 180000, // min ms between bed follow-ups
        last_follow: 0,
        update: async function (agent) {
            // NOTE: normal persona keeps this ACTION. She still follows people
            // to bed and still sleeps beside them - that is a capability, and
            // both personas must have identical capabilities. Only the framing
            // changes: the possessive openers and the beloved-always rate below.
            // An earlier version returned early here, which wrongly removed
            // the ability entirely from normal.
            const yandere = isYandere();
            const bot = agent.bot;
            const now = Date.now();
            if (now - agent._sleeper_time > 30000) return; // nobody recently went to bed
            if (!agent.isIdle()) return; // work-respect: never pull her off a dig/fight for bed
            // Config is read HERE, not where this object is defined: modes_list is
            // built at import time, before setSettings() injects the config, so
            // settings.* is undefined at definition time. Reading it in update()
            // is both correct and what makes the cooldown configurable live.
            const cfgCd = settings.mode_cooldowns?.sleep_together;
            if (typeof cfgCd === 'number') this.cooldown = cfgCd;
            if (now - this.last_follow < this.cooldown) return;
            const name = agent._last_sleeper;
            if (!name) return;
            this.last_follow = now;

            // Her beloved is always joined in yandere (she cannot bear to be
            // apart). In normal there is no beloved and nobody is a special
            // case, so everyone gets the same ordinary rate - still a real
            // chance, never a guarantee.
            const beloved = (agent.prompter.profile.beloved || '');
            const isBeloved = yandere && name === beloved;
            const roll = Math.random();
            const chance = isBeloved ? 0.85 : (yandere ? 0.35 : 0.40);
            if (!isBeloved && roll > chance) return;
            // reset so we don't re-trigger for the same sleep event
            agent._sleeper_time = 0;

            execute(this, agent, async () => {
                if (roll < chance - 0.25) { // sometimes open with a line first
                    const lines = yandere ? [
                        `${name}~ sleeping without me? How cruel~ ♥ let me join you...`,
                        `eh? you're going to bed? w-wait for me~ UwU wants cuddles... ♥`,
                        `hehe~ night night ${name}~ I'll keep you warm... ♥`,
                    ] : [
                        `${name} heading to bed? I'll come too, don't wait up.`,
                        `wait up, I'm coming to bed too~`,
                        `night ${name}, I'm crashing beside you in a sec.`,
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
        interrupts: [],
        on: true,
        active: false,
        cooldown: 60000,
        last_try: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (!bot.time || bot.time.timeOfDay < 12541 || bot.time.timeOfDay > 23458) return; // night only — the old check (< 12541 return) treated DAWN+DAY as night, so every solo morning fired the bed hunt at 60s cadence, interrupting real actions
            if (!agent.isIdle()) return; // work-respect: bed hunt never interrupts work
            for (const name of Object.keys(bot.players || {}))
                if (name !== agent.name) return; // someone online — don't skip their night
            if (bot.isSleeping) return;
            const now = Date.now();
            const cd = settings.mode_cooldowns?.sleep_alone;
            if (typeof cd === 'number') this.cooldown = cd;
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
        name: 'seek_company',
        description: 'When idle with no company in sight, walk to the nearest visible player and hang around them — courtship needs contact.',
        interrupts: [],
        on: true,
        active: false,
        last_seek: 0,
        cooldown: 120000, // min 2 min between seeks
        update: async function (agent) {
            const bot = agent.bot;
            if (!agent.isIdle() || bot.pathfinder.goal) return;
            const now = Date.now();
            const cd = settings.mode_cooldowns?.seek_company;
            if (typeof cd === 'number') this.cooldown = cd;
            if (now - this.last_seek < this.cooldown) return;
            // someone already close — nothing to do (stare/chat take it).
            // 26.3 RCON-truth: entity scans miss players the server withholds
            // (verified 3 blocks apart, still invisible), so check the
            // server's coordinates too before concluding nobody is close.
            const near = world.getNearbyPlayers(bot, 16).find((e) => e.username !== agent.name && e.username !== bot.username);
            if (near) return;
            try {
                const { rconPlayerPos } = await import('../utils/rcon.js');
                const names = Object.keys(bot.players || {})
                    .filter(n => n && n !== agent.name && n !== bot.username
                        && !/^(rcon|server|console)$/i.test(n));
                for (const n of names.slice(0, 4)) {
                    const pos = await rconPlayerPos(n).catch(() => null);
                    if (!pos || !bot.entity?.position) continue;
                    if (Math.hypot(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z) < 16) return;
                }
            } catch (_) {}
            // nearest player entity anywhere visible (up to 64) — walk to them.
            // DECAY-TRUTH (verified 18:24): bot does NOT see YandereDev's entity
            // at 11 blocks on 26.3 — entities arrive only when the server sends
            // them (render-distance/antixray/batch timing), so idle+camera-only
            // stretches are normal. But the BRAIN knows the tablist ($STATS
            // lists server players even when entities aren't rendered), so fall
            // back to TABLIST proximity when no entity is visible: if a real
            // player is on the server and not close, ask the brain to go find
            // them (brain has goToPlayer + memory of last positions) instead of
            // waiting on an entity that may never render.
            let best = null, bestD = 64;
            try {
                for (const ent of Object.values(bot.entities || {})) {
                    if (ent?.type !== 'player' || !ent.username || ent.username === agent.name) continue;
                    if (!ent.position || !bot.entity?.position) continue;
                    const d = ent.position.distanceTo(bot.entity.position);
                    if (d < bestD) { bestD = d; best = ent; }
                }
            } catch (e) {}
            if (best && bestD >= 16) {
                this.last_seek = now;
                const target = best;
                execute(this, agent, async () => {
                    await skills.followPlayer(bot, target.username, 4);
                });
                return;
            }
            if (best && bestD < 16) return; // someone close — stare/chat take it
            // No visible entity: check the server tablist for a real player.
            // (bot.players includes stale entries, so only names that have a
            // uuid / actually logged in count — never Rcon/Server/console.)
            let tablisted = null;
            try {
                for (const [pname, p] of Object.entries(bot.players || {})) {
                    if (!pname || pname === agent.name || pname === bot.username) continue;
                    if (/^(rcon|server|console)$/i.test(pname)) continue;
                    if (!p || (!p.uuid && !p.entity)) continue;
                    tablisted = pname;
                    break;
                }
            } catch (e) {}
            if (!tablisted) return;
            this.last_seek = now;
            const who = tablisted;
            // ── NORMAL PERSONA: PATHFIND SILENTLY ──────────────────────────
            // Going to find someone is a MOVEMENT, not a line of chat. The
            // old version spoke an "(AUTO) You feel clingy ... sweet,
            // possessive" prompt into her own brain on every seek tick. That
            // text is yandere, it was never gated on isYandere(), and because
            // the seek runs on a timer with nobody having said anything, it
            // replayed every 45s: her live log filled with "where's
            // YandereDev? I need you right now" aimed at nobody, and the
            // (AUTO) turns were then written back into memory, so the yandere
            // voice re-poisoned the persona after the profile had been
            // corrected. A prompt cannot fix a poison that is fed back in as
            // history - that loop is what had to be cut.
            if (!isYandere()) {
                execute(this, agent, async () => {
                    await skills.goToPlayer(bot, who, 4);
                });
                return;
            }
            execute(this, agent, async () => {
                // Brain-side: tablist says they're on, entity isn't rendered —
                // go find them via memory/known positions, then hang around.
                agent.handleMessage('system', `(AUTO) You feel clingy. ${who} is on the server but you can't see them right now — go find them (!goToPlayer(\"${who}\", 4) or head to where you last saw them) and stay near them. Sweet, possessive, in character.`);
            });
        }
    },
    {
        name: 'conversation_starter',
        // Normal persona does NOT use this to fill silence. A human who is
        // playing does not narrate their own mood to nobody ("you feel chatty")
        // every 90 seconds - that is the framework talking through the bot. In
        // normal mode she only speaks when she has a real reason: someone
        // spoke to her, or something happened that is actually worth saying.
        // See conversation_starter gate below for the normal branch.
        description: 'Occasionally start a conversation with a nearby player and ask personal/getting-to-know-you questions, in character.',
        interrupts: [],
        on: true,
        active: false,
        last_start: 0,
        cooldown_min: 90000,  // 90s — she was silent for hours with players 20 blocks away; talk first, courtship needs contact
        cooldown_max: 240000,  // up to 4 min
        // Normal persona: far lazier. A real player opens their mouth when
        // something happens, not on a timer. Yandere keeps the courtship
        // cadence (she is built to seek you out); normal gets a long, jittered
        // window so she reads as someone who happens to talk when there's a
        // reason, not a bot on a schedule.
        cooldown_min_normal: 240000,   // 4 min floor
        cooldown_max_normal: 900000,   // up to 15 min
        next_start: 0,
        update: async function (agent) {
            const bot = agent.bot;
            const now = Date.now();

            // ── IS SHE ACTUALLY AT THE COMPUTER? ──────────────────────────
            // Runs before the next_start check, so it keeps ticking while she
            // is away - that is the only way she can come back on time. A
            // person is not continuously available; a bot is, and that absence
            // of absence is one of the loudest tells there is.
            if (!isYandere()) {
                const { LifeState } = await import('../utils/life_state.js');
                if (!agent._life) agent._life = new LifeState();
                const { Tilt } = await import('../utils/tilt.js');
                if (!agent._tilt) agent._tilt = new Tilt();
                // Anger cools whether or not anyone is watching. Without the
                // decay one death would sour the whole evening, which is not how
                // being angry works.
                agent._tiltLevel = agent._tilt.tick();

                // Back? Say so, and make it consistent with why she left.
                const back = agent._life.checkReturn();
                if (back) {
                    console.log(`${agent.name} [life] back from ${back.id}` +
                        `${back.said ? ` (had said "${back.said}")` : ' (said nothing)'}`);
                    if (back.back) {
                        agent.history.add('system',
                            `You just came back from ${back.id}. You ${back.said ? `said "${back.said}" ` : 'left without saying anything, '}and now you are back. If the conversation continues, do not ignore that gap - you were away.`);
                    }
                }
                // Gone? Announce it if the absence is the kind people announce.
                if (!agent._life.isAway) {
                    const go = agent._life.shouldLeave();
                    if (go.leave) {
                        const a = agent._life.leave();
                        if (a?.said) {
                            agent.history.add('system',
                                `You said "${a.said}" and stepped away from the computer (${a.id}). You are not at the keyboard now.`);
                            console.log(`${agent.name} [life] left: ${a.id} - "${a.said}" for ~${Math.round((a.until - now) / 60000)}min`);
                        } else {
                            console.log(`${agent.name} [life] slipped away: ${a?.id} (silent)`);
                        }
                    }
                }
                // While away she has nothing to say. Checked on every tick.
                if (agent._life.isAway) {
                    this.next_start = now + 20000 + Math.random() * 25000;
                    return;
                }
            }

            if (now < this.next_start) return; // schedule-based: only fire after a random wait

            // ── NORMAL PERSONA GATE ──────────────────────────────────────
            // Nobody feels chatty by default. In normal mode this mode must
            // have a REAL trigger or it does nothing:
            //   1. someone spoke to her recently, or
            //   2. something just happened that is worth reporting
            //      (damage, a death, finishing/losing something).
            // Without this she fires on a 90s timer and narrates her mood into
            // public chat - "You feel chatty" is the agent's state leaking
            // into the transcript, and it is the single most bot-like sentence
            // the stack can produce.
            const normal = !isYandere();
            if (normal) {
                const recentlySpokeTo = (() => {
                    try {
                        const h = agent.history && agent.history.getHistory ? agent.history.getHistory() : [];
                        const real = h.filter((m) => m && m.role === 'user'
                            && !/^\(AUTO/.test(String(m.content || '').trim()));
                        const last = real[real.length - 1];
                        return last ? (Date.now() - (last.__at || Date.now()) < 10 * 60 * 1000) : false;
                    } catch (_) { return false; }
                })();
                const eventWorthSaying = (agent._lastNotableEvent && Date.now() - agent._lastNotableEvent.at < 3 * 60 * 1000);
                const addressedByName = (() => {
                    try {
                        const h = agent.history && agent.history.getHistory ? agent.history.getHistory() : [];
                        const real = h.filter((m) => m && m.role === 'user'
                            && !/^\(AUTO/.test(String(m.content || '').trim()));
                        const last = real[real.length - 1];
                        return !!(last && new RegExp(`\\b${agent.name}\\b`, 'i').test(String(last.content || '')));
                    } catch (_) { return false; }
                })();
                if (!recentlySpokeTo && !eventWorthSaying && !addressedByName) {
                    // No reason to speak. Stay quiet and try again later.
                    this.next_start = now + this.cooldown_min_normal
                        + Math.random() * (this.cooldown_max_normal - this.cooldown_min_normal);
                    return;
                }
                // INITIATIVE. The owner: "she can start a conversation, no
                // forced". So starting one is allowed - but it is a probability
                // per eligible turn, never a timer. The old 45s gear produced
                // the "(AUTO) You feel clingy" loop, which is a different failure
                // wearing the same clothes. Rates: chattier alone with one person
                // than in a group, never mid-exchange, never right after speaking.
                if (!addressedByName && !recentlySpokeTo) {
                    try {
                        const { shouldStartConversation } = await import('../utils/reply_trigger.js');
                        const _go = shouldStartConversation({
                            visible_humans: agent._visibleHumanCount ? agent._visibleHumanCount() : 0,
                            human_exchange: !!(agent.self_prompter
                                && agent.self_prompter.humanExchangeInProgress()),
                        });
                        if (!_go.start) {
                            this.next_start = now + 30000 + Math.random() * 60000;
                            return;
                        }
                        console.log(`${agent.name} [initiative:${_go.why}] starting a conversation`);
                    } catch (e) {
                        // fail open to the pre-existing trigger rules
                    }
                }

                // ROOM AWARENESS. Being one of 2-3 people means she is not the
                // host of the room, and two humans talking to each other are not
                // her conversation to join mid-thread. She defers and lets them
                // finish. The exemption is being addressed BY NAME: a direct
                // question outranks etiquette, and real people answer those even
                // mid-argument - deferring there would be the bigger tell.
                let humansTalking = false;
                try {
                    humansTalking = !!(agent.self_prompter
                        && agent.self_prompter.humanExchangeInProgress());
                } catch (_) { humansTalking = false; }
                if (humansTalking && !addressedByName) {
                    this.next_start = now + 20000 + Math.random() * 25000;
                    return;
                }
            }
            // WORK-RESPECT (2026-09-27: this mode interrupted !collectBlocks
            // mid-dig — "click one block and leave" — because interrupts:['all']
            // fires whenever she stands near the requester. Chatting never
            // outranks working: only speak when idle.
            if (!agent.isIdle()) { this.next_start = now + 30000; return; }
            // need someone near-ish to talk to — 16 blocks (stare/conversation
            // range), NOT 12: at 12 she stays mute to anyone across a room.
            // 26.3 RCON-truth: entities are withheld at range, so an
            // entity-only scan says "nobody near" while the player stands 3
            // blocks away. RCON position (1.2s cache) is ground truth.
            const players = world.getNearbyPlayers(bot, 16);
            let player = players.find((e) => e.username !== agent.name && e.username !== bot.username);
            if (!player) {
                try {
                    const names = Object.keys(bot.players || {})
                        .filter(n => n && n !== agent.name && n !== bot.username
                            && !/^(rcon|server|console)$/i.test(n));
                    const { rconPlayerPos } = await import('../utils/rcon.js');
                    let best = null, bestD = 17;
                    for (const n of names.slice(0, 4)) {
                        const pos = await rconPlayerPos(n).catch(() => null);
                        if (!pos || !bot.entity?.position) continue;
                        const d = Math.hypot(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z);
                        if (d < bestD) { bestD = d; best = { username: n }; }
                    }
                    if (best) player = best;
                } catch (_) {}
            }
            if (!player) { this.next_start = now + 60000; return; } // nobody near, check again in a bit
            this.next_start = now + this.cooldown_min + Math.random() * (this.cooldown_max - this.cooldown_min);

            const name = player.username || player.name;
            execute(this, agent, async () => {
                // Normal persona: a real player opens with something about the
                // moment or what she is doing, not a getting-to-know-you
                // interview. "what are you building" lands; "tell me about your
                // dreams" reads as a dating sim NPC. Stay grounded in the
                // actual scene so the line is about something real.
                const prompts = isYandere() ? [
                    `Ask ${name} a personal, getting-to-know-you question in character (hobbies, favourite things, dreams, love life). Be curious and flirty, as a yandere who wants to know everything about someone she likes.`,
                    `Strike up conversation with ${name} — sweet, nosy, a little possessive. Ask something about them that shows you've been paying attention.`,
                    `Tease ${name} playfully and ask how their day is. Keep it cute and in character.`,
                ] : [
                    `Say something to ${name} about what you are both doing right now - what you are building, where you are, what just happened. Keep it to one short line, in character. Never open with a greeting and never ask how they are. If nothing specific is going on, stay quiet instead of forcing it.`,
                    `Ask ${name} a casual one-liner about whatever they are working on. Not an interview, not personal questions - just what they're up to. One short line.`,
                    `${name} is nearby. If you have something genuinely worth saying to them right now, say it in one short line, and make it about what is actually going on. Otherwise stay quiet - real players do not talk just to talk, and if all you have is "hi, how are you" then say nothing.`,
                ];
                const p = prompts[Math.floor(Math.random() * prompts.length)];
                // Reaching here in normal mode means the gate above already
                // found a REAL trigger - someone spoke recently, or something
                // worth reporting happened. So the self-prompt is earned, not
                // ambient, and persisting it as history is correct.
                //
                // (An earlier version gated this with a bare persona early
                // return. That was redundant — the gate above already handles
                // it — and persona_parity.test.mjs correctly rejected it: a
                // bare return disables the mode for normal, and both personas
                // must keep every capability. The stale "(AUTO) You feel
                // chatty" turn found in memory.json predates that gate, not
                // because of it. Note the wording: an earlier revision of this
                // comment spelled that guard out literally, and the parity test
                // then matched its own documentation and failed.)
                // Wording matters as much as the gate. "You feel chatty" is
                // yandere state-leak - it narrates an inner mood, which the
                // normal persona explicitly forbids ("the agent's state leaking
                // into public chat"). In normal mode the trigger is a real
                // conversational opening, so say that instead. The yandere
                // branch keeps the original phrasing.
                agent.handleMessage('system', isYandere()
                    ? `(AUTO) You feel chatty. ${p}`
                    : `(AUTO) Someone just spoke to you or something happened worth reporting. Reply to it in one short line. ${p}`);
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

    /** The mode object itself, for callers that need its state (and for tests). */
    get(mode_name) {
        return modes_map[mode_name] || null;
    }

    setOn(mode_name, on) {
        // survival server: the cheat mode can never be armed (op=false).
        if (mode_name === 'cheat' && on && !canOp()) return;
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
            // Retired modes (blocked by the reliability tracker) must never auto-fire.
            // Blacklisting only stops the !mode:X *command*; this gate stops the
            // automatic update() path that bypasses the command map entirely.
            if (_agent.reliability?.isRetired('!mode:' + mode.name)) continue;
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
    // survival server (op=false in servers.json): the cheat mode can never
    // run OP commands, so pin it off no matter what the profile says.
    if (modes_json && !canOp() && modes_json.cheat !== undefined) modes_json.cheat = false;
    // Per-server mode overrides (servers.json "modes"): applied after the
    // profile so one context can quiet e.g. hunting without touching home.
    try {
        const ov = (typeof modeOverrides === 'function') ? modeOverrides() : {};
        if (modes_json && ov) for (const k of Object.keys(ov)) modes_json[k] = ov[k];
    } catch (_) {}
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
    if (!canOp()) agent.bot.modes.setOn('cheat', false);
}
