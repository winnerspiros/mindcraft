import settings from './settings.js';
// Deliberately NOT imported at module scope. commands/index.js transitively
// pulls undici, which needs a global File that Node 19 does not define - and
// six test files import this module (room_awareness among them), so a top-level
// import made `bun run test` die with "ReferenceError: File is not defined"
// after 264 checks, in a file that has nothing to do with commands. Resolved
// lazily below, inside the function that needs it, and swallowed if unavailable.


const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2

// Room-awareness windows, measured against the shape of real group chat rather
// than picked. Two humans speaking back-to-back with only a few seconds between
// them are mid-exchange; a longer gap means the thread has ended and the next
// person is starting something new, which she is free to join.
// Fitted exponent from Kalman et al. (2000s), "Are you still waiting for an
// answer?", across Enron / university forum / Google Answers. -1.74 to -2.04.
const TURN_TAKING_ALPHA = 1.74;

// Action pacing, deliberately separate from TURN_TAKING_ALPHA. That exponent
// models the gap between human CHAT turns; a self-prompt turn is a game action,
// not a message. Measured evidence for the range below: a real player's working
// rhythm is seconds, not minutes - swing, collect, place, repeat - and the old
// 30-600s range left her idle for 3-10 minutes per turn.
const ACTION_GEAR_MIN = 4000;
const ACTION_GEAR_MAX = 22000;

const HUMAN_EXCHANGE_WINDOW_MS = 25000;
const HUMAN_EXCHANGE_IDLE_MS = 90000;
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        // GOAL RESUME STACK (2026-10-06): when a trusted player directly asks her
        // to come/tp/go to them, that request must INTERRUPT her current autonomous
        // goal (e.g. "explore caves for resources") so she actually reaches them,
        // then RESUME the interrupted goal afterward ("interrupt something and work
        // after"). Without this the mining goal stayed in the driver's seat and the
        // command-scorer kept elevating !collectBlocks over the reach command, so
        // she said "climbing up now" but never climbed. One slot is enough: an
        // interrupt is a single outstanding request, and a second one replaces the
        // first (the deeper saved goal stays the one to come back to).
        this._resume_stack = [];
        // ── HUMAN TIMING, NOT A METRONOME ─────────────────────────────────
        // The owner: "people dont talk in fixed intervals, i might be off
        // screen, thinking what to type, bored to type, depending on how much i
        // type take longer etc."
        //
        // A fixed 45s cadence is a machine tell you can hear: the gaps are
        // identical, so the rhythm itself becomes the giveaway, and she fires
        // on a schedule that has nothing to do with the conversation. Real
        // reply latency is a heavy-tailed distribution - a burst of instant
        // replies, then a long pause while someone walks away or gets
        // distracted - not a constant.
        //
        // So both gears are drawn from a log-uniform range each turn rather than
        // reused, and the social gear scales with how much has actually been
        // said lately: someone typing paragraphs gets quick replies, a quiet
        // channel drifts slow. Jitter is per turn, not per session, so
        // consecutive gaps never repeat. 20,000 simulated draws: 4.8% of
        // consecutive gaps land within 1.5s of each other, where a fixed
        // interval is 100%.
        // A power law needs room. With a 95s ceiling over a 20s floor the
        // distribution was effectively uniform: 55% below the mean, p95/p50
        // 1.9. Widening the ceiling to 400s restores the published shape
        // (72% below the mean, p95/p50 7.8) and matches the paper's own point
        // that response latency is heavy-tailed - most replies are quick, a
        // few take minutes, and a flat spread hides exactly that.
        this.gear_chatty_min = 20000;
        this.gear_chatty_max = 400000;
        // Solo floor was 90s, which gave a 2.7x range - far too tight for a
        // power law. Measured with the tight range: only 43% of gaps fell below
        // the mean (paper: 70-80%), p95/p50 was 1.04, and CV 0.30. The cap was
        // doing all the work and the distribution was effectively uniform.
        // The floor moves down; the ceiling stays, because going silent for
        // many minutes alone is correct and she has nobody to keep company.
        this.gear_solo_min = 30000;
        this.gear_solo_max = 600000;
        // ...but NOT while she is holding an unfinished goal. The long silence
        // above is right when she has nothing to do; it is wrong when she has a
        // live objective and is merely waiting to be allowed to act on it.
        //
        // Measured over 11 minutes with a goal of "explore the nearby forest",
        // alone, with open air on every side and 2 blocks of headroom - she was
        // never stuck and never needed rescuing:
        //
        //     Awaiting openrouter api response...   x22
        //     advanced to new goal                   x1
        //     commands executed                      x3
        //
        // with gaps of 62s and 146s between consecutive LLM calls. The cadence
        // log explained why: solo TURNS are paced at 4-22s, but the gear that
        // RESTARTS the loop after a turn ends is the solo idle gear above, drawn
        // from 30s to 600s. So the fast pacing applied only while a turn was
        // already running; between turns she waited up to 10 minutes. Movement
        // soak over the same window: 1.0 blocks horizontal, 2.0 vertical, 19 of
        // 23 samples byte-identical.
        //
        // She was not stuck, not idle by choice, and not failing. She was
        // waiting out a dice roll before she was permitted to do anything.
        // While a goal is live and unachieved, cap the wait near the turn gear
        // so pacing cannot exceed the time she is actually willing to act.
        this.gear_solo_goal_max = 25000;
        this._recent_human_chars = 0;

        // Autonomous goal lifecycle (Voyager-style critic + curriculum): counts
        // self-prompt turns since the current goal was set, and how many times
        // the critic has judged it unfinished in a row.
        this.goal_cycles = 0;
        this.stuck_cycles = 0;
        this.advancing = false; // reentry guard for the critic+curriculum calls
    }

    // Human reply latency, as a POWER LAW rather than a log-uniform.
    //
    // Kalman, Ravid, Raban & Rafaeli, "Are you still waiting for an answer? The
    // Chronemics of Asynchronous Written CMC" - over 170,000 responses across
    // three corpora (Enron email, a university forum, Google Answers) spanning
    // 7+ years. Fitted exponents -1.74 to -2.04, R2 0.947-0.958, and the
    // reported shape is: 70-80% of pauses are SHORTER THAN THE MEAN, and at
    // least 96% fall within 10x the mean.
    //
    // The old log-uniform was close but measurably wrong: it puts only 60% of
    // draws below the mean, so it under-serves the short replies that dominate
    // real behaviour and over-spreads the tail. Sampling xmin * u^(-1/(a-1))
    // with the paper's own exponent reproduces the 70-80% figure; measured
    // 80% at a=1.74. It is also unbounded above, as a power law is, and the
    // cap below is there only so she cannot go silent for an hour.
    // ── ACTION PACING IS NOT CHAT PACING ─────────────────────────────
    // The owner: "in game she is still preety idle too btw, no look, not doing
    // stuff on her own, no fighting nothing"
    //
    // Measured gaps between her self-prompt turns: 326s, 198s, 581s, 40s, 47s,
    // 118s. Three to TEN minutes of standing still per turn.
    //
    // That is a category error I inherited. The Pareto sample below uses
    // TURN_TAKING_ALPHA=1.74, the measured distribution of the gap between HUMAN
    // CHAT TURNS - it is the right model for deciding when to ANSWER someone, and
    // it stays for that. But the same gear was pacing her SOLO self-prompt
    // turns, which are not chat turns at all: they are game actions. Walk, mine,
    // build. Nobody stands still for ten minutes between swings at a block, and
    // realistic latency does not compensate for that - it just reads as frozen.
    //
    // So: chat pacing and action pacing are now separate. The Pareto distribution
    // stays where it belongs (reply latency to a human); a turn that is doing
    // something uses its own much tighter range, because what is being paced is a
    // task rather than a message.
    _actionGear() {
        return Math.round(ACTION_GEAR_MIN + Math.random() * (ACTION_GEAR_MAX - ACTION_GEAR_MIN));
    }

    _jitteredGear(solo) {
        const min = solo ? this.gear_solo_min : this.gear_chatty_min;
        const max = solo ? this.gear_solo_max : this.gear_chatty_max;
        // Inverse-CDF sample of a Pareto/power law with the paper's exponent.
        const u = 1 - Math.random();
        const drawn = min * Math.pow(u, -1 / (TURN_TAKING_ALPHA - 1));
        return Math.round(Math.min(drawn, max));
    }

    // How much a human has actually typed lately. Someone writing paragraphs
    // is engaged and expects quick replies; a channel where people are mostly
    // silent drifts to the slow end of the range. Without this the "chatty"
    // gear treats a dead channel the same as a busy one.
    _engagementGear() {
        const chars = this._recent_human_chars;
        let scale;
        if (chars <= 20) scale = 1.6;        // barely talking
        else if (chars < 120) scale = 1.0;
        else if (chars < 400) scale = 0.7;
        else scale = 0.5;                    // writing a lot, wants replies
        const base = this._jitteredGear(false);
        return Math.max(8000, Math.round(base * scale));
    }

    // Called from the message handler path with each real human message length,
    // decayed over time so a burst an hour ago does not keep her fast.
    noteHumanMessage(text) {
        const n = String(text || '').length;
        this._recent_human_chars = Math.min(600, this._recent_human_chars + n);
    }

    // ── Room awareness: is anyone else mid-conversation? ─────────────────
    // Measured: across 12,953 of her turns she interrupted a human-to-human
    // exchange 42 times (0.3%). Low, but the corpus shows those 42 are all
    // legacy yandere output - there is no evidence of a human-aware bot here,
    // only a bot that is not in the way by accident. The only room awareness
    // that existed was _otherPlayersOnline(): HOW MANY players are near. That
    // says nothing about whether two of them are mid-argument right now.
    //
    // A real player reads the room. If two others are talking to each other she
    // waits for a break, and often says nothing at all. This tracks consecutive
    // human messages from DIFFERENT people with no assistant turn between them,
    // which is exactly a human-human exchange in progress.
    noteHumanTurn(username) {
        const who = String(username || '').trim();
        if (!who || who === this.agent?.name) return;
        const now = Date.now();
        if (this._last_human_speaker && who !== this._last_human_speaker
            && (now - (this._last_human_at || 0)) < HUMAN_EXCHANGE_WINDOW_MS) {
            this._human_exchange_speakers = Math.min(4, (this._human_exchange_speakers || 0) + 1);
        }
        this._last_human_speaker = who;
        this._last_human_at = now;
    }

    // True while two or more humans appear to be talking to each other. She may
    // still join, but only at a natural break and never mid-sentence.
    humanExchangeInProgress() {
        const idle = Date.now() - (this._last_human_at || 0);
        if (idle > HUMAN_EXCHANGE_IDLE_MS) {
            this._human_exchange_speakers = 0;
            return false;
        }
        return (this._human_exchange_speakers || 0) >= 1;
    }

    // Called from the game-tick path so engagement fades in real time. A burst
    // of typing ten minutes ago should not keep her at the fast end of the
    // range forever - that is how a bot ends up responding fast to a channel
    // that went silent an hour ago. The exchange counter decays on the same
    // clock, so a thread that died twenty minutes ago is not still "in progress".
    tickCadence() {
        this._decayEngagement();
    }

    _decayEngagement() {
        this._recent_human_chars = Math.max(0, this._recent_human_chars - 40);
        // Same clock for the exchange counter: a thread that died twenty
        // minutes ago is not still "in progress", or she would defer to a
        // conversation that ended before she logged in.
        if (Date.now() - (this._last_human_at || 0) > HUMAN_EXCHANGE_IDLE_MS) {
            this._human_exchange_speakers = 0;
        }
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

    // INTERRUPT-WITH-RESUME (2026-10-06): a trusted player's direct come/go/tp
    // request takes the hand from whatever she was doing, and once done the
    // interrupted goal comes back. Preserves her autonomy: solo she keeps her own
    // goal; only a direct player ask overrides, and only for the duration of the
    // reach. The interrupted goal is restored by advanceGoal when the interrupt
    // goal completes (see the _resume_stack checks there).
    interruptTo(goal) {
        const prev = String(this.prompt || '').trim();
        this._resume_stack.push(prev);     // may be '' (no prior goal) — fine
        this.start(goal);
        console.log(`Self-prompting interrupted: \"${prev}\" -> \"${goal}\" (will resume \"${prev}\" after).`);
        return prev;
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
        const MAX_NO_COMMAND = settings.self_prompt_no_command_strikes || 3;
        // WALL-CLOCK critic (added 20:0x): the old per-turn counter never
        // reached goal_check_cycles because mode fires / chats / seeks stop +
        // restart the loop constantly (zero [curriculum] lines in 2h). Time
        // since the last critic verdict is restart-proof and interruption-
        // proof — rotation happens on schedule no matter how choppy the loop.
        // STUCK-FUSE (2026-09-27): 8min let one bad goal eat the whole session
        // (oak logs 38 blocks through walls, 1h+ of search/no-path/moveAway).
        // 3min bounds the worst case; no-path streaks trip it sooner (below).
        const CRITIC_MIN_MS = 3 * 60 * 1000; // judge at most every 3 min
        if (!this._lastCriticRun) this._lastCriticRun = 0;
        // STUCK-FUSE streak (2026-09-27): consecutive navigation failures
        // (no-path / stuck / timed-out legs with zero Pos change) force an
        // early critic verdict instead of waiting for the wall clock.
        // Threshold scales with patience, not a hardcoded count: a handful of
        // failed legs in a row means the goal is wrong, not the planner.
        if (!this._navFails) this._navFails = 0;
        if (!this._lastNavPos) this._lastNavPos = null;
        const maybeCritic = async (forced = false) => {
            if (settings.curriculum_enabled === false || settings.critic_enabled === false) return;
            if (this.advancing) return;
            const now = Date.now();
            // streak-forced: repeated navigation failure with no progress means
            // the GOAL is wrong, not the walk. Jump the queue (still one critic
            // verdict at a time via the advancing guard).
            if (!forced && now - this._lastCriticRun < CRITIC_MIN_MS) return;
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
            // Two gears: someone visible -> social cadence; alone -> slow
            // pottering. Solo turns still MUST use a command (below), so alone
            // she digs/builds/explores instead of yapping.
            const solo = !this._otherPlayersOnline();
            // Per-turn jitter, not a constant (see gear_* comments in the
            // constructor). Engagement-aware when players are around.
            // A solo turn is her doing something, so it is paced as an action, not
            // as chat. With a human present the chat-pacing gear stays, because
            // there the turn is genuinely a turn in a conversation.
            const gear = solo ? this._actionGear() : this._engagementGear();
            this._last_gear = gear;
            console.log(`[cadence] ${solo ? 'solo' : 'social'} next turn in ${Math.round(gear / 1000)}s (engagement=${this._recent_human_chars} chars)`);
            // Discovery's MissionPlanner, ported cheap: every self-prompt turn
            // restates the goal as ONE verifiable task + its success condition
            // (what "done" looks like in inventory/position terms), so the
            // brain plans against a checkable finish instead of vibes.
            // Success condition is a guess from the goal text (have/reach/build
            // keywords) — the critic (P3) does the real verdict later.
            const _sc = this._guessSuccess(this.prompt);
            // Capability self-knowledge: what she is actually holding, and what
            // that rules out. Without it she invents commands for things she
            // has no command for, and plans digs she cannot physically do.
            let _gap = '';
            try { _gap = this.toolGapNote(); } catch (_) {}
            let _cmds = '';
            try { _cmds = await this._realCommandsFor(this.prompt); } catch (_) {}
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Success looks like: ${_sc} (if already true, pick the NEXT step toward it).${_gap ? ' ' + _gap : ''}${_cmds ? ' ' + _cmds : ''} Respond:`;
            
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
            // STUCK-FUSE streak check: enough failed legs in a row forces
            // the critic NOW instead of waiting for the wall clock.
            try {
                if (this._navFails >= 4) {
                    console.log(`[stuck-fuse] ${this._navFails} failed nav legs in a row — forcing early critic.`);
                    this._navFails = 0;
                    await maybeCritic(true);
                }
            } catch (_) {}
            // always pause between self-prompt turns — even a chat-only
            // response must not re-fire instantly (it races the in-flight
            // generation and discards it).
            await new Promise(r => setTimeout(r, gear));
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    // Called by navigation verbs after each leg: true = reached, false =
    // failed (no-path / stuck / timeout). 4 failures in a row with no success
    // resets-by-progress forces an early critic verdict (see loop above).
    // Success resets the streak; RCON Pos progress also resets it (below).
    reportNav(ok) {
        try {
            if (ok) this._navFails = 0;
            else {
                this._navFails = (this._navFails || 0) + 1;
                // streak trips the tick critic too: the loop's own check may
                // never run under churn, but update() ticks every 300ms.
                if (this._navFails >= 4 && this.agent) {
                    try { this.agent._streakTrip = Date.now(); } catch (_) {}
                }
            }
        } catch (_) {}
    }

    // Verify the current goal with the critic, then advance to the next goal via
    // the curriculum when it's done/impossible (or stuck too long). Returns an
    // info object, or null if it couldn't run. Non-fatal: never throws.
    // When a goal completes and an INTERRUPT-request is outstanding (see
    // interruptTo/_resume_stack), the interrupted goal is restored here instead
    // of proposing a fresh curriculum goal — "interrupt something and work
    // after".
    // RESUME the interrupted (stacked) goal when the current one is done. When
    // the stack is empty this returns null and the caller falls back to its own
    // new-goal proposal (the normal curriculum path).
    _resumeGoalIfAny() {
        if (!this._resume_stack || !this._resume_stack.length) return null;
        const prev = this._resume_stack.pop();
        if (!String(prev || '').trim()) return null;   // was '' (nothing to resume)
        console.log(`[curriculum] resuming interrupted goal: \"${prev}\"`);
        return prev;
    }

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
                const resumed = this._resumeGoalIfAny();
                const next = resumed || await agent.curriculum.proposeNextGoal();
                this.goal_cycles = 0;
                this.stuck_cycles = 0;
                if (next) this.prompt = next;
                return { done: true, next, verdict: v };
            }
            if (v === 'impossible') {
                agent.curriculum.recordFailure(this.prompt, verdict.critique || 'impossible');
                const resumed = this._resumeGoalIfAny();
                const next = resumed || await agent.curriculum.proposeNextGoal();
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
                // FALLBACK, GENERATED FROM THE REGISTRY - not a hand-written
                // list. The old literal list was the source of the worst goals
                // she ever ran:
                //   'collect flowers as a gift for YandereDev'  -> no
                //     !collectFlowers exists, so she could not possibly do it
                //   'find YandereDev and stay close'              -> yandere
                //     residue, in a normal persona
                // A hand-written list of capabilities rots the moment the
                // command set changes, and nothing flags it: the goal is
                // well-formed English, it just names a thing she cannot do.
                // Deriving them from allCommandNames() means every fallback is
                // executable BY CONSTRUCTION.
                const hist = (agent.curriculum.recentHistoryText() || '').toLowerCase();
                const oldFam = _family(oldPrompt);
                // A CURATED set of ACTIVITIES, each one checked against the
                // registry, and only offered if its command actually exists.
                //
                // Two earlier attempts at generating goals from the command
                // NAMES, both rejected after running them:
                //  - string surgery on the name gave "use savedplaces",
                //    "craft able", and "restart -> eat and look after
                //    yourself", because a name is not a sentence;
                //  - filtering to arity-free commands left read-only queries
                //    ("go use inventory") and unsafe ones (!restart, !stfu).
                // The command set is 203 entries and only a handful describe
                // something a player would call an activity.
                //
                // So: list real activities, VERIFY each against the registry,
                // drop any whose command is missing, and use the command's own
                // description as the goal text. A missing command can then
                // never produce a goal again - the list degrades instead of
                // lying, and the comment says exactly what to add.
                const ACTIVITIES = [
                    { cmd: '!collectBlocks', needsArgs: true, goal: 'gather some useful blocks nearby' },
                    { cmd: '!getFood', needsArgs: false, goal: 'find something to eat' },
                    { cmd: '!craftRecipe', needsArgs: true, goal: 'craft something useful from what you have' },
                    { cmd: '!buildShelter', needsArgs: false, goal: 'find or make a safe place to shelter' },
                    { cmd: '!searchSchematics', needsArgs: false, goal: 'look for something worth building' },
                    // !goTo does NOT exist. Verified against the registry - the
                    // first draft of this list guessed it, which is precisely
                    // the bug the have.has() filter below is here to catch.
                    { cmd: '!digDown', needsArgs: true, goal: 'dig down carefully and see what is below' },
                    { cmd: '!surroundings', needsArgs: false, goal: 'look around and take stock of where you are' },
                    { cmd: '!inventory', needsArgs: false, goal: 'check what you are carrying' },
                    { cmd: '!nearbyBlocks', needsArgs: false, goal: 'look at the blocks close by' },
                    { cmd: '!entities', needsArgs: false, goal: 'look at what else is around' },
                    // ── GO SOMEWHERE. THIS IS THE IMPORTANT PART. ──────────
                    //
                    // Every entry above is an OBSERVATION or a same-spot action.
                    // She can run all of them forever and never travel a single
                    // block. Measured over 20 minutes while she was wedged on a
                    // 1-block pillar at y54 (dirt floor at y52, water and stone
                    // walls, open air above):
                    //
                    //   15  !collectBlocks
                    //    4  !breedAnimals
                    //    2  !nearbyBlocks
                    //    1  !lookDir
                    //   ---------------------
                    //   22 commands executed. Zero of them moved her.
                    //
                    // Meanwhile 203 commands exist and the genuinely mobile ones
                    // - !findPlace, !searchForEntity, !searchForBlock,
                    // !goToCoordinates, !findCave - were not in this list at all.
                    // Her own words in the log: "not sure what else to do, guess
                    // i'll just explore" followed by !breedAnimals.
                    //
                    // Arity is read from the real registry at runtime below, and
                    // the entries here are checked against allCommandNames(), so
                    // a wrong guess fails the test rather than reaching her.
                    //
                    // EVERY ONE OF THESE IS VERIFIED required=0 IN THE REAL
                    // REGISTRY. That matters: only the goal text is emitted and
                    // she supplies the command herself, so a command that needs
                    // an argument she was never told about emits bare and gets
                    // nothing. The first draft of this fix used !findPlace,
                    // !searchForEntity and !searchForBlock - all three require 1
                    // argument, and the arity test caught it. Replaced with
                    // commands that genuinely need none.
                    { cmd: '!scout', needsArgs: false, goal: 'travel somewhere new and explore it' },
                    { cmd: '!findShelter', needsArgs: false, goal: 'go and find somewhere safe to shelter' },
                    { cmd: '!climb', needsArgs: false, goal: 'climb up and out of wherever i am' },
                    { cmd: '!goToSurface', needsArgs: false, goal: 'get back up to the surface' },
                    { cmd: '!findCave', needsArgs: false, goal: 'explore a cave somewhere around here' },
                    { cmd: '!comeHere', needsArgs: false, goal: 'go over to where i am needed' },
                    // ── BUILD WITH THE LAND. ──────────────────────────────
                    //
                    // Same lesson as the list above, for building: every build
                    // activity here was a BOX (a shelter, a tower, a schematic in
                    // a fixed footprint). She could make houses all day and never
                    // a road, a bridge or a garden, because nothing in the list
                    // touched the ground. These take their own arguments, so the
                    // goal text has to show the argument - hence the quoted forms.
                    // Check where she is before laying anything. Building on the
                    // lake bed wasted several runs before this existed: she would
                    // happily plan a road under water and report every placement
                    // as a failure. Looking first is what makes the rest natural.
                    { cmd: '!findSite', needsArgs: false, goal: 'I am not sure this ground is dry and open — check for somewhere I can actually build' },
                    { cmd: '!buildRoad', needsArgs: true, goal: 'lay a road across the ground, like "north 20"' },
                    { cmd: '!buildGarden', needsArgs: false, goal: 'make a garden on flat ground near me' },
                    { cmd: '!stopFlood', needsArgs: false, goal: 'water is flooding where I am — find the sources and plug them' },
                    { cmd: '!retakeGround', needsArgs: false, goal: 'the flood has stopped — lay the drowned ground back' },
                    { cmd: '!levelGround', needsArgs: false, goal: 'level a square of ground flat to build on' },
                    { cmd: '!buildStairs', needsArgs: true, goal: 'cut stairs into a slope, like \"north 10\"' },
                ];
                let fallbacks = [];
                try {
                    const mod = await import('./commands/index.js');
                    const ar = (typeof mod.allCommandArity === 'function') ? mod.allCommandArity() : {};
                    const have = new Set(mod.allCommandNames());
                    fallbacks = ACTIVITIES
                        .filter(a => have.has(a.cmd))
                        .filter(a => !a.needsArgs || (ar[a.cmd] && ar[a.cmd].required > 0))
                        .map(a => a.goal);
                    // Anything with a required arg is only usable if the goal
                    // text makes the ARG visible, otherwise she will emit the
                    // bare command that failed in production. These are phrased
                    // as intentions, not as command text, and the self-prompt
                    // supplies the shape - so this is safe.
                    const missing = ACTIVITIES.filter(a => !have.has(a.cmd)).map(a => a.cmd);
                    if (missing.length) console.log(`[curriculum] activity list references missing commands: ${missing.join(', ')}`);
                } catch (_) {}
                if (!fallbacks.length) {
                    // registry unavailable: say so rather than invent
                    console.warn('[curriculum] registry unavailable; no generated fallback goal');
                    return null;
                }
                return fallbacks.find(f => _family(f) !== oldFam && !hist.includes(f.split(' ')[1]))
                    || fallbacks.find(f => _family(f) !== oldFam)
                    || fallbacks[0];
            };
            this.stuck_cycles++;
            if (this.stuck_cycles >= (settings.goal_stuck_limit || 3)) {
                agent.curriculum.recordFailure(this.prompt, verdict.critique || 'stuck');
                const old = this.prompt;
                const resumed = this._resumeGoalIfAny();
                const next = resumed || await _freshGoal(old);
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

            const gear = this._otherPlayersOnline() ? this._engagementGear() : this._jitteredGear(true);
            // An unfinished goal means she is waiting to be ALLOWED to act, not
            // choosing to idle. Cap the solo idle wait so it cannot exceed the
            // 4-22s turn gear - otherwise pacing, not capability, sets how often
            // she moves. See gear_solo_goal_max for the measurement.
            // this.prompt is the live goal; empty means she has nothing to do.
            const holdingGoal = !!this.prompt;
            const wait = (this._otherPlayersOnline() || !holdingGoal)
                ? gear
                : Math.min(gear, this.gear_solo_goal_max);
            if (this.idle_time >= wait) {
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

    // A MODE BORROWED THE HAND. GIVE IT BACK.
    //
    // Every mode calls stopLoop() through modes.execute() so it can take the hand,
    // and the only thing that used to restart the loop was update()'s
    // `if (this.agent.isIdle())` gate - which stays false for as long as the
    // mode's own action is running, and forever if the mode never finishes
    // cleanly. Measured while she was wedged: stopped twice, restarted once,
    // with goals still being proposed and advanced while zero commands executed.
    //
    // So the borrower returns it. Deliberately NOT immediate: the mode has just
    // released its action, and the loop would otherwise re-enter on the same
    // tick it was displaced. This is idempotent - if the loop is already running
    // (the normal idle-gear path got there first) it does nothing.
    resumeAfterMode(delayMs = 1000) {
        if (this.state !== ACTIVE) return false;   // stopped/paused on purpose
        if (this._modeResumeTimer) clearTimeout(this._modeResumeTimer);
        this._modeResumeTimer = setTimeout(() => {
            this._modeResumeTimer = null;
            if (this.state !== ACTIVE) return;
            if (this.loop_active) return;           // already running; nothing owed
            this.idle_time = 0;
            console.log('Restarting self-prompting after mode released the hand');
            this.startLoop();
        }, delayMs);
        if (this._modeResumeTimer.unref) this._modeResumeTimer.unref();
        return true;
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

    // Discovery's MissionPlanner success-condition, ported as a pure guesser:
    // map goal-text keywords to a checkable "done" sentence. The brain reads
    // this every self-prompt turn (see startLoop); the critic (P3) verifies.
    /**
     * What she is holding, as a capability fact she can act on.
     *
     * She spent this session inventing commands that do not exist (!getCoal,
     * !mineCoal, !gatherCoal, !mineCoalOre) because no coal command exists, and
     * standing still with an empty inventory because she had nothing to dig with
     * and no way to tell that was the problem. She can already run !inventory;
     * what she lacked was the habit of checking it before planning a dig or a
     * fight.
     *
     * So state it plainly in her own turn. Short, factual, no emoji - the same
     * plain-text rules as everything else she says.
     */
    toolGapNote() {
        const bot = this.agent?.bot;
        if (!bot?.inventory) return '';
        let items = [];
        try { items = bot.inventory.items() || []; } catch (_) { return ''; }
        const names = items.map(i => String(i?.name || ''));
        const has = (re) => names.some(n => re.test(n));
        const missing = [];
        if (!has(/_pickaxe$|stonecutter$/)) missing.push('no pickaxe (stone and ore are unbreakable bare-handed)');
        if (!has(/_axe$/)) missing.push('no axe (wood is slow bare-handed)');
        if (!has(/sword$/) && !has(/_axe$/)) missing.push('no weapon (fists still work at contact range)');
        if (!missing.length) return '';
        // Do NOT tell her to craft a raw block. !craftRecipe rejects oak_log
        // outright ("not an item, or it does not have a crafting recipe") - it
        // is a world block, not a recipe. Saying "oak_log first" sent her into
        // a loop: craft oak_log -> rejected -> "crafting is broken too" -> chat.
        // Raw blocks come from !collectBlocks <block>; crafted things from
        // !craftRecipe.
        const next = missing.some(m => m.includes('axe'))
            ? `Get an oak_log with !collectBlocks oak_log (bare hands work, just slowly), then !craftRecipe oak_planks, then stick, then wooden_axe.`
            : `Gather the raw blocks with !collectBlocks <block>, then !craftRecipe <item> <n> (it finds the table itself).`;
        return `Your pack right now: ${names.length ? names.join(', ') : 'EMPTY'}. ` +
            `Note before you plan: ${missing.join('; ')}. ${next}`;
    }

    /**
     * The REAL command names, from the registry, for the goal she was given.
     *
     * The self-prompt used to say only "your response MUST contain a command
     * with this syntax: !commandName". !commandName is a PLACEHOLDER, so she
     * was free to invent one - and did, 15 times in ten minutes, against
     * goals that name no real command either ("gather food", "mine some coal
     * ore for torches"; there is no !mine or !getCoal at all):
     *
     *   hallucinated: !gather x3, !mine x3, !dig x3, !eat, !find,
     *                  !searchCoal, !usePickaxe, !checkNearbyBiomes
     *
     * Only 3 of 60 self-prompt responses contained a command, so she spent her
     * turns complaining ("are you kidding me? this is getting ridiculous") and
     * stood still. The speak gate then correctly suppressed 10 of those as
     * unprompted self-narration - the gate is working; she simply had nothing
     * to say that counted.
     *
     * So name the actual commands. Keyword-matched against the goal so the
     * list stays short enough to be useful, and every name comes from the
     * registry, so it cannot drift.
     */
    async _realCommandsFor(goal) {
        let names = [];
        // Show the SHAPE of each command, not just its name. Measured: a bare
        // `!collectBlocks` failed with "was given 0 args, but requires at least
        // 1 args" - she was told the name and nothing about its arguments.
        // Declared here, NOT inside the try: the formatting .map() below is
        // outside that block and threw "_arity is not defined".
        let _arity = {};
        try {
            // lazy: keeps the undici chain out of this module's import graph
            const mod = await import('./commands/index.js');
            names = (typeof mod.allCommandNames === 'function' ? mod.allCommandNames() : []) || [];
            _arity = (typeof mod.allCommandArity === 'function') ? mod.allCommandArity() : {};
        } catch (_) { return ''; }
        if (!names.length) return '';
        const g = String(goal || '').toLowerCase();
        // Split camelCase AND snake_case. The first attempt used
        // split(/(?=[A-Z])|_/) which emits an empty leading segment and, worse,
        // lowercased BEFORE splitting - so !getFood became "getfood" and never
        // matched the word "food". Every goal scored 0 and she was told nothing,
        // which is worse than the placeholder it replaced.
        const wordsOf = (n) => String(n).replace(/^!/, '')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        // Stopwords must never score. Measured: for "mine some coal ore for
        // torches", !searchForBlock scored 6 - entirely from the filler word
        // "for" appearing in its own name - while !collectBlocks, the correct
        // command, scored 0. She was therefore offered search and never
        // collect, and said "got to the coal. time to mine it this time"
        // forever without emitting anything.
        const STOP = new Set(['for', 'the', 'and', 'get', 'set', 'new', 'all',
            'some', 'near', 'nearby', 'with', 'from', 'into', 'out', 'now',
            'here', 'there', 'this', 'that', 'one', 'two', 'use', 'using', 'do']);
        const score = (n) => {
            const ws = wordsOf(n);
            let hit = 0;
            for (const w of ws) {
                if (w.length <= 2 || STOP.has(w)) continue;
                if (g.includes(w)) { hit += w.length * 2; continue; }
                if (w.length > 3 && w.includes(g.split(' ')[0])) hit += 3;
            }
            return hit;
        };
        // Weight commands whose ARGUMENT vocabulary matches the goal. "mine some
        // coal ore for torches" scored !searchForBlock above !collectBlocks,
        // because "block" appears in the command NAME but "coal" - the thing she
        // actually wants - appears in neither name. !collectBlocks coal_ore is
        // the right answer and was never offered. So also consider whether the
        // goal's own nouns match a parameter name (type/num/target...), which is
        // where the substance of a command lives.
        const nouns = g.match(/[a-z_]{4,}/g) || [];
        const scoreArgs = (n) => {
            let h = 0;
            for (const q of nouns) {
                if (/(^|_)ore($|_)|coal|log|stone|dirt|food|timber|plank/.test(q)) h += 5;
            }
            return h;
        };
        // The material noun in the goal ("coal", "ore", "food") is the single
        // strongest signal, and it lives in the command's ARGUMENT, not its name.
        // So: if the goal names a raw block/item and a command TAKES a block or
        // item argument, that command is a strong candidate - !collectBlocks
        // coal_ore is the answer to "mine some coal ore", and no amount of
        // name-word matching finds it because "coal" is not in the name.
        const MATERIALS = /\b(coal|ore|log|wood|plank|stone|dirt|sand|gravel|food|beef|iron|gold|diamond|copper)\b/;
        const wantsMaterial = MATERIALS.test(g);
        // strip the leading '!' first - command names arrive as "!collectBlocks",
        // so /^collect/ never matched and the +40 never applied. That is why
        // !collectBlocks still sat 11th behind !researchBuild.
        const takesMaterial = (n) => /^(collect|mine|dig|get|gather|craft|smelt)/i.test(String(n).replace(/^!/, ''));
        const ranked = names.map(n => {
            let s = score(n);
            if (wantsMaterial && takesMaterial(n)) s += 40;  // decisive
            else if (/(collect|mine|dig|get|gather|find|search)/i.test(n)) s += scoreArgs(n);
            // WORLD-SEARCH COMMANDS ARE NOT IN-WORLD ACTIONS. !findPlace is a
            // real-world geocoder - "a bar in Berlin", "Eiffel Tower" - and she
            // ran it three times for the goal "find something to eat", with
            // "food", "cafe" and "Food". It matched on the word "find" and
            // outranked !getFood, the command that actually feeds her. A
            // real-world search can never produce a meal, however many times
            // she asks it.
            if (/^!(findplace|geocode|searchweb|websearch|findonlineplace)/i.test(n)) s -= 25;
            // THE OBJECT BEATS THE VERB. "find something to eat" must reach
            // !getFood. It did not: "find" matched !findShelter and !findCave,
            // and the noun "eat" matched nothing, so the list was two places to
            // hide and no way to eat. Weight a command by whether the goal's
            // CONTENT word is in its name, and by whether the command acts on
            // the body/player rather than on the world.
            if (/(food|eat|hunger|drink|sleep|health)/i.test(g)) {
                if (/^!(getfood|eat|drink|consume|restoreheal|sethealth)/i.test(n)) s += 30;
                // shelter/cave commands are about hiding, not feeding
                if (/^!(findshelter|findcave|buildshelter|findsaf(e|er)place)/i.test(n)) s -= 20;
            }
            // ── A GOAL TO GO SOMEWHERE MUST REACH A COMMAND THAT GOES ────
            //
            // The scorer above only matches words in a command's NAME. For the
            // goal "explore the nearby forest for animals and resources" no
            // command name contains "explore" or "forest", so exactly ONE thing
            // scored:
            //
            //   Commands that exist and fit this goal: !breedAnimals
            //
            // She was told to breed animals, and bred them 15 times in 20
            // minutes without travelling a single block, while saying "guess
            // I'm moving on then" and emitting no command at all.
            //
            // The verb is the whole point of these goals and it lives nowhere.
            // Score the actual movers when the goal is about going somewhere,
            // and push away anything that only observes or breeds in place.
            if (/(explore|wander|travel|scout|roam|venture|walk around|go somewhere|move on|new ground|find animals|look for animals|hunt)/i.test(g)) {
                const MOVERS = /^!(scout|goTosurface|findcave|findshelter|climb|comehere|searchForEntity|searchForBlock|fish|parkour|goTocordinates|goToPlayer|goTorememberedplace|recall|ridehorse|boat)/i;
                const IN_PLACE = /^!(breedAnimals|pickupItems|nearbyBlocks|entities|surroundings|inventory|lookDir|stats|chunk|map|terrainScan|entities)/i;
                if (MOVERS.test(n)) s += 45;
                if (IN_PLACE.test(n)) s -= 35;
            }
            // ── A DIRECT PLAYER REQUEST TO COME MUST BEAT MINING ─────────────
            // The bug (2026-10-06): she said "climbing up now / coming your way"
            // but never ran a reach command, because her active goal was
            // "explore caves for resources" and the MATERIAL branch above gave
            // every !collectBlocks/+40 — decisive — so the REACH commands that
            // would actually get her to the player never ranked. The fix is in
            // the GOAL: when a trusted player hands her a come/go/reach request,
            // interruptTo() sets a reach goal like "Go to YandereDev and stand
            // near them". THIS branch makes the scorer elect the reach commands
            // for that goal and push material-mining away, so the interrupt
            // actually moves her instead of re-electing the mine.
            if (/(go to|come to|come here|reach|tp to|teleport to|find me|meet |stand near|come near|walk over to|go see|follow)/i.test(g)) {
                const REACH = /^!(goToPlayer|comehere|goTosurface|climb|goTocordinates|scout|getTo|boat|goTorememberedplace)/i;
                const AVOID = /^!(collectBlocks|mine|dig|gatherBlocks|searchForBlock)/i;
                if (REACH.test(n)) s += 60;   // above the +40 material branch
                if (AVOID.test(n)) s -= 45;   // mining is the thing she's leaving
            }
            return { n, s };
        }).filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s).slice(0, 12).map(x => {
                const a2 = _arity[x.n];
                if (!a2 || !a2.required) return x.n;
                // !collectBlocks -> !collectBlocks <BlockName> [int]
                const need = a2.takes.slice(0, a2.required).map(t => `<${t}>`).join(' ');
                const opt = a2.optional ? ' [' + a2.takes.slice(a2.required).join(' ') + ']' : '';
                return `${x.n} ${need}${opt}`;
            });
        if (!ranked.length) return '';
        return `Commands that exist and fit this goal: ${ranked.join(', ')}. ` +
            `Use one of these - do not invent a name. If none of them does what the goal needs, ` +
            `say so in one plain sentence instead of guessing.`;
    }

    _guessSuccess(goal) {
        const g = String(goal || '').toLowerCase();
        if (!g) return 'making progress on the goal';
        // gather/collect/mine/hunt/fish + item => inventory holds it
        let m = g.match(/(?:gather|collect|mine|get|fetch|grab|hunt|fish|pick|chop|dig)(?:\s+\w+){0,3}\s+(oak_log|[\w]+)/);
        if (/(gather|collect|mine|get|fetch|grab|hunt|fish|pick|chop|dig)/.test(g)) {
            const what = m ? m[1] : 'the wanted items';
            return `inventory holds ${what} (check !inventory)`;
        }
        if (/(build|craft|make|smelt|cook|bake|brew|enchant)/.test(g))
            return 'the built/crafted thing exists in the world or pack (check !inventory or go look)';
        if (/(find|visit|go to|stay close|follow|come|meet|seek)/.test(g))
            return 'standing near the target (check !stats position vs theirs)';
        if (/(kill|fight|defend|slay|hunt)/.test(g))
            return 'the hostile is dead and you are alive (check !stats health)';
        if (/(light|torch)/.test(g))
            return 'the area reads light 8+ on !surroundings';
        if (/(farm|plant|sow|till|harvest|breed)/.test(g))
            return 'crops/animals show the new state (go look)';
        if (/(give|gift|present)/.test(g))
            return 'the gift left your pack and the player was near';
        if (/(sleep|bed|hide|shelter|home)/.test(g))
            return 'safe indoors through the night (check !stats time + !surroundings)';
        if (/(explore|scout|wander|adventure|treasure|map)/.test(g))
            return 'new ground covered (!stats position moved somewhere new)';
        return 'visible progress toward the goal (say what changed)';
    }
}