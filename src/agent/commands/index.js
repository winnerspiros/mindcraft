import { getBlockId, getItemId, suggestBlockNames, suggestItemNames, suggestBlockOrItemNames } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import { powerRank, powerRefused } from '../library/skills.js';
import { canOp } from '../../utils/server_context.js';

// Trust levels for operator-power commands. Thin wrappers so this module
// doesn't reach into relationship internals directly.
function powerRankFor(agent, playerName) {
    try { return powerRank(agent, playerName); } catch (_) { return 'none'; }
}
function powerRefusedFor(agent, playerName, what) {
    try { powerRefused(agent, playerName, what); } catch (_) {}
}

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

// One argument token: number, bool, "quoted string", or bare word (granite,
// YandereDev). The brain emits bare words constantly despite the docs saying
// to quote strings — dropping them caused the `was given 0 args` loop.
const argToken = '(?:-?\\d+(?:\\.\\d+)?|true|false|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)';
const argList = `${argToken}(?:\\s*,\\s*${argToken})*`;
// Space-separated form: "!goToPlayer YandereDev", "!collectBlocks granite 3".
// The brain puts the command last, so anything past the command's param count
// is trailing prose and gets cut at parse time (see parseCommandMessage).
const spaceArgs = `${argToken}(?: +${argToken})*`;
// Explicit command syntax: "!name", "!name(args...)" or "!name arg1 arg2".
// Bang may be ASCII '!' or full-width U+FF01, which kawaii/JP-flavoured
// models sometimes emit instead of '!'.
const commandRegex = new RegExp(`[!！](\\w+)(?:\\((${argList})\\)| +(${spaceArgs}))?`);
// Bare function-call syntax "name(args...)" for known command names. Some models (e.g. gpt-4o-mini)
// drop the "!" prefix, which was previously treated as plain conversation text and bled the raw
// command string into chat. Restrict to real command names so ordinary prose isn't matched.
const commandNames = commandList
    .map((c) => c.name.replace(/^!/, ''))
    .sort((a, b) => b.length - a.length);
const bareNamePattern = commandNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const bareCommandRegex = new RegExp(`(${bareNamePattern})\\((${argList})\\)`);
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*/g;

// Returns { name (with '!'), argsStr, raw (the matched text), index } for the first command
// found in message (bang-prefixed OR bare function-call), or null if none.
export function getCommandInfo(message) {
    let m = message.match(commandRegex);
    if (m) {
        // paren form m[2], space form m[3] — trim space-form tokens to the
        // command's param count so trailing prose ("and stay close") isn't
        // swallowed as extra args.
        let argsStr = m[2] ?? null;
        let raw = m[0];
        if (argsStr == null && m[3] != null) {
            const cmd = commandMap['!' + m[1]];
            const maxArgs = cmd && cmd.params ? Object.keys(cmd.params).length : Infinity;
            const toks = m[3].match(argRegex) || [];
            const kept = toks.slice(0, maxArgs);
            argsStr = kept.join(' ');
            raw = raw.slice(0, raw.length - m[3].length) + kept.join(' ');
        }
        return { name: '!' + m[1], argsStr, raw, index: m.index };
    }
    m = message.match(bareCommandRegex);
    if (m) return { name: '!' + m[1], argsStr: m[2], raw: m[0], index: m.index };
    return null;
}

export function containsCommand(message) {
    const info = getCommandInfo(message);
    if (info)
        return info.name;
    return null;
}

/**
 * The real command names a hallucinated one probably meant.
 *
 * The model reaches for the obvious English word - !gather, !mine, !dig, !punch -
 * and all of those are absent while the actual names are present in its docs.
 * Saying "does not exist" teaches nothing, so it repeats the mistake. This ranks
 * the REAL command list by edit distance and by shared prefix, so the wrong word
 * becomes a correction instead of a dead end.
 *
 * Case-insensitive on both sides, because !collectBlocks and !collectblocks are
 * the same intent and the model's casing is not always deliberate.
 *
 * @param {string} bad   the invented name, with or without a leading '!'
 * @param {number} [limit]
 * @returns {string[]} real names, closest first, each with its leading '!'
 */
export function nearestCommandNames(bad, limit = 3) {
    const want = String(bad || '').replace(/^!/, '').toLowerCase();
    if (!want) return [];
    const scored = [];
    for (const name of Object.keys(commandMap)) {
        const real = name.replace(/^!/, '').toLowerCase();
        if (real === want) continue;
        // shared prefix is a strong signal: !dig -> !digDown, !look -> !lookAtPlayer
        let prefix = 0;
        while (prefix < real.length && prefix < want.length
            && real[prefix] === want[prefix]) prefix++;
        // a prefix covering most of the invented word is worth more than a short
        // accidental one, so scale it against the length of what was typed
        const prefixScore = prefix >= 3 ? prefix / want.length : 0;
        const d = editDistance(want, real);
        // normalise by length so !look is not unfairly beaten by a 20-char command
        let score = prefixScore * 2 + (1 - d / Math.max(want.length, real.length));
        // substring containment: !giveItem -> !givePlayer, !collect -> !collectBlocks
        if (real.includes(want) || want.includes(real)) score += 0.45;
        // LENGTH SANITY. Measured noise without it: !gather -> !weather/!placeHere/
        // !goToBed and !mine -> !ride/!hide/!modes. A five-letter guess has nothing
        // to do with a seventeen-letter command, and those suggestions are worse
        // than no suggestion because they send her off inventing again. Anything
        // more than ~1.6x the length is not what she meant.
        const ratio = real.length / Math.max(1, want.length);
        if (ratio > 1.6) score -= 0.5;

        // A suggestion must be STRUCTURALLY related, not just edit-distance-close.
        // Measured without this: !gather -> !weather/!placeHere/!goToBed and
        // !mine -> !ride/!hide/!modes. Those are worse than no answer, because she
        // acts on a suggestion - it would send her to !weather when she wanted
        // blocks. So a real prefix, a substring, or a tight distance is required;
        // otherwise the honest reply is "check the command list".
        // Shared letters in the same POSITIONS, not merely a similar count.
        // This is what separates giveItem/givePlayer from gather/weather: both of
        // those are six letters and therefore edit-distance-close by luck, and
        // suggesting !weather when she meant "get blocks" sends her further off.
        let sameSpot = 0;
        for (let k = 0; k < Math.min(want.length, real.length); k++) {
            if (want[k] === real[k]) sameSpot++;
        }
        // The FIRST character must also agree. With short words a couple of
        // coincidental index matches cleared half the length on their own, which
        // is how !mine kept matching !ride and !hide. A genuine typo or a
        // near-miss command almost always starts the same way - and every bad pair
        // here (mine/ride, mine/hide, gather/weather) differs at index 0.
        const firstOk = real[0] === want[0];
        const structural = (prefix >= 3 && firstOk)
            || real.includes(want) || want.includes(real)
            || (d <= 2 && firstOk && sameSpot >= Math.ceil(want.length / 2));
        if (structural && score > 0.34) scored.push({ name, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.name);
}

/** Levenshtein, single-row. Only ever called on short command names. */
function editDistance(a, b) {
    if (a === b) return 0;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        let last = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(
                prev[j] + 1,
                prev[j - 1] + 1,
                last + (a[i - 1] === b[j - 1] ? 0 : 1));
            last = tmp;
        }
    }
    return prev[b.length];
}

/**
 * When a real command is called with the WRONG SHAPE, say what shape it wants.
 *
 * Measured live: she wanted coal, reached for !breakBlock (x, y, z floats), and
 * got "Param 'x' must be of type float" because `coal_ore` landed in the x slot.
 * She then retried with 1.0 2.0 3.0 - still wrong - and the turn produced nothing
 * visible. !collectBlocks(type, num) is what she meant and it is in her docs.
 *
 * So the fix is the same idea as nearestCommandNames, applied to arguments: when
 * a param fails its declared type, report the command's real signature. Keyed on
 * the command's own `params`, which is already the single source of truth - so
 * this cannot drift from the commands it describes.
 *
 * @returns {string|null} a correction the model can act on, or null
 */
export function explainParamError(commandName, errorText) {
    const cmd = commandMap[String(commandName || '').startsWith('!')
        ? commandName : '!' + commandName];
    if (!cmd) return null;
    const err = String(errorText || '');

    // A wrong ARG COUNT is the same failure and was left unexplained, which is
    // why the log is full of it. Live, 07:0x, in six minutes:
    //
    //   Agent executed: !breakBlock and got: given 1 args, but requires 3
    //   Agent executed: !tps and got: given 3 args, but it only accepts 0
    //   Agent executed: !collectBlocks and got: given 0 args, but requires 1
    //   Agent executed: !craftRecipe and got: given 1 args, but requires 2
    //
    // Four different commands, all of them recoverable by one sentence. The
    // model kept guessing because the error never said what it wanted. The
    // type-error branch below was already written for exactly this reason; it
    // just did not match this message shape.
    const arity = /was given (\d+) args?, but (?:it )?(?:only accepts|requires at least) (\d+)/.exec(err);
    if (arity) {
        const got = Number(arity[1]);
        const want = Number(arity[2]);
        // A command with no declared params (like !tps) still deserves a
        // correction - "it takes no parameters, you passed 1" is the whole
        // lesson and it takes one line.
        const sig = cmd.params && Object.keys(cmd.params).length
            ? Object.entries(cmd.params)
                .map(([name, s]) => `${name}: ${s.type}${s.default !== undefined ? ` (default ${s.default})` : ''}`)
                .join(', ')
            : '(no parameters)';
        return `${commandName} takes ${sig}. You passed ${got} arg(s); it wants ${want}. `
            + (got > want
                ? 'Drop the extra ones and call it with nothing after the name.'
                : 'Supply every listed param, in the order shown.');
    }

    // Wrong TYPE: only reachable for commands that declare params.
    if (!cmd.params) return null;
    const m = /Param '(\w+)' must be of type (\w+)/.exec(err);
    if (!m) return null;
    const [, badParam, wantedType] = m;
    const spec = cmd.params[badParam];
    if (!spec) return null;

    const sig = Object.entries(cmd.params)
        .map(([name, s]) => `${name}: ${s.type}${s.default !== undefined ? ` (default ${s.default})` : ''}`)
        .join(', ');
    const hint = spec.type === 'BlockName' || spec.type === 'ItemName'
        ? ` ${badParam} wants a block/item name, not a coordinate.`
        : ` ${badParam} wants a ${wantedType}.`;
    return `${commandName} takes (${sig}).${hint} Your call put a value of the wrong type in ${badParam}.`;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Heuristic: did the model emit something meant to be a command that doesn't parse
 * (a typo, space-separated words, or a missing bang)? Used to stop raw command-ish
 * text from leaking into chat when command parsing fails — e.g. "defend self",
 * "shoot player", or "!defend self".
 * Only flags multi-word (camelCase) command names and bang-prefixed tokens; plain
 * single-word commands ("stop", "attack", "follow") are common English and are left
 * alone so ordinary prose isn't over-scrubbed.
 */
export function looksLikeCommand(message) {
    if (!message) return false;
    const text = message.trim();
    if (!text) return false;

    // a bang-prefixed token (valid or not) is a command attempt
    if (/^[!！]/.test(text)) return true;

    const words = text.toLowerCase().split(/\s+/);
    for (const name of commandNames) {
        if (!/[A-Z]/.test(name)) continue; // skip single-word command names
        const lower = name.toLowerCase();
        const expanded = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
        if (words[0] === lower) return true;                    // "defendSelf" / "shootplayer"
        if (expanded.length >= 2 && expanded.every((w, i) => words[i] === w)) return true; // "defend self"
    }
    return false;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message, preCap = null) {
    const info = getCommandInfo(message);
    if (!info) return `Command is incorrectly formatted`;

    const commandName = info.name;

    let args;
    if (info.argsStr) args = info.argsStr.match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    // Power-cap pre-pass: shrink absurd asks (200 withers) to the cap BEFORE
    // domain validation, so a capped request proceeds at the cap instead of
    // tripping the domain error. Runs on RAW string args, so numeric parsing
    // happens here, not in the cap function.
    if (preCap && typeof preCap === 'function' && command.power && args) {
        const coerced = args.map(a => {
            let t = String(a).trim();
            if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
                t = t.substring(1, t.length - 1);
            const n = Number(t);
            return t !== '' && !Number.isNaN(n) ? n : t;
        });
        preCap(coerced);
        args = coerced.map(a => typeof a === 'number' ? String(a) : `"${a}"`);
    }

    const params = commandParams(command);
    const paramNames = commandParamNames(command);

    // Optional params: the LLM frequently omits trailing "closeness"/"distance"
    // args. Require only params without a default; fill missing with defaults.
    const required = params.filter(p => !('default' in p)).length;
    if (args.length < required)
        return `Command ${command.name} was given ${args.length} args, but requires at least ${required} args.`;
    if (args.length > params.length)
        return `Command ${command.name} was given ${args.length} args, but it only accepts ${params.length} args.`;

    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) {
                const s = suggestBlockNames(arg);
                return `Invalid block type: ${arg}.${s.length ? ` Did you mean: ${s.join(', ')}?` : ''}`;
            }
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) {
                const s = suggestItemNames(arg);
                return `Invalid item type: ${arg}.${s.length ? ` Did you mean: ${s.join(', ')}?` : ''}`;
            }
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) {
                const s = suggestBlockOrItemNames(arg);
                return `Invalid block or item type: ${arg}.${s.length ? ` Did you mean: ${s.join(', ')}?` : ''}`;
            }
        }
        args[i] = arg;
    }

    // Fill trailing omitted optional params with their defaults so
    // perform() always receives the full argument list.
    while (args.length < params.length) {
        const missing = params[args.length];
        args.push('default' in missing ? missing.default : undefined);
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const info = getCommandInfo(message);
    if (info) {
        return message.substring(0, info.index + info.raw.length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

// Tight pattern for command parse/validation errors. Distinct from "soft" action
// results like "No zombie nearby" (which should NOT prompt a correction loop).
const RETRYABLE_ERROR_RE = /^(Command is incorrectly formatted|Command .* was given .* args|Error: Param .*|Invalid (block|item|block or item) type)/;
export function isRetryableError(str) {
    return typeof str === 'string' && RETRYABLE_ERROR_RE.test(str.trim());
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

export async function executeCommand(agent, message) {
    // Cheap pre-resolve so the power-cap pre-pass knows which cap to apply
    // before parse-domain validation runs (parse-then-cap trips the domain
    // error on absurd asks like 200 withers instead of shrinking them).
    const preInfo = getCommandInfo(message);
    const preCmd = preInfo ? getCommand(preInfo.name) : null;
    const preCap = preCmd && preCmd.power && typeof preCmd.powerCap === 'function' ? preCmd.powerCap : null;
    let parsed = parseCommandMessage(message, preCap);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        const command = getCommand(parsed.commandName);
        // POWER GATE: operator-power commands need a trusted requester. The
        // requester is the last human sender (players can't invoke these via
        // !-syntax from chat unless the LLM echoes them — in both cases the
        // human who triggered this turn is agent.last_sender). On a survival
        // server (op=false) they also need the server to HAVE powers at all.
        if (command.power) {
            if (!canOp()) {
                return `${parsed.commandName} unavailable: this server is survival-only (no operator powers here). Do it the honest way — walk, craft, mine, trade, or ask players.`;
            }
            const requester = agent.last_sender;
            const level = powerRankFor(agent, requester);
            if (level === 'none') {
                powerRefusedFor(agent, requester, command.power);
                return `${parsed.commandName} refused: ${requester || 'unknown'} is not trusted enough for operator powers.`;
            }
            // Trust never waives physics: the pre-pass already shrunk the ask
            // to the cap for 'small' AND 'full' alike. Nothing more to do here.
        }
        console.log('parsed command:', parsed);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        // Optional params (trailing params with a `default`): tolerate the LLM
        // omitting them — the parser already padded missing args with defaults.
        const params = commandParams(command);
        const required = params.filter(p => !('default' in p)).length;
        if (numArgs !== params.length)
            return `Command ${command.name} was given ${numArgs} args, but requires at least ${required} args.`;
        else {
            // A throwing command must never kill the bot. perform() reaches
            // arbitrary task code, and an uncaught rejection here propagates
            // through self_prompter.startLoop into the process exit - 13
            // restarts in 3h, all from one command. A command that fails is a
            // message back to the model, which is how every other failure
            // already reports itself; it is not an outage.
            try {
                return await command.perform(agent, ...parsed.args);
            } catch (err) {
                console.log(`${command.name} threw: ${err.message}`);
                return `Command ${command.name} failed: ${err.message}. Something is wrong with the world state it needed - do not retry it, pick a different command.`;
            }
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
