import { readFileSync, existsSync } from 'fs';
import path from 'path';

// uwu's moderation + personal-memory watcher.
// Deliberately passive: it only *flags* suspicious movement as data for the AI to
// judge (she decides punish vs protect vs ignore — she plays favourites), and it
// loads her per-player dossier notes into context so every interaction is personal.
export class ModerationWatcher {
    constructor(agent) {
        this.agent = agent;
        this.lastPos = {};   // username -> {x,y,z,t}
        this.lastFlag = {};  // username -> timestamp
        this.cooldown = 30000; // ms between flags per player
        this.speedLimit = 25; // blocks/sec — above any legit movement
        this.timer = null;
    }

    _dossierFile() {
        return path.join(process.cwd(), 'bots', this.agent.name, 'players.json');
    }

    // Inject her existing player notes as context (no response turn triggered).
    loadDossiers() {
        const file = this._dossierFile();
        if (!existsSync(file)) return;
        let d;
        try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
        const entries = Object.entries(d);
        if (entries.length === 0) return;
        const list = entries.map(([n, notes]) => `${n}: ${notes}`).join('\n');
        this.agent.history.add('system',
            `Your private dossier on players you've met before (greet them personally; these are yours):\n${list}`);
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this._check(), 1000);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    _check() {
        const now = Date.now();
        for (const [name, player] of Object.entries(this.agent.bot.players || {})) {
            if (name === this.agent.name) continue;
            const pos = player?.entity?.position;
            if (!pos) continue;
            const prev = this.lastPos[name];
            this.lastPos[name] = { x: pos.x, y: pos.y, z: pos.z, t: now };
            if (!prev) continue;
            const dt = (now - prev.t) / 1000;
            if (dt <= 0) continue;
            const speed = Math.hypot(pos.x - prev.x, pos.z - prev.z) / dt;
            if (speed > this.speedLimit && now - (this.lastFlag[name] || 0) > this.cooldown) {
                this.lastFlag[name] = now;
                const msg = `[MODERATION] ${name} is moving impossibly fast (${speed.toFixed(0)} blocks/sec, beyond any legit speed). Decide: investigate, warn, !kick, or ignore if they're yours.`;
                this.agent.handleMessage('system', msg, 2).catch(() => {});
            }
        }
    }
}