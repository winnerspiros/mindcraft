import fs from 'fs';
import path from 'path';

// MINI-PLANNER (2026-10-14): deterministic goal -> skill-chain decomposition.
//
// The self-prompter asks the LLM for ONE command per turn with no memory of
// what the chain is for. This module replaces that guess with a real plan:
// an ordered list of !command steps with a verifiable check after each one.
// The LLM is only consulted when the plan is BLOCKED (missing material,
// failed step 3x) — not for every step.
//
// A plan is: { goal, steps: [{cmd, check}], idx, fails }
// Persisted to bots/<name>/plan.json so a restart resumes mid-chain.

const CHAINS = [
    {
        id: 'wooden_tools',
        match: /axe|pickaxe|wooden tool|stone tool|upgrade.*tool/i,
        build: (inv) => {
            const steps = [];
            const logs = (inv.logs || 0);
            const planks = (inv.planks || 0);
            const cobble = (inv.cobblestone || 0);
            const hasPick = inv.hasPick, hasAxe = inv.hasAxe;
            if (!hasAxe && !hasPick) {
                if (logs + Math.floor(planks / 4) < 3)
                    steps.push({ cmd: '!collectBlocks oak_log 5', check: 'logs>=3' });
                steps.push({ cmd: '!craftRecipe oak_planks 2', check: 'planks' });
                steps.push({ cmd: '!craftRecipe stick 2', check: 'sticks' });
                steps.push({ cmd: '!craftRecipe crafting_table 1', check: 'table' });
                if (!hasAxe) steps.push({ cmd: '!craftRecipe wooden_axe 1', check: 'axe' });
                if (!hasPick) steps.push({ cmd: '!craftRecipe wooden_pickaxe 1', check: 'pick' });
                // stone upgrade in the same chain — no second plan needed
                steps.push({ cmd: '!collectBlocks cobblestone 11', check: 'cobble>=3' });
                steps.push({ cmd: '!craftRecipe stone_pickaxe 1', check: 'stone_pick' });
                steps.push({ cmd: '!craftRecipe stone_axe 1', check: 'stone_axe' });
            } else if (hasPick && cobble < 3) {
                steps.push({ cmd: '!collectBlocks cobblestone 11', check: 'cobble>=3' });
                steps.push({ cmd: '!craftRecipe stone_pickaxe 1', check: 'stone_pick' });
            }
            return steps;
        }
    },
    {
        id: 'torches',
        match: /torch|light/i,
        build: (inv) => {
            const steps = [];
            if ((inv.torches || 0) >= 8) return steps;
            if ((inv.coal || 0) < 1 && (inv.charcoal || 0) < 1) {
                if (!inv.hasPick) {
                    if ((inv.logs || 0) < 3)
                        steps.push({ cmd: '!collectBlocks oak_log 3', check: 'logs' });
                    steps.push({ cmd: '!craftRecipe oak_planks 1', check: 'planks' });
                    steps.push({ cmd: '!craftRecipe wooden_pickaxe 1', check: 'pick' });
                }
                steps.push({ cmd: '!collectBlocks coal_ore 3', check: 'coal' });
            }
            if ((inv.sticks || 0) < 1) {
                if ((inv.logs || 0) < 1 && (inv.planks || 0) < 2)
                    steps.push({ cmd: '!collectBlocks oak_log 2', check: 'logs' });
                if ((inv.planks || 0) < 2)
                    steps.push({ cmd: '!craftRecipe oak_planks 1', check: 'planks' });
                steps.push({ cmd: '!craftRecipe stick 1', check: 'sticks' });
            }
            steps.push({ cmd: '!craftRecipe torch 2', check: 'torches' });
            steps.push({ cmd: '!lightUp 8', check: 'lit' });
            return steps;
        }
    },
    {
        id: 'shelter',
        match: /shelter|house|home|base/i,
        build: (inv) => {
            const steps = [];
            if (!inv.hasPick && (inv.logs || 0) < 3)
                steps.push({ cmd: '!collectBlocks oak_log 5', check: 'logs>=3' });
            steps.push({ cmd: '!findSite', check: 'sited' });
            steps.push({ cmd: '!levelGround', check: 'leveled' });
            steps.push({ cmd: '!buildShelter', check: 'sheltered' });
            steps.push({ cmd: '!craftRecipe torch 1', check: 'torches' });
            return steps;
        }
    },
    {
        id: 'food',
        match: /food|eat|hungry|starv|heal/i,
        build: () => [{ cmd: '!getFood', check: 'food' }],
    },
];

function readInv(bot) {
    const inv = { logs: 0, planks: 0, sticks: 0, torches: 0, coal: 0, charcoal: 0, cobblestone: 0 };
    try {
        for (const i of (bot?.inventory?.items() || [])) {
            const n = i.name, c = i.count;
            if (n.endsWith('_log')) inv.logs += c;
            else if (n.endsWith('_planks')) inv.planks += c;
            else if (n === 'stick') inv.sticks += c;
            else if (n === 'torch') inv.torches += c;
            else if (n === 'coal') inv.coal += c;
            else if (n === 'charcoal') inv.charcoal += c;
            else if (n === 'cobblestone') inv.cobblestone += c;
            else if (n.endsWith('_pickaxe')) { inv.hasPick = true; if (/stone|iron|diamond/.test(n)) inv.hasStonePick = true; }
            else if (n.endsWith('_axe')) { inv.hasAxe = true; }
        }
    } catch (_) {}
    return inv;
}

export class Planner {
    constructor(agent) {
        this.agent = agent;
        this.plan = null;
        this.file = null;
        try {
            this.file = path.join(process.cwd(), 'bots', agent.name, 'plan.json');
            if (fs.existsSync(this.file)) {
                const p = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (p && p.steps && p.idx < p.steps.length) {
                    this.plan = p;
                    console.log(`[planner] resumed plan "${p.goal}" at step ${p.idx + 1}/${p.steps.length}`);
                }
            }
        } catch (_) {}
    }

    save() {
        if (!this.file) return;
        try {
            if (this.plan) fs.writeFileSync(this.file, JSON.stringify(this.plan));
            else if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
        } catch (_) {}
    }

    // Try to decompose a goal into a step chain. Returns true if planned.
    tryPlan(goal) {
        const bot = this.agent?.bot;
        const inv = readInv(bot);
        for (const chain of CHAINS) {
            if (!chain.match.test(goal || '')) continue;
            const steps = chain.build(inv);
            if (!steps.length) return false; // already satisfied
            this.plan = { goal, chain: chain.id, steps, idx: 0, fails: 0 };
            this.save();
            console.log(`[planner] planned "${goal}" -> ${steps.length} steps (${chain.id}): ${steps.map(s => s.cmd).join(' → ')}`);
            return true;
        }
        return false;
    }

    hasPlan() { return !!(this.plan && this.plan.idx < this.plan.steps.length); }

    current() { return this.hasPlan() ? this.plan.steps[this.plan.idx] : null; }

    // Execute the current step via the real command pipeline (action gating
    // applies). Returns true if a step ran.
    async runNext() {
        const step = this.current();
        if (!step) return false;
        console.log(`[planner] step ${this.plan.idx + 1}/${this.plan.steps.length}: ${step.cmd} (for "${this.plan.goal}")`);
        try {
            const mod = await import('./commands/index.js');
            const r = await mod.executeCommand(this.agent, step.cmd);
            void r;
        } catch (e) {
            console.warn(`[planner] step failed to dispatch: ${e.message}`);
            return this.noteFail();
        }
        return true;
    }

    // Called after the step's action settles. Verify via inventory, advance
    // or count a failure. 3 failures on one step = plan blocked, drop it and
    // let the LLM replan from the new state.
    noteSettled() {
        const step = this.current();
        if (!step) return;
        const ok = this.verify(step.check);
        if (ok) {
            this.plan.idx++;
            this.plan.fails = 0;
            console.log(`[planner] step verified (${step.check}), ${this.plan.idx}/${this.plan.steps.length} done`);
            if (!this.hasPlan()) {
                console.log(`[planner] plan complete: "${this.plan.goal}"`);
                try { this.agent?.curriculum?.recordComplete(this.plan.goal); } catch (_) {}
                this.plan = null;
            }
        } else {
            this.plan.fails++;
            console.warn(`[planner] step unverified (${step.check}), fail ${this.plan.fails}/3`);
            if (this.plan.fails >= 3) {
                console.warn(`[planner] plan blocked at "${step.cmd}", dropping — LLM replans`);
                try { this.agent?.curriculum?.recordFailure(this.plan.goal, `blocked at ${step.cmd}`); } catch (_) {}
                this.plan = null;
            }
        }
        this.save();
    }

    noteFail() {
        if (!this.plan) return false;
        this.plan.fails++;
        if (this.plan.fails >= 3) {
            console.warn(`[planner] plan blocked, dropping`);
            this.plan = null;
        }
        this.save();
        return true;
    }

    clear() { this.plan = null; this.save(); }

    verify(check) {
        const inv = readInv(this.agent?.bot);
        const [k, want] = String(check).split('>=');
        switch (k) {
            case 'logs': return inv.logs >= (want ? +want : 1);
            case 'planks': return inv.planks >= 1;
            case 'sticks': return inv.sticks >= 1;
            case 'table': return true; // placed in world; dispatch success = done
            case 'axe': return !!inv.hasAxe;
            case 'pick': return !!inv.hasPick;
            case 'stone_pick': return !!inv.hasStonePick;
            case 'stone_axe': return inv.cobblestone < 3 || true; // best-effort
            case 'cobble': return inv.cobblestone >= (want ? +want : 1);
            case 'coal': return (inv.coal + inv.charcoal) >= 1;
            case 'torches': return inv.torches >= 1;
            case 'food': return true; // !getFood reports its own result
            case 'lit': case 'sited': case 'leveled': case 'sheltered': return true;
            default: return true;
        }
    }
}
