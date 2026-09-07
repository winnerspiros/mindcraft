import { readFileSync, writeFileSync, existsSync } from 'fs';

// Automatic curriculum (Voyager-style): proposes the NEXT self-directed goal
// based on the current world state + recently completed/failed goals, and
// persists that history so she never loops the same goal forever. This is what
// replaces the 4 hardcoded self-prompt goals in uwu.json.
//
// The LLM decides WHAT to do; the existing self_prompter loop + coder execute it.

export class Curriculum {
    constructor(agent) {
        this.agent = agent;
        this.fp = `./bots/${agent.name}/curriculum.json`;
        this.completed_tasks = [];   // [{ goal, when }]
        this.failed_tasks = [];      // [{ goal, reason, when }]
        this._load();
    }

    _load() {
        try {
            if (existsSync(this.fp)) {
                const d = JSON.parse(readFileSync(this.fp, 'utf8'));
                if (Array.isArray(d.completed_tasks)) this.completed_tasks = d.completed_tasks;
                if (Array.isArray(d.failed_tasks)) this.failed_tasks = d.failed_tasks;
            }
        } catch (e) {
            console.warn('Failed to load curriculum:', e.message);
        }
    }

    _save() {
        try {
            writeFileSync(this.fp, JSON.stringify({
                completed_tasks: this.completed_tasks.slice(-50),
                failed_tasks: this.failed_tasks.slice(-50),
            }, null, 2));
        } catch (e) {
            console.warn('Failed to save curriculum:', e.message);
        }
    }

    recordComplete(goal) {
        if (!goal) return;
        this.completed_tasks.push({ goal, when: Date.now() });
        this.failed_tasks = this.failed_tasks.filter(t => t.goal !== goal);
        this._save();
    }

    recordFailure(goal, reason) {
        if (!goal) return;
        // don't stack identical failures; keep only the most recent for a goal
        this.failed_tasks = this.failed_tasks.filter(t => t.goal !== goal);
        this.failed_tasks.push({ goal, reason: reason || '', when: Date.now() });
        this._save();
    }

    // Compact recent-history text for the curriculum prompt.
    recentHistoryText() {
        const c = this.completed_tasks.slice(-8).map(t => `completed: ${t.goal}`);
        const f = this.failed_tasks.slice(-8).map(t => `failed: ${t.goal}${t.reason ? ` (${t.reason})` : ''}`);
        const all = c.concat(f);
        return all.length ? all.join('\n') : '(nothing yet — this is the very start)';
    }

    // Ask the LLM to propose the next self-directed goal. Returns a short goal
    // string or null. Non-fatal: a failure leaves the caller's current goal intact.
    async proposeNextGoal() {
        const prompter = this.agent.prompter;
        if (!prompter || typeof prompter.promptCurriculum !== 'function') return null;
        try {
            const goal = await prompter.promptCurriculum(this.recentHistoryText());
            if (goal) console.log(`[curriculum] proposed next goal: "${goal}"`);
            return goal;
        } catch (e) {
            console.warn('proposeNextGoal failed (non-fatal):', e.message);
            return null;
        }
    }
}
