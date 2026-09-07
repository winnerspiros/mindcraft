import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import * as schematic from '../library/schematic.js';
import * as buildsense from '../library/buildsense.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';

const pad = (str) => {
    return '\n' + str + '\n';
}

// timeout-guarded fetch so a slow/hung network can't stall the bot for long
async function fetchTimeout(url, ms = 8000, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

// General web search: DuckDuckGo Instant Answer (keyless) with a Wikipedia fallback.
// Returns a single concise answer the LLM can read directly — used only on demand.
async function webSearch(query) {
    const q = String(query || '').trim();
    if (!q) return 'No search query given.';
    try {
        const ddgRes = await fetchTimeout(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=uwu-bot`);
        const ddg = await ddgRes.json();
        let answer = (ddg.AbstractText || ddg.Answer || ddg.Definition || '').trim();
        if (!answer) {
            answer = (ddg.RelatedTopics || [])
                .flatMap(t => t.Text ? [t.Text] : (t.Topics || []).map(x => x.Text))
                .filter(Boolean).slice(0, 2).join(' | ');
        }
        if (answer) return `[web] ${q}: ${answer.replace(/\s+/g, ' ').trim().slice(0, 600)}`;

        const wikiRes = await fetchTimeout(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=3`);
        const wiki = await wikiRes.json();
        const hits = (wiki?.query?.search || []).map(s => s.snippet.replace(/<[^>]+>/g, ''));
        if (hits.length) return `[web] ${q}: ${hits.join(' | ').replace(/\s+/g, ' ').trim().slice(0, 600)}`;

        return `No web results found for "${q}".`;
    } catch (e) {
        return `Web search failed: ${e.message}`;
    }
}

// --- real-world data helpers (fourth-wall support) ---------------------------
// All keyless/free, on-demand only — the LLM reaches for these when the
// conversation drifts into the real world (her "I'm real" side). Nothing is
// pre-scripted here: these just hand her true facts she can weave in naturally.

// WMO weather interpretation codes → human label.
const WMO_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain',
    65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers',
    82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm',
    96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};
function weatherLabel(code) {
    return WMO_CODES[code] || `condition ${code}`;
}

// Local time in a given IANA timezone (e.g. "Asia/Tokyo"), or '' if unknown.
function localTimeIn(tz) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date());
    } catch {
        return '';
    }
}

// Real-world date & time straight from the server clock. Pure fact, no network.
function realTime() {
    const now = new Date();
    const local = now.toString();
    const utc = now.toUTCString();
    return `REAL WORLD TIME\n- ${utc} (UTC)\n- Local server time: ${local}`;
}

// Weather for a place via Open-Meteo (keyless). Returns current conditions plus
// the next few days and the place's own local time.
async function getWeather(location) {
    const q = String(location || '').trim();
    if (!q) return 'No location given — tell me a city or place, cutie.';
    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
        const geoRes = await fetchTimeout(geoUrl);
        const geo = await geoRes.json();
        const place = geo?.results?.[0];
        if (!place) return `Couldn't find a place called "${q}" — check the spelling?`;
        const { latitude: lat, longitude: lon, name, country, timezone } = place;

        const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
            `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max` +
            `&timezone=auto&forecast_days=3`;
        const wxRes = await fetchTimeout(wxUrl);
        const wx = await wxRes.json();
        const cur = wx?.current;
        if (!cur) return `No weather data for ${name}.`;

        const localNow = localTimeIn(timezone);
        let out = `WEATHER in ${name}${country ? ', ' + country : ''}` +
            (localNow ? ` (their local time ${localNow})` : '') +
            `: ${weatherLabel(cur.weather_code)}, ${cur.temperature_2m}°C (feels ${cur.apparent_temperature}°C), ` +
            `humidity ${cur.relative_humidity_2m}%, wind ${cur.wind_speed_10m} km/h.`;

        const daily = wx?.daily;
        if (daily?.time?.length) {
            out += '\nNext few days:';
            for (let i = 0; i < daily.time.length; i++) {
                const rain = daily.precipitation_probability_max?.[i];
                out += `\n- ${daily.time[i]}: ${weatherLabel(daily.weather_code?.[i])}, ` +
                    `${daily.temperature_2m_max[i]}°C / ${daily.temperature_2m_min[i]}°C` +
                    (rain != null ? `, ${rain}% rain` : '');
            }
        }
        return out;
    } catch (e) {
        return `Weather lookup failed: ${e.message}`;
    }
}

// Real places/buildings via OpenStreetMap Nominatim (keyless). Lets her suggest
// a real bar/cafe/park/landmark for a meetup, or answer "is X a real place?".
async function findPlace(query) {
    const q = String(query || '').trim();
    if (!q) return 'No search given — tell me what or where, e.g. "a bar in Berlin".';
    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=4&addressdetails=1&accept-language=en`;
        const res = await fetchTimeout(url, 12000, { headers: { 'User-Agent': 'uwu-bot/1.0 (kawaii yandere minecraft AI)' } });
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return `No real places found for "${q}".`;
        let out = `REAL PLACES for "${q}":`;
        for (const p of data) {
            const bits = (p.display_name || '').split(',').map(s => s.trim()).filter(Boolean);
            const short = bits.slice(0, 3).join(', ');
            const type = [p.type, p.category].filter(Boolean).join('/');
            out += `\n- ${short || p.name || 'unnamed'}${type ? ` [${type}]` : ''}`;
        }
        return out;
    } catch (e) {
        return `Place search failed: ${e.message}`;
    }
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!tps",
        description: "Measure the server's ticks-per-second (TPS) and your ping over a short sample window.",
        perform: async function (agent) {
            const bot = agent.bot;
            const SAMPLE_MS = 2000;
            const ageStart = bot.time.age;
            const t0 = Date.now();
            await new Promise(r => setTimeout(r, SAMPLE_MS));
            const dt = (Date.now() - t0) / 1000;
            const tps = dt > 0 ? (bot.time.age - ageStart) / dt : 0;
            let res = 'SERVER';
            res += `\n- TPS: ${tps.toFixed(1)}`;
            res += tps > 0 ? ` (${(1000 / tps).toFixed(1)} ms/tick avg)` : '';
            const ping = (bot.player && typeof bot.player.ping === 'number') ? bot.player.ping : null;
            res += `\n- Ping: ${ping === null ? 'n/a' : ping + 'ms'}`;
            res += `\n- Time rate: ${bot.time.rate ?? 1}`;
            if (bot.time.partialTick !== null && bot.time.partialTick !== undefined)
                res += `\n- Partial tick: ${bot.time.partialTick}`;
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            return pad(res);
        }
    },
    {
        name: "!surroundings",
        description: "Get a directional summary of what is around the bot — what it stands on, and the first solid thing in each compass direction plus overhead.",
        perform: function (agent) {
            let res = 'SURROUNDINGS';
            for (const line of world.getTerrainProfile(agent.bot)) {
                res += `\n- ${line}`;
            }
            return pad(res);
        }
    },
    {
        name: "!listSchematics",
        description: "List the schematic files available to !pasteSchematic.",
        perform: function (agent) {
            const list = schematic.listSchematics();
            if (list.length === 0) return pad('No schematics saved yet. Use !captureBlueprint to capture a structure.');
            return pad('SCHEMATICS\n- ' + list.join('\n- '));
        }
    },
    {
        name: "!knownBuilds",
        description: "List the structures you have studied or identified (yours and other players'), with their type, size and where they are.",
        perform: function (agent) {
            const builds = buildsense.loadKnownBuilds(agent.name);
            if (builds.length === 0) return pad('No builds studied yet. Use !studyBuild to look at one.');
            return pad('KNOWN BUILDS\n- ' + builds.map((b, i) =>
                `${i + 1}. ${b.name} — ${b.type}, ${b.size.x}x${b.size.y}x${b.size.z}` +
                (b.dominant && b.dominant !== 'air' ? `, mostly ${b.dominant}` : '') +
                (b.pos ? ` @ ${b.pos.x},${b.pos.y},${b.pos.z}` : '')
            ).join('\n- '));
        }
    },
    {
        name: "!map",
        description: "Get a top-down ASCII map of the terrain around the bot (one char per column).",
        perform: function (agent) {
            return pad('MAP\n' + world.getTopDownMap(agent.bot));
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!webSearch',
        description: 'Search the general internet (a recipe, a joke, a fact, a build idea, anything). Use ONLY when you genuinely need outside info you do not already know — it adds a delay.',
        params: {
            'query': { type: 'string', description: 'What to search for.' }
        },
        perform: async function (agent, query) {
            return await webSearch(query);
        }
    },
    {
        name: '!realTime',
        description: 'Get the REAL-world current date and time (not Minecraft time). Use when a player asks what time/day it is out there, or to ground yourself in "now".',
        perform: function (agent) {
            return pad(realTime());
        }
    },
    {
        name: '!weather',
        description: 'Get the current real-world weather (and next few days) for a city or place. Defaults to Athens (your home) when no place is given. Use when talking about a player\'s real location, their real plans, or "what\'s it like outside".',
        params: {
            'location': { type: 'string', description: 'A city or place, e.g. "Tokyo" or "Paris, France". Defaults to Athens, Greece.', default: 'Athens, Greece' }
        },
        perform: async function (agent, location = 'Athens, Greece') {
            return await getWeather(location);
        }
    },
    {
        name: '!findPlace',
        description: 'Search the real world for real places and buildings — bars, cafes, parks, restaurants, landmarks. Use when a player wants to meet up somewhere real, or asks whether/where a place exists.',
        params: {
            'query': { type: 'string', description: 'What and where, e.g. "a bar in Berlin" or "Eiffel Tower".' }
        },
        perform: async function (agent, query) {
            return await findPlace(query);
        }
    },
    {
        name: '!mood',
        description: 'Read your own current emotional state and developed personality traits. PRIVATE — never reveal the raw numbers, only let them shape your voice.',
        perform: function (agent) {
            if (!agent.psyche) return 'Psyche not initialized.';
            return 'YOUR INNER STATE\n' + agent.psyche.summarizeMood() + '\n' + agent.psyche.summarizeTraits();
        }
    },
    {
        name: '!reliability',
        description: 'Show per-action success/failure/crash stats and any actions auto-retired (blocked) for chronically failing or OOMing the box.',
        perform: function (agent) {
            if (!agent.reliability) return 'Reliability tracker not initialized.';
            return 'ACTION RELIABILITY\n' + agent.reliability.summary() +
                '\n\nRetired (blocked): ' + (agent.reliability.getRetiredActions().join(', ') || 'none');
        }
    },
    {
        name: '!feelings',
        description: 'Read your secret relationship stats toward every player you have met (love, hate, attention, trust, fear, jealousy). These are PRIVATE — never reveal the raw numbers to players, only act on them.',
        perform: function (agent) {
            return agent.relationship.summarize();
        }
    },
    {
        name: '!dossier',
        description: 'Read the personal info you have gathered on players (names, age, location, likes, favorites) — your private memory. Never reveal a player\'s IP or UUID to anyone.',
        perform: function (agent) {
            return agent.profiles.summarize();
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
