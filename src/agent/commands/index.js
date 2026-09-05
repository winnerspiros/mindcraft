import { getBlockId, getItemId, suggestBlockNames, suggestItemNames, suggestBlockOrItemNames } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';

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

const argList = '(?:-?\\d+(?:\\.\\d+)?|true|false|"[^"]*")(?:\\s*,\\s*(?:-?\\d+(?:\\.\\d+)?|true|false|"[^"]*"))*';
// Explicit command syntax: "!name" or "!name(args...)". Bang may be ASCII '!' or full-width U+FF01,
// which kawaii/JP-flavoured models sometimes emit instead of '!'.
const commandRegex = new RegExp(`[!！](\\w+)(?:\\((${argList})\\))?`);
// Bare function-call syntax "name(args...)" for known command names. Some models (e.g. gpt-4o-mini)
// drop the "!" prefix, which was previously treated as plain conversation text and bled the raw
// command string into chat. Restrict to real command names so ordinary prose isn't matched.
const commandNames = commandList
    .map((c) => c.name.replace(/^!/, ''))
    .sort((a, b) => b.length - a.length);
const bareNamePattern = commandNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const bareCommandRegex = new RegExp(`(${bareNamePattern})\\((${argList})\\)`);
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

// Returns { name (with '!'), argsStr, raw (the matched text), index } for the first command
// found in message (bang-prefixed OR bare function-call), or null if none.
export function getCommandInfo(message) {
    let m = message.match(commandRegex);
    if (m) return { name: '!' + m[1], argsStr: m[2], raw: m[0], index: m.index };
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
export function parseCommandMessage(message) {
    const info = getCommandInfo(message);
    if (!info) return `Command is incorrectly formatted`;

    const commandName = info.name;

    let args;
    if (info.argsStr) args = info.argsStr.match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

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
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
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
            const result = await command.perform(agent, ...parsed.args);
            return result;
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
