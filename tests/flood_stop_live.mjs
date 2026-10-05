// Does plugging a water source actually STOP the flood, in the real world?
//
// Detection is already proven (tests/flood_probe_live.mjs found 124 sources, 5
// real leaks). This asks the harder question: after plugging, does the water
// actually recede, and does she notice? It plugs ONE leak, waits, and re-measures
// the same volume.
import mineflayer from 'mineflayer';
import { createRequire } from 'module';
import * as landwork from '../src/agent/library/landwork.js';
import * as skills from '../src/agent/library/skills.js';
import * as rconmod from '../src/utils/rcon.js';
import fs from 'fs';

const REPORT = '/home/ubuntu/.hermes/cache/scratch/flood_live.txt';
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(REPORT, s + '\n'); };
fs.writeFileSync(REPORT, '');
const rconCmd = (c) => rconmod.rconCommand(c);
const require = createRequire(import.meta.url);

const BOT = 'FloodStop';
const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25565, username: BOT, auth: 'offline',
    version: (() => { const l = require('mineflayer'); const list = l.testedVersions || l.supportedVersions || []; return list.includes('26.3') ? '26.3' : (list[list.length-1] || '1.21.4'); })(),
});
// Same CJS interop landwork_live.mjs uses: these packages are ESM-transpiled CJS
// and the plugin function lives on a named property, not on `default`. A plain
// `import { tool } from 'mineflayer-tool'` throws "Named export not found" and
// the module never runs at all — which is why the first attempt wrote no log.
function plugin(mod, ...keys) {
    if (typeof mod === 'function') return mod;
    for (const k of [...keys, 'default', 'plugin']) if (typeof mod?.[k] === 'function') return mod[k];
    throw new Error('no plugin fn in ' + JSON.stringify(Object.keys(mod)));
}
bot.loadPlugin(plugin(require('mineflayer-pathfinder'), 'pathfinder'));
bot.loadPlugin(plugin(require('mineflayer-collectblock'), 'plugin'));
bot.loadPlugin(plugin(require('mineflayer-tool'), 'tool'));
const notes = [];
bot.on('chat', (m) => { log('CHAT', m); });
bot.on('kicked', (r) => { log('KICKED', JSON.stringify(r).slice(0,200)); });
bot.once('error', (e) => { log('ERR', e.message); finish(1); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let finished = false;
function finish(code) { if (finished) return; finished = true; log('RESULT ' + JSON.stringify(notes)); process.exit(code); }

// Count water in a box, so before/after are measured the same way.
function countWater(g, cx, cy, cz, R = 14, H = 8) {
    let n = 0;
    for (let x = Math.round(cx-R); x <= Math.round(cx+R); x++)
        for (let z = Math.round(cz-R); z <= Math.round(cz+R); z++)
            for (let y = Math.round(cy-H); y <= Math.round(cy+H); y++) {
                const st = g.getState(x,y,z);
                if (st && (st.name === 'water' || st.name === 'flowing_water')) n++;
            }
    return n;
}

const t0 = Date.now();
const iv = setInterval(async () => {
    if (!bot.entity || !bot.entity.position) {
        if (Date.now()-t0 > 90000) { clearInterval(iv); log('TIMEOUT no spawn'); finish(1); }
        return;
    }
    clearInterval(iv);
    const p = bot.entity.position;
    log('spawned at', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1));

    // EasyAuth: register then authenticate before anything else.
    await sleep(4000);
    bot.chat('/register floodtest123 floodtest123');
    await sleep(4000);

    // Stock the plug material into a known slot. Server truth, 64 max per stack.
    await rconCmd(`item replace entity ${BOT} inventory.9 with minecraft:cobblestone 64`);
    await sleep(2500);
    log('stocked cobblestone; server sees:', await rconmod.rconItemCount(BOT, 'cobblestone'));

    const g = landwork.terrainSampler(bot);
    const survey = landwork.surveyFlood(g, { x: p.x, y: p.y, z: p.z }, 14, 8);
    log('survey: sources', survey.sources.length, 'flowing', survey.flowing.length);
    const cls = landwork.classifySources(survey, {});
    log('classify: plugs', cls.plugs.length, 'ponds', cls.ponds.length);
    notes.push({ step: 'survey', sources: survey.sources.length, plugs: cls.plugs.length, ponds: cls.ponds.length });
    if (!cls.plugs.length) { log('no leaks found — nothing to test'); finish(0); return; }

    // Plug ONE leak, the highest reachable one, so we can watch a real change.
    const target = cls.plugs.slice().sort((a,b) => b.y - a.y)[0];
    log('target leak', JSON.stringify(target));
    const before = countWater(g, target.x, target.y, target.z, 10, 6);
    log('water volume BEFORE (10-block box):', before);
    notes.push({ step: 'before', at: target, water: before });

    // Stand next to it, then plug it through the real production path.
    try { await rconCmd(`tp ${BOT} ${target.x + 1.5} ${target.y + 1} ${target.z + 0.5}`); } catch (e) { log('tp failed', e.message); }
    await sleep(3000);
    log('teleported to', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
    log('target is now:', JSON.stringify(g.getState(target.x, target.y, target.z)));

    const origin = { x: target.x, y: target.y, z: target.z };
    const plan = landwork.floodPlugPlan(survey, origin, { plugs: [target], ponds: cls.ponds });
    log('plan blocks:', plan.blocks.length, JSON.stringify(plan.report));
    const summary = await landwork.placeGenerated(bot, plan);
    log('placed:', JSON.stringify(summary));
    notes.push({ step: 'placed', summary: { placed: summary.placed, of: summary.of, faults: summary.faults } });

    const nowState = g.getState(target.x, target.y, target.z);
    log('target after plug:', JSON.stringify(nowState));
    notes.push({ step: 'targetAfter', state: nowState });

    // Water recedes on a tick, so wait and re-measure the SAME box.
    await sleep(12000);
    const after = countWater(g, target.x, target.y, target.z, 10, 6);
    log('water volume AFTER (same box):', after, 'delta:', after - before);
    notes.push({ step: 'after', water: after, delta: after - before });

    const s2 = landwork.surveyFlood(g, { x: p.x, y: p.y, z: p.z }, 14, 8);
    log('re-survey: sources', s2.sources.length, 'flowing', s2.flowing.length);
    notes.push({ step: 'resurvey', sources: s2.sources.length, flowing: s2.flowing.length });

    log('last output:', String(bot.output||'').split('\n').slice(-6).join(' | '));
    finish(0);
}, 500);
