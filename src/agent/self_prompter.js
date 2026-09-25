import settings from './settings.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        // Autonomous self-prompt cadence. 180s was set to calm API burn, but it
        // left her catatonic when alone (3 lines in 6 min). Two gears now:
        // players online -> chatty 45s; alone -> quiet 150s pottering. Both
        // still gated per-turn below (see loop guard) so she acts, never spams.
        this.cooldown_chatty = 45000;
        this.cooldown_solo = 150000;

        // Autonomous goal lifecycle (Voyager-style critic + curriculum): counts
        // self-prompt turns since the current goal was set, and how many times
        // the critic has judged it unfinished in a row.
        this.goal_cycles = 0;
        this.stuck_cycles = 0;
        this.advancing = false; // reentry guard for the critic+curriculum calls
    }

    _otherPlayersOnline() {
        // 26.3: bot.players includes HERSELF — the old check (any key != her
        // name) was true even when alone, because the tablist carries stale
        // entries (Rcon, past visitors). That pinned the CHATTY 45s gear
        // forever, so she burned a turn every ~45s digging the same hole
        // instead of idling (no stare/hop/twirl window, no follow, no chat).
        // Real check: someone else VISIBLE — an entity within 16 blocks
        // (matches stare/conversation range, so CHATTY means she can actually
        // see you). Beyond that she's effectively alone: SOLO gear, long
        // idle windows between turns for hop/twirl/stare instead of burning
        // a turn every 45s at someone 27 blocks away she can't even see.
        const bot = this.agent.bot;
        if (!bot || !bot.players || !bot.entities) return false;
        try {
            for (const ent of Object.values(bot.entities)) {
                if (ent?.type === 'player' && ent.username && ent.username !== this.agent.name
                    && ent.position && bot.entity?.position
                    && ent.position.distanceTo(bot.entity.position) < 16) return true;
            }
        } catch (e) {}
        return false;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        // NEW GOAL: reset the rotation counters. SAME goal (loop restart
        // after a mode fire / chat / seek): KEEP counting — the critic must
        // judge it on schedule, not get its fuse reset every interruption
        // (that bug held one stuck goal all day: restarts zeroed goal_cycles
        // before it ever reached goal_check_cycles).
        const sameGoal = prompt === this.prompt && this.goal_cycles > 0;
        this.state = ACTIVE;
        this.prompt = prompt;
        if (!sameGoal) {
            this.goal_cycles = 0;
            this.stuck_cycles = 0;
        }
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        // WALL-CLOCK critic (added 20:0x): the old per-turn counter never
        // reached goal_check_cycles because mode fires / chats / seeks stop +
        // restart the loop constantly (zero [curriculum] lines in 2h). Time
        // since the last critic verdict is restart-proof and interruption-
        // proof — rotation happens on schedule no matter how choppy the loop.
        const CRITIC_MIN_MS = 8 * 60 * 1000; // judge at most every 8 min
        if (!this._lastCriticRun) this._lastCriticRun = 0;
        const maybeCritic = async () => {
            if (settings.curriculum_enabled === false || settings.critic_enabled === false) return;
            if (this.advancing) return;
            const now = Date.now();
            if (now - this._lastCriticRun < CRITIC_MIN_MS) return;
            this._lastCriticRun = now;
            try {
                const r = await this.advanceGoal();
                if (r && r.done && r.next) console.log(`[curriculum] advanced to new goal: "${r.next}"`);
                else if (r && r.done && !r.next) console.log('[curriculum] goal finished, but no next goal proposed.');
            } catch (e) {
                console.warn('wall-clock goal advance failed (non-fatal):', e.message);
            }
        };
        while (!this.interrupt) {
            // Two gears: players online -> chatty 45s turns; alone -> quiet
            // 150s pottering (she was catatonic with the old 180s + require-
            // players gate). Solo turns still MUST use a command (below), so
            // alone she digs/builds/explores instead of yapping.
            const solo = !this._otherPlayersOnline();
            const gear = solo ? this.cooldown_solo : this.cooldown_chatty;
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    // Don't permanently kill self-prompting over a few flaky turns —
                    // the old path set state=STOPPED + broke, which left her silent and
                    // wound the agent down to cleanKill/exit. Pause longer instead and
                    // keep state ACTIVE so update() can keep her running.
                    console.warn(`Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Pausing self-prompting briefly.`);
                    no_command_count = 0;
                    await new Promise(r => setTimeout(r, gear * 2));
                    continue;
                }
            }
            else {
                no_command_count = 0;
            }
            // Wall-clock critic (see above): per-turn counter kept as a
            // backstop, but rotation no longer depends on it.
            if (settings.curriculum_enabled !== false && settings.critic_enabled !== false) {
                this.goal_cycles++;
                if (this.goal_cycles >= (settings.goal_check_cycles || 5)) {
                    this.goal_cycles = 0;
                    this._lastCriticRun = Date.now(); // per-turn path ran it — reset the wall clock too
                    try {
                        const r = await this.advanceGoal();
                        if (r && r.done && r.next) console.log(`[curriculum] advanced to new goal: "${r.next}"`);
                        else if (r && r.done && !r.next) console.log('[curriculum] goal finished, but no next goal proposed.');
                    } catch (e) {
                        console.warn('periodic goal advance failed (non-fatal):', e.message);
                    }
                } else {
                    await maybeCritic();
                }
            }
            // always pause between self-prompt turns — even a chat-only
            // response must not re-fire instantly (it races the in-flight
            // generation and discards it).
            await new Promise(r => setTimeout(r, gear));
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    // Verify the current goal with the critic, then advance to the next goal via
    // the curriculum when it's done/impossible (or stuck too long). Returns an
    // info object, or null if it couldn't run. Non-fatal: never throws.
    async advanceGoal() {
        const agent = this.agent;
        if (!this.prompt) return null;
        if (!agent.prompter || !agent.curriculum) return null;
        if (this.advancing) return null;
        this.advancing = true;
        try {
            const verdict = await agent.prompter.promptCritic(this.prompt);
            const v = verdict && verdict.verdict ? verdict.verdict : 'incomplete';
            if (v === 'complete') {
                agent.curriculum.recordComplete(this.prompt);
                const next = await agent.curriculum.proposeNextGoal();
                this.goal_cycles = 0;
                this.stuck_cycles = 0;
                if (next) this.prompt = next;
                return { done: true, next, verdict: v };
            }
            if (v === 'impossible') {
                agent.curriculum.recordFailure(this.prompt, verdict.critique || 'impossible');
                const next = await agent.curriculum.proposeNextGoal();
                this.goal_cycles = 0;
                this.stuck_cycles = 0;
                if (next) this.prompt = next;
                return { done: true, next, verdict: v };
            }
            // incomplete — keep working, but don't stay stuck forever.
            // SIMILARITY GUARD (added 21:2x): the curriculum kept proposing
            // near-identical goals ("...treasures!" vs "...treasures again!"),
            // which the history check treats as novel — infinite forest loop.
            // Reject proposals too similar to the current goal and force a
            // DIFFERENT activity (wood/build/gift/visit) instead.
            // FAMILY DEDUP (added 05:5x): bouquet -> flower crown passed the
            // word check (different words, same activity). Families catch what
            // word overlap can't: same activity family = same goal.
            const _family = (s) => {
                const t = String(s).toLowerCase();
                if (/flower|bouquet|crown|daisy|tulip|poppy|peony|blossom|petal/.test(t)) return 'flowers';
                if (/log|wood|plank|stick|tree|oak|birch|spruce/.test(t)) return 'wood';
                if (/build|shelter|house|tower|wall|foundation|room/.test(t)) return 'build';
                if (/chicken|feather|cow|pig|sheep|hunt|meat|leather|egg/.test(t)) return 'hunt';
                if (/mine|ore|diamond|iron|gold|stone|cobble|dig/.test(t)) return 'mine';
                if (/gift|present|give|trader|present/.test(t)) return 'gift';
                if (/beloved|yanderedev|visit|find .*player|stay close|follow/.test(t)) return 'visit';
                if (/treasure|explore|forest|adventure|wander/.test(t)) return 'explore';
                if (/farm|wheat|carrot|potato|berry|crop|harvest/.test(t)) return 'farm';
                if (/craft|furnace|smelt|arrow|bow|tool/.test(t)) return 'craft';
                return 'other';
            };
            const _sim = (a, b) => {
                if (_family(a) !== 'other' && _family(a) === _family(b)) return 1;
                const wa = new Set(String(a).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3));
                const wb = new Set(String(b).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3));
                if (!wa.size || !wb.size) return 0;
                let inter = 0;
                for (const w of wa) if (wb.has(w)) inter++;
                return inter / Math.max(wa.size, wb.size);
            };
            const _freshGoal = async (oldPrompt) => {
                for (let tries = 0; tries < 2; tries++) {
                    const next = await agent.curriculum.proposeNextGoal();
                    if (next && _sim(next, oldPrompt) < 0.6) return next;
                    console.log(`[curriculum] rejected too-similar goal: "${next}" — retrying`);
                }
                // fallback: force a concrete different activity, no LLM needed.
                // Family-aware: skip families already in recent history.
                const fallbacks = ['gather oak logs for building', 'collect flowers as a gift for YandereDev', 'find YandereDev and stay close', 'craft planks and build a small shelter', 'mine cobblestone for tools', 'hunt chickens for feathers and food'];
                const hist = (agent.curriculum.recentHistoryText() || '').toLowerCase();
                const oldFam = _family(oldPrompt);
                return fallbacks.find(f => _family(f) !== oldFam && !hist.includes(f.split(' ')[1])) || fallbacks.find(f => _family(f) !== oldFam) || fallbacks[0];
            };
            this.stuck_cycles++;
            if (this.stuck_cycles >= (settings.goal_stuck_limit || 3)) {
                agent.curriculum.recordFailure(this.prompt, verdict.critique || 'stuck');
                const old = this.prompt;
                const next = await _freshGoal(old);
                this.goal_cycles = 0;
                this.stuck_cycles = 0;
                if (next) this.prompt = next;
                return { done: true, next, verdict: v };
            }
            return { done: false, critique: verdict && verdict.critique, verdict: v };
        } catch (e) {
            console.warn('advanceGoal failed (non-fatal):', e.message);
            return null;
        } finally {
            this.advancing = false;
        }
    }

    update(delta) {
        // automatically restarts loop — same two gears as the loop itself.
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            const gear = this._otherPlayersOnline() ? this.cooldown_chatty : this.cooldown_solo;
            if (this.idle_time >= gear) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}