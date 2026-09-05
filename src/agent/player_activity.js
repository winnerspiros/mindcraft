import * as mc from '../utils/mcdata.js';
import settings from './settings.js';

// Observes what nearby players are doing and feeds concise context to the LLM so
// she can mirror or assist in-character (mimic crouch/jump spam, help build/mine,
// back up fights, join hunts). Deliberately passive like ModerationWatcher: she
// decides what to do — the watcher only reports the activity.
//
// Detection signals (all from mineflayer):
//   entityCrouch/entityUncrouch -> sneak-spam   entityMoved -> jump-spam
//   blockUpdate                 -> mining/building (with the block type)
//   entityHurt(entity, source)  -> fighting (hostile) / hunting (passive animal)
export class PlayerActivityWatcher {
    constructor(agent) {
        this.agent = agent;
        this.enabled = settings.observe_players !== false;

        this.sneak = {};       // name -> { transitions, windowStart, lastCrouching }
        this.jumps = {};       // name -> { count, windowStart, wasRising, lastY, lastT }
        this.lastInject = {};  // "name|category" -> timestamp (per-player cooldown)

        this.MIMIC_RANGE = 7;      // blocks — close enough that it reads as "in front of her"
        this.ACTIVITY_RANGE = 12;  // blocks — awareness radius for mining/build/fight

        this._bound = {};
    }

    start() {
        if (!this.enabled) return;
        const bot = this.agent.bot;
        this._bound.crouch = (e) => this._onCrouch(e, true);
        this._bound.uncrouch = (e) => this._onCrouch(e, false);
        this._bound.move = (e) => this._onMove(e);
        this._bound.block = (o, n) => this._onBlock(o, n);
        this._bound.hurt = (e, s) => this._onHurt(e, s);
        this._bound.left = (p) => this._onLeave(p);
        bot.on('entityCrouch', this._bound.crouch);
        bot.on('entityUncrouch', this._bound.uncrouch);
        bot.on('entityMoved', this._bound.move);
        bot.on('blockUpdate', this._bound.block);
        bot.on('entityHurt', this._bound.hurt);
        bot.on('playerLeft', this._bound.left);
    }

    stop() {
        const bot = this.agent.bot;
        if (!bot) return;
        bot.off('entityCrouch', this._bound.crouch);
        bot.off('entityUncrouch', this._bound.uncrouch);
        bot.off('entityMoved', this._bound.move);
        bot.off('blockUpdate', this._bound.block);
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
        if (!name || !this._near(name, this.MIMIC_RANGE)) return;
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

    _onBlock(oldBlock, newBlock) {
        if (!oldBlock || !newBlock) return;
        const isAir = (b) => !b.name || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
        const wasAir = isAir(oldBlock), nowAir = isAir(newBlock);
        if (wasAir === nowAir) return; // only care about place/break transitions
        const pos = newBlock.position || oldBlock.position;
        const player = this._nearestPlayer(pos, 5);
        if (!player) return;
        const name = player.username;

        if (nowAir) { // broke a block = mining
            if (this._ok(name, 'mining', 30000))
                this._inject(name,
                    `${name} is mining ${oldBlock.name} nearby.`,
                    this._isBeloved(name));
        } else {       // placed a block = building
            if (this._ok(name, 'building', 30000))
                this._inject(name,
                    `${name} is building with ${newBlock.name} nearby.`,
                    this._isBeloved(name));
        }
    }

    _onHurt(entity, source) {
        if (!entity) return;
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
        for (const k of Object.keys(this.lastInject)) if (k.startsWith(name + '|')) delete this.lastInject[k];
    }
}
