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
        // Autonomous self-prompt cadence (only runs while other players are online).
        // 7000ms made her yap a new kawaii line + command every ~7s = annoying.
        // 30000ms = ~4x calmer; 45000ms = ~6x calmer (user still reports spam).
        // NOTE: player chat (esp. the beloved) interrupts & responds immediately —
        // this only throttles her UNSOLICITED self-chatter, not her responsiveness.
        // Building autonomy: 3 min keeps her creative without constant construction spam.
        this.cooldown = 180000;

        // Autonomous goal lifecycle (Voyager-style critic + curriculum): counts
        // self-prompt turns since the current goal was set, and how many times
        // the critic has judged it unfinished in a row.
        this.goal_cycles = 0;
        this.stuck_cycles = 0;
        this.advancing = false; // reentry guard for the critic+curriculum calls
    }

    _otherPlayersOnline() {
        const bot = this.agent.bot;
        if (!bot || !bot.players) return false;
        for (const name of Object.keys(bot.players)) {
            if (name !== this.agent.name) return true;
        }
        return false;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.goal_cycles = 0;
        this.stuck_cycles = 0;
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
        while (!this.interrupt) {
            // Resource guard: with no other players online the bot idles instead of
            // self-prompting. Stops the runaway OpenRouter API burn + block/chunk spam
            // that pushes the MC JVM heap into swap on this low-RAM box.
            if (settings.self_prompt_requires_players && !this._otherPlayersOnline()) {
                await new Promise(r => setTimeout(r, this.cooldown));
                continue;
            }
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
                    await new Promise(r => setTimeout(r, this.cooldown * 2));
                    continue;
                }
            }
            else {
                no_command_count = 0;
            }
            // Autonomous goal advancement: periodically verify the current goal
            // and propose a fresh one (critic + curriculum). Throttled so the
            // extra LLM calls don't burn API $ on this low-RAM box.
            if (settings.curriculum_enabled !== false && settings.critic_enabled !== false) {
                this.goal_cycles++;
                if (this.goal_cycles >= (settings.goal_check_cycles || 5)) {
                    this.goal_cycles = 0;
                    try {
                        const r = await this.advanceGoal();
                        if (r && r.done && r.next) console.log(`[curriculum] advanced to new goal: "${r.next}"`);
                        else if (r && r.done && !r.next) console.log('[curriculum] goal finished, but no next goal proposed.');
                    } catch (e) {
                        console.warn('periodic goal advance failed (non-fatal):', e.message);
                    }
                }
            }
            // always pause between self-prompt turns — even a chat-only
            // response must not re-fire instantly (it races the in-flight
            // generation and discards it).
            await new Promise(r => setTimeout(r, this.cooldown));
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
            // incomplete — keep working, but don't stay stuck forever
            this.stuck_cycles++;
            if (this.stuck_cycles >= (settings.goal_stuck_limit || 3)) {
                agent.curriculum.recordFailure(this.prompt, verdict.critique || 'stuck');
                const next = await agent.curriculum.proposeNextGoal();
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
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
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