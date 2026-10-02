import { readFileSync, writeFileSync, existsSync } from 'fs';

// Automatic curriculum (Voyager-style): proposes the NEXT self-directed goal
// based on the current world state + recently completed/failed goals, and
// persists that history so she never loops the same goal forever. This is what
// replaces the 4 hardcoded self-prompt goals in uwu.json.
//
// The LLM decides WHAT to do; the existing self_prompter loop + coder execute it.

// The entity nouns a goal can be unexecutable about. Deliberately mobs and
// animals only: "the rest of that oak" is a block and "the crafting table" is
// furniture, and neither can be checked against bot.entities, so a goal naming
// one must be left strictly alone. A false rewrite is worse than the original
// bug, because it replaces a real task with a vague one.
const MOB_NOUN = /^(?:pig|cow|chicken|sheep|wolf|fox|bee|deer|rabbit|horse|llama|zombie|skeleton|creeper|spider|enderman|phantom|squid|cod|salmon|tropical|puffer|bat|ocelot|stray|cat|dog|villager|glowsquid|drowned|husk|zombified|pillager|ravager|goat|axolotl|panda|mob)$/;

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

    // ── A GOAL THAT NAMES AN ABSENT TARGET IS UNEXECUTABLE ──────────────
    // This is what stood her still, and it is not a timeout and not a cadence
    // problem. Live, 06:2x-06:3x, twenty-five minutes of it:
    //
    //   [curriculum] proposed next goal: "gather food from the nearby pig"
    //   received message from system: You are self-prompting with the goal:
    //     'gather food from the nearby pig'. Your next response MUST contain a
    //     command with this syntax: !commandName.
    //   ... six consecutive turns, identical goal ...
    //   Current Action: Idle
    //
    // The self-prompt demands a command every turn, so the model dutifully
    // produced !kill pig, !attack pig, !hunt pig, !kick pig - forty-three
    // !kicks in fifteen minutes - against an animal that was not there. Every
    // one a no-op or an error. She is not idle by choice: she is handed the
    // same impossible goal on a 4-22s gear and given nothing that can succeed.
    //
    // The curriculum proposes goals from a PROMPT (promptCurriculum) and never
    // checks them against the world, so the model is free to invent "the
    // nearby pig" out of nothing - which it did, repeatedly, and the
    // similarity guard could not catch it because each variant was a different
    // animal. So the check belongs here, at the one place a goal enters the
    // system, and it is a WORLD FACT not a phrase table: is the entity the
    // goal names actually present right now?
    //
    // Rejection is by REWRITE, not refusal. A null here would leave the caller
    // holding the dead goal, which is the exact state that produced the bug.
    _entityIsNearby(name) {
        const bot = this.agent && this.agent.bot;
        if (!bot || !bot.entities) return null;   // unknown: do not reject
        const want = String(name).toLowerCase();
        let best = Infinity;
        const p = bot.entity && bot.entity.position;
        for (const e of Object.values(bot.entities)) {
            const n = String((e && (e.name || e.displayName)) || '').toLowerCase();
            if (!n || !(n === want || n.includes(want) || want.includes(n))) continue;
            const ep = e.position;
            if (!ep || !p) return 0;
            const d = Math.hypot(ep.x - p.x, ep.y - p.y, ep.z - p.z);
            if (d < best) best = d;
        }
        if (best === Infinity) return -1;         // definitively not present
        return best;
    }

    // "the nearby pig" / "that oak" / "a chicken" - pull the target noun out so
    // it can be checked against the world. Returns null when the goal names no
    // specific target, which is most goals and is perfectly fine: "mine
    // cobblestone for tools" has nothing to be absent.
    _goalTarget(goal) {
        const t = String(goal || '').toLowerCase();
        // Requires an EXPLICIT positional or demonstrative word. My first two
        // attempts made the whole determiner chain optional, and a chain that
        // can match empty matches the first word of the sentence - so
        // "gather food from the nearby pig" returned "gather", the mob check
        // rejected it, and the guard did nothing on the exact live goal.
        // Twice. The lesson: an optional prefix plus a capture is a capture of
        // nothing.
        const POSITIONAL = /\b(?:(?:the|a|an|some)\s+)*(?:nearby|nearest|close|adjacent|next|that|those)\s+(?:(?:the|a|an|some)\s+)*([a-z]+)/;
        let m = t.match(POSITIONAL);
        if (m) return MOB_NOUN.test(m[1]) ? m[1] : null;
        // "gather food from a pig" has no positional word at all. Only accept a
        // BARE determiner+noun when the determiner is immediately followed by a
        // known mob, so "build a small house" and "chop the rest of that oak"
        // are untouched.
        m = t.match(/\b(?:(?:the|a|an)\s+)([a-z]+)/);
        if (m && MOB_NOUN.test(m[1])) return m[1];
        return null;
    }

    // Rewrite an unexecutable goal into one that is possible from where she
    // stands, WITHOUT another model call - the LLM round trip is the slow part
    // and the substitution is unambiguous. Returns the original when there is
    // nothing to check.
    makeExecutable(goal) {
        const target = this._goalTarget(goal);
        if (!target) return goal;
        const d = this._entityIsNearby(target);
        if (d === null || d >= 0) return goal;    // unknown, or actually here
        console.warn(`[curriculum] goal names an absent target: "${goal}" `
            + `(${target} is not present) - rewriting`);
        // Strip the whole determiner+noun phrase, not just the determiner. My
        // first version removed "the nearby" and left "gather food pig" - a
        // dangling noun that is worse than the original, because it reads as a
        // command to do something to a pig that is not there.
        const fixed = String(goal)
            .replace(new RegExp(`\\b(?:(?:the|a|an|some)\\s+)*(?:nearby|nearest|close|adjacent|next|that|those)\\s+(?:(?:the|a|an|some)\\s+)*${target}\\b`, 'i'), '')
            .replace(new RegExp(`\\b(?:the|a|an)\\s+${target}\\b`, 'i'), '')
            .replace(/\b(?:from|to|near|around|at|of|with)\s*$/i, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/[\s,.;:!?]+$/, '')
            .trim();
        return fixed.length >= 3 ? fixed : 'look around for something to do';
    }

    // Ask the LLM to propose the next self-directed goal. Returns a short goal
    // string or null. Non-fatal: a failure leaves the caller's current goal intact.
    async proposeNextGoal() {
        const prompter = this.agent.prompter;
        if (!prompter || typeof prompter.promptCurriculum !== 'function') return null;
        try {
            const goal = await prompter.promptCurriculum(this.recentHistoryText());
            if (!goal) return null;
            // Checked HERE, at the single point a goal enters the system, so
            // every consumer gets an executable one. Not in the prompt: the
            // model cannot see the world in a way that reliably stops it
            // inventing a nearby animal, and it kept doing so across six
            // separate goals in a row.
            const ok = this.makeExecutable(goal);
            if (ok !== goal) console.log(`[curriculum] executable goal: "${ok}"`);
            else console.log(`[curriculum] proposed next goal: "${ok}"`);
            return ok;
        } catch (e) {
            console.warn('proposeNextGoal failed (non-fatal):', e.message);
            return null;
        }
    }
}
