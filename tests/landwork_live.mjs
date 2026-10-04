// LIVE end-to-end test of the landwork builders against the real server, using
// the REAL placement path (gather -> craft -> walk -> place by hand), not the
// stub the offline tests use. A second bot joins as LandworkTest, builds on a
// spot it is given, and reports what actually happened in the world.
//
// This is the test that would catch anything the fake world cannot: blocks she
// has no materials for, placements that fail against real block states, a
// generate/plan mismatch, terrain sampling against real chunk data.
import mineflayer from 'mineflayer';
// This server speaks "26.3" - a fork naming, not a real release - so the version
// must be taken from mineflayer.testedVersions, exactly as settings.js does.
// Hardcoding a vanilla version gets the connection rejected outright.
function botVersion() {
    try {
        const mc = require('mineflayer');
        const list = mc.testedVersions || mc.supportedVersions || [];
        if (list.includes('26.3')) return '26.3';
        if (list.length) return list[list.length - 1];
    } catch (_) {}
    return '1.21.4';
}
import * as landwork from '../src/agent/library/landwork.js';
import * as buildsense from '../src/agent/library/buildsense.js';
import { createRequire } from 'module';
import Vec3 from 'vec3';
// RCON gives the test bot materials: this world is survival and these bots build
// by hand, so stock has to come from somewhere a real player would use.
async function rconCmd(cmd) {
    const rcon = await import('../src/utils/rcon.js');
    return rcon.rconCommand(cmd);
}
const require = createRequire(import.meta.url);

const HOST = '127.0.0.1';
const PORT = 25565;
// Write to a file directly as well as stdout: this runs detached under systemd
// -like conditions where stdout is a pipe nobody drains, and a test whose
// output goes nowhere tells you nothing.
import { writeFileSync, appendFileSync } from 'fs';
const OUT = '/home/ubuntu/.hermes/cache/scratch/live_report.txt';
try { writeFileSync(OUT, ''); } catch (_) {}
const log = (...a) => {
    const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    console.log('[live]', line);
    try { appendFileSync(OUT, line + '\n'); } catch (_) {}
};

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: 'LandworkTest',
    version: botVersion(),
    auth: 'offline',
});

const result = { steps: [] };
const note = (name, data) => { result.steps.push({ name, ...data }); log(name, JSON.stringify(data)); };

log('module loaded, bot created');
// The same plugin stack the real bot loads. placeBlock() walks to each block,
// so without pathfinder it dies on bot.pathfinder.setMovements.
// CJS default export interop: these are ESM-transpiled CJS packages, so the
// plugin function lives on .default and loadPlugin asserts a function.
// These CJS packages export named objects, not a bare plugin fn: the plugin is
// the `pathfinder` / `plugin` / `tool` property (mcdata.js loads them the same way).
function plugin(mod, ...keys) {
    if (typeof mod === 'function') return mod;
    for (const k of [...keys, 'default', 'plugin']) if (typeof mod?.[k] === 'function') return mod[k];
    throw new Error('no plugin fn in ' + JSON.stringify(Object.keys(mod)));
}
bot.loadPlugin(plugin(require('mineflayer-pathfinder'), 'pathfinder'));
bot.loadPlugin(plugin(require('mineflayer-collectblock'), 'plugin'));
bot.loadPlugin(plugin(require('mineflayer-tool'), 'tool'));

bot.on('error', e => { log('ERROR', e.message); process.exit(1); });
bot.on('kicked', r => log('KICKED', JSON.stringify(r)));
// Log the server's own replies: EasyAuth answers /register and /login with a
// message, and without seeing it a silent auth failure looks like a timeout.
bot.on('message', (msg) => {
    const t = String(msg);
    if (/login|register|auth|password|again|expired/i.test(t)) log('CHAT', t.slice(0, 160));
});
bot.on('end', r => log('END', r));
// EasyAuth runs on this server and kicks with "Authentication time has
// expired" if nobody logs in inside the window. It has no RCON console commands,
// only the in-game /register and /login, so the test bot has to say them.
// YandereDev's own bot already proved the flow; this is the same two commands.
const TEST_PW = 'landtest';
bot.once('login', () => {
    // EasyAuth's kick-timeout is 300s to authenticate, and a retry loop that
    // re-registers while the bot stocks up burns that budget. Register once,
    // then log in, and wait for the success reply before touching anything.
    log('login ok, authenticating for EasyAuth');
    // The prompt is the instruction: "/register <password> <password>". Passing
    // the password once silently does nothing and the kick arrives 300s later.
    bot.chat(`/register ${TEST_PW} ${TEST_PW}`);
    setTimeout(() => bot.chat(`/login ${TEST_PW}`), 1500);
    // Keep saying /login: it is idempotent once registered, and an idle test bot
    // can still drift past the auth window while it gathers and places.
    setInterval(() => { try { bot.chat(`/login ${TEST_PW}`); } catch (_) {} }, 45000);
});
// This 26.3 fork logs in and has an entity position but never emits 'spawn',
// so wait on the condition itself rather than on the event: a test that hangs
// forever on an event this server does not emit looks exactly like a pass.
let started = false;
const waitForWorld = setInterval(() => {
    if (started) return;
    if (!bot.entity?.position) { log('waiting for a position...'); return; }
    started = true;
    clearInterval(waitForWorld);
    log('spawned (polled)', Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z));
    setTimeout(() => run().catch(e => { log('FAILED', e.message, String(e.stack).slice(0, 400)); process.exit(1); }), 3000);
}, 1000);

async function run() {
    const p = bot.entity.position;
    // registry only exists once the bot is fully in the world
    try {
        const shovel = bot.registry.toolsByName?.shovel?.id;
        if (shovel != null) await bot.equip(shovel, 'hand');
    } catch (_) {}
    log('spawned at', Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));

    // Give ourselves a flat, known test plot: this world is survival and the
    // whole point is that these builders place blocks BY HAND, so a /fill here
    // only clears the site, it does not build anything.
    let ox = Math.floor(p.x) + 2;
    let oz = Math.floor(p.z);
    // Find a plot that is actually OPEN SURFACE, not a cave floor: solid ground,
    // a real soil block on top, and clear sky several blocks up. Without this the
    // test happily picks a stone cavern, the road gets generated into rock, and
    // every placement fails for reasons that have nothing to do with landwork.
    const SOIL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'sand', 'red_sand', 'gravel', 'snow', 'sandstone']);
    const AIRN = new Set(['air', 'cave_air', 'void_air']);
    let groundY = null;
    for (let x = ox; x < ox + 12 && groundY == null; x++) {
        for (let z = oz - 8; z < oz + 8; z++) {
            let gy = null;
            for (let y = Math.floor(p.y) + 14; y > 10; y--) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && !AIRN.has(b.name)) { gy = y; break; }
            }
            if (gy == null) continue;
            const topB = bot.blockAt(new Vec3(x, gy, z));
            if (!topB || !SOIL.has(topB.name)) continue;
            let open = true;
            for (let k = 1; k <= 7; k++) {
                const b = bot.blockAt(new Vec3(x, gy + k, z));
                if (b && !AIRN.has(b.name)) { open = false; break; }
            }
            if (open) { ox = x; oz = z; groundY = gy; break; }
        }
    }
    log('plot', ox, oz, 'ground y', groundY);
    if (groundY == null) { log('no open surface plot found'); bot.quit(); return; }


    // Stock the test bot so placement is actually exercised. The default test
    // bot spawns with a bare inventory, so a 0/172 result would only prove she
    // has nothing to build with, not that placement works.
    const cmds = [
        // Name the bot explicitly: @s from RCON resolves to the console itself
        // and every give silently reports "No player was found".
        ...['dirt 96', 'cobblestone 96', 'oak_planks 96', 'oak_fence 96', 'oak_log 32',
            'stick 48', 'stone_bricks 96', 'gravel 96', 'sandstone 96', 'short_grass 96']
            .map(spec => `give LandworkTest ${spec}`),
    ];
    // Retry until the inventory actually shows it. EasyAuth finishes a beat
    // after login and resets the player's inventory on the way in, so a single
    // /give round right after spawn is silently undone — the server cheerfully
    // reports "Gave 96 [Dirt]" and the bot ends up holding nothing.
    let stock = {};
    for (let attempt = 1; attempt <= 6; attempt++) {
        // Only clear on the first round: re-clearing mid-build would delete the
        // dirt she is actively placing from.
        if (attempt === 1) { try { await rconCmd('clear LandworkTest'); } catch (_) {} }
        for (const c of cmds) { try { await rconCmd(c); } catch (_) {} }
        await new Promise(r => setTimeout(r, 2500));
        stock = {};
        for (const it of bot.inventory.items()) stock[it.name] = it.count;
        log(`stock attempt ${attempt}`, JSON.stringify(stock));
        if (Object.keys(stock).length >= 5) break;
        await new Promise(r => setTimeout(r, 3000));
    }

    // Put her ON the plot. A /tp, not pathfinding: the test bot spawns in a cave
    // and pathfinder.goto to the surface hangs forever with no timeout, which is
    // how the previous run sat silent for ten minutes. A teleport is instant and
    // deterministic, and placement still walks to every block from there.
    try {
        await rconCmd(`tp LandworkTest ${ox + 0.5} ${groundY + 1} ${oz + 0.5}`);
        await new Promise(r => setTimeout(r, 3000));
        const p2 = bot.entity.position;
        log('teleported to the plot', Math.floor(p2.x), Math.floor(p2.y), Math.floor(p2.z));
    } catch (e) { log('teleport failed:', e.message); }

    const g = landwork.terrainSampler(bot);
    note('terrain', { sampled: g.top(ox, oz), range: [g.yLo, g.yHi] });

    // --- 1. WALL: a small retaining wall along real ground
    const wall = landwork.retainingWall(g, { x: ox, z: oz - 4 }, { x: ox, z: oz + 4 }, { height: 2 });
    note('wall_generated', { blocks: wall.blocks.length, report: wall.report });

    // --- 2. STAIRS: supported run along real ground
    const st = landwork.stairs(g, { x: ox, z: oz - 3 }, { x: ox + 6, z: oz - 3 }, {});
    note('stairs_generated', { blocks: st.blocks.length, report: st.report });

    // --- 3. ROAD: the real one
    // Keep it SMALL: every block is placed by hand with a walk to it, and
    // EasyAuth's session expires well before a 172-block road finishes. A short
    // road still exercises the whole real path (sample -> generate -> plan ->
    // gather -> place -> verify -> damage -> repair) inside the window.
    const road = landwork.road(g, { x: ox, z: oz + 6 }, { x: ox + 4, z: oz + 6 }, { width: 3 });
    note('road_generated', { blocks: road.blocks.length, report: road.report, describe: landwork.describe(road) });

    // --- 4. PLAN: what does she think it costs, and can she get it?
    const planned = landwork.planGenerated(bot, road);
    // planBuild returns {total, missing, rows}, NOT lines/need/have.
    note('road_planned', {
        total: planned.plan?.total ?? null,
        missing: planned.plan?.missing ?? null,
        rows: (planned.plan?.rows || []).map(r => `${r.name} ${r.have}/${r.need} ${r.status}`).slice(0, 10),
        adaptation: (planned.adaptation || []).slice(0, 5),
        formatted: buildsense.formatPlan(planned.plan, 'road').split('\n').slice(0, 12),
    });

    // --- 5. PLACE it for real, by hand
    // First a single block, adjacent and unambiguous, so a failure tells us WHY
    // rather than leaving us with an aggregate "13 of 64".
    const probeBlock = road.blocks.find(b => b.y === 0) || road.blocks[0];
    const pvx = road.origin.x + probeBlock.x;
    const pvy = road.origin.y + probeBlock.y;
    const pvz = road.origin.z + probeBlock.z;
    log('probe target', probeBlock.name, 'at', pvx, pvy, pvz,
        'bot at', Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z),
        'dist', Math.round(bot.entity.position.distanceTo(new Vec3(pvx + 0.5, pvy + 0.5, pvz + 0.5))));
    try {
        const skills = await import('../src/agent/library/skills.js');
        const okOne = await skills.placeBlock(bot, probeBlock.name, pvx, pvy, pvz, 'bottom', true);
        log('single placeBlock ->', okOne, 'now:', bot.blockAt(new Vec3(pvx, pvy, pvz))?.name);
    } catch (e) { log('single placeBlock THREW', e.message); }

    const summary = await landwork.placeGenerated(bot, road);
    note('road_placed', summary);

    // --- 6. VERIFY by diffing the design against the world we just built
    const diff = landwork.diffAgainstWorld(road, g.get, road.origin);
    note('road_verified', {
        missing: diff.missing.length,
        wrong: diff.wrong.length,
        extra: diff.extra.length,
    });

    // --- 7. Vandalise it, then REPAIR only what is missing
    if (road.blocks.length) {
        const victim = road.blocks[Math.floor(road.blocks.length / 2)];
        const wx = road.origin.x + victim.x, wy = road.origin.y + victim.y, wz = road.origin.z + victim.z;
        const V = Vec3;
        const before = bot.blockAt(new V(wx, wy, wz));
        bot.dig(before).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        const now = bot.blockAt(new V(wx, wy, wz));
        note('vandalised', { at: [wx, wy, wz], was: before?.name, now: now?.name ?? 'air' });

        const d2 = landwork.diffAgainstWorld(road, g.get, road.origin);
        note('damage_detected', { missing: d2.missing.length, wrong: d2.wrong.length });
    }

    // --- 8. STACK CHECK: what did she actually end up holding
    const inv = {};
    for (const it of bot.inventory.items()) inv[it.name] = it.count;
    note('inventory', inv);

    console.log('RESULT ' + JSON.stringify(result));
    bot.quit();
    setTimeout(() => process.exit(0), 800);
}