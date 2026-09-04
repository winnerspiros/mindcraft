// Reliability tracker — records per-action outcomes and retires (blocks) actions
// that chronically fail or crash the process.
//
// This maps directly to the 911MB OOM problem: chunk-load searches
// (!searchForBlock, !searchForEntity, !collectBlocks) can OOM the box. A hard OOM
// is a kernel SIGKILL, so we can't catch it in-process. Instead we write a
// crash marker to disk (fsync'd) before each action runs and, on next boot,
// attribute any orphaned marker to the action that was running when we died.
//
// Two retirement paths, matching the swarm project's reliability.ts idea:
//   crash-based  — >= CRASH_RETIRE process deaths attributed to an action => block it.
//   rate-based   — >= RETIRE_MIN_ATTEMPTS attempts with < RETIRE_RATE success => block it.
//
// Meta-actions like !newAction are exempt from rate retirement (code quality
// varies with the LLM) but NOT from crash retirement (generated code that OOMs
// the box must still be gated).

import { writeFileSync, readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, mkdirSync } from 'fs';
import { blacklistCommands } from './commands/index.js';

const RETIRE_MIN_ATTEMPTS = 8;   // rate-based: need this many attempts before retiring
const RETIRE_RATE = 0.1;         // retire when success rate drops below this
const CRASH_RETIRE = 2;          // retire immediately after this many process-deaths
const NEVER_RATE_RETIRE = new Set(['!newAction']);

export class ReliabilityTracker {
    constructor(agent) {
        this.agent = agent;
        this.dir = `./bots/${agent.name}`;
        this.statsFp = `${this.dir}/reliability.json`;
        this.inFlightFp = `${this.dir}/in-flight.json`;
        mkdirSync(this.dir, { recursive: true });
        this.stats = this._load();
        // Clear the in-flight marker on any CLEAN process exit (restart, stop,
        // normal return). SIGKILL/OOM does not fire 'exit', so an orphaned marker
        // on next boot correctly signals a hard crash. unlinkSync is synchronous,
        // which is required inside an 'exit' handler.
        process.on('exit', () => this.clearInFlight());
        this._recoverCrash();
    }

    _load() {
        try {
            if (existsSync(this.statsFp)) {
                return JSON.parse(readFileSync(this.statsFp, 'utf8'));
            }
        } catch (e) {
            console.error('[reliability] failed to load stats:', e.message);
        }
        return {};
    }

    _save() {
        try {
            writeFileSync(this.statsFp, JSON.stringify(this.stats, null, 2), 'utf8');
        } catch (e) {
            console.error('[reliability] failed to save stats:', e.message);
        }
    }

    // fsync so a hard SIGKILL/OOM can't lose the marker before it hits disk.
    markInFlight(actionName) {
        try {
            const fd = openSync(this.inFlightFp, 'w');
            writeSync(fd, JSON.stringify({ action: actionName, ts: Date.now() }));
            fsyncSync(fd);
            closeSync(fd);
        } catch (e) {
            console.error('[reliability] failed to write in-flight marker:', e.message);
        }
    }

    clearInFlight() {
        try {
            if (existsSync(this.inFlightFp)) unlinkSync(this.inFlightFp);
        } catch (e) {
            console.error('[reliability] failed to clear in-flight marker:', e.message);
        }
    }

    // ActionManager labels are 'action:goToPlayer' / 'action:newAction'; the
    // blocklist and prompt use the '!goToPlayer' form. Normalize to the latter.
    normalizeLabel(actionLabel) {
        if (!actionLabel) return null;
        const name = String(actionLabel).replace(/^action:/, '');
        return name ? '!' + name : null;
    }

    // On startup: an orphaned in-flight marker means the previous process died
    // mid-action (almost certainly OOM). Attribute a crash to that action.
    _recoverCrash() {
        try {
            if (!existsSync(this.inFlightFp)) return;
            const data = JSON.parse(readFileSync(this.inFlightFp, 'utf8'));
            if (data && data.action) {
                console.warn(`[reliability] recovered crash: previous process died while running ${data.action} (likely OOM)`);
                this.record(data.action, 'crash');
            }
            this.clearInFlight();
        } catch (e) {
            console.error('[reliability] failed to recover crash marker:', e.message);
        }
    }

    _get(actionName) {
        if (!this.stats[actionName]) {
            this.stats[actionName] = { attempts: 0, successes: 0, failures: 0, crashes: 0, retired: false };
        }
        return this.stats[actionName];
    }

    // outcome: 'success' | 'failure' | 'timeout' | 'crash'
    record(actionName, outcome) {
        if (!actionName) return;
        const s = this._get(actionName);
        s.attempts++;
        if (outcome === 'success') s.successes++;
        else if (outcome === 'crash') s.crashes++;
        else s.failures++; // 'failure' or 'timeout'

        this._maybeRetire(actionName, s);
        this._save();
    }

    _maybeRetire(actionName, s) {
        if (s.retired) return;
        let reason = null;

        if (s.crashes >= CRASH_RETIRE) {
            reason = `${s.crashes} process crashes (likely OOM)`;
        } else if (s.attempts >= RETIRE_MIN_ATTEMPTS && !NEVER_RATE_RETIRE.has(actionName)) {
            const rate = s.successes / s.attempts;
            if (rate < RETIRE_RATE) {
                reason = `success rate ${(rate * 100).toFixed(0)}% over ${s.attempts} attempts`;
            }
        }

        if (reason) {
            s.retired = true;
            console.warn(`[reliability] RETIRING action ${actionName}: ${reason}. Blocking it.`);
            this._block(actionName);
        }
    }

    _block(actionName) {
        if (!this.agent.blocked_actions.includes(actionName)) {
            this.agent.blocked_actions.push(actionName);
        }
        try {
            blacklistCommands([actionName]);
        } catch (e) {
            console.error('[reliability] failed to blacklist:', e.message);
        }
    }

    isRetired(actionName) {
        return !!this.stats[actionName]?.retired;
    }

    getRetiredActions() {
        return Object.keys(this.stats).filter(k => this.stats[k].retired);
    }

    // Re-block every retired action on a fresh boot (commandMap is rebuilt from
    // the action list each process, so runtime blacklisting doesn't persist).
    reapplyRetired() {
        const retired = this.getRetiredActions();
        if (retired.length === 0) return;
        console.warn(`[reliability] re-blocking retired actions: ${retired.join(', ')}`);
        for (const name of retired) {
            if (!this.agent.blocked_actions.includes(name)) {
                this.agent.blocked_actions.push(name);
            }
        }
        blacklistCommands(retired);
    }

    summary() {
        const lines = Object.entries(this.stats)
            .filter(([, s]) => s.attempts > 0)
            .map(([name, s]) => {
                const rate = s.attempts ? Math.round((s.successes / s.attempts) * 100) : 0;
                return `${name}: ${rate}% (${s.successes}/${s.attempts})` +
                    (s.crashes ? ` crashes:${s.crashes}` : '') +
                    (s.retired ? ' RETIRED' : '');
            });
        return lines.join('\n') || '(no actions recorded)';
    }
}
