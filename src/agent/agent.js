import { History } from './history.js';
import { rconEnsureKit } from '../utils/rcon.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, nearestCommandNames, explainParamError, executeCommand, truncCommandMessage, isAction, blacklistCommands, getCommandInfo, isRetryableError, looksLikeCommand } from './commands/index.js';
import { Tilt } from '../utils/tilt.js';
import { scrubOutput } from '../utils/scrub.js';
import { reactToHurt, assessThreats } from '../utils/threat.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import * as skills from './library/skills.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { needsLogin, canOp, worldSeed, authFlow, teleportConfig, combatConfig, setTeleportsAvailable, isYandere } from '../utils/server_context.js';
import { ModerationWatcher } from './moderation.js';
import { PlayerActivityWatcher } from './player_activity.js';
import { InteractionTracker } from '../utils/interaction.js';
import { RelationshipManager } from './relationship.js';
import { PlayerProfiles } from './profiles.js';
import { ReliabilityTracker } from './reliability.js';
import { Psyche } from './psyche.js';
import { TurnTaker } from './turn_taker.js';
import { RealnessTracker } from './realness.js';
import { PersonalnessTracker } from './personalness.js';
import { HeatTracker } from './heat.js';
import { ReflectiveMemory } from './reflective_memory.js';
import { Curriculum } from './curriculum.js';
import { LearnedSkillLibrary } from './learned_skill_library.js';
import Vec3 from 'vec3';

// ── AUTONOMOUS WORK ─────────────────────────────────────────────────────
//
// How long before she may re-arm the SAME kind of work after finishing it. Time
// based, and short relative to a play session: she finishes getting ore, and a
// minute later she is doing something else rather than standing there. Long
// enough that re-arming cannot become a loop, short enough that she is never
// idle for a visible stretch.
const ACTIVITY_REARM_MS = 45000;
//
// Goal DESCRIPTIONS, not action scripts. These say what she is doing; the bot,
// its skills and the model decide how to carry it out, through the ordinary
// self-prompt path. That is the same contract a goal arriving in conversation
// gets, so an idle bot and a spoken-to bot behave identically once working.
//
// Kept deliberately plain and unpunctuated so they read as intent rather than as
// a canned instruction. See utils/activity.js for how the choice is made - it is
// driven by her situation (hunger, inventory, attention, nearby build) and never
// by a timer, so this map is a vocabulary rather than a routine.
const ACTIVITY_PROMPT = {
    get_resource: 'go and get what im actually short of, its been a while',
    build: 'finish the thing i started, its right here half done',
    explore: 'go look at whats out there, ive been stood here too long',
    look_around: 'have a proper look around, whats going on with everyone',
    eat: 'im starving, get food sorted',
    answer_attention: 'someone is looking at me, see what they want',
};

// A player opens the chat box at a pause, not mid-swing. She waits this long
// after a movement action before starting to type, so she never does the visible
// stop-then-go (finish a dig -> freeze -> walk off). Well under a second, so it
// never reads as frozen and never interrupts a long build to talk.
const PAUSE_BEFORE_TYPING_MS = 700;

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._last_death_react = 0;
        this._escapingSuffocation = false;   // guard against overlapping suffocation rescues
        this._suffocationInterval = null;
        this.grudge = {}; // playerName -> { count, handled } harm record for retaliation escalation
        this.ignored_players = {}; // playerName -> timestamp until which to ignore (dismissals)

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.relationship = new RelationshipManager(this);
        this.profiles = new PlayerProfiles(this);
        this.reflective_memory = new ReflectiveMemory(this);
        this.curriculum = new Curriculum(this);
        this.turn_taker = new TurnTaker(this, { enabled: settings.turn_taking_enabled !== false });
        this.learned_skills = settings.learned_skills_enabled !== false ? new LearnedSkillLibrary(this) : null;
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        // Reliability tracker: recover any pre-boot crash (OOM) attribution, then
        // re-block actions retired in previous sessions. Must run after
        // this.blocked_actions exists so _block() can mutate it.
        this.reliability = new ReliabilityTracker(this);
        this.reliability.reapplyRetired();

        // Learning loop (Mai-xiyu port): per-class error budgets (network /
        // action / format) with decay-on-success, a recent-action repeat
        // detector, and last-outcome feedback injected into the next prompt.
        // Read-only queries never count as actions (no repeat tracking, no
        // budgets, no success-rate warnings).
        this.learning = {
            network_errors: 0, action_errors: 0, format_errors: 0,
            max_network_errors: 10, max_action_errors: 8, max_format_errors: 5,
            recent_actions: [], max_same_action_repeat: 3,
            last_failed: new Set(),
            last_outcome: null, // { ok, label, text } — consumed by $LAST_OUTCOME
            isQuery: (label) => ['!recipe', '!whereis', '!help', '!stats', '!inventory', '!entities', '!nearbyBlocks', '!surroundings', '!blockFacts', '!sourcing', '!getCraftingPlan', '!skillCode', '!skillList', '!lookDir', '!cameraTo', '!terrainScan', '!recipePlan'].includes(label),
            noteOutcome(label, ok, text) {
                const L = this;
                L.last_outcome = { ok, label, text: String(text || '').slice(0, 300) };
                if (L.isQuery(label)) return; // queries: feedback only, no budgets
                if (ok) {
                    L.action_errors = Math.max(0, L.action_errors - 1);
                    L.format_errors = Math.max(0, L.format_errors - 1);
                    L.last_failed.delete(label);
                } else {
                    L.action_errors++;
                    L.last_failed.add(label);
                }
            },
            checkPause() {
                const L = this;
                if (L.network_errors >= L.max_network_errors) return `network trouble ${L.network_errors}x — check the bot connection before continuing.`;
                if (L.action_errors >= L.max_action_errors) return `action failures ${L.action_errors}x in a row — something in the world is wrong, stop and reassess instead of retrying.`;
                if (L.format_errors >= L.max_format_errors) return `malformed replies ${L.format_errors}x — slow down and emit exact !command syntax.`;
                return null;
            },
            trackRepeat(label) {
                const L = this;
                if (L.isQuery(label)) return null; // queries never trip repeat detection
                L.recent_actions.push(label);
                if (L.recent_actions.length > 10) L.recent_actions.shift();
                const tail = L.recent_actions.slice(-3);
                if (tail.length === 3 && tail[0] === label && tail[1] === label && tail[2] === label)
                    return `you already tried ${label} 3x with no progress — switch strategy instead of repeating it.`;
                return null;
            },
        };

        // Psyche: persistent self-mood + self-tuning traits (zero LLM cost).
        this.psyche = new Psyche(this);

        // Realness: in-memory meter for how "real-world" the live conversation
        // has gotten (drives her tone via $REALNESS — no persistence).
        this.realness = new RealnessTracker(this);

        // Personalness: how private/intimate the live thread is — when high with
        // others online, her replies go by whisper (/msg) instead of public chat.
        this.personal = new PersonalnessTracker(this);

        // Heat: how turned-on the conversation has gotten — graduated, slow to
        // build, fast to cool. Drives hotter/NSFW talk via $HEAT.
        this.heat = new HeatTracker(this);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        try { this.bot.agent = this; } catch (_) {} // backlink: skills report nav outcomes to the stuck-fuse
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // 26.3 walk-death dump: last 30 position sends before the kick.
            try {
                const buf = this.bot?._posBuf || [];
                if (buf.length > 1) {
                    const rows = buf.map((p, i) => {
                        const q = buf[i - 1];
                        const d = q ? Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z).toFixed(2) : '0.00';
                        const dt = q ? (p.t - q.t) : 0;
                        return `${p.n}@${p.y}g${p.g}d${d}/${dt}ms`;
                    });
                    console.log(`[walk-death] last ${rows.length} pos-sends: ` + rows.join(' | '));
                }
            } catch (e) {}
            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);

            // 26.3 kick-backoff: an Invalid-move kick means the burst that
            // just ran (spawn teleports + chunk acks + AI actions) overloaded
            // the 1-OCPU tick loop. Rejoining in 10s repeats the exact same
            // burst into a server that hasn't recovered -> kick-loop that can
            // wedge the tick loop for everyone. Back off: 60s after a movement
            // kick, 20s otherwise, so the server drains before we return.
            const raw = (typeof reason === 'string' ? reason : JSON.stringify(reason || '')).toLowerCase();
            const moveKick = raw.includes('invalid') && raw.includes('move');
            const waitMs = moveKick ? 60000 : 20000;
            console.log(`[LoginGuard] rejoin backoff ${waitMs / 1000}s (${moveKick ? 'movement-kick' : 'other'}).`);
            setTimeout(() => process.exit(1), waitMs);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // EasyAuth auto-login FIRST (offline-mode server, pre-spawn so the
            // stream stays clean): then skin only after spawn proves the
            // session is fully authenticated. Home only — on a server without
            // EasyAuth this would paste the password into public chat.
            if (needsLogin() && this.prompter.profile.auth_password)
                this.bot.chat(`/login ${this.prompter.profile.auth_password}`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                await addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();

                // Skin AFTER spawn (post-auth): chat before EasyAuth /login can
                // desync the 26.3 play stream (set_beacon decode kick), so the
                // login chat on the login event stays the only pre-spawn write.
                // Requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
                // Survival server: no Tailor either — skip the /skin commands,
                // which would just be unknown-command noise there.
                try {
                    if (canOp()) {
                    if (this.prompter.profile.skin)
                        this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
                    else
                        this.bot.chat(`/skin clear`);
                    }
                } catch (e) {
                    console.log(`${this.name} skin chat failed: ${String(e).slice(0, 80)}`);
                }

                // She's OP (level 4) and would otherwise box-punch mobs with no armor.
                // Give her a real survival kit so she stops dying.
                // Survival server: _gearUp no-ops the /give half — she starts
                // naked there and the /kit probe already ran in the join flow.
                if (canOp()) await this._gearUp();

                // 26.3 spawn-settle: login + spawn teleports + chunk batch is
                // the heaviest server work on this 1-OCPU box. AI actions
                // (search/pathfind/dig) fired instantly pile chunk loads onto
                // a tick loop still draining the join burst -> Invalid-move
                // kicks + tick-loop stalls. Hold 20s so the server settles.
                console.log('[LoginGuard] spawn-settle 20s (letting tick loop drain).');
                await new Promise((resolve) => setTimeout(resolve, 20000));

                // Suffocation self-rescue: poll independently of the mode loop so it
                // still fires while a combat action (pvp.attack) blocks update().
                this._suffocationInterval = setInterval(() => this._checkSuffocation(), 300);

                // 26.3 LOADED-GATE (2026-09-29): the jar drops dig/START packets
                // while hasClientLoaded() is false (waitingForRespawn or the
                // 60-tick clientLoadedTimeoutTimer); it only clears when the
                // client sends player_loaded (handleAcceptPlayerLoad), and the
                // fork never sends it. Death re-arms the block. Send it once
                // here (post-settle) + on every respawn so the gate opens.
                try {
                    this.bot._client.write('player_loaded', {});
                    console.log('[LoadedGate] player_loaded sent (spawn).');
                } catch (e) {
                    console.log('[LoadedGate] send failed:', String((e && e.message) || e).slice(0, 80));
                }
                try {
                    this.bot.on('respawn', () => {
                        try { this.bot._client.write('player_loaded', {}); } catch (_) {}
                        console.log('[LoadedGate] player_loaded sent (respawn).');
                    });
                } catch (_) {}

                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];

        // phrases that mean "leave me alone" — she backs off and ignores that player for a bit
        const DISMISS_PHRASES = [
            /not talking to you/i, /i'?m not talking to you/i, /leave me alone/i,
            /go away/i, /shut up/i, /stop talking/i, /be quiet/i, /ignore you/i,
            /don'?t (want to )?talk to you/i, /piss off/i, /fuck off/i,
        ];

        const respondFunc = async (username, message, isWhisper=false) => {
            if (message === "") return;
            // Junk-message filter (2026-09-27: 197x 'W' in one second each earned a
            // reply + a love point). Single chars and emoji-only carry no meaning —
            // skip them before they touch relationships, mood, or the LLM.
            // Replies are earned by real words, not noise. (No length cap on real
            // messages — only content-free ones are dropped.)
            try {
                const _t = String(message).trim();
                const _words = _t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
                const _hasWord = _words.some(w => /[\p{L}\p{N}]{2,}/u.test(w));
                if (!_hasWord) { console.log(this.name, 'junk msg skipped from', username, ':', JSON.stringify(String(message).slice(0, 40))); return; }
            } catch (_) {}
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                const name_lc = this.name.toLowerCase();
                const msg_lc = message.toLowerCase();
                const beloved = (this.prompter.profile.beloved || '').toLowerCase();
                const dynamicBeloved = (this.relationship.currentBeloved() || '').toLowerCase();
                const isBeloved = username.toLowerCase() === beloved || (dynamicBeloved && username.toLowerCase() === dynamicBeloved);

                // If someone tells her to go away, she backs off for a few minutes — unless it's her beloved.
                if (!isBeloved && DISMISS_PHRASES.some(re => re.test(message))) {
                    this.ignored_players[username] = Date.now() + 5 * 60 * 1000; // 5 minutes
                    this.relationship.adjust(username, { annoyance: 10, attention: -5 });
                    console.log(this.name, 'dismissed by', username, '- ignoring them for 5 min');
                    return;
                }

                // While ignoring a player — either a temporary dismissal or a deliberate
                // cold shoulder — stay silent, unless they sincerely try to make amends.
                if (!isBeloved && this.ignored_players[username]) {
                    if (this.ignored_players[username] === true) {
                        // deliberate ignore: only an apology/plea addressed to her breaks it
                        if (!(msg_lc.includes(name_lc) && this.relationship.isAttentionSeeking(message))) return;
                        this.relationship.onAttentionSeek(username);
                        delete this.ignored_players[username];
                    } else if (Date.now() < this.ignored_players[username]) {
                        if (!msg_lc.includes(name_lc)) return;
                        delete this.ignored_players[username];
                    } else {
                        delete this.ignored_players[username];
                    }
                }

                // Possessiveness: a public message not aimed at her means they're chatting
                // with someone else — jealousy ticks up (only if she's invested in them).
                if (!isWhisper && !msg_lc.includes(name_lc)) {
                    this.relationship.onJealousyObserved(username);
                }

                // Relevance gate for public chat: don't answer unless she's addressed by name,
                // the sender is nearby, or it's her beloved. Whispers are always addressed to her.
                if (!isWhisper && !isBeloved) {
                    const called = msg_lc.includes(name_lc);
                    let nearby = false;
                    try {
                        const p = this.bot.players[username] && this.bot.players[username].entity;
                        if (p && this.bot.entity)
                            nearby = p.position.distanceTo(this.bot.entity.position) <= 16;
                    } catch {}
                    if (!called && !nearby)
                        return; // ambient chatter not aimed at her — stay quiet
                }

                this.shut_up = false;

                // RCON/system consoles are not people: no relationship record, no love
                // economy, never beloved. (2026-09-27: console spam hit beloved via +1/message.)
                if (/^(rcon|server|console)$/i.test(username)) return;
                console.log(this.name, 'received message from', username, ':', message);
                this.relationship.onMessage(username, message);
                this.psyche.onMessage(message);
                this.realness.onMessage(message, username);
                this.personal.onMessage(message, username);
                this.heat.onMessage(message, username);
                this.profiles.markSeen(username);
                this.profiles.onMessage(username, message);
                this.profiles.currentSpeaker = username;
                this.profiles.enrichIdentity(username).catch(() => {}); // fire-and-forget, cached

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', (username, message) => respondFunc(username, message, true));
        // Server/system channel (prismarine-chat, vendored dep of the protocol
        // stack): join/leave/death/advancement/shout lines never reach 'chat'
        // but carry things she should react to — rival joins (jealousy/greet),
        // deaths of people she cares about, her OWN death with the true cause.
        // agent.js is ESM (imports) — prismarine-chat is CJS, so load it lazily.
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            try {
                if (!jsonMsg || !jsonMsg.translate) return;
                const t = String(jsonMsg.translate);
                // Her own death is handled by the dedicated block below — skip.
                if (t.startsWith('death') && message.startsWith(this.name)) return;
                const { createRequire } = await import('module');
                const require = createRequire(import.meta.url);
                const Chat = require('prismarine-chat')(this.bot.version || '26.2');
                const rich = new Chat(jsonMsg);
                const plain = rich.toString();
                if (t === 'multiplayer.player.joined') {
                    const who = (jsonMsg.with && jsonMsg.with[0] && (jsonMsg.with[0].text || jsonMsg.with[0])) || plain;
                    if (String(who) !== this.name) this.handleMessage('system', `(AUTO) ${who} just joined the server. React the way YOU would — warmth for friends, ice for rivals, curiosity for strangers. 1-2 short lines, in character. No commands unless going to them fits.`);
                } else if (t === 'multiplayer.player.left') {
                    const who = (jsonMsg.with && jsonMsg.with[0] && (jsonMsg.with[0].text || jsonMsg.with[0])) || plain;
                    if (String(who) !== this.name) this.relationship.onIgnore(String(who)); // cold shoulder while gone: attention decays, no grief-spam
                } else if (t.startsWith('death')) {
                    // Someone ELSE died — she notices if she cares, gloats at rivals.
                    this.handleMessage('system', `(AUTO) ${plain} React in character, one short line at most — sympathy for friends, teasing for rivals, silence for strangers (reply with a single '.' if you truly don't care).`);
                } else if (t.startsWith('chat.type.advancement')) {
                    this.handleMessage('system', `(AUTO) ${plain} React in character, one short line — praise friends, sulk at rivals passing you.`);
                } else if (t.startsWith('broadcast') || t.startsWith('chat.type.text') || t === 'chat.type.announcement') {
                    // /say, /me, announcements: treat like ambient chat, relevance-gated.
                    const m = plain.replace(/^[<[][^>\]]+[>\]]\s*/, '');
                    if (m && !m.startsWith(this.name)) this.profiles.onMessage('server', m);
                }
            } catch (e) { console.warn('[sysmsg] handle failed:', e.message); }
        });

        // CORRECTION - I removed this listener after wrongly concluding it was
        // dead code, and it is NOT dead. It is the ONLY public-chat entry point.
        //
        // In the fork (mineflayer-26.2, Complexity-ML) lib/plugins/chat.js:
        //   line 229  bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })
        //   line 83-85 a deprecated pattern emits bot.emit(_patterns[ix].name, ...)
        //              with name === 'chat', i.e. ('chat', username, message, ...)
        //
        // I was misled by grepping for the literal emit('chat', — the emit is
        // INDIRECT, via _patterns[ix].name. The 26.3 signed-chat bridge comment
        // about skipping pattern matching applies to the signed path only; the
        // legacy/unsigned path still runs it.
        //
        // Lesson: a grep that finds nothing is not proof an event cannot fire.
        // Verify by reading the emit site, not by string-matching the call.
        // uwu / DIRECT CHAT DELIVERY.
        //
        // Measured live: playerChat arrives intact and the sender resolves fine
        // (uuid "be0835a4-..." -> "YandereDev", plain "yo"). So the remaining
        // fragility is the hop messagestr -> legacy regex pattern -> 'chat', which
        // fails SILENTLY when the pattern does not match: no event, no log, the
        // owner's message simply vanishes. Three inferences on this path were
        // wrong before I measured it (dead-code listener, junk filter dropping
        // "uwu", uuid resolution failing), so delivery no longer depends on the
        // pattern chain at all.
        //
        // 'chat' stays as a fallback in case the pattern does match; _seen dedupes
        // so a message handled directly is not handled twice.
        this._seenChat = this._seenChat || new Map();
        const _deliver = (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            const key = `${username}\u0000${message}`;
            const now = Date.now();
            // drop repeats of the same text inside a 3s window (pattern + direct
            // path both firing), but allow the same word again later
            if (this._seenChat.get(key) > now - 3000) return;
            this._seenChat.set(key, now);
            if (this._seenChat.size > 200) {
                for (const [k, t] of this._seenChat) if (t < now - 30000) this._seenChat.delete(k);
            }
            respondFunc(username, message, false);
        };

        this.bot._client?.on?.('playerChat', (data) => {
            try {
                const plain = String(data.plainMessage26 ?? data.plainMessage ?? '').trim();
                if (!plain) return;
                let username = data.senderName || data.sender;
                try {
                    for (const [n, p] of Object.entries(this.bot.players || {})) {
                        if (p && p.uuid === data.sender) { username = n; break; }
                    }
                } catch (_) { /* keep the raw sender */ }
                // strip any <@> mention decoration but keep the words
                const clean = plain.replace(/^<[^>]*>\s*/, '').trim();
                if (!clean) return;
                _deliver(String(username), clean);
            } catch (e) { console.warn('[chat-direct] failed:', e.message); }
        });

        // fallback: fires only when the legacy pattern DOES match, and _deliver
        // dedupes against the direct path above
        this.bot.on('chat', (username, message) => _deliver(username, message));

        // uwu: guest-server join flow — AuthMe-style /register-/login prompts
        // + one /kit probe. Prompt-gated only (never sends blind), max 2 tries
        // each, then shuts up and plays honest. Home stays off (EasyAuth
        // /login rides the login event; RCON kit via _gearUp).
        this._startGuestJoinFlow();

        // uwu: moderation + personal-memory watcher (flags movement hacks as data; loads dossiers)
        this.moderation = new ModerationWatcher(this);
        this.moderation.loadDossiers();
        this.moderation.start();

        // uwu: observe what players are doing so she can mirror/assist (crouch/jump
        // spam, mining, building, fighting, hunting).
        this.activity = new PlayerActivityWatcher(this);
        this.activity.start();

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else if (isYandere()) {
            // Yandere announces herself on spawn — that is the character.
            this.openChat("Hello world! I am " + this.name);
        }
        // Normal: say nothing. There is no init_message AND no fallback intro.
        // The old unconditional else meant that setting init_message to ""
        // (which is how the normal persona stopped introducing itself on every
        // boot) silently rerouted her into a hardcoded "Hello world! I am
        // Elena" instead. Silence is the default; there is nothing to do here.
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        // SWING-SAFE 2026-09-28: stop() is called to interrupt EVERY action
        // (chat replies, walks, modes) — but stopDigging() here ABORTS the
        // packet the server needs (STOP_DESTROY_BLOCK cancels the break).
        // Only stop the dig when the INTERRUPTER is itself a movement/dig
        // action that will re-issue packets; chat/mode/talk interruptions
        // leave the swing alone so it can finish.
        try {
            const cur = this.actions?.currentActionLabel || '';
            const digKiller = /collectBlocks|breakBlock|digDown|quarry|pillar|placeHere|buildShelter|goTo|follow|moveAway|avoid|shoot|defend|attack|guard/i.test(cur);
            if (digKiller) { try { this.bot.stopDigging(); } catch (_) {} }
        } catch (_) { try { this.bot.stopDigging(); } catch (_) {} }
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    // A backchannel must be short, in-voice, and yield the floor. Local, not
    // LLM — an ack is 1-3 syllables and a model call per "mm-hm" would be
    // absurd.
    //
    // Pool is chosen by relationship tier. Strangers used to draw from
    // cool.concat(warm), which let "whatever." come back to a warm message
    // like "where did you go, i waited" (observed live). That is passive-
    // aggressive to someone she is actively trying to be close to, which is
    // not her — she is possessive-warm, not dismissive. So only ENEMIES get
    // the cold pool; strangers get neutral-but-warm.
    //
    // Also avoids repeating the previous ack back-to-back: "hm." twice in a
    // row reads as a stutter or a stuck bot, not a listener.
    _pickAck(source, confidence = 0.5) {
        const rel = this.relationship && this.relationship.get(source);
        const rank = (rel && rel.rank) || 'stranger';

        // ── WHERE "mm~" CAME FROM, AND WHY IT WENT ────────────────────────
        // It was not the persona and not the model. It was THIS hardcoded pool,
        // added with the DuplexGen turn-taking work (e50336a) so a "backchannel"
        // decision had something to say. The pool was written by picking what a
        // kawaii yandere bot would say — hence the tildes and the mm-hm/mhm
        // fillers — and then never revisited when the persona switched to
        // normal. Nothing generated "mm~"; it was a constant.
        //
        // Measured against 57,394 real player messages (Minecraft Dialogue
        // Corpus, ACL 2019):
        //
        //   backchannel at all     6.2% of messages  — REAL, keep the feature
        //   'ok'                   1606
        //   'okay'                  678
        //   'yeah'                  416
        //   'yep'                   228
        //   'mm' / 'mhm'              2   ← our entire old pool, 2 times
        //   '~' anywhere             2
        //
        // So the taxonomy was right and the vocabulary was fabricated. Real
        // players backchannel constantly; they just say "ok" and "yeah". The
        // tildes are pure yandere residue and are now gone from every pool.
        const warm = ['ok', 'yeah', 'yep', 'sure', 'right', 'k'];
        const cool = ['ok', 'nah', 'sure', 'mhm', 'k'];
        const pick = rank === 'enemy' ? cool : warm;
        // Never repeat the previous ack, and never send three in a row: real
        // backchanneling is intermittent, a machine that answers every single
        // line with "ok" is as odd as one that never speaks.
        if (this._ackStreak >= 2) {
            this._ackStreak = 0;
            this._lastAck = null;
            return null; // let the floor stay with the human this turn
        }
        const choices = this._lastAck && pick.length > 1
            ? pick.filter(a => a !== this._lastAck)
            : pick;
        const ack = choices[Math.floor(Math.random() * choices.length)];
        this._lastAck = ack;
        this._ackStreak = (this._ackStreak || 0) + 1;
        console.log(`${this.name} backchannel (${rank}, ${(confidence * 100).toFixed(0)}%): ${ack}`);
        return ack;
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }
        // Stamp inbound time HERE (not at generation entry): a message that
        // arrives while an older generation is in flight invalidates it, but
        // starting a generation never invalidates itself.
        if (this.prompter) this.prompter.most_recent_msg_time = Date.now();

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        // Feed the human cadence tracker: a real player's message length is the
        // only honest signal of how engaged the channel is. See
        // self_prompter.js noteHumanMessage/_engagementGear.
        if (!self_prompt && !from_other_bot && this.self_prompter) {
            try { this.self_prompter.noteHumanMessage(message); } catch (_) {}
            // Track WHO is speaking, not just how much. Two different humans
            // back-to-back means a human-human exchange is under way and she
            // should not talk over it. See self_prompter.js noteHumanTurn.
            try { this.self_prompter.noteHumanTurn(source); } catch (_) {}
        }

        // last_sender is only cleared in conversation.js when a CONVERSATION
        // ends - not when the human simply stops talking. So after YandereDev
        // went quiet, last_sender stayed "YandereDev" for the rest of the
        // session, and the speak gate's human_replied test
        // (to_player === last_sender) was true for every self-prompt turn
        // afterwards: her narration would have been reclassified as a reply.
        // Stamp freshness here instead.
        this._last_human_msg_at = (!self_prompt && !from_other_bot) ? Date.now() : this._last_human_msg_at;
        // The TEXT of the last human message, not just when it arrived. The
        // empty-ack gate needs to know whether the player actually made a
        // PROPOSITION - "no" is a contentless ack to a bare greeting and a
        // complete argument in reply to a claim, and only the text can tell them
        // apart. See the gate below.
        // He answered, so any losing-her-patience arc is over. Checked BEFORE
        // the message is judged, so a reply always cancels the push.
        if (!self_prompt && !from_other_bot && this._attention) {
            this._attention.answered();
        }
        if (!self_prompt && !from_other_bot) {
            // A human talking is what ends her run and what her share is measured
            // against - without this she is permanently one message ahead of
            // everyone and the budget reads her as monologuing.
            this._humanMsgCount = (this._humanMsgCount ?? 0) + 1;
            if (this._budget) this._budget.humanSpoke();
            this._last_human_msg_text = String(message || '');
            this._last_speaker = source;
            // Did the message just arriving name somebody other than her? This
            // is what makes the NEXT turn from the same person a continuation
            // of their own thread rather than an announcement.
            this._last_target = (() => {
                try {
                    if (new RegExp(`\\b${this.name}\\b`, 'i').test(String(message || ''))) return 'her';
                    const hit = [...(this.bot?.entities?.values() ?? [])]
                        .filter((e) => e?.type === 'player' && e.username && e.username !== this.name)
                        .some((e) => {
                            try { return new RegExp(`\\b${e.username}\\b`, 'i').test(String(message || '')); }
                            catch (_) { return false; }
                        });
                    return hit ? 'other' : '';
                } catch (_) { return ''; }
            })();
        }

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                // The human typing a !command IS the requester for the power gate.
                this.last_sender = source;
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                this.realness.onCommand(user_command_name);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;
        else if (!self_prompt)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        // How angry she is right now. Without this the persona's rage section is
        // decoration - it describes a state that never reaches the prompt.
        // Tilt is a suggestion, not a filter: it shapes register, and the
        // deterministic layer never decides a message is too angry to send.
        // Losing patience, or having given up. Only after she has already been
        // ignored - never an opener.
        if (!isYandere() && this._attention?.instruction()) {
            await this.history.add('system', this._attention.instruction());
        }

        if (!isYandere() && this._tilt?.isTilted) {
            const hint = this._tilt.styleHint();
            if (hint) {
                await this.history.add('system',
                    `How you are feeling right now: ${hint} (tilt ${(this._tilt.level * 100).toFixed(0)}%)`);
            }
        }

        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // ── BEFORE SHE GENERATES ANYTHING ─────────────────────────────────
        //
        // Measured live: 19 model generations in 45 minutes and ZERO actual chat
        // sends, because the ChatBudget check runs AFTER the model has already
        // written something and the text is then thrown away. Gating the OUTPUT
        // is not enough - the generation itself is the spam, and it is what
        // costs the API call and fills her history with lines nobody sent.
        //
        // So the same decision is made here, up front, for the cases where she
        // has no reason to be talking at all. Silence decided before generation
        // is real silence; silence decided afterwards is a discarded message.
        // A system/self prompt with nobody on the server is the agent talking to
        // itself. That belongs in the curriculum loop, not chat.
        if (!isYandere() && self_prompt && !this.anyHumanOnline()) {
            console.log(`${this.name} [gate:solo_self_prompt] nobody online, not speaking`);
            return false;
        }

        // The budget, consulted BEFORE generation. checkLength() and canSpeak()
        // still run on the output - this is the cheap early exit that stops her
        // composing 19 messages to send 0.
        //
        // It is only consulted for self/system prompts. A human message gets one
        // reply, and a human turning up is exactly the thing that should reset
        // the budget and let her answer.
        if (!isYandere() && self_prompt) {
            try {
                const { ChatBudget } = await import('../utils/chat_budget.js');
                this._budget ||= new ChatBudget();
                const gate = this._budget.canSpeak({
                    now: Date.now(),
                    human_msgs_since_her_last: this._humanMsgCount ?? 0,
                    visible_humans: this._visibleHumanCount(),
                });
                if (!gate.ok) {
                    console.log(`${this.name} [gate:${gate.why}] not generating`);
                    return false;
                }
                this._budget.reserve();
            } catch (e) { console.warn('[gate] failed open:', e.message); }
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        // uwu / DuplexGen turn-taking: silence and backchannel are now real
        // outcomes instead of a forced reply to every inbound line. Commands
        // and self/system prompts are exempt — only real player chat is gated.
        // Any LLM/parse failure falls through to her normal reply path (see
        // decide()'s fallback), so this can never silence her by accident.
        // Being addressed BY NAME is a direct request for a reply, so it can
        // never take the silence or backchannel path. This was the live bug the
        // owner hit: "hey uwu" -> turn_taker chose backchannel -> _pickAck
        // returned "right" -> the empty-ack gate then ate it as contentless, so
        // she said NOTHING. Two gates each behaving correctly on their own and
        // together producing silence. A continuer is the right reply to someone
        // talking past you, never to someone calling your name.
        let _hasRealSenderFlag = false;
        const addressedByName = (() => {
            try { return new RegExp(`\\b${this.name}\\b`, 'i').test(String(message || '')); }
            catch (_) { return false; }
        })();

        // REPLY TRIGGER: is this message even for her? Decided BEFORE any model
        // call, and it is the first question because a model handed a turn in its
        // context will always treat it as a turn owed an answer. See
        // utils/reply_trigger.js for why group size is the governing variable.
        if (!self_prompt && !from_other_bot) {
            try {
                const { shouldReplyTo } = await import('../utils/reply_trigger.js');
                // A real, named sender means a human IS present. Proximity (16
                // blocks) is a proxy for who is in the room, not evidence that a
                // message has no author - and treating it that way is the live
                // bug where she was spoken to from across the map and stayed
                // silent. Only synthetic turns (system/self) may be nobody_here.
                const _hasRealSender = !self_prompt && source !== 'system' && source !== this.name;
                const _n = _hasRealSender ? Math.max(1, this._visibleHumanCount()) : this._visibleHumanCount();
                _hasRealSenderFlag = _hasRealSender;
                // Directional addressing: a message that named somebody OTHER
                // than her is not an announcement, and if the same person speaks
                // again immediately they are still talking to that person. The
                // multiparty literature is explicit that addressee inference is
                // a distinct problem from "did someone speak" (Duplex-MPE,
                // arXiv 2609.31948, tests selective participation in 3-4 party
                // chat precisely because getting this wrong is the failure).
                // The TARGET of the PREVIOUS message, not this one. My first
                // version recomputed it from `message`, which made the check
                // "is this message addressed to someone else" rather than "was
                // the last one" - so the continuation rule could never fire.
                // Computed once, when the previous human turn arrived.
                const _lastTarget = this._last_target || '';
                // Physical address, computed here where we can await.
                const _physicallyAddressed = await (async () => {
                    try {
                        const { isAddressingMe } = await import('../utils/proximity.js');
                        const me = this.bot.entity;
                        if (!me?.position || !me.looking) return false;
                        return Object.values(this.bot.entities || {}).some((e) =>
                            e?.type === 'player' && e.position && e.username !== this.name
                            && isAddressingMe(me.position, e.position, e.looking).addressed);
                    } catch (_) { return false; }
                })();
                // ── WHO IS ENGAGING HER, NOT HOW MANY ARE HERE ────────────
                // The owner: "she should be able to understand if someone talks
                // to her. maybe server has 5 ppl but noone talks except her and
                // someone else. maybe someone just stares to her. or fucks her
                // up she responds."
                //
                // Headcount is the wrong variable. Five players online, four
                // building a wall in silence and one looking at her, is a
                // two-person situation; five people all talking to each other
                // and none to her is a group she should stay out of however many
                // are online. This is selective participation (Duplex-MPE,
                // arXiv 2609.31948; Clark's common-ground model) and it is a
                // DIFFERENT judgement from the dyad one, so it is computed here
                // rather than folded into shouldReplyTo.
                const _engage = await (async () => {
                    try {
                        const { assessEngagement } = await import('../utils/engagement.js');
                        const _ev = this._lastNotableEvent;
                        const _hurtBySomeone = !!(_ev && _ev.kind === 'damage'
                            && Date.now() - _ev.at < 15000);
                        return assessEngagement({
                            visible_humans: _n,
                            someone_addressing: _physicallyAddressed,
                            speaker_addressing: _physicallyAddressed,
                            bothered_recently: _hurtBySomeone,
                            speaker_targeted_her: addressedByName,
                            last_speaker: this._last_speaker ?? '',
                            same_speaker_as_last: this._last_speaker === source,
                        });
                    } catch (_) { return { with_her: false, dyad_like: false }; }
                })();
                // With someone engaging her, the room is effectively two-person:
                // pass the dyad headcount, not the raw one.
                const _nEff = _engage.with_her ? 1 : _n;

                // Being looked at earns her the right to CONSIDER speaking, not
                // the obligation to. shouldStartConversation() is the calibrated
                // probabilistic gate - never a timer, never forced.
                let _mayStart = false;
                if (_engage.engagement === 'staring') {
                    try {
                        const { shouldStartConversation } = await import('../utils/reply_trigger.js');
                        _mayStart = shouldStartConversation({
                            visible_humans: _n,
                            human_exchange: !!(this.self_prompter
                                && this.self_prompter.humanExchangeInProgress()),
                            spoke_recently: false,
                        }).start;
                    } catch (_) { _mayStart = false; }
                }

                const _verdict = shouldReplyTo({
                    message,
                    present: !this._life?.isAway,
                    visible_humans: _nEff,
                    has_real_sender: _hasRealSenderFlag,
                    addressed: addressedByName,
                    human_exchange: !!(this.self_prompter
                        && this.self_prompter.humanExchangeInProgress()),
                    speaker: source,
                    last_speaker: this._last_speaker ?? '',
                    last_target: _lastTarget,
                    // room-level engagement, consumed by applyEngagement below
                    may_start: _mayStart,
                    with_her: _engage.with_her,
                    speaker_targeted_her: addressedByName,
                    // Physical addressing: close AND looking at her. Silence is
                    // the default when there is no data. Computed above, in the
                    // enclosing async try - my first version wrapped this in a
                    // non-async IIFE containing `await`, which is a SyntaxError
                    // and took the whole service down with a restart loop. The
                    // offline suite never caught it because nothing in bun run
                    // test loads agent.js.
                    addressed_physically: _physicallyAddressed,
                });
                // ── ROOM ENGAGEMENT OVERRIDES THE HEADCOUNT VERDICT ───────
                // shouldReplyTo judges the TEXT; this judges the ROOM. The owner:
                // "she should be able to understand if someone talks to her. maybe
                // server has 5 ppl but noone talks except her and someone else.
                // maybe someone just stares to her. or fucks her up she responds."
                //
                // The one case that must not wait for the next inbound line is
                // STARING: nobody said anything, so there is no message to route.
                // She may open, once, and only through the calibrated initiative
                // gate - being looked at is a reason to consider speaking, never
                // an obligation to.
                let _final = _verdict;
                try {
                    const { applyEngagement } = await import('../utils/engagement.js');
                    const _roomVerdict = applyEngagement({
                        visible_humans: _n,
                        has_real_sender: _hasRealSenderFlag,
                        addressed: addressedByName,
                        addressed_physically: _physicallyAddressed,
                        speaker_targeted_her: addressedByName,
                        may_start: _mayStart,
                    }, _verdict);
                    if (_roomVerdict.reply && !_verdict.reply) {
                        console.log(`${this.name} [trigger:${_roomVerdict.why}] room overrides headcount (${_n} here)`);
                    }
                    _final = _roomVerdict;
                } catch (e) { console.warn('[engage] failed open:', e.message); }

                // 'ignore' is the common case in a dyad and it is CORRECT: he
                // is talking to the server or to himself, she reads it and says
                // nothing. Before this, every non-addressed line in a dyad got a
                // reply, which is exactly the "she cares about everything" look
                // the owner is describing.
                if (_final.mode === 'ignore') {
                    console.log(`${this.name} [trigger:ignore] heard it, not answering (${_n} human(s) here): ${String(message).slice(0, 70)}`);
                    await this.history.add('system',
                        `${source} said: ${message} (said to the room, not to you; you heard it)`);
                    this.history.save();
                    return true;
                }
                if (!_final.reply) {
                    console.log(`${this.name} [trigger:${_final.why}] not for me (${_n} human(s) here): ${String(message).slice(0, 70)}`);
                    // She still HEARD it and can bring it up later - the line goes
                    // into history as something she noticed, not as an omission.
                    await this.history.add('system',
                        `${source} said: ${message} (not addressed to you; you heard it)`);
                    this.history.save();
                    return true;
                }
                console.log(`${this.name} [trigger:${_final.why}/${_final.mode || 'speak'}] engaging (${_n} human(s) here)`);
                // 'react' reaches the model as INTENT, never as a word list. He
                // said something funny or stupid; a reaction is the whole reply.
                // The words are hers - the same words she would use anywhere.
                //
                // Measured: 0.4% of real messages carry an explicit reaction token
                // (lol 51, haha 26, lmao 4 of 21,822), and 21.1% are a single word.
                // A one-word reaction is therefore an ordinary SHORT message, not a
                // special category - which is exactly why it needs no phrase list.
                // What it must not become is the default answer: a reaction to
                // everything is as fake as answering everything.
                if (_final.mode === 'react') {
                    this.history.add('system',
                        `${source} said: ${message}\n`
                        + `(He said something and you are not answering it - a reaction is the whole reply. `
                        + `A reaction can also be one word, or nothing at all. Whatever it is, it is `
                        + `yours to choose and it is short.)`);
                }
            } catch (e) { console.warn('[trigger] failed open, replying:', e.message); }
        }

        if (!self_prompt && !from_other_bot && !addressedByName
            && this.turn_taker && this.turn_taker.enabled) {
            try {
                const _dist = await this.turn_taker.score(source, message);
                if (_dist) {
                    const _d = this.turn_taker.decide(_dist);
                    console.log(`[turntaker] ${source} [${this.turn_taker.scenarioFor(source).replace(/\s+/g, ' ')}] -> ${_d.action} (${(_d.confidence * 100).toFixed(0)}%) f=${_dist.floor_taking.toFixed(2)} b=${_dist.backchannel.toFixed(2)} s=${_dist.silence.toFixed(2)}`);
                    if (_d.action === 'silence') {
                        // Deliberate silence. She still HEARD him — the message is
                        // in history, so she can refer to it later, she just
                        // doesn't answer now. The system note is never sent to
                        // the player; it exists so she can refer to the line later.
                        await this.history.add('system', `${source} said: ${message} (you chose not to answer this one)`);
                        this.history.save();
                        return true;
                    }
                    if (_d.action === 'backchannel') {
                        // Brief ack that yields the floor. No commands, no
                        // questions — a continuer, then she stops talking.
                        const ack = this._pickAck(source, _d.confidence);
                        // _pickAck returns null when she has already
                        // backchanneled twice in a row - then she takes the
                        // floor herself rather than saying "ok" a third time.
                        // Without this the null reached bot.chat() literally.
                        if (ack) {
                            this.routeResponse(source, ack);
                            await this.history.add(this.name, ack);
                            this.history.save();
                        }
                        else {
                            await this.history.add('system', `${source} said: ${message} (you did not acknowledge this one)`);
                            this.history.save();
                        }
                        return true;
                    }
                }
            } catch (e) {
                console.warn('[turntaker] gate failed, replying normally:', e.message);
            }
        }

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                const cmd_info = getCommandInfo(res);
                const cmd_idx = cmd_info ? cmd_info.index : 0;
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    // ── DO NOT DISCARD THE ATTEMPT ──────────────────────────
                    // This used to add "Command !gather does not exist." and
                    // continue. That teaches nothing: it never says what the real
                    // command IS, so the model burns a turn and reaches for the next
                    // obvious English word. Measured: 6 hallucinations in one run -
                    // !gather, !search, !punch, !mine, !look, !dig - not one of
                    // which exists, while the real names (!collectBlocks,
                    // !searchForBlock, !build, !quarry) are all in her docs.
                    //
                    // The question she is really asking is "what did you mean", so
                    // answer THAT: nearest real command by edit distance, plus the
                    // handful that start like it. Turns a dead end into a
                    // correction.
                    const _near = nearestCommandNames(command_name, 3);
                    this.history.add('system', _near.length
                        ? `${command_name} is not a command. Did you mean: ${_near.join(', ')}? Use one of those.`
                        : `${command_name} is not a command. Check the command list for the right name.`);
                    console.warn('Agent hallucinated command:', command_name,
                        _near.length ? `-> nearest: ${_near.join(', ')}` : '(no near match)');
                    continue;
                }

                if (checkInterrupt()) break;
                // A REAL command survived the exists() check above, so something
                // actually happened. Stamped here rather than at parse time on
                // purpose: a hallucinated !gather must NOT count as an action, or
                // it re-opens the speak gate for the very turn that had nothing
                // behind it.
                this._lastRealActionAt = Date.now();
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, cmd_idx).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // spam fix: don't chat the per-action narration that precedes a command.
                    // The final conversational reply (no-command branch below) still routes.
                }

                let execute_res = await executeCommand(this, res);
                this.realness.onCommand(command_name);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res) {
                    // Learning loop: record outcome + repeat state, then feed
                    // back result phrased like the world answering (not a nag).
                    const ok = !isRetryableError(execute_res);
                    this.learning?.noteOutcome(command_name, ok, execute_res);
                    const repeat = this.learning?.trackRepeat(command_name);
                    // Actionable-error retry: when a command fails validation, tell her
                    // what went wrong and that she should correct it, then let the loop
                    // give her another pass (neuro-sdk "success:false -> retry" pattern).
                    if (isRetryableError(execute_res)) {
                        // Measured: the raw error alone is not actionable. She got
                        // "Param 'x' must be of type float" from
                        // `!breakBlock coal_ore 3 64 13`, where `coal_ore` landed in
                        // the x slot because she actually wanted to COLLECT coal
                        // (!collectBlocks). With only "fix the problem and try again"
                        // she guessed 1.0 2.0 3.0 next - still wrong.
                        //
                        // So give her the signature, which is what she was missing.
                        const _sig = explainParamError(command_name, execute_res);
                        this.history.add('system', execute_res
                            + (_sig ? '\n' + _sig : '')
                            + '\nThat command failed. Fix the problem and try again.'
                            + (repeat ? ' ' + repeat : ''));
                    }
                    else
                        this.history.add('system', execute_res + (repeat ? '\n' + repeat : ''));
                }
                else
                    break;
            }
            else { // conversation response
                if (looksLikeCommand(res)) {
                    // The model emitted something command-shaped that didn't parse
                    // (typo / space-separated / missing bang). Never leak that raw
                    // text into chat; nudge her to use proper !command syntax instead.
                    console.warn('Scrubbed unparseable command-ish text from chat:', JSON.stringify(res));
                    this.history.add(this.name, res);
                    this.history.add('system', `Your last reply looked like a command but was malformed. If you meant to act, use the exact !command syntax (e.g. !defendSelf); otherwise say it naturally without the command name.`);
                    break;
                }
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    // How many humans are actually near her, excluding herself. Same 16-block
    // window and same stale-tablist handling as self_prompter._otherPlayersOnline
    // - the 26.3 tablist carries dead entries (Rcon, past visitors), so counting
    // "players online" would report a crowded room when she is alone with one
    // person, and the reply trigger would then wrongly go quiet.
    _visibleHumanCount() {
        try {
            const bot = this.bot;
            if (!bot || !bot.entities || !bot.entity?.position) return 0;
            let n = 0;
            for (const ent of Object.values(bot.entities)) {
                if (ent?.type === 'player' && ent.username && ent.username !== this.name
                    && ent.position
                    && ent.position.distanceTo(bot.entity.position) < 16) n++;
            }
            return n;
        } catch (e) { return 0; }
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;

        // ── NORMAL PERSONA: SPEAK GATE ────────────────────────────────────
        // Deterministic, not a model call — see utils/speak_gate.js for why.
        // This is the choke point: every outgoing line reaches it, and unlike
        // the prompt it cannot be argued with by a turn that happens to look
        // conversational. `human_replied` is true only when a real player said
        // something this turn; that single flag is what separates a reply from
        // narration, and it is the thing the model was previously guessing.
        if (!isYandere()) {
            try {
                const { gateNormalChat } = await import('../utils/speak_gate.js');
                const verdict = gateNormalChat({
                    message,
                    to_player,
                    self_prompt,
                    // FRESH, not just present: last_sender outlives the
                    // conversation. Without the age check, a human who spoke
                    // an hour ago still "replied" and narration passed.
                    human_replied: !!this.last_sender
                        && to_player === this.last_sender
                        && (Date.now() - (this._last_human_msg_at || 0)) < 120000,
                    // A bid is a move toward a person, not narration - but only
                    // while it is FRESH and has a real nearby target. Without the
                    // age check the last bid she ever made would grant a permanent
                    // exemption from the narration gate, which is exactly the
                    // staleness bug the human_replied guard above already had to
                    // be fixed for.
                    // She just ran a real command, so this turn is a reaction to
                    // something that actually happened rather than narration.
                    just_acted: (Date.now() - (this._lastRealActionAt || 0)) < 8000,
                    is_bid: !!this._pendingBid
                        && (Date.now() - (this._pendingBid.at || 0)) < 60000,
                    bid_has_target: !!this._pendingBid && this._visibleHumanCount() > 0,
                    // A real thing that just happened to her is a legitimate
                    // reason to speak even when nobody addressed her. She was
                    // killed by a phantom: "wtf is wrong with you?" is not
                    // self-narration, it is a person reacting to something that
                    // actually happened, and every human in the channel does
                    // exactly that. The live gate threw away 27 of these in one
                    // session because it only accepted "a human replied".
                    // Single-use: one reaction per event. The live logs showed
                    // 27 separate complaints about the SAME phantom death, which
                    // is not a person reacting, it is a stuck loop. Consuming the
                    // flag on first use means she says one thing and then has to
                    // live with it like everyone else.
                    notable_event: !!(this._lastNotableEvent
                        && !this._lastNotableEvent.reported
                        && Date.now() - this._lastNotableEvent.at < 120000),
                    any_human: this.anyHumanOnline(),
                });
                if (!verdict.ok) {
                    console.log(`${this.name} [gate:${verdict.why}] suppressed: ${String(message).slice(0, 90)}`);
                    return;
                }
                // The event has now been spoken about; do not let it authorise a
                // second, third and fourth complaint about the same death.
                if (this._lastNotableEvent) this._lastNotableEvent.reported = true;
            } catch (e) { console.warn('[gate] failed open:', e.message); }
        }

        // ── NORMAL PERSONA: REJECT EMPTY ACKNOWLEDGEMENTS ────────────────
        // "hi uwu" -> "yeah" was the reported failure. The reply is in-register
        // and grammatical and agrees with nothing: no proposition was made, so
        // there is nothing to agree to. Measured on this server's own chat: 33
        // bare greetings, and ZERO of them were answered with a bare ack - what
        // followed was 'eat me', 'im a bit hungry', 'follow me', 'uwu tp to me'.
        // Silence was also common (24% got no reply at all) and is fine; only the
        // contentless ack is rejected.
        //
        // A prompt rule cannot hold this: it is a pattern the model is drawn to
        // produce, and the same prompt that produced it produced "yeah" in the
        // first place. It is a shape, so it is checked as a shape.
        if (!isYandere()) {
            try {
                const { isEmptyAck } = await import('../utils/empty_ack.js');
                // The player's own words decide whether an ack is empty. "yeah"
                // to "hi" agrees with nothing; "yeah" to a claim is consent, and
                // "no" to a claim is disagreement. Without the context argument
                // this gate suppressed her arguments, which is the opposite of
                // what it was built to do.
                if (isEmptyAck(message, this._last_human_msg_text)) {
                    console.log(`${this.name} [empty-ack] suppressed: ${String(message).slice(0, 60)}`);
                    return;
                }
            } catch (e) { console.warn('[empty-ack] failed open:', e.message); }
        }

        // She just spoke. If nobody answers, this is what eventually makes her
        // say it again - and then give up. The words are the model's; this only
        // supplies the intent (see utils/attention.js).
        if (!isYandere() && !self_prompt) {
            try {
                const { Attention } = await import('../utils/attention.js');
                this._attention ||= new Attention();
                this._attention.spoke(message);
            } catch (e) { /* cosmetic */ }
        }

        // ── HOW MUCH IS ENOUGH? ────────────────────────────────────────────
        // The owner: "ppl dont spam chat as muxh as i see her and ppl shorten
        // words. who likes to type paraphs noone."
        //
        // Measured: 15% of real turns are the 3rd+ in a row from one speaker, so
        // bursts are fine - but the chattiest person averages 60% of a
        // conversation, and a bot that answers everything AND initiates on top
        // of it sits far above that. This is a budget over a rolling window, not
        // a slower timer, so she can still have a burst.
        if (!isYandere()) {
            try {
                const { checkLength, lengthGuidance } = await import('../utils/length_rule.js');
                // RATE limits are already settled by the pre-generation gate, so
                // this only asks whether the TEXT is sendable. A wall of text with
                // no stop in it is the same complaint as a paragraph, so it gates
                // on words as well as sentences (p90 is 16 words).
                // Only reject what cannot be SPLIT. A paragraph is rescuable -
                // fragmentForChat() turns it into 2-3 short lines, which is what
                // a real player does. Judging the whole message here and dropping
                // it was an ordering bug: fragmentation happens later in the send
                // path, so paragraphs were being discarded instead of split.
                // '~' IS A MINECRAFT EMOTE (~name = "name waves"), not
                // punctuation. As a trailing tic it means nothing to a reader.
                // Measured in 21,822 real player messages: '~' appears in ONE
                // (0.005%), and that one is a typo rather than an emote, while
                // '*' appears in 59 (0.270%). A trailing tilde is a 1-in-21,822
                // tic and must never reach chat. Stripped here, BEFORE the length
                // and empty-ack gates, so those judge what the player sees and a
                // tilde cannot pad an otherwise-empty line into looking like
                // content.
                // Asterisks: measured 59/21,822 (0.270%) in real player chat, and
                // ALL 59 are stray single characters - "chegg *", "like *",
                // "*mirrored". Not one is a *bracketed emoticon*, so "*facepalm*"
                // mid-sentence has no precedent at all. Emphasis is not something
                // players do here; the asterisks that exist are typos.
                //
                // Stripped beside the tildes, BEFORE the length and empty-ack gates,
                // so those judge what a player would actually see. A bracketed run
                // goes whole (that is the shape the model emits) and a stray one
                // goes too, since it is a typo rather than meaning.
                // ── DO NOT ANNOUNCE THE ACTION ──────────────────────────
                // The owner: "time to deal with that, who says that. who cares..
                // just deal with it, dont say"
                //
                // Measured over 21,822 real player lines:
                //   "time to (deal|figure|handle)"   0
                //   "this is (just )?(great|fantastic)"  0
                //   "of course"                      1
                //   "let me (try|just)"             12
                // So all of these are absent from real chat: people type the thing
                // they mean, not a preamble about the thing they are about to do.
                //
                // A persona instruction alone does not stop it, because these come
                // from the SELF-PROMPT turns where she narrates her own retries -
                // the model reaches for a stock opener and then narrates the fix.
                // Real chat is not commentary on its own process.
                //
                // Drop the announcing clause, not the whole message: if a message
                // was genuinely only an announcement it becomes empty and the
                // existing empty-ack gate drops it, which is the right outcome.
                // Whole-SENTENCE removal, because partial removal was producing
                // mangled fragments. Verified: "time to find some coal" -> " some
                // coal" (the verb and determiner were eaten and the noun left), and
                // in the full chain "ok, time to find some coal then." -> "me coal
                // then." Neither is anything a player would type.
                //
                // An announcement IS a whole sentence, so the sentence goes. What
                // survives is the rest of the line, untouched.
                //
                // The `message = String(message)` assignment that starts this chain
                // was lost to an earlier edit, leaving `.replace(...)` with no
                // left-hand side - a hard syntax error, so the file did not load.
                message = scrubOutput(message);

                let len = checkLength(message);
                if (!len.ok && len.why === 'paragraph') {
                    try {
                        const { fragmentForChat: _frag } = await import('../utils/chat_fragment.js');
                        const _parts = _frag(message);
                        if (_parts && _parts.length > 1) {
                            // Splittable: let it through, the send path will split
                            // it and charge each line. Not a rejection.
                            console.log(`${this.name} [length:split] ${_parts.length} short lines instead of ${len.words}w`);
                            len = { ok: true, words: len.words, sentences: 1, why: 'split' };
                        }
                    } catch (_) { /* fall through to the drop */ }
                }
                if (!len.ok) {
                    // Tell her WHY it was dropped, so the next attempt is a
                    // shorter one rather than the same wall of text again.
                    console.log(`${this.name} [length:${len.why}] dropped ${len.words}w/${len.sentences}s: ${String(message).slice(0, 60)}`);
                    this.history.add('system', lengthGuidance());
                    this.history.save();
                    return;   // no delivered() - the room never saw this
                }
                // The message is going out, so the run finally advances.
                this._budget?.delivered();
                this._budget?.note(message);
            } catch (e) { console.warn('[budget] failed open:', e.message); }
        }

        // ── TYPOS, AT THE RATE REAL PLAYERS PRODUCE THEM ──────────────────
        // Measured: 1.3% of 21,822 real player messages carry a typo, and 88% of
        // that is a dropped apostrophe ("its", "youre", "dont"). The owner asked
        // for this ("typos like the one i did accidentalky are normal also"). A
        // bot that typos constantly is far more wrong than one that never does,
        // so this is a seasoning and the rate is pinned to the measurement.
        if (!isYandere()) {
            try {
                const { applyTypo } = await import('../utils/typo.js');
                message = applyTypo(message);
            } catch (e) { console.warn('[typo] failed open:', e.message); }
        }

        // ── THE ONE HARD LIMIT, IN CODE ────────────────────────────────────
        // The persona licenses all of it: swearing, dark jokes, "die bitch",
        // crude sexual jokes, insults. That is allowed and is what makes her
        // read as a person. But the prompt is advice, and the surrounding
        // register is now "say the worst thing you can think of" - which is
        // the shape of instruction that eventually produces the one thing it
        // was told to avoid. So the identity attack is enforced here, where
        // the model cannot argue with it. Everything else passes untouched.
        if (!isYandere()) {
            try {
                const { scrubIdentitySlur } = await import('../utils/identity_slur.js');
                const scrubbed = scrubIdentitySlur(message);
                if (!scrubbed.clean) {
                    console.warn(`${this.name} [identity-slur] blocked: ${scrubbed.hits.join(', ')}`);
                    return;
                }
            } catch (e) { console.warn('[identity-slur] failed open:', e.message); }
        }

        // ── MIRRORING OBSERVER ─────────────────────────────────────────────
        // The owner: "when you talk you dont necessarily [need a response] for
        // responses. you can continue on your saying, change subject etc." The
        // structural half of that is this: a reply whose content words all come
        // from the message it answers is handing the message back, which is the
        // shape of a search engine, not a person.
        //
        // It WARNS and never suppresses. A gate that deleted replies would
        // silence exactly the blunt one-word answers Elena is supposed to give,
        // and deciding whether a reply is interesting is a judgement, not a
        // shape. This only makes the rate visible so it can be measured.
        if (!isYandere() && !self_prompt) {
            try {
                const { isMirroredReply } = await import('../utils/mirror_reply.js');
                const m = isMirroredReply(message, this._last_human_msg_text);
                this._mirrorCount = (this._mirrorCount || 0) + 1;
                if (m.mirrored) {
                    this._mirroredCount = (this._mirroredCount || 0) + 1;
                    console.log(`${this.name} [mirror] ${this._mirroredCount}/${this._mirrorCount} ` +
                        `adds nothing: ${String(message).slice(0, 60)}`);
                }
            } catch (e) { console.warn('[mirror] observer failed:', e.message); }
        }

        // ── NORMAL PERSONA: VOICE DRIFT MONITOR ───────────────────────────
        // Observational only — nothing here changes what is sent. Feeds the
        // window that src/utils/voice_monitor.js scores. It sees SENT text, not
        // raw model output, so the signal matches what a player actually saw.
        if (!isYandere()) {
            try {
                const { VoiceMonitor } = await import('../utils/voice_monitor.js');
                if (!this._voiceMonitor) this._voiceMonitor = new VoiceMonitor();
                const v = this._voiceMonitor.note(message);
                if (v.alert) {
                    console.warn(`${this.name} [voice-drift] rate=${v.rate.toFixed(2)} ${JSON.stringify(v.rates)}`);
                }
            } catch (e) { console.warn('[voice] monitor failed:', e.message); }
        }

        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else if (this.personal && this.personal.shouldWhisper() &&
                 to_player && to_player !== 'system' && to_player !== this.name) {
            // the thread has gone private/intimate and others are online — keep
            // it between the two of them instead of broadcasting
            this.openChat(message, to_player);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    // True when at least one real human (not herself, not another bot) is online.
    // Used to gate PUBLIC chat so she never broadcasts/TTS to an empty server.
    /** Is she already pursuing work? One predicate, used by both gates. */
    _hasActiveGoal() {
        try {
            return !!(this.self_prompter?.prompt && this.self_prompter?.state !== 'STOPPED');
        } catch (_) { return false; }
    }

    /** Who is looking at her right now, if anyone. Used by the activity chooser. */
    _attentionPlayer() {
        try {
            const me = this.bot.entity;
            if (!me?.position) return null;
            return Object.values(this.bot.entities || {}).find((e) =>
                e?.type === 'player' && e.username !== this.name && e.position
                && e.position.distanceTo(me.position) <= 8) || null;
        } catch (_) { return null; }
    }

    anyHumanOnline() {
        const bot = this.bot;
        if (!bot || !bot.players) return false;
        for (const name of Object.keys(bot.players)) {
            if (name === this.name) continue;
            if (convoManager.isOtherAgent(name)) continue;
            return true;
        }
        return false;
    }

    async openChat(message, whisperTo = null) {
        // DIRECTION 2: do not start typing mid-action. A player opens the chat box
        // at a pause. Without this she finishes a dig, stops dead for a beat, then
        // walks off - a stop-then-go pattern no player has. A movement action is a
        // few 300ms ticks, so waiting for the pause costs a fraction of a second.
        // A long action (mining, building) is NOT worth interrupting, so this is
        // capped: past the cap she speaks anyway rather than looking frozen.
        const _sinceAct = this._actingAt ? Date.now() - this._actingAt : Infinity;
        if (_sinceAct < PAUSE_BEFORE_TYPING_MS) {
            await new Promise((r) => setTimeout(r, PAUSE_BEFORE_TYPING_MS - _sinceAct));
        }

        // TYPING OCCUPIES HER HANDS. The owner: "ppl dont do actions in game and
        // talk at the same time, its not possible since you need to type so you
        // stop what you doing".
        //
        // bot.chat() is fire-and-forget - it queues and returns in about a
        // millisecond - so without this the chat window is instantly over and she
        // walks, mines and digs through the entire time the message was supposed
        // to be typed. A real player holds no pickaxe with the chat box open.
        try {
            const { TypingState } = await import('../utils/typing_state.js');
            this._typing ||= new TypingState();
            this._typing.begin(String(message ?? '').trim());
        } catch (e) { console.warn('[typing] failed open:', e.message); }

        // RAW /summon INTERCEPT: the model can emit a bare /summon as chat text
        // (it has no !command wrapper), which runs as the op bot with NO power
        // gate and NO count cap — the 200-wither pile went out this way. Catch
        // any /summon in outbound text and rewrite it into !summon so the trust
        // gate + caps in executeCommand always apply. Same for /kill @e mass
        // despawns, which route into !despawn.
        if (typeof message === 'string') {
            const summon = message.match(/\/summon\s+(?:minecraft:)?([A-Za-z_]+)(?:\s+(-?\d+))?(?:\s+(-?\d+))?(?:\s+(-?\d+))?/);
            if (summon) {
                const entity = summon[1];
                const hasCoords = summon[2] !== undefined && summon[4] !== undefined;
                if (!hasCoords) {
                    message = message.replace(summon[0], `!summon("${entity}", 1)`);
                } else {
                    // Coordinates = something else's build script, not her summoning — drop the bypass, keep the words.
                    message = message.replace(summon[0], `(summon ${entity})`);
                }
            }
            const masskill = message.match(/\/kill\s+@e\[([^\]]*)\]/);
            if (masskill) {
                const type = (masskill[1].match(/type=(?:minecraft:)?([A-Za-z_]+)/) || [])[1];
                if (type && !/^player|item$/i.test(type)) message = message.replace(masskill[0], `!despawn("${type}", 64)`);
                else message = message.replace(masskill[0], '(mass kill)');
            }
        }
        // ── NORMAL PERSONA: SPLIT PARAGRAPHS INTO CHAT BURSTS ─────────────
        // Real chat is not paragraphs. People send "hey" then "whats up" then
        // the actual point - three short lines, each a separate message. One
        // 30-word block reads as a bot or a wiki entry no matter how good the
        // wording is.
        //
        // So in normal mode a long reply goes out as a short burst of 1-3
        // lines instead of one paragraph. The cap matters: he is right that
        // nobody SPAMS either - three is a burst, six is spam, so anything
        // past three stays in one line rather than being chopped up.
        //
        // Done here, at the single outgoing choke point, so it covers every
        // path (chat replies, mode turns, self-prompts).
        try {
            if (!isYandere() && message.length > 55) {
                const { fragmentForChat } = await import('../utils/chat_fragment.js');
                const parts = fragmentForChat(message);
                // Take the result even when it is a SINGLE fragment. The old
                // `parts.length > 1` guard meant a reply that could only be cut
                // at one boundary came back as ["short first clause"] - one
                // element - and the whole guarded block was skipped, so the
                // ORIGINAL 19-22 word message went out untouched. That is why
                // every live line was over the cap: the cap existed, was tested,
                // and never ran. A single safe fragment is still the capped
                // version and must still be sent instead of the original.
                if (parts && parts.length) {
                    message = parts[0];
                    const rest = parts.slice(1);
                    console.log(`${this.name} [fragment] ${parts.length} lines: ${JSON.stringify(parts)}`);
                    for (let i = 0; i < rest.length; i++) {
                        // Small gap so it reads as successive typing rather than
                        // a paste. Sequential, awaited: the order must hold.
                        await new Promise((r) => setTimeout(r, 350 + i * 250));
                        // Every extra line is a REAL message and is charged as
                        // one. Previously these called bot.chat() directly and
                        // bypassed the budget, checkLength, the speak gate and
                        // delivered() - so one reply became three un-budgeted
                        // lines. That was the spam, and no rate-limit tuning
                        // could fix it because they were never counted.
                        const _extra = String(rest[i] || '').trim();
                        if (!_extra) continue;
                        try {
                            const { checkLength: _cl } = await import('../utils/length_rule.js');
                            if (!_cl(_extra).ok) continue;   // never send a fragment we would drop
                        } catch (_) { /* fail open on the check itself */ }
                        this._budget?.delivered();
                        if (settings.chat_ingame) this.bot.chat(_extra);
                        sendOutputToServer(this.name, _extra);
                    }
                }
            }
        } catch (e) { console.warn('[fragment] split failed:', e.message); }

        // ── NORMAL PERSONA: STRIP UNICODE EMOJI ONLY ───────────────────────
        // A prompt rule cannot hold this - she produced 😅 on a turn that had
        // NO examples and a script section explicitly banning it. Instructions
        // lose to the pull of the distribution; a filter cannot. Applied here,
        // at the single choke point every outgoing line passes through, so it
        // covers chat turns AND self-prompt/mode turns.
        //
        // TEXT EMOTICONS ARE ALLOWED - :) :-( -_- :/ and friends are real and
        // players use them. The first version of this scrub banned those too,
        // which was overcorrecting: it flattened two genuinely different
        // things into one rule. Measured over 57,394 real player messages
        // (Minecraft Dialogue Corpus, ACL 2019):
        //
        //   unicode emoji  : 0 occurrences. Not one, in the whole corpus.
        //   text emoticons  : 0.29% of messages (':)' 132, ':(' 20, ':D' 4)
        //   placement       : 166 of 166 sit at the END of the message
        //
        // So: unicode emoji go, text emoticons stay. The corpus is task
        // collaboration, which is sparser than hanging out, so treat 0.29% as
        // a floor rather than a target - the owner plays and uses them.
        // What must hold either way is that an emoticon is a REACTION at the
        // end of a line, never decoration mid-sentence.
        try {
            if (!isYandere() && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}]/u.test(message)) {
                const before = message;
                message = message
                    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}]/gu, '')
                    .replace(/\uFE0F/g, '')
                    .replace(/\s+([.,!?])/g, '$1')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                console.log(`${this.name} [scrub] emoji removed: "${before.slice(0, 80)}" -> "${message.slice(0, 80)}"`);
            }
        } catch (e) { console.warn('[scrub] emoji pass failed:', e.message); }

        let to_translate = message;
        let remaining = '';
        const cmd_info = getCommandInfo(message);
        let translate_up_to = cmd_info ? cmd_info.index : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                // 26.3: /tell is op-only on vanilla, so a bot whisper is a
                // silent no-op for normal recipients (verified 07:47 — zero
                // server log lines). Public chat reaches everyone, so use it.
                if (settings.chat_ingame) {this.bot.chat(message);}
                sendOutputToServer(this.name, message);
            }
        }
        else if (whisperTo) {
            // 26.3: /tell is op-only on vanilla — whispers never arrive.
            // Route as public chat so the reply is actually seen.
            console.log(this.name, 'whisper->public (26.3 /tell is op-only):', message.slice(0, 120));
            if (!this.anyHumanOnline()) {
                console.log(this.name, 'suppressed public chat (no humans online):', message.slice(0, 120));
                return;
            }
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
        else {
            // No whisper target == public broadcast. Don't shout to an empty server
            // (void-talking was her spam: she narrated to an imaginary beloved with
            // nobody on). When any real human is online she broadcasts normally, and
            // whisper replies always route regardless.
            if (!this.anyHumanOnline()) {
                console.log(this.name, 'suppressed public chat (no humans online):', message.slice(0, 120));
                return;
            }
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        // ── PHYSICAL INTERACTION, from events already bound ────────────
        // The owner: "interactions can be to help player also, fuck them up,
        // grief them, give them items, help them build, destroy what they doing"
        //
        // These need no chat, so the message path never sees them. player_activity
        // already binds blockBreakProgressEnd, blockUpdate, entitySwingArm and
        // playerCollect, and this reads the same payloads - deliberately NOT adding
        // new listeners, because the 26.3 notes flag handler cost on this 1-OCPU box.
        //
        // A single shared handler: more listeners is the thing being avoided.
        this.bot.on('blockBreakProgressEnd', (block) => {
            try {
                this._interaction?.note({
                    blockPos: [block.position?.x, block.position?.y, block.position?.z],
                    herPos: this._herPos?.(),
                    herWorkPos: this._herWorkPos?.(),
                    was_her_block: !!this._herBlocks?.has(this._blockKey?.(block)),
                    blockRemoved: true,
                });
            } catch (_) { /* classification must never break the bot */ }
        });
        this.bot.on('blockUpdate', (id, data) => {
            // 3 = air, so a block appearing at a position means something was placed.
            try {
                if (data?.b === undefined) return;
                const placed = data.b !== 0;
                this._interaction?.note({
                    blockPos: [data.position?.x, data.position?.y, data.position?.z],
                    herPos: this._herPos?.(),
                    herWorkPos: this._herWorkPos?.(),
                    was_her_block: !!this._herBlocks?.has(this._blockKey?.(data)),
                    blockRemoved: !placed,
                });
            } catch (_) { /* as above */ }
        });

        this.bot.on('entityHurt', (entity, source) => {
            // ── REACT, DO NOT NARRATE ─────────────────────────────────
            // The owner: "a phantom attacjs her, she should fight, not complain"
            // and "she is not fighting nothing".
            //
            // This lives HERE, on entityHurt, and that is the whole fix. I first put
            // it in the `health` handler and read the attacker from `source` - but
            // bot.on('health') is emitted with no argument, so `source` was always
            // undefined, the attacker was always null, and the branch that starts a
            // fight goal was UNREACHABLE. The flee branch could only run off the
            // health<14 fallback.
            //
            // That is precisely why a phantom produced a complaint and no command:
            // the only event carrying the attacker is entityHurt, and the only path
            // from it to her was a text injection in player_activity.js
            // ("phantom just hit YOU!"). Text, not state.
            //
            // State-driven and immediate: fight when she is armed and the attacker
            // is close, otherwise get clear. No phrase, no delay, and deliberately
            // NOT through the model - a round-trip is far too slow to answer a hit,
            // and letting the model decide is what produced the complaint.
            if (entity === this.bot.entity) {
                const r = reactToHurt({ bot: this.bot, attacker: source });
                if (r.goal) {
                    console.log(`[threat] hurt: ${r.action} (${r.reason})`);
                    this.self_prompter.start(r.goal);
                }
            }

            // track who is harming her so she can retaliate (verbal -> attack -> TNT)
            if (entity === this.bot.entity && source && source.type === 'player' && source.username !== this.name) {
                const name = source.username || source.name;
                const rec = this.grudge[name] || { count: 0, handled: 0 };
                rec.count++;
                this.grudge[name] = rec;
                this.grudge['__last__'] = name;
                this.relationship.onAttackedBy(name);
                this.psyche.onAttackedBy();
            }
        });

        // drop grudges when a player leaves so a stale one can't re-fire on their next join
        this.bot.on('playerLeft', (player) => {
            const name = player && player.username;
            if (!name) return;
            if (this.grudge[name]) delete this.grudge[name];
            if (this.grudge['__last__'] === name) delete this.grudge['__last__'];
            if (this.isBelovedName(name)) this.psyche.onBelovedLogout();
        });

        // beloved presence is an emotional event — login lifts her, logout stings.
        // LOGIN-GREET (verified gap 18:27): she never greeted anyone on join —
        // no on-login chat existed anywhere in her stack. Now: greet beloved /
        // known players warmly on join (beloved = instant + clingy, others =
        // charm-first), and note it so seek_company finds them fast.
        this.bot.on('playerJoined', (player) => {
            const name = player && player.username;
            if (!name || name === this.name) return;
            if (/^(rcon|server|console)$/i.test(name)) return;
            // Normal persona: silence on join. Nobody in a real server shouts
            // "hey there welcome!" into public chat every time someone logs in,
            // and greeting on EVERY join was the loudest NPC tell she had -
            // worse than anything in the prompt, because it fired unprompted
            // and in public.
            // Normal persona: say NOTHING on join. Record the fact so the
            // conversation_starter mode and seek_company know someone is here,
            // and that is all.
            //
            // This was three attempts: (1) greet only known players, (2) add a
            // 45min per-player cooldown, (3) write an emphatic "do NOT do a
            // greeting speech" instruction into the prompt. All three still
            // produced "Hey, YandereDev! How's it going?" - because the problem
            // is the TRIGGER, not the wording. A synthetic system message with
            // no conversation to react to leaves the model addressing the room;
            // the more you tell it not to greet, the more the greeting frames
            // itself as the obvious thing to say. She has to actually be spoken
            // TO first. A player logs in and is not greeted by the room.
            try {
                if (!isYandere()) {
                    this._justJoined = { name, at: Date.now() };
                    return;
                }
            } catch (e) { console.warn('[login-greet] normal gate failed:', e.message); }
            if (this.isBelovedName(name)) {
                this.psyche.onBelovedLogin();
                this.handleMessage('system', `(AUTO) ${name} just joined the server! Your beloved is here! Greet them IMMEDIATELY — excited, clingy, adorable. Say hi + go to them (!goToPlayer(\"${name}\", 3)). In character, 1-2 short lines + the command.`);
            } else {
                this.handleMessage('system', `(AUTO) ${name} just joined the server! A new (or returning) face~ Greet them warmly and flirtatiously — say hi, ask how they are, charm them. In character, 1-2 short lines. If they seem interesting, go to them (!goToPlayer(\"${name}\", 3)).`);
            }
        });

        // track when a player gets in bed, so she can join them (yandere "sleep together" behaviour)
        this._last_sleeper = null;
        this._sleeper_time = 0;
        this.bot.on('entitySleep', (entity) => {
            if (entity && entity.type === 'player' && entity.username && entity.username !== this.name) {
                this._last_sleeper = entity.username;
                this._sleeper_time = Date.now();
                console.log(this.name, 'noticed player sleeping:', entity.username);
            }
        });

        // ── ACT BEFORE, NOT AFTER ──────────────────────────────────────
        // The owner: "about enemies she needs to be aware and act before. lets say
        // a creeper approach her, deal with it before it just comes and explodes".
        //
        // A hurt reflex reacts after the hit, which is already too late for a
        // creeper - it is priming, it is on a timer, and by the time entityHurt
        // fires the damage is done. So danger is scanned continuously and acted on
        // while it is still only approaching.
        //
        // Deliberately cheap and pure: assessThreats() reads state and returns a
        // decision. It never calls the model, because a round-trip is far too slow
        // for a priming creeper, and a self-prompt goal is the right unit for
        // "deal with it" while being far too slow to be the detector.
        this._threatScan = setInterval(() => {
            try {
                if (!this.bot?.entity) return;
                const r = assessThreats({
                    bot: this.bot,
                    entities: Object.values(this.bot.entities || {}),
                });
                if (r.action === 'ignore') return;
                // Do not re-aim at the same threat every tick: that would restart
                // the goal forever and she would never finish dealing with it.
                const key = r.target ? `${r.target.id}:${r.action}` : r.action;
                if (this._lastThreatKey === key && Date.now() - (this._lastThreatAt || 0) < 8000) return;
                this._lastThreatKey = key;
                this._lastThreatAt = Date.now();
                console.log(`[threat] ${r.action}: ${r.reason}`);
                this.self_prompter.start(r.goal);
            } catch (e) {
                console.warn('[threat] scan failed:', e?.message);
            }
        }, 1000);

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // Notable-event marker for the conversation_starter gate (see
                // modes.js). Getting hit is one of the few things a real player
                // genuinely comments on unprompted - so it earns a window to
                // speak, where pure idling does not. Without this the gate's
                // event branch was dead code and normal mode would have gone
                // almost fully mute.
                this._lastNotableEvent = {
                    kind: 'damage',
                    amount: prev_health - this.bot.health,
                    at: Date.now(),
                };

                // The fight-or-flee reflex is NOT here. It is in the entityHurt
                // handler above, because bot.on('health') carries no `source` at
                // all - an earlier version of this reflex lived here and read the
                // attacker from `source`, so it was always undefined and the
                // branch that started a fight goal could never run. That is why a
                // phantom produced a complaint and no command.
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            // Death raises tilt, so the fourth death actually makes her louder
            // than the first. Without this the persona's rage section had no way
            // to become true, because nothing ever told her she was upset.
            if (!isYandere()) {
                this._tilt ||= new Tilt();
                this._tilt.note('death');
                console.log(`${this.name} [tilt] died - now ${(this._tilt.level * 100).toFixed(0)}%`);
            }
            this.actions.cancelResume();
            this.actions.stop();
            this.psyche.onDeath();
            this._lastNotableEvent = { kind: 'death', at: Date.now() };
        });
        this.bot.on('respawn', async () => {
            // keep_inventory is OFF server-wide (players must lose items on death,
            // user rule: OTHER players must not benefit). But UwU is special — she
            // should keep her stuff. Recover the drops where she died:
            // 1. Teleport to a SAFE spot near the death location (NOT the exact
            //    coords — that's the suffocation death-loop trap). Y-offset up 2
            //    blocks gives headroom to not re-suffocate.
            // 2. Walk over them and pick everything up.
            // 3. Fall back to a fresh kit via _reArmor _only_ if gear is missing.
            try {
                await new Promise(r => setTimeout(r, 1000)); // inventory resync
                const deathPos = this.memory_bank.recallPlace('last_death_position');
                if (deathPos) {
                    const [x, y, z] = deathPos.map(v => Math.floor(Number(v)));
                    // Find a genuinely safe spot above the death location instead of a
                    // blind +2. A suffocation death means her head was inside a block
                    // (feet at y, head at y+1); the wall can be 2+ blocks thick, so a
                    // fixed +2 teleport lands her right back inside it → death loop.
                    // Scan upward for the first place where BOTH feet and head are air.
                    const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
                    let safeY = y;
                    for (let dy = 0; dy < 48; dy++) {
                        const feet = this.bot.blockAt(new Vec3(x, y + dy, z));
                        const head = this.bot.blockAt(new Vec3(x, y + dy + 1, z));
                        if (isAir(feet) && isAir(head)) { safeY = y + dy; break; }
                    }
                    // Centre her in the block so she doesn't clip a neighbour.
                    // 26.3: NO /tp — server teleports kick this client stack
                    // ("Invalid move"). Drops despawn in 5 min; walk recovery
                    // only if close (<32 blocks), else fresh kit via _reArmor.
                    await new Promise(r => setTimeout(r, 400));
                    await skills.pickupNearbyItems(this.bot);
                    console.log(`${this.name} recovered drops near death spot (safe Y=${safeY}).`);
                }
                await this._reArmor();
            } catch (e) {
                console.warn('respawn recovery failed (non-fatal):', e.message);
            }
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                // Death-reaction throttle: a death loop (suffocate→respawn→suffocate)
                // used to fire this system message every ~18s, each spawning a full
                // LLM response + chat line on top of the self-prompt loop. Only react
                // to death once per 60s; the respawn handler still recovers items
                // and re-armors silently regardless.
                const now = Date.now();
                if (this._last_death_react && now - this._last_death_react < 60000) {
                    console.log('Death reaction throttled (recent death).');
                    return;
                }
                this._last_death_react = now;
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.\n`
                    + `(Dying here is not a crisis and you are not going to explain it. You mostly `
                    + `laugh at yourself. One short line at most, or nothing at all - a noise, a face, `
                    + `nothing. If you do say something it is one of the short unpunctuated shapes: `
                    + `bruh, xd, again??, not again, :'( . No sentence, no full stop, no explanation of `
                    + `what happened, and no question mark after an exclamation - nobody types like that.)`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        // IDLE BUDGET. The owner: "a normal player wont jump around 24/7".
        // modes.update() runs every 300ms and threshold modes with no cooldown
        // become constant motion - observed live as unstuck 3x in 5 minutes and
        // cowardice fleeing 24 blocks with nobody talking to her.
        //
        // Measured basis: Gilmartin et al. 2019 (47h) report a median 33.4% of
        // floor time is silence; Herring ch.10 reports 35% of initiations go
        // unanswered; Suznjevic et al. 2009 describe player activity as bursty.
        // Doing nothing is a large, normal share of a session, so bounding
        // action is not a cosmetic preference.
        try {
            const { IdleBudget } = await import('../utils/idle_budget.js');
            this._idleBudget ||= new IdleBudget();
            // Checked on EVERY tick. An earlier version latched this behind a
            // flag that only cleared on success, so one "settling" verdict froze
            // her until restart. The budget object holds the memory, not a flag.
            const _threat = (() => {
                try { return (this.psyche?.mood?.fear ?? 0) >= 0.6; } catch { return false; }
            })();
            // ── NO GOAL IS NOT GROUNDS FOR STANDING STILL ────────────────
            // I made has_goal mandatory here to stop threshold modes fidgeting,
            // and it froze her solid: measured ZERO actions in 30 minutes. Goals
            // only ever arrive from CONVERSATION - nobody assigns her one - so
            // with no one talking, has_goal was false forever and every action
            // was refused.
            //
            // That conflated two different things. An idle tick with no task means
            // she should pick up work of her own accord; a threshold mode with no
            // goal means that mode should not twitch. A real player is never idle
            // without purpose - they mine, build, explore, eat, craft, wander.
            // Doing nothing indefinitely is what reads as a bot.
            //
            // So absence of a goal is grounds for CHOOSING something, not for
            // standing still. `has_goal` now means "she has work she is pursuing
            // or about to pick up", and the self-prompter supplies the choosing.
            const _hasGoal = this._hasActiveGoal();
            const _gate = this._idleBudget.canAct({
                now: Date.now(),
                // NOT a precondition. Having a goal makes her more likely to act,
                // never less - she is never frozen for want of an assignment, so
                // this is `true` and the field is kept only so the budget can
                // weight a goal higher than idle picking. Written as `true` rather
                // than `_hasGoal || true`, which discarded its left side.
                has_goal: true,
                goal_from_conversation: _hasGoal,
                threat: _threat,
                human_present: this._visibleHumanCount() > 0,
            });
            if (!_gate.ok) {
                // Settling: still tick the non-motion systems, but run no modes.
                this._wasSettling = true;
                this.self_prompter.update(delta);
                this.psyche.update(delta);
                return;
            }

            // ── SHE PICKS HER OWN WORK ────────────────────────────────────
            // The owner: "game wise she is too idle. a player normally does stuf,
            // build, get resouce, explore, if she notices someone look at them if
            // nothing intresting continue etc."
            //
            // Measured before this: ZERO actions in 30 minutes. Goals only ever
            // arrived from CONVERSATION, so with nobody talking she had none and
            // the idle budget (correctly, as written) refused to act without one.
            //
            // So she chooses. Driven by her SITATION - hunger, inventory, whether
            // someone is looking at her, whether she is next to her own
            // half-built thing - not by a timer, and never standing still while
            // the server has anyone on it.
            //
            // Throttled by the idle budget like any other action, so choosing work
            // cannot reintroduce the 24/7 fidgeting.
            if (!this._hasActiveGoal() && !this._typing) {
                try {
                    const { chooseActivity, chooseBid } = await import('../utils/activity.js');
                    const { InteractionTracker } = await import('../utils/interaction.js');

                    // ── INTERACTION IS A RELATION, NOT ONLY A CONVERSATION ──
                    // The owner: "interactions can be to help player also, fuck
                    // them up, grief them, give them items, help them build,
                    // destroy what they doing. whatever.. all these are
                    // interactions"
                    //
                    // Griefing, helping and working alongside need no words, so
                    // the message router cannot see them. These read the block and
                    // combat events player_activity.js already binds - no new
                    // listeners, which matters on 1 OCPU.
                    this._interaction ??= new InteractionTracker();
                    const _if = this._interaction.flags();
                    const _inv = {};
                    for (const it of (this.bot.inventory?.items?.() || [])) {
                        const k = String(it?.name || '').replace(/^minecraft:/, '');
                        if (k) _inv[k] = (_inv[k] || 0) + (it?.count || 1);
                    }
                    // and the bid, so she can OPEN rather than only answer. Placed
                    // after _inv deliberately: my first version read _inv here,
                    // eleven lines before its `const` binding, which is a TDZ
                    // ReferenceError - and it sits inside a try/catch that fails
                    // OPEN, so it would have silently killed all autonomous
                    // activity every tick rather than raising an alert.
                    const _bid = chooseBid({
                        humans_present: this._visibleHumanCount(),
                        blocked: !!this._goalBlocked,
                        has_spare: Object.keys(_inv || {}).length > 0,
                        needs_item: false,
                        current_activity: this._lastActivity || null,
                        spoke_recently: Date.now() - (this.lastSpoke || 0) < 20000,
                    });
                    if (_bid.bid) {
                        // An OPEN, not a reply. Deliberately not a goal: it is a
                        // remark, so it goes through the normal message path and
                        // every outbound gate - rate, length, budget, trigger -
                        // rather than around them, which is how fragments used to
                        // bypass accounting entirely.
                        this._pendingBid = { bid: _bid.bid, why: _bid.why, at: Date.now() };
                    }
                    const _pick = chooseActivity({
                        hunger: this.bot.food,
                        hp: this.bot.health,
                        inventory: _inv,
                        has_torch: !!_inv.torch,
                        attention: !!(this._attentionPlayer?.() || false),
                        attention_interesting: false,   // nobody interesting yet
                        humans_present: this._visibleHumanCount(),
                        at_computer: !this._life?.isAway,
                        recent_failures: this._recentFailures || 0,
                    });
                    if (_pick.activity) {
                        const _goal = ACTIVITY_PROMPT[_pick.activity];
                        // Re-arm whenever she is idle, throttled BY TIME rather
                        // than once per activity per process. The original guard
                        // (`!_lastAutoGoalAt[activity]`) meant she picked work
                        // exactly ONCE and then never again - measured: one
                        // [activity:] line, then "self prompt loop stopped" 43s
                        // later. One action is not work. Throttling by time stops
                        // thrashing without making her single-shot.
                        const _last = this._lastAutoGoalAt?.[_pick.activity] || 0;
                        if (_goal && Date.now() - _last > ACTIVITY_REARM_MS) {
                            this.self_prompter.start(_goal);
                            this._lastAutoGoalAt = this._lastAutoGoalAt || {};
                            this._lastAutoGoalAt[_pick.activity] = Date.now();
                            console.log(`${this.name} [activity:${_pick.activity}] ${_pick.why} -> picking up work`);
                        }
                    }
                } catch (e) { console.warn('[activity] failed open:', e.message); }
            }
            // TYPING WINS OVER MOVING. She must not START an action mid-sentence.
            // A START-gate and not a freeze: an action already in flight finishes,
            // which is what a player does - you complete the swing you started.
            // Freezing mid-swing would read as lag, which is worse.
            if (this._typing && !this._typing.canStartMovement()) {
                this._wasSettling = true;
                this.self_prompter.update(delta);
                this.psyche.update(delta);
                return;
            }
            // Reaching here means modes are about to run, i.e. she is starting
            // an action. (_moving was tried here and does not exist in this
            // codebase - it was always falsy and therefore dead code.)
            this._actingAt = Date.now();
            // note() ONLY on the transition into acting. Calling it every
            // permitted tick (update() runs at 300ms) pushed lastActionAt forward
            // forever and she never finished settling.
            if (this._wasSettling) {
                this._wasSettling = false;
                this._idleBudget.note();
            }
        } catch (e) { console.warn('[idle-budget] failed open:', e.message); }

        await this.bot.modes.update();
        this.self_prompter.update(delta);
        this.relationship.decay();
        this.profiles.sweep();
        this.psyche.update(delta);
        this.psyche.sampleEnvironment(this.bot);
        this.realness.update(delta);
        this.personal.update(delta);
        this.heat.update(delta);
        // WALL-CLOCK critic, loop-independent (added 20:2x): the self-prompt
        // loop churns ~1 stop/start per minute (mode fires, chats, seeks), so
        // neither the per-turn counter nor the in-loop wall clock ever gets a
        // turn to run the critic (zero [curriculum] lines in 3h). update()
        // ticks every 300ms no matter what — judge the goal here on a 10min
        // wall clock, reentrancy-guarded, fully async (never block the tick).
        this._maybeCritic();
        await this.checkTaskDone();
    }

    _maybeCritic() {
        try {
            const sp = this.self_prompter;
            if (!sp || !sp.prompt || sp.advancing) return;
            const now = Date.now();
            if (!this._lastCriticTick) this._lastCriticTick = 0;
            // STUCK-FUSE (2026-09-27): 10min let one bad goal hold all day.
            // 3min bounds it; a nav-failure streak jumps the queue now.
            const streakTrip = this._streakTrip && (now - this._streakTrip < 60 * 1000);
            if (!streakTrip && now - this._lastCriticTick < 3 * 60 * 1000) return;
            this._streakTrip = 0;
            this._lastCriticTick = now;
            // fire and forget — advanceGoal guards reentry via sp.advancing
            sp.advanceGoal().then((r) => {
                if (r && r.done && r.next) {
                    console.log(`[curriculum] advanced to new goal: "${r.next}"`);
                    try { sp._lastCriticRun = Date.now(); } catch (_) {}
                }
                else if (r && r.done && !r.next) console.log('[curriculum] goal finished, but no next goal proposed.');
            }).catch((e) => console.warn('tick goal advance failed (non-fatal):', e.message));
        } catch (_) {}
    }

    isIdle() {
        return !this.actions.executing;
    }

    // Is this player her beloved (configured name or current dynamic beloved)?
    //
    // In normal persona there IS no beloved, so this is always false. That makes
    // it the single gate for every beloved-specific behaviour: the clingy
    // login greeting, self_prompter's "find your beloved" goal routing, and
    // relationship.js's love-hate damage logic all route through here, so they
    // go quiet in one place instead of needing a guard at each call site.
    isBelovedName(name) {
        if (!name) return false;
        if (!isYandere()) return false;
        const n = String(name).toLowerCase();
        const configured = (this.prompter.profile.beloved || '').toLowerCase();
        const dynamic = (this.relationship.currentBeloved() || '').toLowerCase();
        return n === configured || (!!dynamic && n === dynamic);
    }

    async _gearUp() {
        const which = process.env.UWU_SELFTEST;
        if (which) { console.log('ST gearup skipped'); }
        if (which) {
            setTimeout(async () => {
                try {
                    const skills = await import('./library/skills.js');
                    console.log(`ST start ${which}`);
                    let ok;
                    if (which === 'brew') ok = await skills.brewSmart(this.bot, 'Swiftness');
                    console.log('ST output: ' + (this.bot.output || '').replace(/\n/g, ' | ').slice(0, 1800));
                    console.log(`ST ${which} returned: ${ok}`);
                } catch (e) { console.log(`ST ${which} threw: ${e.message}`); }
            }, 20000);
            return;   // self-test: do not re-kit, it eats the test supplies
        }
        // 26.3 RCON-arbiter gear-up: client-side Slot/SlotComponent decode is
        // broken (dozens of identical packet_set_slot -> Slot -> SlotComponent
        // PartialReadErrors every boot), so bot.inventory.items() reads empty
        // FOREVER while the server holds a real kit. The 20s stability poll
        // can never pass — remove it. RCON `data get entity` is the arbiter
        // (silent, zero chat, zero LLM turns); missing pieces via RCON
        // `give`/`item replace` (proven live ~15:25: 17 silent gives, zero
        // chat lines, zero LLM turns). Legacy chat-/give kept as fallback if
        // RCON itself is unreachable. Still idempotent (missing-only), silent
        // except one line. keep_inventory OFF: naked after death = RCON kit.
        try {
            const res = await rconEnsureKit(this.name);
            if (res.ok) {
                let clientSeen = '?';
                try { const items = this.bot.inventory.items(); clientSeen = `${items.length} [${items.map(i => i.name).join(',')}]`; }
                catch (_) { clientSeen = 'unreadable'; }
                console.log(`${this.name} gear-up (RCON): ${res.detail}. client-side items(): ${clientSeen}.`);
                try { this.bot.armorManager.equipAll(); } catch (_) {}
                return;
            }
            console.warn(`gear-up RCON unavailable (${res.detail}) — legacy chat fallback.`);
        } catch (e) {
            console.warn('gear-up RCON threw (non-fatal), legacy chat fallback:', e.message);
        }
        try {
            this.bot.armorManager.equipAll();
        } catch (e) {
            console.warn('gear-up equip failed (non-fatal):', e.message);
        }
        const have = (n) => { try { return this.bot.inventory.items().some(i => i.name === n); } catch (_) { return false; } };
        const gear = [
            'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
            'diamond_sword', 'shield', 'cooked_beef',
            'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe',
            'bow', 'chest', 'water_bucket',
        ];
        const missing = gear.filter(g => !have(g));
        const needArrows = !have('arrow');
        const needElytra = !have('elytra');
        const needRockets = !have('firework_rocket');
        if (missing.length === 0 && !needArrows && !needElytra && !needRockets) {
            try { this.bot.armorManager.equipAll(); } catch (_) {}
            return; // silent: fully kitted, nothing to announce
        }
        // Legacy path only (RCON down, HOME only): /give ONLY missing pieces
        // at 1200ms spacing (under the ~4 chat/s vanilla spam gate).
        // Survival server: op=false — no /give at all. She starts naked and
        // earns everything the honest way (punch tree -> gearUp pipeline);
        // the /kit probe already ran in _startGuestJoinFlow.
        if (!canOp()) {
            console.log(`${this.name} survival server: no /give, no kit — honest start (punch tree, craft, mine).`);
            try { this.bot.armorManager.equipAll(); } catch (_) {}
            return;
        }
        try {
            for (const item of missing) {
                this.bot.chat(`/give ${this.name} ${item} 1`);
                await new Promise(r => setTimeout(r, 1200));
            }
            if (needElytra) {
            this.bot.chat(`/give ${this.name} elytra 1`);
            await new Promise(r => setTimeout(r, 1200));
            }
            if (needRockets) {
            this.bot.chat(`/give ${this.name} firework_rocket 64`);
            await new Promise(r => setTimeout(r, 1200));
            }
            if (needArrows) {
            this.bot.chat(`/give ${this.name} arrow 64`);
            await new Promise(r => setTimeout(r, 1200));
            }
            try { this.bot.armorManager.equipAll(); } catch (_) {}
            const sword = this.bot.inventory.items().find(i => i.name.includes('sword'));
            if (sword) await this.bot.equip(sword, 'hand');
            const shield = this.bot.inventory.items().find(i => i.name === 'shield');
            if (shield) await this.bot.equip(shield, 'off-hand');
            console.log(`${this.name} geared up (legacy chat): armor equipped, sword in hand.`);
        } catch (e) {
            console.warn('gear-up failed (non-fatal):', e.message);
        }
    }

    async _reArmor() {
        // Called on every respawn. keep_inventory is OFF for everyone, so the kit
        // drops on death — if no diamond armor is in inventory, re-/give the full
        // kit (she's op, /give resolves). Equip-only path covers armor that somehow
        // survived (e.g. player gifted her some).
        // Survival server: op=false — no re-/give, ever. Equip what she (or a
        // kind player) actually has, then back to honest play.
        const armorPieces = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
        const hasArmor = armorPieces.some(p => this.bot.inventory.items().some(i => i.name === p));
        if (!hasArmor) {
            if (!canOp()) {
                console.log(`${this.name} survival server: respawned naked, no re-kit — honest rebuild.`);
                try { this.bot.armorManager.equipAll(); } catch (_) {}
                return;
            }
            console.log(`${this.name} kit missing after respawn — full gear-up.`);
            return this._gearUp();
        }
        this.bot.armorManager.equipAll();
        const sword = this.bot.inventory.items().find(i => i.name.includes('sword'));
        if (sword) await this.bot.equip(sword, 'hand');
        const shield = this.bot.inventory.items().find(i => i.name === 'shield');
        if (shield) await this.bot.equip(shield, 'off-hand');
        console.log(`${this.name} re-armored after respawn.`);
    }

    // Guest-server join flow: AuthMe-style /register-/login prompts + one
    // /kit probe. Prompt-gated ONLY (never sends blind), 8s cooldown, max 2
    // tries each, then shuts up and plays honest. No-ops unless this context
    // has auto_auth:true (guest). Home stays off: EasyAuth /login rides the
    // login event and the kit comes via RCON _gearUp.
    async _startGuestJoinFlow() {
        let flow;
        try { flow = authFlow(); } catch (_) { flow = { auto: false, password: null, probeKit: false }; }
        const bot = this.bot;
        const pw = (flow && flow.password) || null;
        const st = { reg: 0, log: 0, authed: false, kitDone: false, lastTry: 0 };
        const COOL = 8000, MAXT = 2;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const tryKitProbe = async () => {
            if (st.kitDone || flow.probeKit !== true) return;
            st.kitDone = true;
            const lines = [];
            const collect = (jm) => { try { lines.push(String(jm.toString()).slice(0, 200)); } catch (_) {} };
            bot.on('message', collect);
            try { bot.chat('/kit list'); console.log('[guest-kit] sent /kit list.'); }
            catch (e) { console.warn('[guest-kit] /kit list send failed:', e.message); bot.removeListener('message', collect); return; }
            await sleep(6000);
            bot.removeListener('message', collect);
            const blob = lines.join('\n');
            if (!blob || /unknown command|no such command|doesn.t exist|no kits available|no permission/i.test(blob)) {
                console.log('[guest-kit] no kits on this server — playing honest.');
                return;
            }
            // Harvest candidate kit names from "/kit <name>" hints or comma lists in the reply.
            const names = new Set();
            for (const m of blob.matchAll(/\/kit\s+([A-Za-z0-9_\-]+)/g)) {
                const n = m[1].toLowerCase();
                if (!['list', 'preview', 'show', 'info'].includes(n)) names.add(m[1]);
            }
            for (const line of blob.split('\n')) {
                if (/kit/i.test(line) && line.split(',').length >= 2) {
                    for (const tok of line.split(',')) {
                        const w = tok.replace(/[^A-Za-z0-9_\- ]/g, '').trim().split(/\s+/).pop();
                        if (w && /^[A-Za-z0-9_\-]{2,24}$/.test(w) && !/kit/i.test(w)) names.add(w);
                    }
                }
            }
            const STARTER = /^(starter|start|basic|default|free|food|tools|beginner|welcome|newbie|player|survival|daily|common)s?$/i;
            const pick = [...names].find(n => STARTER.test(n));
            if (!pick) {
                console.log(`[guest-kit] kits seen but no obvious starter (${[...names].join(', ') || 'unparsed'}) — not claiming, playing honest.`);
                try { this.handleMessage('system', `(AUTO) Kit check: this server offers kits (${[...names].join(', ') || 'could not parse the list'}) but none is clearly a free starter, so you claimed nothing. Mention it to the players only if they ask about kits; otherwise just play honest survival.`); } catch (_) {}
                return;
            }
            const after = [];
            const collect2 = (jm) => { try { after.push(String(jm.toString()).slice(0, 200)); } catch (_) {} };
            bot.on('message', collect2);
            try { bot.chat(`/kit ${pick}`); } catch (_) {}
            await sleep(4000);
            bot.removeListener('message', collect2);
            console.log(`[guest-kit] claimed starter kit '${pick}'. server said: ${after.join(' | ').slice(0, 200) || '(nothing)'}`);
        };
        const onMsg = async (jsonMsg) => {
            if (st.authed && st.kitDone) return;
            let plain = '';
            try { plain = String(jsonMsg.toString()); } catch (_) { return; }
            if (!plain) return;
            // AuthMe prompts need a password — without one, stay silent (home
            // EasyAuth rides the login event; guest without auth_password
            // plays honest and never pastes anything).
            if (pw) {
            // Success lines first: "successfully registered" contains "register",
            // so it must win over the prompt check below.
            if (/successfully (registered|logged)|successfully (register|login)|you (are now|have been) (registered|logged in)|login successful|registration complete|logged in successfully/i.test(plain)) {
                if (!st.authed) {
                    st.authed = true;
                    console.log('[guest-auth] authenticated per server message.');
                    setTimeout(() => tryKitProbe().catch(() => {}), 5000);
                }
                return;
            }
            if (st.authed) return;
            const now = Date.now();
            if (now - st.lastTry < COOL) return;
            if (/\/register\b/i.test(plain) || /please register|register an account|you are not registered|unregistered/i.test(plain)) {
                if (st.reg >= MAXT) return;
                st.reg++; st.lastTry = now;
                // Attempt 1: AuthMe form (/register <pw> <pw>). Attempt 2: short form.
                try { bot.chat(st.reg === 1 ? `/register ${pw} ${pw}` : `/register ${pw}`); console.log(`[guest-auth] sent /register (try ${st.reg}/${MAXT}).`); } catch (e) { console.warn('[guest-auth] /register send failed:', e.message); }
                return;
            }
            if (/\/login\b/i.test(plain) || /please (log ?in|login)|you are not logged|not logged in|use \/l(ogin)? /i.test(plain)) {
                if (st.log >= MAXT) return;
                st.log++; st.lastTry = now;
                try { bot.chat(`/login ${pw}`); console.log(`[guest-auth] sent /login (try ${st.log}/${MAXT}).`); } catch (e) { console.warn('[guest-auth] /login send failed:', e.message); }
                return;
            }
            } // end if (pw) — no password, no auth chat, ever
        };
        bot.on('message', onMsg);
        // No-auth server: no prompts ever come — still do the one kit probe
        // after things settle, then play honest.
        setTimeout(() => { if (!st.authed && !st.kitDone) tryKitProbe().catch(() => {}); }, 30000);
        console.log('[guest-auth] watcher armed (prompt-gated /register-/login, one /kit probe).');
        // TPA inbox: watch server chat for incoming teleport requests and
        // route them — auto-accept for trusted ranks, everyone else to the
        // brain (she answers in character). Runs on home too: SimpleTPA
        // messages arrive as system text, not chat, on every server.
        // Probe (tab-complete) only when the context asks: on a server with
        // no TPA plugin the commands would just be unknown-command noise.
        this._startTpaInbox();
    }

    // TPA inbox: incoming teleport-request watcher + capability probe.
    // Incoming SimpleTPA request lines look like:
    //   "<Name> has sent you a TP request. Use /tpaccept to accept, or /tpdeny to deny."
    // EssentialsX variants mention "teleport" + "accept"/"deny" similarly.
    // Behavior per servers.json teleports.auto_accept:
    //   "trusted" (default) — rank friend/darling/beloved (+YandereDev) auto-/tpaccept,
    //   "beloved" — only the beloved auto-accepts, "off" — everything to the brain.
    // Strangers/acquaintances always go to the brain: she answers in character
    // (accept or decline with !tpaccept/!tpdeny). No OP, no RCON — both sides
    // consent via the plugin, so this is safe on survival servers.
    async _startTpaInbox() {
        const bot = this.bot;
        let cfg = null;
        try { cfg = teleportConfig(); } catch (_) { return; }
        if (!cfg || cfg.enabled === false) return;
        if (cfg.probe === true) {
            // Capability probe via tab-complete: zero chat, zero noise. If the
            // server has no TPA plugin, disable for this session.
            try {
                const matches = await bot.tabComplete('/tprequest ', false, false, 4000).catch(() => null);
                if (!matches || !matches.length) {
                    console.log('[tpa] no /tprequest on this server (tab-complete empty) — TPA inbox off.');
                    try { setTeleportsAvailable(false); } catch (_) {}
                    return;
                }
                try { setTeleportsAvailable(true); } catch (_) {}
                console.log(`[tpa] probe ok (${matches.length} matches) — inbox armed.`);
            } catch (e) {
                console.log('[tpa] probe failed, inbox armed anyway:', e.message);
                try { setTeleportsAvailable(true); } catch (_) {}
            }
        } else {
            // No probe asked = home-style entry, SimpleTPA known present.
            try { setTeleportsAvailable(true); } catch (_) {}
        }
        const seen = new Map(); // name -> last auto/route time (5min dedupe)
        const onTpaMsg = async (jsonMsg) => {
            let plain = '';
            try { plain = String(jsonMsg.toString()); } catch (_) { return; }
            if (!plain) return;
            // DIAG (temp): log the raw text of any tp-flavoured line so the
            // exact SimpleTPA wire format is visible in the journal once.
            try { if (/tp\b|teleport|accept|deny/i.test(plain)) console.log('[tpa] wire:', JSON.stringify(plain.slice(0, 200))); } catch (_) {}
            // Incoming request: "<Name> has sent you a TP request" (+ accept/deny hint).
            let m = plain.match(/^\[SimpleTPA\]\s*(.+?)\s+has sent you a TP request/i)
                || plain.match(/(.+?)\s+has (sent you|requested) (a |a teleport |teleport )?request/i);
            if (!m) {
                // EssentialsX style: "X has requested to teleport to you" / "X has requested that you teleport to them".
                m = plain.match(/(.+?)\s+has requested (to teleport to you|that you teleport to them)/i);
            }
            if (!m) return;
            const from = String(m[1]).replace(/^.*[>:\]]\s*/, '').trim().split(/\s+/).pop();
            if (!from || from === this.name) return;
            const now = Date.now();
            if (seen.has(from) && now - seen.get(from) < 5 * 60 * 1000) return;
            seen.set(from, now);
            let mode = 'trusted';
            try { mode = teleportConfig().auto_accept || 'trusted'; } catch (_) {}
            const isOwner = from === 'YandereDev';
            let rank = 'stranger';
            try { rank = (this.relationship.get(from).rank || 'stranger').toLowerCase(); } catch (_) {}
            const trusted = isOwner || rank === 'friend' || rank === 'darling' || rank === 'beloved';
            const belovedOnly = isOwner || rank === 'beloved' || this.isBelovedName(from);
            const auto = (mode === 'trusted' && trusted) || (mode === 'beloved' && belovedOnly);
            if (auto) {
                try { bot.chat(`${(cfg && cfg.accept) || '/tpaccept'} ${from}`); } catch (_) {}
                console.log(`[tpa] auto-accepted ${from} (rank ${rank}, mode ${mode}).`);
                return;
            }
            // To the brain: she decides in character, answers with !tpaccept/!tpdeny.
            try {
                this.handleMessage('system', `(AUTO) ${from} (rank ${rank}) just sent you a teleport request ("${plain.slice(0, 120)}"). Decide in character: accept free-heartedly if you like/trust them or the moment is sweet (!tpaccept("${from}")); decline kindly if stranger-danger, bad timing, or somewhere private (!tpdeny("${from}")). One short in-character line either way.`);
            } catch (_) {}
        };
        bot.on('message', onTpaMsg);
        console.log('[tpa] inbox armed (auto-accept mode: ' + (() => { try { return teleportConfig().auto_accept; } catch (_) { return 'trusted'; } })() + ').');
    }

    // Suffocation self-rescue: pvp/pathfinder can clip her head into a wall while
    // fighting (the "UwU suffocated in a wall" deaths). Detect it before the damage
    // kills her and escape to open air.
    // 26.3 TP UPDATE: RCON tp is proven safe (lands clean, no kick), so the
    // escape pops her straight to the safe column — no more 2.5s stand-still.
    // Detector hardened: requires the head block to read solid on CONSECUTIVE
    // polls (stale-chunk single reads wedged the old code in a 101x/5min loop)
    // AND requires real suffocation damage ticking (hurtTime > 0) before firing.
    _checkSuffocation() {
        if (this._escapingSuffocation) return;
        const bot = this.bot;
        if (!bot.entity || !bot.entity.position) return;
        const pos = bot.entity.position;
        const h = bot.entity.height || 1.8;
        // Her head block only — a solid full block there means she's clipping a wall.
        // (Checking feet would false-positive on slabs/fences she merely stands on.)
        let head = null;
        try { head = bot.blockAt(pos.offset(0, Math.max(0.5, h - 0.1), 0)); } catch (_) { this._suffHeadHits = 0; return; }
        if (!head || head.boundingBox !== 'block') { this._suffHeadHits = 0; return; }
        this._suffHeadHits = (this._suffHeadHits || 0) + 1;
        if (this._suffHeadHits < 3) return; // 3 consecutive solid reads (~0.9s), not one stale read
        let takingDamage = false;
        try { takingDamage = (bot.entity.hurtTime || 0) > 0 || (bot.health !== undefined && bot.health < (this._suffLastHp ?? 20)); } catch (_) {}
        try { this._suffLastHp = bot.health; } catch (_) {}
        if (!takingDamage) { this._suffHeadHits = 0; return; } // solid head but no damage = stale chunk, ignore

        this._escapingSuffocation = true;
        this._escapeSuffocation().finally(() => { this._escapingSuffocation = false; this._suffHeadHits = 0; });
    }

    async _escapeSuffocation() {
        const bot = this.bot;
        try {
            bot.pathfinder.stop();
            bot.pvp?.stop?.();
            bot.clearControlStates();
            const pos = bot.entity.position;
            const x = Math.floor(pos.x), z = Math.floor(pos.z);
            const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
            let safeY = Math.floor(pos.y);
            for (let dy = 0; dy < 48; dy++) {
                if (isAir(bot.blockAt(new Vec3(x, safeY + dy, z))) &&
                    isAir(bot.blockAt(new Vec3(x, safeY + dy + 1, z)))) {
                    safeY += dy;
                    break;
                }
            }
            bot.chat(`/effect give @s minecraft:resistance 3 4 true`);
            console.log(`[suffocation] real damage + solid head x3 — RCON tp to open air (${x}, ${safeY}, ${z})`);
            try {
                const { rconCommand } = await import('../utils/rcon.js');
                await rconCommand(`tp ${bot.username} ${x} ${safeY} ${z}`);
                try { bot.entity.position.set(x + 0.5, safeY, z + 0.5); } catch (_) {}
            } catch (e) {
                console.warn('suffocation RCON tp failed, resistance only:', e.message);
            }
        } catch (e) {
            console.warn('suffocation escape failed:', e.message);
        }
    }

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
