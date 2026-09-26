import * as mc from '../utils/mcdata.js';
import settings from './settings.js';

// Observes what nearby players (and mobs) are DOING — especially TO HER — and
// feeds concise context to the LLM so she can react in-character. Deliberately
// passive like ModerationWatcher: she decides what to do — the watcher only
// reports. Covers: mimicry (crouch/jump spam), mining/building, fighting,
// hunting, arm-swing gestures + pointing (who faces her, what block they aim
// at), semi-breaking (spam-hitting a block without finishing), break-and-replace,
// door/lever/button toggle spam, chest snooping, note-block/piston activity,
// item tosses, crowding/pushing, being boxed in, mobs swinging at / hurting her.
//
// Detection signals (all from mineflayer):
//   entityCrouch/entityUncrouch -> sneak-spam   entityMoved -> jump-spam + crowd
//   entitySwingArm              -> gestures, pointing, mob attacks on her
//   blockBreakProgressObserved/End -> semi-breaks, teasing hits
//   blockUpdate                 -> mining/building, toggles, break+replace
//   chestLidMove                -> someone opening a chest in her space
//   noteHeard / pistonMove      -> music machines / machinery near her
//   itemDrop / playerCollect    -> tosses, gifts, pickups
//   entitySleep                 -> someone sleeping nearby
//   entityHurt(entity, source)  -> fighting / hunting / HER being hit
export class PlayerActivityWatcher {
    constructor(agent) {
        this.agent = agent;
        this.enabled = settings.observe_players !== false;

        this.sneak = {};       // name -> { transitions, windowStart, lastCrouching }
        this.jumps = {};       // name -> { count, windowStart, wasRising, lastY, lastT }
        this.swings = {};      // name -> { count, windowStart } (arm-swing spam = attention grab)
        this.crowd = {};       // name -> { count, windowStart } (too close, too often = pushing)
        this.breakProg = {};   // "name|x,y,z" -> { maxStage, startT, sessions }
        this.recentBreak = {}; // "x,y,z" -> { name, time, player } (break-then-replace radar)
        this.toggles = {};     // "x,y,z" -> { count, windowStart, name } (door/lever spam)
        this.lastInject = {};  // "name|category" -> timestamp (per-player cooldown)

        this.MIMIC_RANGE = 7;      // blocks — close enough that it reads as "in front of her"
        this.ACTIVITY_RANGE = 12;  // blocks — awareness radius for mining/build/fight
        this.POINT_RANGE = 6;      // blocks — pointing-target raycast length

        this._bound = {};
    }

    start() {
        if (!this.enabled) return;
        const bot = this.agent.bot;
        this._bound.crouch = (e) => this._onCrouch(e, true);
        this._bound.uncrouch = (e) => this._onCrouch(e, false);
        this._bound.move = (e) => this._onMove(e);
        this._bound.swing = (e) => this._onSwing(e);
        this._bound.bpStart = (block, stage, e) => this._onBreakProgress(block, stage, e);
        this._bound.bpEnd = (block, e) => this._onBreakEnd(block, e);
        this._bound.block = (o, n) => this._onBlock(o, n);
        this._bound.chest = (block, count) => this._onChest(block, count);
        this._bound.note = (block) => this._onNote(block);
        this._bound.piston = (block) => this._onPiston(block);
        this._bound.drop = (e) => this._onDrop(e);
        this._bound.collect = (collector, collected) => this._onCollect(collector, collected);
        this._bound.sleep = (e) => this._onSleep(e);
        this._bound.hurt = (e, s) => this._onHurt(e, s);
        this._bound.left = (p) => this._onLeave(p);
        bot.on('entityCrouch', this._bound.crouch);
        bot.on('entityUncrouch', this._bound.uncrouch);
        bot.on('entityMoved', this._bound.move);
        bot.on('entitySwingArm', this._bound.swing);
        bot.on('blockBreakProgressObserved', this._bound.bpStart);
        bot.on('blockBreakProgressEnd', this._bound.bpEnd);
        bot.on('blockUpdate', this._bound.block);
        bot.on('chestLidMove', this._bound.chest);
        bot.on('noteHeard', this._bound.note);
        bot.on('pistonMove', this._bound.piston);
        bot.on('itemDrop', this._bound.drop);
        bot.on('playerCollect', this._bound.collect);
        bot.on('entitySleep', this._bound.sleep);
        bot.on('entityHurt', this._bound.hurt);
        bot.on('playerLeft', this._bound.left);
    }

    stop() {
        const bot = this.agent.bot;
        if (!bot) return;
        bot.off('entityCrouch', this._bound.crouch);
        bot.off('entityUncrouch', this._bound.uncrouch);
        bot.off('entityMoved', this._bound.move);
        bot.off('entitySwingArm', this._bound.swing);
        bot.off('blockBreakProgressObserved', this._bound.bpStart);
        bot.off('blockBreakProgressEnd', this._bound.bpEnd);
        bot.off('blockUpdate', this._bound.block);
        bot.off('chestLidMove', this._bound.chest);
        bot.off('noteHeard', this._bound.note);
        bot.off('pistonMove', this._bound.piston);
        bot.off('itemDrop', this._bound.drop);
        bot.off('playerCollect', this._bound.collect);
        bot.off('entitySleep', this._bound.sleep);
        bot.off('entityHurt', this._bound.hurt);
        bot.off('playerLeft', this._bound.left);
    }

    // --- helpers ---

    _playerName(entity) {
        const u = entity && entity.username;
        if (!u || u === this.agent.name) return null;
        return u;
    }

    _near(name, dist) {
        const e = this.agent.bot.players?.[name]?.entity;
        return !!(e && e.position && e.position.distanceTo(this.agent.bot.entity.position) <= dist);
    }

    _nearestPlayer(pos, dist) {
        const players = this.agent.bot.players || {};
        let best = null, bestD = dist;
        for (const name of Object.keys(players)) {
            if (name === this.agent.name) continue;
            const e = players[name] && players[name].entity;
            if (!e || !e.position) continue;
            const d = pos.distanceTo(e.position);
            if (d <= bestD) { bestD = d; best = players[name]; }
        }
        return best;
    }

    // per-player + per-category cooldown gate (neuro-sdk: occasional messages, not a stream)
    _ok(name, category, ms) {
        const key = `${name}|${category}`;
        const now = Date.now();
        if (now - (this.lastInject[key] || 0) < ms) return false;
        this.lastInject[key] = now;
        return true;
    }

    _isBeloved(name) { return this.agent.isBelovedName(name); }

    _inject(name, text, prompt) {
        if (prompt) {
            // time-sensitive / beloved -> actually nudge her to respond now
            this.agent.handleMessage('system', text, 2).catch(() => {});
        } else {
            // quiet awareness — she acts on it next natural turn
            this.agent.history.add('system', text).catch(() => {});
        }
    }

    // --- activity handlers ---

    _onCrouch(entity, crouching) {
        const name = this._playerName(entity);
        if (!name || !this._near(name, this.MIMIC_RANGE)) return;
        const now = Date.now();
        const s = this.sneak[name] || (this.sneak[name] = { transitions: 0, windowStart: now, lastCrouching: null });
        if (now - s.windowStart > 2500) { s.transitions = 0; s.windowStart = now; }
        if (s.lastCrouching !== null && s.lastCrouching !== crouching) {
            s.transitions++;
            if (s.transitions >= 4 && this._ok(name, 'sneak', 25000)) {
                s.transitions = 0;
                this._inject(name,
                    `${name} is crouching up and down repeatedly in front of you.`,
                    true);
            }
        }
        s.lastCrouching = crouching;
    }

    _onMove(entity) {
        const name = this._playerName(entity);
        if (!name) return;
        // crowding: same player ENTERING her 1.5-block bubble over and over =
        // pushing / body-blocking / trying to shove her somewhere. Edge-triggered
        // (counts entries, not every step inside) so standing next to her is fine
        // but bouncing in-out-in-out reads as shoving.
        const insideNow = this._near(name, 1.5);
        const wasInside = (this.crowd[name] && this.crowd[name].inside) || false;
        if (insideNow && !wasInside) {
            const now = Date.now();
            const c = this.crowd[name] || (this.crowd[name] = { count: 0, windowStart: now, inside: true });
            if (now - c.windowStart > 8000) { c.count = 0; c.windowStart = now; }
            c.count++;
            c.inside = true;
            if (c.count >= 4 && this._ok(name, 'crowd', 60000)) {
                c.count = 0;
                this._inject(name,
                    `${name} keeps pushing right up against you (crowding/pushing).`,
                    true);
            }
        } else if (this.crowd[name]) {
            this.crowd[name].inside = insideNow;
        }
        if (!this._near(name, this.MIMIC_RANGE)) return;
        const now = Date.now();
        const j = this.jumps[name] || (this.jumps[name] = { count: 0, windowStart: now, wasRising: false, lastY: entity.position.y, lastT: now });
        if (now - j.windowStart > 3000) { j.count = 0; j.windowStart = now; }
        const y = entity.position.y;
        const dt = now - j.lastT;
        const dy = y - j.lastY;
        if (dt > 0 && dt < 500 && dy > 0.25 && !j.wasRising) {
            j.count++;
            if (j.count >= 4 && this._ok(name, 'jump', 25000)) {
                j.count = 0;
                this._inject(name,
                    `${name} is jumping up and down repeatedly in front of you.`,
                    true);
            }
        }
        j.wasRising = dy > 0.1;
        j.lastY = y;
        j.lastT = now;
    }

    // --- arm swings: gestures, pointing, mob attacks ---

    // Where is this player looking / what block are they aiming at (short raycast
    // along their facing). Returns { text, block } like "at you" / "at oak_door".
    _aimTarget(entity) {
        const bot = this.agent.bot;
        const me = bot && bot.entity ? bot.entity.position : null;
        const p = entity && entity.position;
        if (!p) return { text: 'somewhere', block: null };
        // "at YOU": standing close AND head-yaw aimed at her (rough cone check).
        if (me && p.distanceTo(me) <= 4 && entity.yaw != null) {
            const want = Math.atan2(-(me.x - p.x), -(me.z - p.z));
            let d = Math.abs(((entity.yaw - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            if (d < 0.5) return { text: 'at YOU', block: null };
        }
        // "at a block": march along their look direction, first solid block wins.
        if (entity.yaw != null && entity.pitch != null) {
            try {
                const dir = { x: -Math.sin(entity.yaw) * Math.cos(entity.pitch), y: Math.sin(entity.pitch), z: -Math.cos(entity.yaw) * Math.cos(entity.pitch) };
                for (let d = 1; d <= this.POINT_RANGE; d++) {
                    const b = bot.blockAt(p.offset(dir.x * d, 1.4 + dir.y * d, dir.z * d));
                    if (b && b.name && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air')
                        return { text: `at ${b.name}`, block: b };
                }
            } catch (_) { /* headless / unloaded — fall through */ }
        }
        return { text: 'nearby', block: null };
    }

    _onSwing(entity) {
        if (!entity) return;
        // a MOB swinging = it is attacking something. If the target is her (or her
        // beloved next to her), that is urgent; otherwise it is just a fight nearby.
        if (!entity.username) {
            const me = this.agent.bot.entity;
            const victim = entity.target || entity.goal || null;
            const isMe = (victim && me && victim === me) || (me && entity.position.distanceTo(me.position) < 3);
            const who = this._playerName(victim) || (isMe ? 'you' : null);
            if (!who) return;
            if (this._ok(who === 'you' ? 'me' : who, 'mobattack', 20000))
                this._inject(who, `A ${entity.name} is attacking ${who === 'you' ? 'YOU' : who}!`, true);
            return;
        }
        const name = this._playerName(entity);
        if (!name || !this._near(name, this.ACTIVITY_RANGE)) return;
        const now = Date.now();
        const s = this.swings[name] || (this.swings[name] = { count: 0, windowStart: now });
        if (now - s.windowStart > 3000) { s.count = 0; s.windowStart = now; }
        s.count++;
        // 6+ swings in 3s = punching the air / spamming hits AT someone or something.
        // Report once with WHO/WHAT they face — that is the "pointing" read.
        if (s.count >= 6 && this._ok(name, 'swing', 30000)) {
            s.count = 0;
            const aim = this._aimTarget(entity);
            this._inject(name, `${name} is swinging their arm repeatedly, aimed ${aim.text}.`, true);
        }
    }

    // --- semi-breaking: spam-hitting a block without finishing ---

    _onBreakProgress(block, stage, entity) {
        const name = entity ? this._playerName(entity) : null;
        if (!name || !block || !block.position) return;
        if (!this._near(name, this.ACTIVITY_RANGE)) return;
        const key = `${name}|${block.position.x},${block.position.y},${block.position.z}`;
        const now = Date.now();
        const b = this.breakProg[key] || (this.breakProg[key] = { maxStage: -1, startT: now, sessions: 0, blockName: block.name });
        b.maxStage = Math.max(b.maxStage, stage);
        // a NEW session = they stopped and started again = teasing / fake-out.
        if (now - (b.lastT || 0) > 2500) { b.sessions++; b.startT = b.startT || now; }
        b.lastT = now;
        b.blockName = block.name;
        // 3+ separate hit-sessions on the same block without it breaking, or 8s of
        // continuous cracking = "semi-breaking": report WHOSE block-punching this is.
        if ((b.sessions >= 3 || now - b.startT > 8000) && this._ok(name, 'semibreak', 40000)) {
            this._inject(name, `${name} keeps hitting ${b.blockName} without breaking it (teasing / softening it up).`, true);
            delete this.breakProg[key];
        }
    }

    _onBreakEnd(block, entity) {
        // crack overlay vanished: either the block broke (handled by blockUpdate) or
        // they STOPPED mid-way — that stop is the semi-break signal when stages got high.
        const name = entity ? this._playerName(entity) : null;
        if (!name || !block || !block.position) return;
        const key = `${name}|${block.position.x},${block.position.y},${block.position.z}`;
        const b = this.breakProg[key];
        if (b && b.maxStage >= 5 && this._ok(name, 'semibreak', 40000)) {
            this._inject(name, `${name} was cracking ${b.blockName} hard then stopped (left it half-broken).`, true);
        }
        delete this.breakProg[key];
    }

    // --- chests, notes, pistons, drops, pickups, sleep ---

    _onChest(block, count) {
        if (!block || !block.position) return;
        if (count <= 0) return; // only care about OPENING, not closing
        const player = this._nearestPlayer(block.position, this.ACTIVITY_RANGE);
        if (!player) return;
        const name = player.username;
        if (this._ok(name, 'chest', 60000))
            this._inject(name, `${name} just opened a ${block.name} nearby (peeking inside?).`, this._isBeloved(name));
    }

    _onNote(block) {
        if (!block || !block.position) return;
        const player = this._nearestPlayer(block.position, 8);
        const name = player ? player.username : null;
        if (name && this._ok(name, 'note', 60000))
            this._inject(name, `${name} is playing a note block nearby.`, false);
    }

    _onPiston(block) {
        if (!block || !block.position) return;
        const player = this._nearestPlayer(block.position, this.ACTIVITY_RANGE);
        const name = player ? player.username : null;
        if (name && this._ok(name, 'piston', 60000))
            this._inject(name, `A piston moved near ${name} (machinery / a hidden door?).`, false);
    }

    _onDrop(entity) {
        const name = entity ? this._playerName(entity) : null;
        if (!name || !this._near(name, this.ACTIVITY_RANGE)) return;
        if (this._ok(name, 'drop', 60000))
            this._inject(name, `${name} just tossed an item on the ground${this._near(name, 4) ? ' right by you (a gift? or bait?)' : '.'}`, this._isBeloved(name));
    }

    _onCollect(collector, collected) {
        const name = collector ? this._playerName(collector) : null;
        if (!name || !this._near(name, this.ACTIVITY_RANGE)) return;
        if (this._ok(name, 'collect', 90000))
            this._inject(name, `${name} just picked up an item.`, false);
    }

    _onSleep(entity) {
        const name = entity ? this._playerName(entity) : null;
        if (!name || !this._near(name, this.ACTIVITY_RANGE)) return;
        if (this._ok(name, 'sleep', 120000))
            this._inject(name, `${name} just got into bed nearby.`, this._isBeloved(name));
    }

    _onBlock(oldBlock, newBlock) {
        if (!oldBlock || !newBlock) return;
        const isAir = (b) => !b.name || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
        const wasAir = isAir(oldBlock), nowAir = isAir(newBlock);
        // same-state flickers (door open/close, lever flips, bulb toggles) are NOT
        // place/break — they are TOGGLE spam. Count rapid toggles per position.
        if (wasAir === nowAir) {
            const pos = newBlock.position || oldBlock.position;
            if (!pos) return;
            const key = `${pos.x},${pos.y},${pos.z}`;
            const now = Date.now();
            const t = this.toggles[key] || (this.toggles[key] = { count: 0, windowStart: now, name: null });
            if (now - t.windowStart > 6000) { t.count = 0; t.windowStart = now; }
            t.count++;
            if (!t.name) {
                const p = this._nearestPlayer(pos, 5);
                t.name = p ? p.username : null;
            }
            // 5+ toggles in 6s = door-spam / lever-flicking AT her or around her.
            if (t.count >= 5 && t.name && this._ok(t.name, 'toggle', 45000)) {
                this._inject(t.name, `${t.name} keeps flipping ${newBlock.name} open and shut (spamming it).`, true);
                delete this.toggles[key];
            }
            return;
        }
        const pos = newBlock.position || oldBlock.position;
        const player = this._nearestPlayer(pos, 5);
        if (!player) return;
        const name = player.username;

        if (nowAir) { // broke a block = mining — also feeds the break+replace radar
            this.recentBreak[`${pos.x},${pos.y},${pos.z}`] = { name, time: Date.now(), was: oldBlock.name };
            if (this._ok(name, 'mining', 30000))
                this._inject(name,
                    `${name} is mining ${oldBlock.name} nearby.`,
                    this._isBeloved(name));
        } else if (wasAir) { // placed a block = building — or break+replace-back?
            const key = `${pos.x},${pos.y},${pos.z}`;
            const prev = this.recentBreak[key];
            if (prev && Date.now() - prev.time < 15000 && prev.name === name) {
                // broke it and put (something) back within 15s = rearranged, griefed
                // + restored, or testing her. Say which.
                delete this.recentBreak[key];
                if (this._ok(name, 'replace', 45000))
                    this._inject(name,
                        prev.was === newBlock.name
                            ? `${name} broke ${prev.was} then put it right back (testing you? covering tracks?).`
                            : `${name} broke ${prev.was} and replaced it with ${newBlock.name}.`,
                        true);
                return;
            }
            if (this._ok(name, 'building', 30000))
                this._inject(name,
                    `${name} is building with ${newBlock.name} nearby.`,
                    this._isBeloved(name));
            // boxing-in check: 4+ fresh solid blocks within 3m of her in 20s = a cage.
            if (this.agent.bot.entity && pos.distanceTo(this.agent.bot.entity.position) <= 3.5 && newBlock.name) {
                try {
                    const box = this.agent.bot.findBlocks({ matching: (b) => b && b.name && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air', maxDistance: 4, count: 30 }) || [];
                    const close = box.filter((p) => p.distanceTo(this.agent.bot.entity.position) <= 3.5);
                    if (close.length >= 8 && this._ok(name, 'trap', 60000))
                        this._inject(name, `${name} is boxing you in with blocks (you may be getting trapped)!`, true);
                } catch (_) { /* headless — skip */ }
            }
        }
    }

    _onHurt(entity, source) {
        if (!entity) return;
        // HER being hit — the urgent one. Report WHO did it, always nudge.
        if (entity.username === this.agent.name || entity === this.agent.bot.entity) {
            const attacker = source ? (this._playerName(source) || source.name) : 'something';
            if (this._ok('me', 'hit', 10000))
                this._inject('me', `${attacker} just hit YOU!`, true);
            return;
        }
        // a player got hurt — they might need food/help (she decides, mood + relationship)
        const victim = this._playerName(entity);
        if (victim && this._near(victim, this.ACTIVITY_RANGE)) {
            if (this._ok(victim, 'hurt', 30000))
                this._inject(victim, `${victim} just took damage.`, this._isBeloved(victim));
            return;
        }
        // a mob was hurt by a player — hunting (food) or fighting
        const name = this._playerName(source);
        if (!name || !this._near(name, this.ACTIVITY_RANGE)) return;
        if (mc.isHuntable(entity)) {
            if (this._ok(name, 'hunting', 30000))
                this._inject(name, `${name} is hunting a ${entity.name} for food.`, this._isBeloved(name));
        } else if (mc.isHostile(entity)) {
            if (this._ok(name, 'fighting', 30000))
                this._inject(name, `${name} is fighting a ${entity.name}.`, this._isBeloved(name));
        }
    }

    _onLeave(player) {
        const name = player && player.username;
        if (!name) return;
        delete this.sneak[name];
        delete this.jumps[name];
        delete this.swings[name];
        delete this.crowd[name];
        for (const k of Object.keys(this.breakProg)) if (k.startsWith(name + '|')) delete this.breakProg[k];
        for (const k of Object.keys(this.lastInject)) if (k.startsWith(name + '|')) delete this.lastInject[k];
    }
}
