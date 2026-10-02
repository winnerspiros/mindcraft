export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this._actionGen = 0;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    /**
     * Preempt the running action IMMEDIATELY, without waiting for it to finish.
     *
     * For life-or-death reflexes only (drowning, a Pillager at 3 blocks). The
     * normal stop() deliberately waits 700ms and then up to 10s for the action
     * to yield, because most actions are safe to let finish. That is fatal when
     * she is being shot: the reflex is queued behind a dig and she dies before
     * it runs.
     *
     * This releases the CONTROLS (movement, digging, pathfinding, pvp) and
     * raises interrupt_code, so whatever is running sees the flag and gives up
     * on its next check, and the new action takes over the body immediately. We
     * deliberately do NOT await the old action: waiting is the bug.
     */
    async _preempt() {
        const label = this.currentActionLabel || '(unknown)';
        try { this.agent.requestInterrupt(); } catch (_) {}
        // Best-effort control release. Any failure here must not prevent the
        // reflex from running - a dig that refuses to stop is still better than
        // standing in the open while we throw.
        try { this.agent.bot.stopDigging?.(); } catch (_) {}
        try { this.agent.bot.collectBlock?.cancelTask?.(); } catch (_) {}
        try { this.agent.bot.pathfinder?.stop?.(); } catch (_) {}
        try { this.agent.bot.pvp?.stop?.(); } catch (_) {}
        try { this.agent.bot.clearControlStates?.(); } catch (_) {}
        try { this.agent.bot.setControlState?.('forward', false); } catch (_) {}
        try { this.agent.bot.setControlState?.('back', false); } catch (_) {}
        try { this.agent.bot.setControlState?.('jump', false); } catch (_) {}
        console.log(`preempted running action "${label}" for a reflex - not waiting`);
    }

    async stop() {
        if (!this.executing) return;
        // 26.3: request the interrupt FIRST and give the action one beat to see
        // it — the old code armed the 10s suicide timer before the action ever
        // saw interrupt_code, so a follow loop sleeping in setTimeout(500) ate
        // the whole 10s and died (05:37 suicide in front of the user). Now the
        // timer only starts after the action had a chance to notice.
        // 2026-09-29: NEVER stopDigging from the manager. Digging-abort races
        // the diggingTask promise: the abort REJECTS it, the rejection escapes
        // the action body, and _executeAction's catch (or an un-awaited throw)
        // exits the process. The dig's own 25s race + STOPWAIT-UPDATE path
        // already ends every swing; an interrupt just sets the flag and lets
        // the race report failure. requestInterrupt() already skips the ABORT
        // for non-dig interrupters (swing-safe), so nothing is lost here.
        const savedStopDigging = this.agent.bot.stopDigging;
        try { this.agent.bot.stopDigging = () => {}; } catch (_) {}
        try {
        this.agent.requestInterrupt();
        await new Promise(resolve => setTimeout(resolve, 700));
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
        } finally {
            try { this.agent.bot.stopDigging = savedStopDigging; } catch (_) {}
        }
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        let relName = this.agent.reliability?.normalizeLabel(actionLabel);
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}`);
                // SAME-ACTION CHAIN (2026-09-27): re-issuing the running dig action
                // (collectBlocks->collectBlocks in the log) killed the swing via
                // stopDigging. Instead wait for it to finish, then run fresh.
                if (actionLabel === this.currentActionLabel) {
                    const t0 = Date.now();
                    while (this.executing && Date.now() - t0 < 15000) {
                        await new Promise(r => setTimeout(r, 300));
                    }
                    if (!this.executing) { this.agent.clearBotLogs(); }
                    else await this.stop();
                } else if (actionLabel.startsWith('mode:')) {
                    // DEATH-MODE PREEMPT (measured 2026-10-02). A Pillager
                    // killed her with exactly this log:
                    //   action "mode:self_preservation" trying to interrupt
                    //   current action "action:collectBlocks"
                    //   Agent died: UwU was shot by Pillager
                    // self_preservation is a DIFFERENT label from the running
                    // dig, so it fell through to the generic else -> stop(),
                    // which gives the action 700ms and then up to 10s of
                    // "waiting for code to finish". A Pillager kills her well
                    // inside 10s, so the reflex fired, was announced in the log,
                    // and she died still holding the pickaxe.
                    //
                    // So: do not wait at all. Signal the interrupt, release the
                    // movement controls the dig is holding, and start now. The
                    // dig's own 25s race reports its failure afterwards - it is
                    // already designed to be interrupted (see the stop() comment
                    // about not calling stopDigging from here).
                    await this._preempt();
                } else await this.stop();
            } else await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            // Generation guard. A preempted action is still running its own
            // `await actionFn()` and will eventually reach the cleanup below -
            // where, without this, it would set executing=false and wipe the
            // state of the reflex that replaced it. Each action captures the
            // generation it started in; if a newer action has begun, this one
            // is a ghost and must not touch shared state.
            const myGen = ++this._actionGen;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // Reliability: write the crash marker (fsync) before the action body
            // runs, so a hard OOM/SIGKILL mid-action is attributable on next boot.
            if (relName) this.agent.reliability?.markInFlight(relName);

            // start the action
            await actionFn();

            // A reflex preempted me while I was still running. I am a ghost: the
            // reflex owns the body now, so leave its state alone. Clearing
            // executing here would make the manager think nothing is running
            // while she is actively fleeing, and the next action would start on
            // top of her.
            if (myGen !== this._actionGen) {
                console.log(`stale action "${actionLabel}" finished after being preempted; leaving state to the newer action`);
                return { success: false, message: 'preempted by a higher-priority reflex', interrupted: true, timedout: false };
            }

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // Reliability: record outcome (skip interrupts — those are stops, not
            // the action's own failure). Timed-out actions count as failures.
            this.agent.reliability?.clearInFlight();
            if (relName && !interrupted) {
                this.agent.reliability?.record(relName, timedout ? 'timeout' : 'success');
            }

            // Discovery's execution-history ring, ported: last 5 action
            // outcomes (label + ok/fail + short output) for the debugger and
            // the next plan turn. Cap the text so one chatty action can't bloat
            // the prompt. Non-fatal — never touches the return path.
            try {
                const L = this.agent.learning;
                if (L && relName) {
                    L.recent_runs = L.recent_runs || [];
                    L.recent_runs.push({ label: relName, ok: !timedout, text: String(output || '').slice(0, 200), when: Date.now() });
                    while (L.recent_runs.length > 5) L.recent_runs.shift();
                }
            } catch (_) {}

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            // 2026-09-29: a stop()-ABORT that loses the diggingTask race lands
            // here ('Digging aborted' / 'Digging aborted (death)') — that is a
            // stop/death race, NOT an action failure. Record nothing, kill
            // nothing, return it as an interrupt so the loop carries on.
            // cleanKill here turned every mid-dig interrupt and every wither
            // death into a systemd restart loop (3 crashes on 09-29).
            const msg = String((err && err.message) || err || '');
            if (/digging aborted/i.test(msg)) {
                try { this.agent.reliability?.clearInFlight(); } catch (_) {}
                this.agent.clearBotLogs();
                return { success: false, message: 'interrupted (' + msg + ')', interrupted: true, timedout: false };
            }
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();

            // Reliability: a thrown exception is the action's own failure.
            this.agent.reliability?.clearInFlight();
            if (relName && !interrupted) {
                this.agent.reliability?.record(relName, 'failure');
            }

            // Same execution-history ring for the failure path (Discovery's
            // debugger reads failures first). Cap text, never touch return.
            try {
                const L = this.agent.learning;
                if (L && relName) {
                    L.recent_runs = L.recent_runs || [];
                    L.recent_runs.push({ label: relName, ok: false, text: String(err || '').slice(0, 200), when: Date.now() });
                    while (L.recent_runs.length > 5) L.recent_runs.shift();
                }
            } catch (_) {}

            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            const half = MAX_OUT / 2;
            const first = output.substring(0, half);
            const firstCut = first.lastIndexOf(' ');
            const keptFirst = firstCut > half * 0.8 ? first.slice(0, firstCut) : first;
            const lastPart = output.substring(output.length - half);
            const lastSpace = lastPart.indexOf(' ');
            const keptLast = lastSpace >= 0 ? lastPart.slice(lastSpace + 1) : lastPart;
            output = `Action output is very long (${output.length} chars) and has been shortened.\n\n`
                + `First outputs:\n${keptFirst}\n...skipping many lines.\nFinal outputs:\n ${keptLast}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}