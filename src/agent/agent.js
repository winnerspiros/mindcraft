import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, getCommandInfo, isRetryableError, looksLikeCommand } from './commands/index.js';
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
import { ModerationWatcher } from './moderation.js';
import { PlayerActivityWatcher } from './player_activity.js';
import { RelationshipManager } from './relationship.js';
import { PlayerProfiles } from './profiles.js';
import { ReliabilityTracker } from './reliability.js';
import { Psyche } from './psyche.js';
import { RealnessTracker } from './realness.js';
import { PersonalnessTracker } from './personalness.js';
import { HeatTracker } from './heat.js';
import { ReflectiveMemory } from './reflective_memory.js';
import Vec3 from 'vec3';

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
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
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
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);

            // EasyAuth auto-login: protect this op account from impersonation (offline-mode server)
            if (this.prompter.profile.auth_password)
                setTimeout(() => this.bot.chat(`/login ${this.prompter.profile.auth_password}`), 1500);
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

                // She's OP (level 4) and would otherwise box-punch mobs with no armor.
                // Give her a real survival kit so she stops dying.
                await this._gearUp();

                // Suffocation self-rescue: poll independently of the mode loop so it
                // still fires while a combat action (pvp.attack) blocks update().
                this._suffocationInterval = setInterval(() => this._checkSuffocation(), 300);
              
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
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message, false);
        });

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
        else {
            this.openChat("Hello world! I am "+this.name);
        }
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
        this.bot.stopDigging();
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

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
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

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

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
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
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
                    // Actionable-error retry: when a command fails validation, tell her
                    // what went wrong and that she should correct it, then let the loop
                    // give her another pass (neuro-sdk "success:false -> retry" pattern).
                    if (isRetryableError(execute_res))
                        this.history.add('system', execute_res + '\nThat command failed. Fix the problem and try again.');
                    else
                        this.history.add('system', execute_res);
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

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
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

    async openChat(message, whisperTo = null) {
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
                this.bot.whisper(username, message);
            }
        }
        else if (whisperTo) {
            // a private /msg reply to one player
            this.bot.whisper(whisperTo, message);
            sendOutputToServer(this.name, message);
        }
        else {
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

        this.bot.on('entityHurt', (entity, source) => {
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

        // beloved presence is an emotional event — login lifts her, logout stings
        this.bot.on('playerJoined', (player) => {
            const name = player && player.username;
            if (name && this.isBelovedName(name)) this.psyche.onBelovedLogin();
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

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
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
            this.actions.cancelResume();
            this.actions.stop();
            this.psyche.onDeath();
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
                    this.bot.chat(`/tp @s ${x + 0.5} ${safeY} ${z + 0.5}`);
                    await new Promise(r => setTimeout(r, 800));
                    await skills.pickupNearbyItems(this.bot);
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
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
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
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        this.relationship.decay();
        this.profiles.sweep();
        this.psyche.update(delta);
        this.psyche.sampleEnvironment(this.bot);
        this.realness.update(delta);
        this.personal.update(delta);
        this.heat.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }

    // Is this player her beloved (configured name or current dynamic beloved)?
    isBelovedName(name) {
        if (!name) return false;
        const n = String(name).toLowerCase();
        const configured = (this.prompter.profile.beloved || '').toLowerCase();
        const dynamic = (this.relationship.currentBeloved() || '').toLowerCase();
        return n === configured || (!!dynamic && n === dynamic);
    }

    async _gearUp() {
        // OP survival kit: full armor + sword + shield + food so she doesn't die to mobs.
        // She is op (level 4) so /give commands resolve; armor/tools go straight to inventory,
        // then armorManager equips the armor and the best sword is moved to hand.
        const gear = [
            'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
            'diamond_sword', 'shield', 'cooked_beef',
            'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe',
            'bow', 'chest', 'water_bucket',
        ];
        try {
            for (const item of gear) {
                this.bot.chat(`/give ${this.name} ${item} 1`);
                await new Promise(r => setTimeout(r, 120));
            }
            this.bot.chat(`/give ${this.name} arrow 64`);
            await new Promise(r => setTimeout(r, 400));
            // Elytra + boost fuel. Safe to /give before equipAll: the armor manager
            // only equips items named *helmet/chestplate/leggings/boots, so it leaves
            // the elytra in her inventory for her to swap in when she wants to fly
            // (and it never strips her diamond chestplate on its own). Both are
            // protected gear, never discarded.
            this.bot.chat(`/give ${this.name} elytra 1`);
            await new Promise(r => setTimeout(r, 120));
            this.bot.chat(`/give ${this.name} firework_rocket 64`);
            await new Promise(r => setTimeout(r, 120));
            this.bot.armorManager.equipAll();
            const sword = this.bot.inventory.items().find(i => i.name.includes('sword'));
            if (sword) await this.bot.equip(sword, 'hand');
            const shield = this.bot.inventory.items().find(i => i.name === 'shield');
            if (shield) await this.bot.equip(shield, 'off-hand');
            console.log(`${this.name} geared up: armor equipped, sword in hand.`);
        } catch (e) {
            console.warn('gear-up failed (non-fatal):', e.message);
        }
    }

    async _reArmor() {
        // Called on every respawn. keep_inventory is OFF for everyone, so the kit
        // drops on death — if no diamond armor is in inventory, re-/give the full
        // kit (she's op, /give resolves). Equip-only path covers armor that somehow
        // survived (e.g. player gifted her some).
        const armorPieces = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
        const hasArmor = armorPieces.some(p => this.bot.inventory.items().some(i => i.name === p));
        if (!hasArmor) {
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

    // Suffocation self-rescue: pvp/pathfinder can clip her head into a wall while
    // fighting (the "UwU suffocated in a wall" deaths). Detect it before the damage
    // kills her and escape to open air (she's OP, /tp resolves).
    _checkSuffocation() {
        if (this._escapingSuffocation) return;
        const bot = this.bot;
        if (!bot.entity || !bot.entity.position) return;
        const pos = bot.entity.position;
        const h = bot.entity.height || 1.8;
        // Her head block only — a solid full block there means she's clipping a wall.
        // (Checking feet would false-positive on slabs/fences she merely stands on.)
        const head = bot.blockAt(pos.offset(0, Math.max(0.5, h - 0.1), 0));
        if (!head || head.boundingBox !== 'block') return;

        this._escapingSuffocation = true;
        this._escapeSuffocation().finally(() => { this._escapingSuffocation = false; });
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
            bot.chat(`/tp @s ${x + 0.5} ${safeY} ${z + 0.5}`);
            console.log(`[suffocation] escaped to ${x + 0.5},${safeY},${z + 0.5}`);
            await new Promise(r => setTimeout(r, 1500));
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
