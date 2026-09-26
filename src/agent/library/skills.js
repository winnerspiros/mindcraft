import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import { rconPlayerPos } from "../../utils/rcon.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

export function log(bot, message) {
    bot.output += message + '\n';
}

// 26.3: silent OP give — runs /give as the CONSOLE via RCON-side path is not
// available in-process, so instead whisper the command out-of-band: the bot
// sends the /give through a chat_command packet with the command-sender
// feedback routed to herself only... simplest silent route that actually
// works: /give with the command feedback gamerule off is overkill — instead
// send the give via bot.chat but suppress HER OWN echo by routing through
// tellraw-free server mechanics is impossible from here. So: use minecraft's
// own silent mechanism — /give ... run as console via RCON is out of reach,
// therefore queue the give through the agent's server-side action queue is
// out of scope. PRAGMATIC silent path: /loot give or /give executed while
// sendCommandFeedback is untouched is still announced. The ACTUAL silent
// mechanism: execute the give as a chat_command — command feedback goes to
// the EXECUTOR (her), not public chat; public chat never sees /give output.
// What you saw in chat was log() narration ("Gave X..."), not the command.
// So: skip the log() narration, keep the chat_command give. Silent gift +
// her own cute words only.
function powerRank(agent, playerName) {
    // Central trust gate for all operator-power actions (gives, summons,
    // effects, kills, TNT, crystals, setblock...). Rank comes from her live
    // relationship tracker: stranger < acquaintance < friend < darling < beloved.
    // YandereDev (owner) always passes. Returns 'full' | 'small' | 'none'.
    if (!playerName) return 'none';
    if (playerName === 'YandereDev') return 'full';
    let rank = 'stranger';
    try { rank = (agent.relationship.get(playerName).rank || 'stranger').toLowerCase(); } catch (_) {}
    if (rank === 'beloved' || rank === 'darling' || rank === 'friend') return 'full';
    if (rank === 'acquaintance') return 'small';
    return 'none';
}

function powerRefused(agent, playerName, what) {
    // Cute in-character refusal that also teaches the boundary. Routed via
    // openChat so it obeys the normal chat gating, never raw bot.chat.
    const rank = (() => { try { return agent.relationship.get(playerName).rank; } catch (_) { return 'stranger'; } })();
    agent.openChat(`Mmm~ ${what} is a big scary power, and I only share those with people I really trust~ ♥ Right now you're ${rank} to me... be sweet to me and maybe I'll earn you more~nya! ✨`);
}

export { powerRank, powerRefused };

function silentGive(bot, username, itemType, num) {
    bot.chat(`/give ${username} ${itemType} ${num}`);
}

// ============================================================================
// MOVEMENT MODES — sprint, parkour, bridging. She is EXEMPT from the vanilla
// moved-wrongly gate (LAC exempt UUID = her offline UUID), so sprint + jumps
// kick nobody; worst case is LAC's own speed_threshold=0.6 (setback-only, no
// ban — straight sprint is ~0.28/tick, sprint-jump ~0.36, both under 0.6).
// walk(bot): every routine below takes a mode — 'sprint' | 'parkour' | 'walk'
// and builds its Movements from moveProfile() so the parkour brain, combat
// approaches and bridge runs all share ONE gate instead of 12 stale flags.
// ============================================================================
export function moveProfile(bot, mode = 'walk') {
    const m = new pf.Movements(bot);
    if (mode === 'sprint') {
        // flat-out running, no jumps planned: straight legs only
        m.allowSprinting = true;
        m.allowParkour = false;
    } else if (mode === 'parkour') {
        // full send: sprint + sprint-jumps for sprint-jump gaps
        m.allowSprinting = true;
        m.allowParkour = true;
    } else {
        // walk: careful legs near edges, lava, mobs
        m.allowSprinting = false;
        m.allowParkour = false;
    }
    return m;
}

// ============================================================================
// PARKOUR PRIMITIVES — neos, 45-strafe, backwards momentum, edge sneaks,
// speed bridging, ladder + block clutches. Low-level control-state driving
// (not pathfinder): precise inputs for precise jumps. All self-terminating,
// all interrupt-aware, all refuse when starving (food <= 6) or over lethal
// ground (lava/void) unless the technique IS the crossing (bridge).
// Yaw convention: mineflayer radians. Forward vector = (-sin(yaw), -cos(yaw)).
// ============================================================================
function _parkStop(bot) {
    try {
        for (const s of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) bot.setControlState(s, false);
    } catch (_) {}
}

function _parkYawTo(bot, x, z) {
    const p = bot.entity.position;
    return Math.atan2(-(x - p.x), -(z - p.z));
}

function _parkDir(bot) {
    const yaw = bot.entity.yaw;
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

function _parkBlockAt(bot, x, y, z) {
    try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); } catch (_) { return null; }
}

function _parkSolid(b) {
    return !!b && b.boundingBox === 'block';
}

function _parkEdgeAhead(bot, lookAhead = 0.7) {
    // true when the ground disappears ahead (edge within one step)
    const p = bot.entity.position;
    const d = _parkDir(bot);
    const ax = p.x + d.x * lookAhead, az = p.z + d.z * lookAhead;
    const feetY = Math.floor(p.y);
    const below = _parkBlockAt(bot, ax, feetY - 1, az);
    const ahead = _parkBlockAt(bot, ax, feetY, az);
    const headClear = !_parkSolid(_parkBlockAt(bot, p.x, feetY + 1, p.z));
    return (!below || !_parkSolid(below)) && headClear && !!(ahead);
}

async function _parkWaitLand(bot, timeoutMs = 3500) {
    const t0 = Date.now();
    const startY = bot.entity.position.y;
    while (Date.now() - t0 < timeoutMs) {
        if (bot.interrupt_code) return false;
        try {
            if (bot.entity.onGround) return true;
        } catch (_) {}
        // landed if fall stopped (y stable 300ms while airborne flag lags)
        if (Date.now() - t0 > 800 && Math.abs(bot.entity.position.y - startY) < 0.05) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

export async function edgeSneak(bot, timeoutMs = 5000) {
    /**
     * Crouch-walk to the very edge and STOP on it — the launch stance for
     * every max-distance jump. Sneak prevents falling off; stopping ON the
     * edge (not one back) buys the full block of run-up distance.
     * @returns {Promise<boolean>} true if parked on the edge.
     **/
    if (bot.food <= 6) { log(bot, 'Too hungry to parkour — feed me first.'); return false; }
    const t0 = Date.now();
    try { bot.setControlState('sneak', true); bot.setControlState('forward', true); } catch (_) {}
    while (Date.now() - t0 < timeoutMs) {
        if (bot.interrupt_code) { _parkStop(bot); return false; }
        if (_parkEdgeAhead(bot)) break;
        await new Promise(r => setTimeout(r, 100));
    }
    try { bot.setControlState('forward', false); } catch (_) {}
    // stay sneaking ON the edge — caller unsneaks to launch
    const onEdge = _parkEdgeAhead(bot);
    log(bot, onEdge ? 'On the edge, crouched — max run-up ready.' : 'No edge ahead — holding sneak.');
    return onEdge;
}

export async function sprintJump(bot, strafe = null) {
    /**
     * The basic weapon: edge-sneak, release, sprint + (optional 45 strafe) +
     * jump. Strafe 'left'/'right' angles the launch 45 degrees for diagonal
     * gaps; null goes straight. Lands and stops ON the far edge.
     **/
    if (bot.food <= 6) { log(bot, 'Too hungry to jump — feed me first.'); return false; }
    await edgeSneak(bot, 4000);
    if (bot.interrupt_code) { _parkStop(bot); return false; }
    try {
        bot.setControlState('sneak', false);
        if (strafe === 'left' || strafe === 'right') {
            // 45-degree strafe: yaw off 45, hold forward + strafe side
            const off = strafe === 'left' ? Math.PI / 4 : -Math.PI / 4;
            try { await bot.look(bot.entity.yaw + off, 0, true); } catch (_) {}
            bot.setControlState('forward', true);
            bot.setControlState(strafe, true);
        } else {
            bot.setControlState('forward', true);
        }
        bot.setControlState('sprint', true);
        await new Promise(r => setTimeout(r, 120)); // stride into the jump
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 350));
        bot.setControlState('jump', false);
        if (strafe) { try { bot.setControlState(strafe, false); } catch (_) {} }
    } catch (_) {}
    const landed = await _parkWaitLand(bot);
    _parkStop(bot);
    log(bot, landed ? `Stuck the ${strafe ? '45-strafe ' : ''}jump~ ♥` : 'Jump fell short — that gap needs more run-up or a bridge.');
    return landed;
}

export async function neoJump(bot, side = 'right') {
    /**
     * NEO: sprint-jump AROUND a pillar with (almost) no run-up — edge-sneak,
     * 45-strafe launch around the obstacle, mid-air yaw snap back to the
     * landing, stick it. Side = which way around ('left'/'right').
     * Advanced: needs 2 blocks of air around the pillar; say so if boxed in.
     **/
    if (bot.food <= 6) { log(bot, 'Too hungry for a neo — feed me first.'); return false; }
    if (side !== 'left' && side !== 'right') side = 'right';
    await edgeSneak(bot, 4000);
    if (bot.interrupt_code) { _parkStop(bot); return false; }
    try {
        bot.setControlState('sneak', false);
        const off = side === 'left' ? Math.PI / 4 : -Math.PI / 4;
        try { await bot.look(bot.entity.yaw + off, 0, true); } catch (_) {}
        bot.setControlState('forward', true);
        bot.setControlState(side, true);
        bot.setControlState('sprint', true);
        await new Promise(r => setTimeout(r, 100));
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 300));
        bot.setControlState('jump', false);
        // mid-air: snap yaw back toward the landing line, drop the strafe
        await new Promise(r => setTimeout(r, 180));
        try { await bot.look(bot.entity.yaw - off, 0, true); } catch (_) {}
        try { bot.setControlState(side, false); } catch (_) {}
    } catch (_) {}
    const landed = await _parkWaitLand(bot);
    _parkStop(bot);
    log(bot, landed ? `Neo around the ${side} stuck~ ♥` : 'Neo missed — need 2 air blocks around the pillar, or walk it instead.');
    return landed;
}

export async function backwardJump(bot) {
    /**
     * BACKWARDS MOMENTUM: short forward sprint for speed, jump, 180 mid-air
     * turn, land travelling backwards — for jumps where the landing faces the
     * run-up (turn-around gaps, headbutt reversals). Lands looking back the
     * way she came.
     **/
    if (bot.food <= 6) { log(bot, 'Too hungry for momentum tricks — feed me first.'); return false; }
    await edgeSneak(bot, 4000);
    if (bot.interrupt_code) { _parkStop(bot); return false; }
    try {
        bot.setControlState('sneak', false);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await new Promise(r => setTimeout(r, 250)); // build momentum
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 250));
        bot.setControlState('jump', false);
        // mid-air 180: face back down the run-up, ride it backwards
        try { await bot.look(bot.entity.yaw + Math.PI, 0, true); } catch (_) {}
        bot.setControlState('forward', false);
        bot.setControlState('back', true);
    } catch (_) {}
    const landed = await _parkWaitLand(bot);
    _parkStop(bot);
    log(bot, landed ? 'Backwards-momentum jump stuck~ ♥' : 'Lost it mid-air — that one needs a longer run-up.');
    return landed;
}

export async function blockClutch(bot, block = null) {
    /**
     * BLOCK CLUTCH (MLG without water): falling with no water in reach — slam
     * a block into the wall-beside-you or under your feet before landing.
     * Picks the most-carried solid block unless named. Refuses over void.
     **/
    const p = bot.entity.position;
    if (p.y < -60) { log(bot, 'Void below — no clutch saves that, sorry.'); return false; }
    let mat = block;
    if (!mat) {
        const inv = world.getInventoryCounts(bot);
        mat = ['cobblestone', 'dirt', 'oak_planks', 'stone', 'deepslate'].find(m => (inv[m] || 0) > 0);
    }
    if (!mat) { log(bot, 'Nothing to clutch with — no blocks carried.'); return false; }
    const f = p.floored();
    // try feet-level wall kick first (side place), then straight under feet
    const tries = [[f.x + 1, f.y, f.z], [f.x - 1, f.y, f.z], [f.x, f.y, f.z + 1], [f.x, f.y, f.z - 1], [f.x, f.y - 1, f.z]];
    for (const [x, y, z] of tries) {
        if (bot.interrupt_code) return false;
        try {
            if (await placeBlock(bot, mat, x, y, z, 'bottom', true)) {
                log(bot, `Clutched on ${mat}~ ♥`);
                return true;
            }
        } catch (_) {}
    }
    log(bot, `Clutch missed — ${mat} found nothing to grip.`);
    return false;
}

export async function ladderClutch(bot) {
    /**
     * LADDER LANDING: falling past/along a wall — slap a ladder onto it and
     * GRAB it to kill the fall, then climb or drop the last metre. Needs a
     * ladder carried and a solid wall within reach.
     **/
    if (!(world.getInventoryCounts(bot)['ladder'] > 0)) {
        try { await craftRecipe(bot, 'ladder', 1, true); } catch (_) {}
    }
    if (!(world.getInventoryCounts(bot)['ladder'] > 0)) { log(bot, 'No ladder to clutch with (7 sticks in an H).'); return false; }
    const f = bot.entity.position.floored();
    const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of walls) {
        if (bot.interrupt_code) return false;
        const wall = _parkBlockAt(bot, f.x + dx, f.y, f.z + dz);
        if (_parkSolid(wall)) {
            try {
                // place ON the wall face (target the air beside it, build off wall)
                if (await placeBlock(bot, 'ladder', f.x + dx * 0, f.y, f.z + dz * 0, 'bottom', true)) {
                    log(bot, 'Ladder slapped — grabbing it!');
                    return true;
                }
            } catch (_) {}
            // direct: aim at wall block face
            try {
                await bot.equip(bot.inventory.findInventoryItem('ladder'), 'hand');
                await bot.lookAt(wall.position.offset(0.5, 0.5, 0.5), true);
                await bot.placeBlock(wall, new Vec3(-dx, 0, -dz));
                log(bot, 'Ladder slapped — grabbing it!');
                return true;
            } catch (_) {}
        }
    }
    log(bot, 'No wall in reach for a ladder — block-clutch or water instead.');
    return false;
}

export async function throwPearl(bot, x = null, y = null, z = null) {
    /**
     * Throw an ender pearl: equip, aim (at coords, straight up for roof-phasing,
     * or at the crosshair target), right-click to throw. Costs ~2.5 hearts on
     * landing — never throw under 6 HP, never over the void. Aim INSIDE the far
     * side of a wall/ceiling to phase through (pearl + ladder trick below).
     * @returns {Promise<boolean>} true if a pearl left her hand.
     **/
    let pearl = bot.inventory.items().find(i => i.name === 'ender_pearl');
    if (!pearl) { log(bot, 'No ender_pearl — kill endermen (warped forests best) or barter piglins (!sourcing "ender_pearl").'); return false; }
    if (bot.health < 6) { log(bot, `Too hurt to pearl (health ${bot.health.toFixed(0)}) — it costs 2.5 hearts.`); return false; }
    // eat FIRST so the pearl damage heals back: pearl costs 2.5 hearts, so go
    // in with a full(ish) belly rather than landing hungry and bleeding.
    try {
        if (bot.food < 18) {
            const snack = (typeof FOOD_RANK !== 'undefined' ? FOOD_RANK : []).find(f => bot.inventory.findInventoryItem(f));
            if (snack) { await consume(bot, snack); }
        }
    } catch (_) {}
    try {
        await bot.equip(pearl, 'hand');
        if (x != null && y != null && z != null) {
            try { await bot.lookAt(new Vec3(Math.floor(x) + 0.5, Math.floor(y) + 0.5, Math.floor(z) + 0.5), true); } catch (_) {}
        } else if (x === 'up') {
            try { await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.05, true); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 150)); // let the aim settle
        await bot.activateItem(); // right-click = throw
        log(bot, x != null && y != null ? `Pearl away toward (${x}, ${y}, ${z}) — brace for landing.` : 'Pearl away!');
        return true;
    } catch (e) {
        log(bot, `Pearl throw failed: ${e.message}`);
        return false;
    }
}

export async function chorusEscape(bot) {
    /**
     * CHORUS ESCAPE (stuck-place eject — cage/box/burial/pillar-trap): eat a
     * chorus_fruit. It teleports you to a random NEARBY surface spot (+/-8
     * blocks, needs headroom) — out of ANY box without breaking a block. No
     * health cost (costs hunger only), but random: eat again if still stuck.
     * NEVER auto-eaten as hunger food (kept out of FOOD_RANK on purpose).
     * @returns {Promise<boolean>} true if a fruit was eaten.
     **/
    const fruit = bot.inventory.items().find(i => i.name === 'chorus_fruit');
    if (!fruit) { log(bot, 'No chorus_fruit — break chorus plants on outer End islands (!sourcing "chorus_fruit"). Smelted popped_chorus does NOT teleport.'); return false; }
    const before = bot.entity.position.clone();
    try {
        await bot.equip(fruit, 'hand');
        await bot.consume();
        await new Promise(r => setTimeout(r, 800)); // teleport lands
        const moved = bot.entity.position.distanceTo(before);
        log(bot, moved > 2 ? `Chorus popped — out of the trap (${moved.toFixed(0)} blocks away)~ ♥` : 'Chorus eaten but barely moved (no headroom nearby?) — eat another or pearl out.');
        return true;
    } catch (e) {
        log(bot, `Chorus escape failed: ${e.message}`);
        return false;
    }
}

export async function travelTrick(bot, x, y, z) {
    /**
     * DAILY-MOVEMENT dispatcher: cross a big gap / reach far ground the SMART
     * way, in order: pearl if far + healthy + pearls carried (fast, costs 2.5
     * hearts — eats first), bridge if mid-range + blocks carried (safe, no
     * health cost), else walk/sprint legs. Picks by distance, inventory and
     * health — never pearls under 6 HP, never bridges with no blocks, says
     * which it chose.
     * @returns {Promise<boolean>} true if a crossing move fired.
     **/
    x = Math.floor(Number(x)); y = Math.floor(Number(y)); z = Math.floor(Number(z));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        log(bot, '!travel needs x y z — where to?');
        return false;
    }
    const d = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z);
    const pearls = bot.inventory.items().filter(i => i.name === 'ender_pearl').reduce((a, i) => a + i.count, 0);
    const blocks = bot.inventory.items().filter(i => i.name.endsWith('stone') || i.name.endsWith('dirt') || i.name.includes('planks') || i.name === 'cobblestone').reduce((a, i) => a + i.count, 0);
    // far + healthy + pearls = pearl it (fastest daily driver)
    if (d > 24 && pearls > 0 && bot.health >= 6) {
        log(bot, `Far ground (${d.toFixed(0)} blocks) + pearls ready — pearling across (2.5 hearts, ate first).`);
        return await throwPearl(bot, x, y, z);
    }
    // mid + blocks = bridge toward it (safe, no health cost)
    if (d > 10 && blocks >= Math.min(d, 16)) {
        log(bot, `Mid gap (${d.toFixed(0)} blocks) + ${blocks} blocks — bridging toward it (no health cost).`);
        try { await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true); } catch (_) {}
        return await speedBridge(bot, null, Math.min(Math.ceil(d), 24));
    }
    // near or broke = walk/parkour legs handle it
    log(bot, `Close ground (${d.toFixed(0)} blocks${pearls ? '' : ', no pearls'}${bot.health < 6 ? ', hurt' : ''}) — walking it instead of tricking.`);
    return await goToPosition(bot, x, y, z, 2, d > 12 ? 'sprint' : 'walk');
}

export async function pearlPhase(bot) {
    /**
     * NETHER-ROOF / WALL PHASE (ladder + pearl): stand under the ceiling, a
     * ladder on the wall/top edge as climb assist + aim reference, look
     * STRAIGHT UP into the ceiling block, throw. The pearl clips the corner
     * hitbox and lands her ON TOP of the roof. Needs pearls + health > 6.
     * Refuses with no pearls instead of pretending.
     **/
    if (!(bot.inventory.items().find(i => i.name === 'ender_pearl'))) {
        log(bot, 'No ender_pearl for phasing — kill endermen or barter piglins first.');
        return false;
    }
    if (bot.health < 6) { log(bot, `Too hurt to phase (health ${bot.health.toFixed(0)}) — pearls cost 2.5 hearts.`); return false; }
    // 1) ladder up: place one if she carries it (climb assist + aim reference)
    try { await ladderClutch(bot); } catch (_) {}
    if (bot.interrupt_code) return false;
    // 2) aim straight up into the ceiling and throw
    const ok = await throwPearl(bot, 'up');
    if (ok) log(bot, 'Phasing up — pearl into the roof, land on top. If still below, nudge sideways and throw again (corners phase easiest).');
    return ok;
}

export async function boatFall(bot) {
    /**
     * BOAT-FALL (no-fall-damage landing): while FALLING — place the boat under
     * her fall line and mount it before impact. Landing inside a boat negates
     * fall damage entirely. Needs a boat + ~10 blocks of fall to react.
     **/
    let boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    if (!boatItem) {
        try { await craftRecipe(bot, 'oak_boat', 1, true); } catch (_) {}
        boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    }
    if (!boatItem) { log(bot, 'No boat for a boat-fall (5 planks in a U).'); return false; }
    const falling = !bot.entity.onGround;
    if (!falling) { log(bot, 'Not falling — boat-fall is a mid-air trick. Walk off first, then call it.'); return false; }
    try {
        await bot.equip(boatItem, 'hand');
        const f = bot.entity.position.floored();
        const ref = bot.blockAt(new Vec3(f.x, f.y - 3, f.z)) || bot.blockAt(new Vec3(f.x, f.y - 5, f.z));
        if (ref) {
            try { await bot.placeEntity(ref, new Vec3(0, 1, 0)); } catch (_) {}
            await new Promise(r => setTimeout(r, 300));
        }
        const boat = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 8);
        if (boat) {
            try { await bot.mount(boat); log(bot, 'In the boat — ride it down, no fall damage~ ♥'); return true; } catch (_) {}
        }
        log(bot, 'Boat placed below — aim for it, landing inside negates the fall.');
        return true;
    } catch (e) {
        log(bot, `Boat-fall failed: ${e.message}`);
        return false;
    }
}

export async function boatFly(bot, seconds = 6) {
    /**
     * BOAT-FLY (mount/unmount hover — 26.3 status: PATCHED on vanilla, and it
     * shows): rapidly mount + dismount a boat/vehicle mid-air to stall the
     * fall — each re-mount resets fall momentum for a tick. On current
     * versions the server catches it within seconds (rubber-band/setback, no
     * ban — LAC setback-only), so this is a SHORT hover to cross one gap or
     * soften one landing, never real flight. Refuses without a boat nearby.
     **/
    const boat = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 8);
    if (!boat && !bot.vehicle) { log(bot, 'No boat nearby to fly with — place one first.'); return false; }
    const end = Date.now() + Math.max(2000, Math.min(12000, (seconds || 6) * 1000));
    log(bot, 'Boat-hover: mount/unmount to stall the fall — short hop only, server rubber-bands this.');
    try {
        while (Date.now() < end) {
            if (bot.interrupt_code) break;
            try {
                if (bot.vehicle) bot.dismount();
                else {
                    const b = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 8);
                    if (b) await bot.mount(b);
                    else break;
                }
            } catch (_) {}
            await new Promise(r => setTimeout(r, 250));
        }
    } finally {
        try { if (!bot.vehicle) { const b = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 8); if (b) await bot.mount(b); } } catch (_) {}
    }
    log(bot, 'Hover over — that trick is patched, expect rubber-banding past a few seconds.');
    return true;
}

export async function boatClip(bot) {
    /**
     * BOAT-CLIP (26.3 status: PATCHED — boats no longer push through blocks on
     * vanilla physics): the honest remainder is SQUEEZING through 1-wide gaps
     * and riding boats through open doors/gates — place boat at the gap mouth,
     * mount, ride through. Reports the patched status instead of pretending.
     **/
    const boat = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 8);
    if (!boat && !bot.vehicle) { log(bot, 'No boat nearby.'); return false; }
    log(bot, 'True boat-clipping is patched on 26.3 — boats ride through open doors/gates and 1-wide water gaps, not through solid walls. Riding the gap instead.');
    try {
        if (!bot.vehicle && boat) await bot.mount(boat);
        return !!bot.vehicle;
    } catch (e) {
        log(bot, `Could not mount: ${e.message}`);
        return false;
    }
}

export async function glitch(bot, trick = 'pearl', arg = null) {
    /**
     * One dispatcher for the glitch list — the brain calls ONE command.
     * trick: pearl | phase | chorus | travel | boatfall | boatfly | boatclip
     * arg: "x y z" target for pearl/travel, "up" for pearl, seconds for boatfly.
     **/
    trick = String(trick || 'pearl').toLowerCase();
    if (trick === 'pearl') {
        const parts = String(arg || '').split(/\s+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.every(Number.isFinite)) return await throwPearl(bot, parts[0], parts[1], parts[2]);
        if (String(arg || '').toLowerCase() === 'up') return await throwPearl(bot, 'up');
        return await throwPearl(bot);
    }
    if (trick === 'phase') return await pearlPhase(bot);
    if (trick === 'chorus' || trick === 'escape' || trick === 'eject') return await chorusEscape(bot);
    if (trick === 'travel' || trick === 'cross' || trick === 'gap') {
        const parts = String(arg || '').split(/\s+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.every(Number.isFinite)) return await travelTrick(bot, parts[0], parts[1], parts[2]);
        log(bot, '!glitch travel needs "x y z" — where to?');
        return false;
    }
    if (trick === 'boatfall' || trick === 'boat-fall' || trick === 'mlgboat') return await boatFall(bot);
    if (trick === 'boatfly' || trick === 'boat-fly' || trick === 'fly') return await boatFly(bot, parseInt(arg, 10) || 6);
    if (trick === 'boatclip' || trick === 'boat-clip' || trick === 'clip') return await boatClip(bot);
    log(bot, `Unknown glitch "${trick}" — try pearl, phase, chorus, travel, boatfall, boatfly, boatclip.`);
    return false;
}

export async function crawl(bot, how = 'trapdoor', seconds = 0) {
    /**
     * Enter the CRAWL pose (0.6 blocks tall — fits 1-high gaps): 'trapdoor'
     * (place + flip + walk under, easiest anywhere), 'boat' (ride under a
     * 2-high ceiling then dismount — stuck crawling until headroom), or
     * 'swim' (dive + sprint-swim under a 1-high ceiling, no gear needed).
     * Crawl ends by standing where 2+ headroom exists (walk out / jump);
     * seconds > 0 auto-stands after that long. Tunnel crawling uses the
     * normal pathfinder — 1-high gaps path as open ground while crawling.
     * @returns {Promise<boolean>} true if crawling (or crawl attempted).
     **/
    how = String(how || 'trapdoor').toLowerCase();
    const inv = () => world.getInventoryCounts(bot);
    const headroom = () => {
        try {
            const p = bot.entity.position;
            const a = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z)));
            const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + 2, Math.floor(p.z)));
            const open = (x) => !x || x.name === 'air' || x.name === 'water' || x.name === 'cave_air';
            return open(a) && open(b) ? 2 : open(a) ? 1 : 0;
        } catch (_) { return 2; }
    };
    if (how === 'boat') {
        // boat entry: SHOVE the boat under the ceiling first (body-push — walk
        // into it toward the mark), mount under a LOW (2-high) ceiling, ride
        // in, dismount = crawl. Needs a boat + a ceiling — refuses in the open
        // (no ceiling = dismount just stands you up again).
        let boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
        if (!boatItem) { try { await craftRecipe(bot, 'oak_boat', 1, true); } catch (_) {} boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest')); }
        if (!boatItem) { log(bot, 'No boat for crawl entry (5 planks U) — trapdoor way needs only 6 planks.'); return false; }
        if (headroom() >= 2) { log(bot, 'Boat-crawl needs a LOW ceiling (2 high) overhead — open sky just stands me up on exit. Trapdoor way works anywhere.'); return false; }
        try {
            const p = bot.entity.position;
            await bot.equip(boatItem, 'hand');
            const ref = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
            if (ref) { try { await bot.placeEntity(ref, new Vec3(0, 1, 0)); } catch (_) {} await new Promise(r => setTimeout(r, 300)); }
            // correct the placement: shove the hull under the ceiling BEFORE
            // mounting — a boat parked in the open ruins the entry.
            try {
                const hull = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 6);
                if (hull) {
                    const hp = hull.position;
                    const a = bot.blockAt(new Vec3(Math.floor(hp.x), Math.floor(hp.y) + 1, Math.floor(hp.z)));
                    const b = bot.blockAt(new Vec3(Math.floor(hp.x), Math.floor(hp.y) + 2, Math.floor(hp.z)));
                    const open = (x) => !x || x.name === 'air' || x.name === 'water' || x.name === 'cave_air';
                    if (!a || open(a)) {
                        // hull sits in the open — push it 2 toward the wall/ceiling side (her facing)
                        const yaw = bot.entity.yaw || 0;
                        const tx = hp.x - Math.sin(yaw) * 2, tz = hp.z + Math.cos(yaw) * 2;
                        try { await shove(bot, 'boat', tx, hp.y, tz); } catch (_) {}
                    }
                }
            } catch (_) {}
            const b = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 6);
            if (b) await bot.mount(b);
            await new Promise(r => setTimeout(r, 400));
            try { bot.dismount(); } catch (_) {}
            log(bot, 'Boat-crawl entry — dismounted under a low ceiling, staying 0.6 tall. Walk the 1-high gap; stand up where it opens.');
            if (seconds > 0) { await new Promise(r => setTimeout(r, seconds * 1000)); try { await standUp(bot); } catch (_) {} }
            return true;
        } catch (e) { log(bot, `Boat-crawl failed: ${e.message} — trapdoor way instead.`); return false; }
    }
    if (how === 'swim' || how === 'water') {
        // swim entry: get wet + sprint under a 1-high ceiling — the game lays
        // you flat (swim pose = 0.6 tall, same as crawl). Two ways in:
        //  (a) NATURAL: water already nearby — walk in, sprint under the gap.
        //  (b) POURED LANE (the trick): no water near but a water_bucket
        //      carried — pour it at your feet toward the gap, swim the lane
        //      flat through the 1-high tunnel to the far side, scoop the
        //      source back up on exit. Your own portable crawl door.
        // OXYGEN: ~15s of bubbles — if low mid-swim, swimUp NOW, never push it.
        let water = world.getNearestBlock(bot, 'water', 16);
        let pouredLane = false; // true when SHE poured it (scoop back on exit)
        if (!water) {
            const hasWaterBucket = (inv()['water_bucket'] || 0) > 0;
            if (!hasWaterBucket) { log(bot, 'Swim-crawl needs water or a water_bucket — none near/carried. Trapdoor way works on dry land.'); return false; }
            // POUR YOUR OWN LANE: face the gap, dump water 1 ahead at feet.
            try {
                const p = bot.entity.position;
                const yaw = bot.entity.yaw || 0;
                const fx = Math.floor(p.x - Math.sin(yaw)), fz = Math.floor(p.z + Math.cos(yaw));
                const laneBlock = bot.blockAt(new Vec3(fx, Math.floor(p.y), fz)) || bot.blockAt(bot.entity.position);
                await goToPosition(bot, fx, p.y, fz, 2);
                await useToolOnBlock(bot, 'water_bucket', laneBlock);
                await new Promise(r => setTimeout(r, 500));
                water = world.getNearestBlock(bot, 'water', 8);
                if (!water) { log(bot, 'Poured the lane but no water showed (blocked face?) — aim at open ground and retry.'); return false; }
                pouredLane = true;
                log(bot, 'Poured my own swim lane — sprint-swim it flat through the 1-gap, scooping back on exit.');
            } catch (e) { log(bot, `Lane pour failed: ${e.message} — trapdoor way instead.`); return false; }
        } else {
            log(bot, 'Swim-crawl: dive in, sprint under the 1-high ceiling — the game lays you flat (no gear needed). Surface past the gap to stand.');
        }
        try {
            await goToPosition(bot, water.position.x, water.position.y, water.position.z, 2);
            try { bot.setControlState('sprint', true); } catch (_) {}
            try { bot.setControlState('forward', true); } catch (_) {}
            await new Promise(r => setTimeout(r, seconds > 0 ? seconds * 1000 : 3500));
            try { bot.setControlState('sprint', false); } catch (_) {}
            try { bot.setControlState('forward', false); } catch (_) {}
            // scoop back a poured lane so the bucket comes home (only when dry now)
            if (pouredLane) {
                try {
                    const left = world.getNearestBlock(bot, 'water', 8);
                    if (left && (inv()['bucket'] || 0) > 0) { await useToolOnBlock(bot, 'bucket', left); log(bot, 'Lane scooped back up — bucket home.'); }
                } catch (_) {}
            }
            return true;
        } catch (e) { log(bot, `Swim-crawl failed: ${e.message}`); return false; }
    }
    // default: trapdoor entry — place at head height, flip open, walk under.
    // Works on dry land anywhere; 6 planks, no water, no ceiling needed.
    if (!Object.keys(inv()).some(n => n.endsWith('_trapdoor') && (inv()[n] || 0) > 0)) {
        try { await craftRecipe(bot, 'oak_trapdoor', 1, true); } catch (_) {}
    }
    const door = Object.keys(inv()).find(n => n.endsWith('_trapdoor') && (inv()[n] || 0) > 0);
    if (!door) { log(bot, 'No trapdoor (6 planks, 2x3) — craft one and I crawl anywhere.'); return false; }
    try {
        const p = bot.entity.position;
        const px = Math.floor(p.x), py = Math.floor(p.y) + 1, pz = Math.floor(p.z);
        const ok = await placeBlock(bot, door, px, py, pz, 'bottom', true);
        if (!ok) { log(bot, 'No wall to hang the trapdoor on — stand by a block and retry.'); return false; }
        const blk = bot.blockAt(new Vec3(px, py, pz));
        try { if (blk) await bot.activateBlock ? await bot.activateBlock(blk) : await useToolOnBlock(bot, 'hand', blk); } catch (_) {}
        try { await goToPosition(bot, px, py - 1, pz, 1); } catch (_) {}
        log(bot, `Trapdoor crawl (${door}) — flipped open overhead, walked under, 0.6 tall now. 1-high gaps are open ground; stand up where 2+ headroom (!crawl stand).`);
        if (seconds > 0) { await new Promise(r => setTimeout(r, seconds * 1000)); try { await standUp(bot); } catch (_) {} }
        return true;
    } catch (e) { log(bot, `Trapdoor crawl failed: ${e.message}`); return false; }
}

export async function standUp(bot) {
    /**
     * STOP crawling: walk/jump to 2+ headroom — the pose ends itself the
     * moment space allows. Refuses with no headroom nearby (says where the
     * ceiling opens instead of suffocating in place).
     * @returns {Promise<boolean>} true if standing room found.
     **/
    const open = (x) => { try { const b = bot.blockAt(new Vec3(x[0], x[1], x[2])); return !b || b.name === 'air' || b.name === 'water' || b.name === 'cave_air'; } catch (_) { return true; } };
    try {
        const p = bot.entity.position;
        const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
        if (open([px, py + 1, pz]) && open([px, py + 2, pz])) {
            try { bot.setControlState('jump', true); } catch (_) {}
            await new Promise(r => setTimeout(r, 400));
            try { bot.setControlState('jump', false); } catch (_) {}
            log(bot, 'Stood up — headroom here, crawl over.');
            return true;
        }
        // look around for an opening: 4 sides, up to 6 out
        for (let r = 1; r <= 6; r++) {
            for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
                if (open([px + dx, py + 1, pz + dz]) && open([px + dx, py + 2, pz + dz])) {
                    log(bot, `Crawling ${r} to (${px + dx},${py},${pz + dz}) — headroom there, stand on arrival.`);
                    try { await goToPosition(bot, px + dx, py, pz + dz, 1); } catch (_) {}
                    try { bot.setControlState('jump', true); } catch (_) {}
                    await new Promise(r => setTimeout(r, 400));
                    try { bot.setControlState('jump', false); } catch (_) {}
                    return true;
                }
            }
        }
    } catch (_) {}
    log(bot, 'No headroom in 6m — still roofed. Crawl toward the light (!crawl stand retries on arrival).');
    return false;
}

export async function buildNetherPortal(bot) {
    /**
     * Build a working nether portal from scratch: 4 wide x 5 tall obsidian
     * frame (10 minimum — corners optional, she builds WITH corners = 14),
     * standing on the ground in front of her, then LIGHT it with flint_and_steel
     * (crafted: iron + flint) or a fire_charge. Reports each missing piece with
     * where to get it instead of pretending.
     * @returns {Promise<boolean>} true if the portal is standing + lit.
     **/
    const need = 14;
    let have = world.getInventoryCounts(bot)['obsidian'] || 0;
    if (have < 10) {
        // gather: obsidian needs a DIAMOND pick; water + lava makes it
        log(bot, `Need ${need} obsidian, carrying ${have} — gathering more (pour water over lava, mine with a diamond pick; !sourcing "obsidian").`);
        try { await collectBlock(bot, 'obsidian', need - have); } catch (_) {}
        have = world.getInventoryCounts(bot)['obsidian'] || 0;
    }
    if (have < 10) { log(bot, `Only ${have}/10 obsidian — can't frame a portal yet. Lava lake + water bucket + diamond pick.`); return false; }
    // frame: 4 wide (x), 5 tall (y), at her feet facing +X... build along X
    const p = bot.entity.position.floored();
    const bx = p.x + 2, by = p.y, bz = p.z; // 2 out so she doesn't stand inside
    const frame = [];
    for (let dx = 0; dx < 4; dx++) {
        frame.push([bx + dx, by, bz]);         // base
        frame.push([bx + dx, by + 4, bz]);     // top
    }
    for (let dy = 1; dy <= 3; dy++) {
        frame.push([bx, by + dy, bz]);         // left pillar
        frame.push([bx + 3, by + dy, bz]);     // right pillar
    }
    for (const [x, y, z] of frame) {
        if (bot.interrupt_code) return false;
        try { await placeBlock(bot, 'obsidian', x, y, z, 'bottom', true); } catch (_) {}
    }
    // verify the hollow middle is air (2 wide x 3 tall)
    let hollow = true;
    for (let dx = 1; dx <= 2; dx++)
        for (let dy = 1; dy <= 3; dy++) {
            const b = bot.blockAt(new Vec3(bx + dx, by + dy, bz));
            if (b && b.name !== 'air' && b.name !== 'nether_portal') hollow = false;
        }
    if (!hollow) { log(bot, 'Frame up but the middle is blocked — clear the 2x3 inside and light it.'); return false; }
    // LIGHT it: flint_and_steel first (reusable), fire_charge as backup
    if (!(world.getInventoryCounts(bot)['flint_and_steel'] > 0)) {
        try { await craftRecipe(bot, 'flint_and_steel', 1, true); } catch (_) {}
    }
    let lighter = world.getInventoryCounts(bot)['flint_and_steel'] > 0 ? 'flint_and_steel'
        : world.getInventoryCounts(bot)['fire_charge'] > 0 ? 'fire_charge' : null;
    if (!lighter) {
        try { await craftRecipe(bot, 'fire_charge', 1, true); } catch (_) {}
        if (world.getInventoryCounts(bot)['fire_charge'] > 0) lighter = 'fire_charge';
    }
    if (!lighter) { log(bot, 'Frame built — but no lighter (flint_and_steel = iron + flint from gravel; fire_charge = blaze_powder + coal + gunpowder). Craft one and right-click the inside.'); return false; }
    const inner = bot.blockAt(new Vec3(bx + 1, by + 1, bz));
    try {
        const ok = await useToolOnBlock(bot, lighter, inner || bot.blockAt(new Vec3(bx + 1, by, bz)));
        await new Promise(r => setTimeout(r, 800));
        const lit = bot.blockAt(new Vec3(bx + 1, by + 1, bz));
        if (lit && lit.name === 'nether_portal') { log(bot, 'Portal LIT — the nether waits~ ♥ (stand inside 4s to travel, don\'t bring the bed)'); return true; }
        log(bot, ok ? 'Clicked the lighter — check the frame glows purple; if not, click the inner bottom edge again.' : 'Could not reach the frame to light it.');
        return ok;
    } catch (e) {
        log(bot, `Lighting failed: ${e.message}`);
        return false;
    }
}

export async function fixPortal(bot, range = 32) {
    /**
     * Find a broken/unlit nether portal nearby (player frame or RUINED portal)
     * and bring it back: fill missing obsidian, REPLACE crying_obsidian (it
     * NEVER lights — swap it for real obsidian), clear the 2x3 inside, light
     * with flint_and_steel / fire_charge. Reports what was wrong + what she did.
     * @returns {Promise<boolean>} true if a portal now stands lit.
     **/
    // find obsidian clusters: ruined or unfinished frames
    const obs = world.getNearestBlocksWhere(bot, b => b && (b.name === 'obsidian' || b.name === 'crying_obsidian' || b.name === 'nether_portal'), range, 40);
    if (!obs.length) { log(bot, 'No portal remains nearby (no obsidian frames in range) — build fresh with !portal nether.'); return false; }
    // cluster center = average of the obsidian found
    const cx = Math.round(obs.reduce((a, b) => a + b.position.x, 0) / obs.length);
    const cy = Math.round(obs.reduce((a, b) => a + b.position.y, 0) / obs.length);
    const cz = Math.round(obs.reduce((a, b) => a + b.position.z, 0) / obs.length);
    await goToPosition(bot, cx, cy, cz, 3);
    let fixed = [];
    // 1) swap crying_obsidian -> obsidian (the classic ruined-portal fault)
    const crying = world.getNearestBlocksWhere(bot, b => b && b.name === 'crying_obsidian', 12, 8);
    for (const c of crying) {
        if (bot.interrupt_code) return false;
        try {
            await collectBlock(bot, 'crying_obsidian', 1, null);
            if ((world.getInventoryCounts(bot)['obsidian'] || 0) > 0) {
                await placeBlock(bot, 'obsidian', c.position.x, c.position.y, c.position.z, 'bottom', true);
                fixed.push(`swapped crying_obsidian at (${c.position.x},${c.position.y},${c.position.z})`);
            }
        } catch (_) {}
    }
    // 2) complete a 4x5 frame around the cluster center (fills any gaps)
    const bx = cx - 1, by = cy, bz = cz;
    const frame = [];
    for (let dx = 0; dx < 4; dx++) { frame.push([bx + dx, by, bz]); frame.push([bx + dx, by + 4, bz]); }
    for (let dy = 1; dy <= 3; dy++) { frame.push([bx, by + dy, bz]); frame.push([bx + 3, by + dy, bz]); }
    for (const [x, y, z] of frame) {
        if (bot.interrupt_code) return false;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b || b.name === 'air') {
            if ((world.getInventoryCounts(bot)['obsidian'] || 0) <= 0) {
                try { await collectBlock(bot, 'obsidian', 1); } catch (_) {}
            }
            if ((world.getInventoryCounts(bot)['obsidian'] || 0) > 0) {
                try { await placeBlock(bot, 'obsidian', x, y, z, 'bottom', true); fixed.push(`filled gap at (${x},${y},${z})`); } catch (_) {}
            }
        }
    }
    // 3) already lit?
    const inside = bot.blockAt(new Vec3(bx + 1, by + 1, bz));
    if (inside && inside.name === 'nether_portal') { log(bot, `Portal already lit — ${fixed.length ? 'also ' + fixed.join('; ') : 'nothing to fix'}. Walk in~ ♥`); return true; }
    // 4) light it
    if (!(world.getInventoryCounts(bot)['flint_and_steel'] > 0)) {
        try { await craftRecipe(bot, 'flint_and_steel', 1, true); } catch (_) {}
    }
    const lighter = world.getInventoryCounts(bot)['flint_and_steel'] > 0 ? 'flint_and_steel'
        : world.getInventoryCounts(bot)['fire_charge'] > 0 ? 'fire_charge' : null;
    if (!lighter) { log(bot, `Repaired (${fixed.join('; ') || 'frame was whole'}) but no lighter — craft flint_and_steel (iron + flint) and click the inside.`); return false; }
    try {
        await useToolOnBlock(bot, lighter, bot.blockAt(new Vec3(bx + 1, by + 1, bz)) || bot.blockAt(new Vec3(bx + 1, by, bz)));
        await new Promise(r => setTimeout(r, 800));
        const lit = bot.blockAt(new Vec3(bx + 1, by + 1, bz));
        if (lit && lit.name === 'nether_portal') { log(bot, `Fixed + LIT (${fixed.join('; ') || 'frame was whole'})~ ♥`); return true; }
        log(bot, `Repaired (${fixed.join('; ') || 'frame whole'}) — lighter clicked, re-check the glow.`);
        return false;
    } catch (e) {
        log(bot, `Repair done (${fixed.join('; ') || 'frame whole'}) but lighting failed: ${e.message}`);
        return false;
    }
}

export async function fillEndPortal(bot, range = 16) {
    /**
     * END portal: she can NEVER build the frame (end_portal_frame is
     * stronghold-only, uncraftable, uncollectible) — but she CAN finish one:
     * find the 12-frame ring nearby, place an ender_eye in every empty frame
     * (right-click each), 12th eye OPENS the portal (don't jump in unready —
     * the End means the dragon). Reports eyes placed vs still missing.
     * @returns {Promise<boolean>} true if the portal is complete/open.
     **/
    const frames = world.getNearestBlocksWhere(bot, b => b && b.name === 'end_portal_frame', range, 12);
    if (!frames.length) {
        log(bot, 'No end_portal_frame nearby — strongholds hide underground; throw an ender_eye and follow where it flies (!sourcing "ender_eye"). I cannot BUILD the frame (uncraftable) — only finish one.');
        return false;
    }
    let have = world.getInventoryCounts(bot)['ender_eye'] || 0;
    if (have <= 0) { log(bot, 'Found the frame but no ender_eye (craft: ender_pearl + blaze_powder). Make eyes first.'); return false; }
    let placed = 0;
    for (const f of frames) {
        if (bot.interrupt_code) break;
        if ((world.getInventoryCounts(bot)['ender_eye'] || 0) <= 0) break;
        // eye already in? frame block with eye=true — try reading state, else attempt
        let hasEye = false;
        try {
            const st = f.state; // mineflayer block state map if present
            if (st && typeof st.eye !== 'undefined') hasEye = !!st.eye;
        } catch (_) {}
        if (hasEye) continue;
        try {
            await goToPosition(bot, f.position.x, f.position.y, f.position.z, 3);
            await useToolOnBlock(bot, 'ender_eye', f);
            placed++;
            await new Promise(r => setTimeout(r, 400));
        } catch (_) {}
    }
    // check: end_portal blocks inside the ring = open
    const insideBlocks = world.getNearestBlocksWhere(bot, b => b && b.name === 'end_portal', 8, 9);
    if (insideBlocks.length >= 5) { log(bot, `END PORTAL OPEN (${placed} eyes placed by me) — the dragon waits. Gear up (full diamond + bow + food + torches) before jumping in.`); return true; }
    const left = frames.length - placed;
    log(bot, `Placed ${placed} eyes; ~${Math.max(0, left)} frames still empty (or already eyed) — ${insideBlocks.length >= 5 ? 'portal hums, OPEN.' : 'bring more ender_eye (pearl + blaze_powder each).'}`);
    return insideBlocks.length >= 5;
}

export async function portal(bot, job = 'help', arg = null) {
    /**
     * One dispatcher for portal work — the brain calls ONE command.
     * job: nether | fix | end | help
     **/
    job = String(job || 'help').toLowerCase();
    if (job === 'nether' || job === 'build') return await buildNetherPortal(bot);
    if (job === 'fix' || job === 'repair' || job === 'light' || job === 'ruined') {
        const r = parseInt(arg, 10);
        return await fixPortal(bot, Number.isFinite(r) ? r : 32);
    }
    if (job === 'end' || job === 'fill' || job === 'eyes') {
        const r = parseInt(arg, 10);
        return await fillEndPortal(bot, Number.isFinite(r) ? r : 16);
    }
    log(bot, 'Portals: !portal nether (build + light a 4x5 frame), !portal fix [range] (repair a broken/ruined frame: swap crying obsidian, fill gaps, light), !portal end [range] (fill stronghold eyes — frame is uncraftable, only finishable).');
    return false;
}

export async function speedBridge(bot, block = null, length = 8) {
    /**
     * SPEED BRIDGE (ninja bridge without falling): crouch-walk BACKWARDS off
     * the edge placing under her own feet — sneak never lets her fall, rhythm
     * places every step. Slow-safe by default; NOT a no-shift godbridge (that
     * one falls to its death on lag — she values her life).
     **/
    length = Math.max(2, Math.min(24, Math.floor(length || 8)));
    let mat = block;
    if (!mat) {
        const inv = world.getInventoryCounts(bot);
        mat = ['cobblestone', 'dirt', 'oak_planks', 'stone', 'deepslate'].find(m => (inv[m] || 0) >= length) || 'dirt';
    }
    const have = await acquireBlocks(bot, mat, length);
    if (have < 2) { log(bot, `Only ${have} ${mat} — need ${length} to bridge.`); return false; }
    // face AWAY from build dir: walk backwards, sneak locked the whole run
    try {
        bot.setControlState('sneak', true);
        for (let i = 0; i < length; i++) {
            if (bot.interrupt_code) { _parkStop(bot); return false; }
            const f = bot.entity.position.floored();
            // place under own feet, then one step back
            const ok = await placeBlock(bot, mat, f.x, f.y - 1, f.z, 'bottom', true);
            if (!ok) break;
            bot.setControlState('back', true);
            await new Promise(r => setTimeout(r, 350)); // one step per place
            bot.setControlState('back', false);
            await new Promise(r => setTimeout(r, 120));
        }
    } finally {
        _parkStop(bot);
    }
    log(bot, `Bridged ~${length} in ${mat}, never unshifted~ ♥`);
    return true;
}

export async function parkour(bot, technique = 'jump', arg = null) {
    /**
     * One dispatcher for the whole trick list — the brain calls ONE command.
     * technique: edge | jump | strafe45 | neo | backward | clutch | ladder | bridge
     * arg: side for neo/strafe (left/right), block for clutch/bridge, length for bridge.
     **/
    technique = String(technique || 'jump').toLowerCase();
    if (technique === 'edge') return await edgeSneak(bot);
    if (technique === 'jump') return await sprintJump(bot, null);
    if (technique === 'strafe45' || technique === 'strafe' || technique === '45') {
        const side = (arg === 'left' || arg === 'right') ? arg : 'right';
        return await sprintJump(bot, side);
    }
    if (technique === 'neo') {
        const side = (arg === 'left' || arg === 'right') ? arg : 'right';
        return await neoJump(bot, side);
    }
    if (technique === 'backward' || technique === 'bw' || technique === 'momentum') return await backwardJump(bot);
    if (technique === 'clutch' || technique === 'mlg') return await blockClutch(bot, arg);
    if (technique === 'ladder') return await ladderClutch(bot);
    if (technique === 'bridge') {
        const parts = String(arg || '').split(/\s+/).filter(Boolean);
        const mat = parts[0] || null;
        const len = parts[1] ? parseInt(parts[1], 10) : 8;
        return await speedBridge(bot, mat, Number.isFinite(len) ? len : 8);
    }
    log(bot, `Unknown trick "${technique}" — try edge, jump, strafe45, neo, backward, clutch, ladder, bridge.`);
    return false;
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function acquireBlocks(bot, blockType, count, _depth = 0) {
    /**
     * Ensure the bot has at least `count` of `blockType` in inventory by gathering
     * raw materials and crafting, survival-style (no /give, no /fill). Returns the
     * number of `blockType` now held (may be less than requested if materials ran out).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} blockType - the block/item to acquire, e.g. 'oak_planks'.
     * @param {number} count - how many are wanted.
     * @returns {Promise<number>} the number of blocks now in inventory.
     * @example
     * await skills.acquireBlocks(bot, 'oak_planks', 64);
     **/
    count = Math.max(1, Math.floor(count));
    const haveCount = () => world.getInventoryCounts(bot)[blockType] || 0;

    let have = haveCount();
    if (have >= count) return have;

    if (_depth > 6) {
        log(bot, `Recipe chain too deep for ${blockType}.`);
        return have;
    }

    const recipes = mc.getItemCraftingRecipes(blockType);
    if (recipes && recipes.length > 0) {
        // recipes[0] = [ {ingredientName: countPerCraft, ...}, {craftedCount} ]
        const [ingredients, out] = recipes[0];
        const craftedCount = (out && out.craftedCount) || 1;
        const need = count - have;
        const crafts = Math.ceil(need / craftedCount);
        for (const [ing, perCraft] of Object.entries(ingredients)) {
            if (bot.interrupt_code) return haveCount();
            await acquireBlocks(bot, ing, crafts * perCraft, _depth + 1);
        }
        await craftRecipe(bot, blockType, crafts);
        have = haveCount();
        if (have >= count) return have;
        log(bot, `Couldn't gather enough ${blockType} (have ${have}, need ${count}).`);
        return have;
    }

    // Not craftable — collect it directly from the world.
    await collectBlock(bot, blockType, count - have);
    return haveCount();
}

export async function doubleChest(bot) {
    /**
     * Make (or extend into) a DOUBLE CHEST: two chests side-by-side = one
     * 54-slot box, one lid, one window. Needs 2 chest items (16 planks —
     * crafts them if short). If a single chest is near, places the second
     * against its side in a NORMAL stance (standing merges); if none is near,
     * places both at her feet. Verifies 54 slots via the opened window.
     * @returns {Promise<boolean>} true if a 54-slot double chest stands.
     **/
    const need = 2 - (bot.inventory.findInventoryItem('chest')?.count || 0) -
        (bot.inventory.findInventoryItem('trapped_chest')?.count || 0);
    if (need > 0) {
        for (let i = 0; i < need; i++) {
            const ok = await craftRecipe(bot, 'chest', 1);
            if (!ok) { log(bot, `Need ${need} more chest(s) for a double — short on planks (8 planks each).`); return false; }
        }
    }
    let first = world.getNearestBlock(bot, 'chest', 32);
    try { bot.setControlState('sneak', false); } catch (_) {} // standing = MERGE
    if (!first) {
        // no chest around: lay the first at her feet, second beside it
        const p = bot.entity.position.floored();
        const ok = await placeBlock(bot, 'chest', p.x + 1, p.y, p.z);
        if (!ok) return false;
        first = bot.blockAt(new Vec3(p.x + 1, p.y, p.z));
    }
    // find a free side slot next to the first chest
    const fp = first.position;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of sides) {
        const t = bot.blockAt(new Vec3(fp.x + dx, fp.y, fp.z + dz));
        if (t && (t.name === 'air' || t.name === 'water')) {
            const ok = await placeBlock(bot, 'chest', t.position.x, t.position.y, t.position.z);
            if (!ok) continue;
            // verify: open the pair — a double window has 90 slots (54 chest + 36 player), single has 63
            try {
                await goToBlockAdjacent(bot, t);
                const win = await bot.openContainer(t);
                const n = win.slots ? win.slots.length : 0;
                try { win.close(); } catch (_) {}
                if (n >= 90) { log(bot, `DOUBLE CHEST done at ${t.position} — 54 slots, one window (verified ${n} window slots).`); return true; }
                log(bot, `Placed second chest at ${t.position} but it stayed SINGLE (27) — likely sneak was held or a trapped_chest neighbor. Break one and re-place standing.`); return false;
            } catch (_) { log(bot, `Second chest placed at ${t.position} — merge assumed (open it to confirm 54).`); return true; }
        }
    }
    log(bot, 'No free side slot around the chest — clear one block beside it first.');
    return false;
}

export async function singleChest(bot) {
    /**
     * Place a chest that stays SINGLE even right beside another chest:
     * holds SNEAK during placement (Java rule — crouch-place never merges).
     * Use for category rows: many separate 27-slot boxes packed wall-to-wall.
     * Alternating normal + trapped_chest also never merges (alarm bonus).
     * @returns {Promise<boolean>} true if a single (27-slot) chest stands.
     **/
    if (!(bot.inventory.findInventoryItem('chest') || bot.inventory.findInventoryItem('trapped_chest'))) {
        const ok = await craftRecipe(bot, 'chest', 1);
        if (!ok) { log(bot, 'No chest and no planks — 8 planks crafts one.'); return false; }
    }
    const near = world.getNearestBlock(bot, 'chest', 32);
    let tx = null, ty = null, tz = null;
    if (near) {
        const fp = near.position;
        const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dz] of sides) {
            const t = bot.blockAt(new Vec3(fp.x + dx, fp.y, fp.z + dz));
            if (t && (t.name === 'air' || t.name === 'water')) { tx = t.position.x; ty = t.position.y; tz = t.position.z; break; }
        }
        if (tx === null) { log(bot, 'No free slot beside the chest row — clear one first.'); return false; }
    } else {
        const p = bot.entity.position.floored(); tx = p.x + 1; ty = p.y; tz = p.z;
    }
    try { bot.setControlState('sneak', true); } catch (_) {} // crouch = NO merge
    let ok = false;
    try { ok = await placeBlock(bot, 'chest', tx, ty, tz); }
    finally { try { bot.setControlState('sneak', false); } catch (_) {} }
    if (ok) log(bot, `SINGLE chest placed at ${tx},${ty},${tz} — sneak-held so it never merged (27 slots, own window).`);
    return ok;
}

export async function placeBlockList(bot, block, positions) {
    /**
     * Place a list of [x, y, z] positions one block at a time, survival-style
     * (real placement that consumes inventory — no /fill or /setblock cheat).
     * Gathers and crafts the material first, then places bottom-up so every block
     * has support. Returns the number of blocks actually placed.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type to build with, e.g. 'oak_planks'.
     * @param {number[][]} positions - array of [x, y, z] integer coordinates.
     * @returns {Promise<number>} blocks placed.
     * @example
     * await skills.placeBlockList(bot, 'oak_planks', [[0,64,0],[1,64,0]]);
     **/
    if (!positions.length) return 0;

    // Bottom-up (y asc) so lower layers are placed first; within a layer, place
    // edge blocks before interior so ceiling blocks always have a neighbour to
    // build off of.
    const xs = positions.map(p => p[0]), zs = positions.map(p => p[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const edgeDist = (p) => Math.min(p[0] - minX, maxX - p[0], p[2] - minZ, maxZ - p[2]);
    positions = [...positions].sort((a, b) => a[1] - b[1] || edgeDist(a) - edgeDist(b));

    const have = await acquireBlocks(bot, block, positions.length);
    if (have < positions.length) {
        log(bot, `Only gathered ${have}/${positions.length} ${block} — building with what I have.`);
    }

    let placed = 0;
    for (const [x, y, z] of positions) {
        if (bot.interrupt_code) break;
        if (await placeBlock(bot, block, x, y, z, 'bottom', true)) placed++;
    }
    log(bot, `Placed ${placed}/${positions.length} ${block} blocks.`);
    return placed;
}

export async function hollowBox(bot, block, width, depth, height) {
    /**
     * Build a hollow box — floor, 4 walls and a ceiling — with an empty walkable
     * interior. Use this to build houses and rooms (NOT a solid cube). Carve a
     * doorway afterwards if you need to walk inside.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type to build with, e.g. 'oak_planks'.
     * @param {number} width - x size in blocks (min 3 for a hollow interior).
     * @param {number} depth - z size in blocks (min 3).
     * @param {number} height - y size in blocks (min 3).
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.hollowBox(bot, 'oak_planks', 7, 7, 4);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + width; x++)
        for (let y = by; y < by + height; y++)
            for (let z = bz; z < bz + depth; z++) {
                const shell = x === bx || x === bx + width - 1 || y === by ||
                    y === by + height - 1 || z === bz || z === bz + depth - 1;
                if (shell) positions.push([x, y, z]);
            }
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built hollow ${block} box ${width}x${depth}x${height} (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function buildFloor(bot, block, width, depth) {
    /**
     * Build a flat floor of a given block, width x depth, at your feet.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type, e.g. 'oak_planks'.
     * @param {number} width - x size in blocks.
     * @param {number} depth - z size in blocks.
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.buildFloor(bot, 'stone_bricks', 10, 8);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + width; x++)
        for (let z = bz; z < bz + depth; z++)
            positions.push([x, by, z]);
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built ${block} floor ${width}x${depth} (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function buildWalls(bot, block, length, height = 4) {
    /**
     * Build a straight 1-block-thick wall, `length` long and `height` tall, along +X
     * from your position.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type, e.g. 'stone_bricks'.
     * @param {number} length - wall length in blocks.
     * @param {number} height - wall height in blocks (default 4).
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.buildWalls(bot, 'cobblestone', 12, 4);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const positions = [];
    for (let x = bx; x < bx + length; x++)
        for (let y = by; y < by + height; y++)
            positions.push([x, y, bz]);
    const placed = await placeBlockList(bot, block, positions);
    log(bot, `Built ${block} wall ${length}x${height} (${placed} blocks placed by hand).`);
    return placed > 0;
}

export async function buildBridge(bot, block, length, width = 3) {
    /**
     * Build a flat bridge with two side railings, `length` long and `width` wide,
     * extending along +X from your position — and WALK OUT along it as it grows,
     * placing the next deck under your own feet (ninja-bridging without the sneak:
     * walk to the fresh edge, place ahead, repeat). Railings keep mobs and her
     * from sliding off. Ends with her standing on the far side.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block type, e.g. 'oak_planks'.
     * @param {number} length - bridge length in blocks.
     * @param {number} width - bridge width in blocks (default 3).
     * @returns {Promise<boolean>} true on success (she crossed).
     * @example
     * await skills.buildBridge(bot, 'oak_planks', 8, 3);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    // gather the whole deck + rails up front (survival: no mid-air /give)
    const need = length * width + length * 2;
    const have = await acquireBlocks(bot, block, need);
    if (have < length * width) {
        log(bot, `Only gathered ${have}/${need} ${block} — not enough for the deck, stopping.`);
        return false;
    }
    // walk-and-place: edge of the deck first, rails from the deck, step forward
    for (let x = bx; x < bx + length; x++) {
        if (bot.interrupt_code) return false;
        for (let z = bz; z < bz + width; z++) {
            if (bot.interrupt_code) return false;
            await placeBlock(bot, block, x, by - 1, z, 'bottom', true);
        }
        await placeBlock(bot, block, x, by, bz, 'bottom', true);
        await placeBlock(bot, block, x, by, bz + width - 1, 'bottom', true);
        // step onto the fresh deck before reaching further
        try { await goToPosition(bot, x + 0.5, by, bz + Math.floor(width / 2) + 0.5, 1); } catch (_) {}
    }
    log(bot, `Bridged ${length}x${width} in ${block} and crossed it~ ♥`);
    return true;
}

export async function tidyUp(bot, what = 'all', arg = null) {
    what = String(what || 'all').toLowerCase();
    const inv = () => world.getInventoryCounts(bot);
    const near = (fn, r) => { try { return fn(bot, r); } catch (_) { return null; } };
    let done = [];
    const want = (k) => what === 'all' || what === k;

    // SPILLS: bucket up stray water/lava sources on walked ground (radius 8).
    // Dry-land rule: the source must sit ON walkable ground (solid below, sky
    // or air around — not part of a river/lake/ocean: neighbours mostly water
    // = leave it). Lava: scoop only, needs empty bucket + nerve; Refuses when
    // no empty bucket carried (never drinks lava obviously).
    if (want('spills') || want('water') || want('lava')) {
        const onlyLava = what === 'lava';
        const onlyWater = what === 'water';
        let fluids = [];
        try { fluids = world.getNearestBlocksWhere(bot, b => b && (b.name === 'water' || b.name === 'lava'), 8, 12) || []; } catch (_) {}
        for (const f of fluids) {
            if (bot.interrupt_code) break;
            if (onlyLava && f.name !== 'lava') continue;
            if (onlyWater && f.name !== 'water') continue;
            try {
                const below = bot.blockAt(f.position.offset(0, -1, 0));
                const solidBelow = below && below.name !== 'air' && below.name !== 'water' && below.name !== 'lava' && below.name !== 'cave_air';
                if (!solidBelow) continue; // in a pool/river, not a spill
                let wetNeighbours = 0;
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    try { const n = bot.blockAt(f.position.offset(dx, 0, dz)); if (n && (n.name === 'water' || n.name === 'lava')) wetNeighbours++; } catch (_) {}
                }
                if (wetNeighbours >= 3) continue; // real water body — hands off
                if ((inv()['bucket'] || 0) < 1) { log(bot, 'Spill spotted but no empty bucket — crafting/carrying one first is the fix.'); break; }
                await goToPosition(bot, f.position.x, f.position.y, f.position.z, 2);
                const got = await scoopAt(bot, f.name);
                if (got) done.push(`${f.name}@${f.position.x},${f.position.y},${f.position.z}`);
            } catch (_) {}
        }
        if (!done.length && (want('spills'))) log(bot, 'No stray spills in reach (bigger water = nature, not mess).');
    }

    // DROPS: pick up loose items lying around (radius 6 walk-over).
    if (want('drops') || want('items')) {
        try {
            const items = world.getNearbyEntities(bot, 8).filter(e => e && (e.name === 'item' || e.kind === 'Drops' || /dropped/i.test(e.displayName || '')));
            if (!items.length) { if (what !== 'all') log(bot, 'No loose drops in reach.'); }
            for (const it of items.slice(0, 8)) {
                if (bot.interrupt_code) break;
                try { await goToPosition(bot, it.position.x, it.position.y, it.position.z, 1); done.push(`picked:${it.name || 'drop'}`); } catch (_) {}
            }
            try { await pickupNearbyItems(bot); } catch (_) {}
        } catch (_) {}
    }

    // HOLES: fill 1-deep trip holes and flat trip lips in paths (radius 6).
    // Fill block: dirt first (cheapest), then cobble — survival honest.
    if (want('holes') || want('paths') || want('path')) {
        let spots = [];
        try { spots = world.getNearestBlocksWhere(bot, b => b && b.name === 'air', 6, 40) || []; } catch (_) {}
        let filled = 0;
        for (const s of spots) {
            if (bot.interrupt_code || filled >= 8) break;
            try {
                const below = bot.blockAt(s.position.offset(0, -1, 0));
                const twoBelow = bot.blockAt(s.position.offset(0, -2, 0));
                const solid = (b) => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.name !== 'cave_air';
                if (solid(below) || !solid(twoBelow)) continue; // not a 1-deep hole
                let fill = (inv()['dirt'] || 0) > 0 ? 'dirt' : ((inv()['cobblestone'] || 0) > 0 ? 'cobblestone' : null);
                if (!fill) { try { await acquireBlocks(bot, 'dirt', 4); } catch (_) {} fill = (inv()['dirt'] || 0) > 0 ? 'dirt' : null; }
                if (!fill) break;
                await placeBlock(bot, fill, s.position.x, s.position.y, s.position.z, 'bottom', true);
                filled++; done.push(`filled:${s.position.x},${s.position.y},${s.position.z}`);
            } catch (_) {}
        }
        if (!filled && what !== 'all') log(bot, 'No trip holes in reach — ground walks clean.');
    }

    // PATCH: re-place obviously-missing blocks in a damaged build (needs a
    // reference: !studyBuild snapshot first — without one she says so and
    // patches only the single named block+spot given as arg "block,x,y,z").
    if (want('patch') || want('repair') || want('fix')) {
        if (arg && /,/.test(String(arg))) {
            const parts = String(arg).split(',').map(s => s.trim());
            const blk = parts[0]; const xyz = parts.slice(1).map(Number);
            if (blk && xyz.length === 3 && xyz.every(Number.isFinite)) {
                try {
                    await placeBlock(bot, blk, xyz[0], xyz[1], xyz[2], 'bottom', true);
                    done.push(`patched:${blk}@${xyz.join(',')}`);
                } catch (e) { log(bot, `Patch failed: ${e.message} (need the block + a solid neighbour).`); }
            }
        } else if (what !== 'all') {
            log(bot, 'Patch needs a reference: !studyBuild a place first (then !whatChanged shows the damage), or !tidy patch <block,x,y,z>.');
        }
    }

    // PESTS: hostile leftovers menacing home (e.g. stray withers at spawn) —
    // HER judgment call: she fights what she can win, refuses suicide.
    // arg may name the mob ("wither", "zombie"...); default: nearest hostile.
    if (want('pests') || want('mobs') || want('wither')) {
        const named = (what === 'pests' || what === 'mobs' || what === 'wither') ? null : (['all', 'spills', 'water', 'lava', 'drops', 'items', 'holes', 'paths', 'path', 'patch', 'repair', 'fix'].includes(what) ? null : what);
        const targetName = named || arg || null;
        try {
            const hostiles = world.getNearbyEntities(bot, 24).filter(e => e && (e.kind === 'Hostile' || /wither|wither_skeleton|zombie|skeleton|creeper|spider|enderman|witch|phantom|slime|drowned|husk|stray|pillager|vex|ravager/i.test(e.name || '')));
            const pick = targetName
                ? hostiles.find(e => (e.name || '').toLowerCase().includes(String(targetName).toLowerCase()))
                : hostiles.sort((a, b) => { try { return bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position); } catch (_) { return 0; } })[0];
            if (!pick) { log(bot, targetName ? `No ${targetName} in 24m — nothing to clear.` : 'No hostiles in 24m — home is quiet.'); }
            else {
                const hp = pick.health || pick.metadata?.[8] || null;
                const scary = /wither|ender_dragon|warden|ravager/i.test(pick.name || '');
                if (scary) {
                    const gear = equipHighestAttack ? true : true;
                    try { await equipHighestAttack(bot); } catch (_) {}
                    const sword = bot.inventory.items().some(i => /sword|axe/i.test(i.name));
                    if (!sword) { log(bot, `${pick.name} nearby and I have no real weapon — refusing suicide. Gear up (!gearUp) first, then I clear it.`); }
                    else { log(bot, `${pick.name} pest at home — engaging (best weapon on, clutch ready).`); await attackEntity(bot, pick, true); done.push(`cleared:${pick.name}`); }
                } else { await attackEntity(bot, pick, true); done.push(`cleared:${pick.name}`); }
            }
        } catch (e) { log(bot, `Pest clear failed: ${e.message}`); }
    }

    // BRIDGE: quick span over the gap in front of her (lava/water/ravine) —
    // arg = block (default cobble), reuses the walk-and-place bridge hands.
    if (want('bridge')) {
        const blk = (arg && !/,/.test(String(arg))) ? String(arg) : 'cobblestone';
        try { await buildBridge(bot, blk, 8, 3); done.push(`bridged:8x3 ${blk}`); } catch (e) { log(bot, `Bridge failed: ${e.message}`); }
    }

    if (!done.length && what === 'all') log(bot, 'Looked around — nothing messy in reach. Home stays clean.');
    else if (done.length) log(bot, `Tidied: ${done.slice(0, 8).join(' | ')}${done.length > 8 ? ` (+${done.length - 8} more)` : ''}`);
    return done;
}

export async function mountNearestEntity(bot, type) {
    const mountable = ['boat', 'minecart', 'horse', 'donkey', 'mule', 'pig', 'strider', 'camel'];
    const entity = world.getNearestEntityWhere(bot, type ? (e) => e.name === type : (e) => mountable.includes(e.name), 8);
    if (!entity) {
        log(bot, `No ${type || 'mountable entity'} nearby.`);
        return false;
    }
    try {
        await bot.mount(entity);
        log(bot, `Mounted ${entity.name}.`);
        return true;
    } catch (e) {
        log(bot, `Could not mount ${entity.name}: ${e.message}`);
        return false;
    }
}

export async function dismount(bot) {
    /**
     * Dismount the entity you are riding (boat, horse, minecart, etc).
     * NOTE on boats + crawling: exiting a boat with less than ~1 block of
     * headroom keeps you in the CRAWL pose (0.6 tall) instead of standing —
     * the classic crawl entry. !crawl boat uses this on purpose; a plain
     * dismount here just steps off wherever the game puts you.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if dismounted.
     * @example
     * await skills.dismount(bot);
     **/
    if (!bot.vehicle) {
        log(bot, 'Not riding anything.');
        return false;
    }
    bot.dismount();
    log(bot, 'Dismounted.');
    return true;
}

export async function spawnAndMountBoat(bot) {
    /**
     * Get on the water the honest way: craft a boat from planks if needed,
     * place it on nearby water, and mount it. Falls back to OP /summon + /give
     * only when she truly cannot (no wood nearby, no boat craftable) — the
     * fallback keeps her mobile instead of stuck, and she says which path she took.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if mounted.
     * @example
     * await skills.spawnAndMountBoat(bot);
     **/
    // 1) honest path: boat in hand (carried or crafted from planks) + water nearby
    let boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    if (!boatItem) {
        // craft one: 5 planks in a U — any wood family works
        for (const fam of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar']) {
            if (bot.interrupt_code) break;
            try {
                if (await craftRecipe(bot, `${fam}_boat`, 1, true)) break;
            } catch (_) {}
        }
        boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    }
    const water = world.getNearestBlock(bot, 'water', 24);
    if (boatItem && water) {
        try {
            await bot.equip(boatItem, 'hand');
            const ref = bot.blockAt(water.position);
            if (ref) {
                const ent = await bot.placeEntity(ref, new Vec3(0, 1, 0));
                await new Promise(r => setTimeout(r, 300));
                const target = (ent && ent.position) ? ent : world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 6);
                if (target) { try { await bot.mount(target); log(bot, `Placed my ${boatItem.name} on the water and hopped in~ ♥`); return true; } catch (_) {} }
            }
        } catch (e) {
            log(bot, `Could not place my boat: ${e.message} — trying the quick way.`);
        }
    }
    // 2) fallback: OP summon + mount (old path) — only when honest fails
    log(bot, boatItem ? 'No water close enough to launch from.' : 'No boat and no wood to make one — taking the quick way.');
    const pos = bot.entity.position;
    bot.chat(`/summon oak_boat ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`);
    await new Promise(r => setTimeout(r, 350));
    const boat = world.getNearestEntityWhere(bot, (e) => e.name === 'boat' || e.name === 'oak_boat', 6);
    if (!boat) {
        log(bot, 'Could not find the spawned boat.');
        return false;
    }
    try { await bot.mount(boat); log(bot, 'Mounted the boat.'); return true; }
    catch (e) { log(bot, `Could not mount boat: ${e.message}`); return false; }
}

export async function rideHorse(bot) {
    /**
     * Find a nearby horse, give yourself a saddle (OP), saddle it and mount it.
     * Untamed horses buck you off — mount repeatedly until hearts appear
     * (tamed), THEN saddle. Tamed + saddled = steering works.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if mounted.
     * @example
     * await skills.rideHorse(bot);
     **/
    const horse = world.getNearestEntityWhere(bot, (e) => ['horse', 'donkey', 'mule'].includes(e.name), 16);
    if (!horse) { log(bot, 'No horse nearby.'); return false; }
    bot.chat('/give @s saddle 1');
    await new Promise(r => setTimeout(r, 200));
    const saddle = bot.inventory.items().find(i => i.name === 'saddle');
    if (saddle) { await bot.equip(saddle, 'hand'); try { await bot.activateEntity(horse); } catch {} }
    await new Promise(r => setTimeout(r, 200));
    try { await bot.mount(horse); log(bot, 'Mounted the horse.'); return true; }
    catch (e) { log(bot, `Could not mount horse: ${e.message}`); return false; }
}

// ============================================================================
// TAMING & RIDING — every mountable mob, honest-first. Pattern everywhere:
// tame (if needed) -> saddle/armor (if needed) -> mount -> steer item (if
// needed). OP /give fallback ONLY for uncraftable tack (saddle); everything
// craftable (carrot stick, fungus stick, leads, boats, minecarts, chests) is
// CRAFTED. Luring uses the mob's follow-food via lureMob(); boats/carts trap
// via boatTrap(). All refuse when the mob is hostile/untameable.
// ============================================================================
const TAME_TABLE = {
    // tamer: item to feed-tame (repeat until hearts); saddle: needs saddle to
    // steer; steerer: item held to drive; chestable: holds a chest;
    // armor: wears horse_armor; boatable: fits in a boat/minecart.
    horse:   { tamer: null, saddle: true, armor: true, boatable: false, note: 'mount repeatedly bare-handed until hearts (tamed), then saddle to steer' },
    donkey:  { tamer: null, saddle: true, chestable: true, boatable: false, note: 'tame like a horse; sneak + use with chest to add 15 slots' },
    mule:    { tamer: null, saddle: true, chestable: true, boatable: false, note: 'horse x donkey bred; tame like a horse; chest like a donkey' },
    pig:     { tamer: null, saddle: true, steerer: 'carrot_on_a_stick', boatable: true, note: 'saddle it, hold carrot_on_a_stick (fishing_rod + carrot) to drive' },
    strider: { tamer: null, saddle: true, steerer: 'warped_fungus_on_a_stick', boatable: false, note: 'nether lava-walker; warped_fungus_on_a_stick (fishing_rod + warped_fungus) drives; rain/snow hurts it, cold slows it' },
    camel:   { tamer: null, saddle: true, boatable: false, note: 'saddle it; seats TWO (driver + passenger); tall — ducks 2-high gaps' },
    wolf:    { tamer: 'bone', saddle: false, armor: true, boatable: true, note: 'feed bones until hearts + collar; sits/stands on command; wolf_armor protects' },
    cat:     { tamer: 'cod', saddle: false, boatable: true, note: 'sneak up with raw cod/salmon, feed until hearts; scares creepers; sits on chests/beds' },
    parrot:  { tamer: 'wheat_seeds', saddle: false, boatable: true, note: 'feed seeds until hearts; perches on shoulder; dances to jukebox; NEVER feed cookies (poison)' },
    llama:   { tamer: null, saddle: false, chestable: true, boatable: true, note: 'mount repeatedly until hearts, then chest for 3-15 slots; NO saddle control — lead it in a caravan (leash one, rest follow)' },
    axolotl: { tamer: null, saddle: false, boatable: true, bucketable: true, note: 'scoop with a water_bucket into a bucket_of_axolotl to carry; fights drowned/guardians beside you' },
    allay:   { tamer: null, saddle: false, boatable: true, note: 'give it ANY item and it fetches matching drops; untameable but befriendable' },
};
// what each mob will FOLLOW when held (lure food) — distinct from taming food
const LURE_FOOD = {
    cow: 'wheat', mooshroom: 'wheat', sheep: 'wheat', goat: 'wheat',
    pig: 'carrot', rabbit: 'carrot',
    chicken: 'wheat_seeds', horse: 'golden_apple', donkey: 'golden_apple',
    cat: 'cod', wolf: 'bone', turtle: 'seagrass', panda: 'bamboo',
    llama: 'hay_block', villager: null, // villagers don't follow food — push/boat them
};

function _tackItem(bot, name) {
    return bot.inventory.items().find(i => i.name === name);
}

export async function tameMob(bot, type) {
    /**
     * Tame a nearby mob of the given type the honest way: feed its taming
     * food until hearts (wolf=bone, cat=cod sneak-fed, parrot=seeds), or
     * mount-repeatedly for horses/donkeys/mules/llamas until hearts.
     * Untameables (pig, strider, camel, axolotl, allay) report HOW to use
     * them instead of pretending to tame.
     **/
    type = String(type || '').toLowerCase().replace(/s$/, type.endsWith('s') ? '' : '');
    const info = TAME_TABLE[type];
    if (!info) { log(bot, `${type || 'that'} is not tameable/rideable — it can't be a mount (boat-trap it with !boatTrap if you need to move it).`); return false; }
    const mob = world.getNearestEntityWhere(bot, e => e.name === type, 16);
    if (!mob) { log(bot, `No ${type} nearby to tame.`); return false; }
    if (info.tamer) {
        // feed-tame: hold food, use on mob until hearts
        if (!_tackItem(bot, info.tamer)) { log(bot, `Need ${info.tamer} to tame a ${type} — find some first (!sourcing).`); return false; }
        try { await bot.equip(_tackItem(bot, info.tamer), 'hand'); } catch (_) {}
        for (let i = 0; i < 8 && !bot.interrupt_code; i++) {
            try {
                if (type === 'cat') bot.setControlState('sneak', true); // cats spook — sneak-feed
                await bot.lookAt(mob.position.offset(0, 1, 0));
                await bot.useOn(mob);
            } catch (_) {}
            await new Promise(r => setTimeout(r, 500));
        }
        try { bot.setControlState('sneak', false); } catch (_) {}
        log(bot, `Fed the ${type} ${info.tamer} — hearts = tamed, collar/sit means it worked.`);
        return true;
    }
    if (['horse', 'donkey', 'mule', 'llama'].includes(type)) {
        // mount-tame: bare hands, mount until it stops bucking (hearts)
        try { await bot.unequip('hand'); } catch (_) {}
        for (let i = 0; i < 10 && !bot.interrupt_code; i++) {
            try { await bot.mount(mob); } catch (_) {}
            await new Promise(r => setTimeout(r, 1200));
            if (bot.vehicle) { log(bot, `${type} tamed (staying on) — hearts~ ♥`); return true; }
        }
        log(bot, `Kept mounting the ${type} — staying on = tamed.`);
        return !!bot.vehicle;
    }
    log(bot, `${type}: ${info.note}.`);
    return false;
}

export async function saddleMob(bot, type) {
    /**
     * Saddle a nearby TAMED mob (horse/donkey/mule/pig/strider/camel).
     * Honest paths first: loot one from structure chests, fish treasure loot,
     * trade a master leatherworker, or kill a ravager (!sourcing("saddle")
     * knows the chain). OP /give ONLY when nothing is near — she says which
     * path she took. Then sneak-use to open its inventory for armor/chest,
     * mount, report tack status.
     **/
    type = String(type || '').toLowerCase();
    const info = TAME_TABLE[type];
    if (!info || !info.saddle) { log(bot, `${type} doesn't take a saddle (${info ? info.note : 'not rideable'}).`); return false; }
    const mob = world.getNearestEntityWhere(bot, e => e.name === type, 16);
    if (!mob) { log(bot, `No ${type} nearby to saddle.`); return false; }
    if (!_tackItem(bot, 'saddle')) {
        // honest first: a chest nearby may already hold one (dungeon/mineshaft/
        // temple loot is how real players get their first saddle)
        const chest = world.getNearestBlock(bot, 'chest', 24);
        if (chest) {
            log(bot, 'No saddle carried — checking the nearest chest for loot first (saddles come from dungeon/mineshaft/temple chests, fishing treasure, master leatherworkers ~6 emeralds, or ravager drops).');
            try { await viewChest(bot); } catch (_) {}
            // chest held one? pull it out honestly
            if (world.getNearestBlock(bot, 'chest', 24) && !_tackItem(bot, 'saddle')) {
                try { await takeFromChest(bot, 'saddle', 1); } catch (_) {}
            }
        }
        if (!_tackItem(bot, 'saddle')) {
            log(bot, 'No saddle in reach — taking the quick way (OP give), since saddles have NO recipe. Loot/fish/trade one honestly when you can.');
            bot.chat('/give @s saddle 1'); // uncraftable — last resort, announced
            await new Promise(r => setTimeout(r, 300));
        } else {
            log(bot, 'Found a saddle honestly — no OP needed~ ♥');
        }
    }
    const saddle = _tackItem(bot, 'saddle');
    if (!saddle) { log(bot, 'Could not get a saddle.'); return false; }
    try { await bot.equip(saddle, 'hand'); } catch (_) {}
    try { await bot.activateEntity(mob); } catch (_) {} // saddle on
    await new Promise(r => setTimeout(r, 300));
    if (info.steerer && !_tackItem(bot, info.steerer)) {
        // carrot/fungus stick IS craftable — make it, don't give it
        try { await craftRecipe(bot, info.steerer, 1, true); } catch (_) {}
    }
    if (type === 'pig' && !_tackItem(bot, 'carrot_on_a_stick')) {
        log(bot, 'Pig saddled but no carrot_on_a_stick (fishing_rod + carrot) — craft one to steer, or it wanders.');
    }
    if (type === 'strider' && !_tackItem(bot, 'warped_fungus_on_a_stick')) {
        log(bot, 'Strider saddled but no warped_fungus_on_a_stick (fishing_rod + warped_fungus) — craft one to steer on lava.');
    }
    try { await bot.mount(mob); log(bot, `Saddled and mounted the ${type}~ ♥`); return true; }
    catch (e) { log(bot, `Saddled the ${type} but could not mount: ${e.message} (tame it first with !tame).`); return false; }
}

export async function chestMob(bot, type) {
    /**
     * Put a chest on a donkey/mule/llama (sneak + use with chest in hand):
     * donkey/mule = 15 slots, llama = 3-15 by strength. Then open with
     * sneak-use to pack/unpack. Reports if already chested or untamed.
     **/
    type = String(type || '').toLowerCase();
    const info = TAME_TABLE[type];
    if (!info || !info.chestable) { log(bot, `${type} can't wear a chest (donkey/mule/llama only).`); return false; }
    const mob = world.getNearestEntityWhere(bot, e => e.name === type, 16);
    if (!mob) { log(bot, `No ${type} nearby.`); return false; }
    if (!_tackItem(bot, 'chest')) {
        try { await craftRecipe(bot, 'chest', 1, true); } catch (_) {}
    }
    if (!_tackItem(bot, 'chest')) { log(bot, 'Need a chest (8 planks) to chest it.'); return false; }
    try {
        await bot.equip(_tackItem(bot, 'chest'), 'hand');
        bot.setControlState('sneak', true);
        await bot.lookAt(mob.position.offset(0, 1, 0));
        await bot.useOn(mob);
        bot.setControlState('sneak', false);
        log(bot, `Chested the ${type} — sneak-use it to pack/unpack ${type === 'llama' ? '(3-15 slots by strength)' : '(15 slots)'}~ ♥`);
        return true;
    } catch (e) {
        try { bot.setControlState('sneak', false); } catch (_) {}
        log(bot, `Could not chest the ${type}: ${e.message} (tame it first with !tame).`);
        return false;
    }
}

export async function rideMount(bot, type) {
    /**
     * Full honest pipeline for ANY mount: tame (if it tames) -> saddle (if it
     * saddles) -> mount -> hold the steering item. One call: !ride pig, !ride
     * horse, !ride strider, !ride camel, !ride donkey, !ride llama...
     **/
    type = String(type || '').toLowerCase();
    const info = TAME_TABLE[type];
    if (!info) { log(bot, `${type} is not a mount. Boat-trap it (!boatTrap) if you need to move it.`); return false; }
    if (info.tamer || ['horse', 'donkey', 'mule', 'llama'].includes(type)) {
        await tameMob(bot, type);
        if (bot.interrupt_code) return false;
    }
    if (info.saddle) {
        const ok = await saddleMob(bot, type);
        if (bot.interrupt_code) return false;
        return ok;
    }
    // no saddle (llama): tame + lead, or mount bareback for fun
    const mob = world.getNearestEntityWhere(bot, e => e.name === type, 16);
    if (!mob) { log(bot, `No ${type} nearby.`); return false; }
    try { await bot.mount(mob); log(bot, `On the ${type} (no saddle needed)~ ♥`); return true; }
    catch (e) { log(bot, `Could not mount the ${type}: ${e.message}`); return false; }
}

export async function lureMob(bot, type) {
    /**
     * Lure a nearby mob by holding its follow-food (cow/sheep=wheat,
     * pig/carrot, chicken=seeds, cat=cod, wolf=bone...) and walking slowly
     * toward the goal — it trails behind. Leads mobs INTO boats/carts/pens.
     * Villagers don't follow food — boat-trap them instead.
     **/
    type = String(type || '').toLowerCase();
    const food = LURE_FOOD[type];
    if (food === null) { log(bot, 'Villagers never follow food — push one into a boat/minecart (!boatTrap) instead.'); return false; }
    if (!food) { log(bot, `Don't know the lure food for ${type} — try holding wheat/seeds/carrots and see.`); return false; }
    const mob = world.getNearestEntityWhere(bot, e => e.name === type, 16);
    if (!mob) { log(bot, `No ${type} nearby to lure.`); return false; }
    if (!_tackItem(bot, food)) { log(bot, `Need ${food} to lure a ${type} (!sourcing).`); return false; }
    try { await bot.equip(_tackItem(bot, food), 'hand'); } catch (_) {}
    try { await bot.lookAt(mob.position.offset(0, 1, 0)); } catch (_) {}
    await new Promise(r => setTimeout(r, 1200)); // let it notice the food
    log(bot, `Holding ${food} — the ${type} should follow. Walk slowly to lead it (sprint scares nothing, but distance breaks interest — stay close).`);
    return true;
}

export async function shove(bot, what, tx = null, ty = null, tz = null) {
    /**
     * Push something by walking INTO it — your body is a physics tool. Boats,
     * minecarts, mobs, armor stands, dropped items: all slide when you walk
     * through them (sprint = harder shove). Give a mob type ("cow") or
     * "boat"/"cart" for the nearest one, plus a target x y z to push TOWARD
     * (omit = just bump it). Use: correct a boat's placement for !crawl boat
     * entry (shove it under the ceiling first), nudge a trap boat onto a mob,
     * push a cart onto rails, crowd mobs into a corner/trap, shove a boat off
     * a beach back into water. Never shoves players (rude + griefy).
     * @returns {Promise<boolean>} true if it moved (or was bumped).
     **/
    what = String(what || '').toLowerCase();
    const isBoat = what.includes('boat');
    const isCart = what.includes('cart') || what.includes('minecart');
    const ent = isBoat ? world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 10)
        : isCart ? world.getNearestEntityWhere(bot, e => /minecart/.test(e.name || ''), 10)
        : world.getNearestEntityWhere(bot, e => e && e.name === what, 10);
    if (!ent) { log(bot, `No ${what || 'thing'} in 10m to shove — get closer first.`); return false; }
    if (ent.type === 'player') { log(bot, 'Never shove players — rude and griefy. Mobs, boats and carts only.'); return false; }
    const hasTarget = Number.isFinite(Number(tx)) && Number.isFinite(Number(ty)) && Number.isFinite(Number(tz));
    const start = ent.position.clone ? ent.position.clone() : { x: ent.position.x, z: ent.position.z };
    // walk INTO it from the opposite side of the target (or just through it):
    // stand ~1.5 past it away from target, then walk at the target through it.
    const t0 = Date.now();
    try {
        if (hasTarget) {
            const dx = Number(tx) - ent.position.x, dz = Number(tz) - ent.position.z;
            const d = Math.hypot(dx, dz) || 1;
            const ax = ent.position.x - dx / d * 1.6, az = ent.position.z - dz / d * 1.6;
            try { await goToPosition(bot, ax, ent.position.y, az, 1); } catch (_) {}
            if (bot.interrupt_code) return false;
            try { await goToPosition(bot, Number(tx), ent.position.y, Number(tz), 1); } catch (_) {}
        } else {
            // no target: walk straight through it twice (bump + follow-through)
            try { await goToPosition(bot, ent.position.x, ent.position.y, ent.position.z, 0); } catch (_) {}
        }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500)); // let physics settle
    let moved = 0;
    try {
        const now = world.getNearestEntityWhere(bot, e => e && e.id === ent.id, 16) || ent;
        moved = Math.hypot(now.position.x - start.x, now.position.z - start.z);
    } catch (_) {}
    if (moved > 0.4) {
        log(bot, `Shoved the ${ent.name} ~${moved.toFixed(1)}m${hasTarget ? ' toward the mark' : ''} — body-push works, repeat as needed.`);
        return true;
    }
    log(bot, `Bumped the ${ent.name} (moved ~${moved.toFixed(1)}m — stuck on a block? clear its path and shove again).`);
    return moved > 0.1;
}

export async function boatTrap(bot, type) {
    /**
     * Trap a nearby mob in a boat or minecart: place the boat ON LAND in the
     * mob's path (or lure/chase it in), it hops in and CANNOT get out —
     * then push/ride the boat or break it to release. Works on villagers,
     * pigs, wolves, cats, chickens, hostile mobs, even endermen (boat stops
     * teleports). Boats fit ONE mob + you; minecarts fit one.
     **/
    type = String(type || '').toLowerCase();
    const mob = world.getNearestEntityWhere(bot, e => e.name === type, 12);
    if (!mob) { log(bot, `No ${type} nearby to trap.`); return false; }
    let boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    if (!boatItem) {
        try { await craftRecipe(bot, 'oak_boat', 1, true); } catch (_) {}
        boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    }
    if (!boatItem) { log(bot, 'Need a boat (5 planks in a U) to trap it.'); return false; }
    try {
        // place the boat right AT the mob — it boards on contact
        await bot.equip(boatItem, 'hand');
        const mp = mob.position.floored();
        const ref = bot.blockAt(new Vec3(mp.x, mp.y - 1, mp.z)) || bot.blockAt(mp);
        if (ref) {
            try { await bot.placeEntity(ref, new Vec3(0, 1, 0)); } catch (_) {}
            await new Promise(r => setTimeout(r, 600));
        }
        // chase it into the hull: walk it toward the boat
        const boat = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 8);
        if (boat && boat.passengers && boat.passengers.length) {
            log(bot, `Trapped the ${type} in a boat — push the boat or hop in to ferry it~ ♥`);
            return true;
        }
        // nudge: bump the mob toward the boat
        try { await bot.lookAt(mob.position.offset(0, 1, 0)); } catch (_) {}
        log(bot, `Boat placed at the ${type} — chase/bump it in (walk into it), it boards on touch.`);
        return true;
    } catch (e) {
        log(bot, `Could not place the trap boat: ${e.message}`);
        return false;
    }
}

export async function waterBucketClutch(bot) {
    /**
     * The classic "MLG water bucket" — survive a fall from height by placing a
     * water source at your landing spot so you splash down safely instead of
     * taking fall damage. Works while falling or standing above a big drop.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if water was placed, false if not needed.
     * @example
     * await skills.waterBucketClutch(bot);
     **/
    const pos = bot.entity.position;
    const solid = (b) => b && b.boundingBox === 'block' && !['leaves', 'water', 'lava'].includes(b.name);
    // find the first solid landing block straight down
    let landing = null;
    for (let y = Math.floor(pos.y); y >= Math.floor(pos.y) - 96; y--) {
        const b = bot.blockAt(new Vec3(Math.floor(pos.x), y, Math.floor(pos.z)));
        if (!b) continue;
        if (b.name === 'water') {
            log(bot, 'There is already water below to land in — no clutch needed.');
            return false;
        }
        if (solid(b)) { landing = b; break; }
    }
    if (!landing) { log(bot, 'No ground below to clutch onto.'); return false; }
    const drop = Math.floor(pos.y) - landing.position.y;
    if (drop <= 3) { log(bot, 'Not high enough to hurt — no water bucket needed.'); return false; }
    // place a water source one block above the landing surface so it does not replace the ground
    const waterPos = new Vec3(landing.position.x, landing.position.y + 1, landing.position.z);
    const placed = await placeBlock(bot, 'water', waterPos.x, waterPos.y, waterPos.z);
    if (!placed) return false;
    log(bot, `Placed water to break a ${drop}-block fall.`);

    // Splash down, then scoop the water back up with a bucket so no source is left
    // behind and she keeps the water bucket for next time.
    const start = Date.now();
    while (!bot.interrupt_code && Date.now() - start < 8000) {
        if (bot.entity.position.y <= waterPos.y + 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 300)); // settle after landing
    const waterBlock = bot.blockAt(waterPos);
    if (waterBlock && waterBlock.name === 'water') {
        // Ensure she has an empty bucket. Clear a cheap item first if the bag is
        // full, otherwise the /give drops the bucket on the ground instead of into
        // her inventory.
        if (!bot.inventory.findInventoryItem('bucket') && bot.modes && bot.modes.isOn('cheat')) {
            const junk = bot.inventory.items().find(i => i.name === 'cobblestone' || i.name === 'dirt');
            if (junk) await discard(bot, junk.name, 1);
            bot.chat('/give @s bucket 1');
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        if (bot.inventory.findInventoryItem('bucket')) {
            await useToolOnBlock(bot, 'bucket', waterBlock);
        } else {
            log(bot, "Couldn't get a bucket to scoop the water back up.");
        }
    }
    return true;
}

export async function findShelter(bot, range = 40) {
    /**
     * Find shelter from weather, night or mobs: an existing building (a bed or
     * door) or a natural overhang/cave with a roof overhead, and move inside.
     * @param {MinecraftBot} bot - the bot.
     * @param {number} range - search radius in blocks (default 40).
     * @returns {Promise<boolean>} true if shelter was found and reached.
     * @example
     * await skills.findShelter(bot);
     **/
    const pos = bot.entity.position;
    const solid = (b) => b && b.boundingBox === 'block' && b.name !== 'leaves';
    const airy = (b) => b && ['air', 'cave_air', 'void_air'].includes(b.name);
    // 1) an existing structure: a bed or a door nearby
    const markers = bot.findBlocks({
        matching: (b) => b.name.includes('bed') || b.name.includes('door'),
        maxDistance: range,
        count: 10,
    });
    if (markers.length) {
        const m = markers[0];
        await goToPosition(bot, m.x, m.y, m.z, 1.5);
        log(bot, `Found an existing shelter at (${m.x}, ${m.y}, ${m.z}) and went inside.`);
        return true;
    }
    // 2) natural cover: a solid roof over a spot she can stand on
    const fy = Math.floor(pos.y);
    const radius = Math.min(12, Math.floor(range / 2));
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const x = Math.floor(pos.x) + dx, z = Math.floor(pos.z) + dz;
            for (let y = fy + 3; y >= fy - 6; y--) {
                const floor = bot.blockAt(new Vec3(x, y, z));
                const head = bot.blockAt(new Vec3(x, y + 1, z));
                const roof = bot.blockAt(new Vec3(x, y + 2, z));
                if (solid(floor) && airy(head) && solid(roof)) {
                    await goToPosition(bot, x + 0.5, y, z + 0.5, 1);
                    log(bot, `Found a covered spot at (${x}, ${y}, ${z}) and took shelter under it.`);
                    return true;
                }
            }
        }
    }
    log(bot, 'No shelter found nearby.');
    return false;
}

export async function lightUp(bot, radius = 8) {
    /**
     * Spawn-proof the ground around her: craft torches if short (charcoal
     * fallback via the furnace when coal is dry), then walk a grid and place
     * them ~7 apart so every floor tile reads light 8+ (nothing spawns at 8+).
     * Skips spots already torch-covered. The honest survival light job —
     * shelters, home, mines, anywhere she stays.
     * @param {MinecraftBot} bot - the bot.
     * @param {number} radius - half-size of the lit square (default 8).
     * @returns {Promise<boolean>} true if torches went down.
     * @example
     * await skills.lightUp(bot);
     **/
    const counts = () => world.getInventoryCounts(bot);
    let torches = counts()['torch'] || 0;
    if (torches < 4) {
        // craft a batch (pipeline makes sticks from planks; needs coal/charcoal)
        try { await craftRecipe(bot, 'torch', 2, true); } catch (_) {}
        torches = counts()['torch'] || 0;
        if (torches < 1) {
            // charcoal fallback: smelt a spare log, then craft again
            const inv = counts();
            const logType = Object.keys(inv).find(n => n.endsWith('_log') && inv[n] > 1);
            if (logType && (inv['furnace'] > 0 || world.getNearestBlock(bot, 'furnace', 16))) {
                try { await smeltItem(bot, logType, 1); } catch (_) {}
                try { await craftRecipe(bot, 'torch', 2, true); } catch (_) {}
                torches = counts()['torch'] || 0;
            }
        }
        if (torches < 1) {
            log(bot, 'No torches and nothing to make them with — need coal (mine coal_ore, best y 96+) or a log + furnace (smelt = charcoal, works the same). !sourcing("coal") says where.');
            return false;
        }
    }
    const airy = new Set(['air', 'water', 'short_grass', 'tall_grass', 'grass', 'snow', 'dead_bush', 'fern']);
    const c = bot.entity.position.floored();
    const step = 7; // torch light 14 -> 8+ reaches ~6; 7-apart overlaps safely
    const pts = [[0, 0]];
    for (let d = step; d <= radius; d += step) {
        pts.push([d, 0], [-d, 0], [0, d], [0, -d], [d, d], [d, -d], [-d, d], [-d, -d]);
    }
    let placed = 0;
    for (const [dx, dz] of pts) {
        if (bot.interrupt_code) break;
        if ((counts()['torch'] || 0) < 1) break;
        const tx = c.x + dx, tz = c.z + dz;
        // already torch-covered within 5? skip (saves torches)
        let covered = false;
        for (let ox = -5; ox <= 5 && !covered; ox++)
            for (let oz = -5; oz <= 5 && !covered; oz++)
                for (let oy = -2; oy <= 2 && !covered; oy++) {
                    const b = bot.blockAt(new Vec3(tx + ox, c.y + oy, tz + oz));
                    if (b && (b.name === 'torch' || b.name === 'wall_torch')) covered = true;
                }
        if (covered) continue;
        // find standing room: air pocket with solid floor near her height
        let ty = null;
        for (let y = c.y + 2; y >= c.y - 4; y--) {
            const b = bot.blockAt(new Vec3(tx, y, tz));
            const below = bot.blockAt(new Vec3(tx, y - 1, tz));
            if (b && below && airy.has(b.name) && !airy.has(below.name) && below.name !== 'lava') { ty = y; break; }
        }
        if (ty === null) continue;
        try { await goToPosition(bot, tx, ty, tz, 2); } catch (_) { continue; }
        try {
            const ok = await placeBlock(bot, 'torch', tx, ty, tz, 'bottom', true);
            if (ok) placed++;
        } catch (_) {}
    }
    log(bot, placed > 0 ? `Lit the area (${placed} torches, ~${step}-grid — floor reads 8+, nothing spawns here).` : 'Area already torch-covered — nothing spawns here.');
    return placed > 0;
}

export async function buildShelter(bot, block = 'oak_planks') {
    /**
     * Build a quick emergency shelter — a small hollow room with a doorway —
     * around yourself, to hide from weather, night or mobs. Crafts + places a
     * torch inside (spawn-proof: nothing spawns at light 8+), so the box she
     * holes up in is dark-proof by construction, not by luck.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} block - block to build with, e.g. 'oak_planks'.
     * @returns {Promise<boolean>} true if built.
     * @example
     * await skills.buildShelter(bot);
     **/
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x) - 2, by = Math.floor(pos.y), bz = Math.floor(pos.z) - 2;
    const w = 5, d = 5;
    const x2 = bx + w - 1, z2 = bz + d - 1;
    const doorX = bx + Math.floor(w / 2);
    const positions = [];
    for (let x = bx; x <= x2; x++)
        for (let z = bz; z <= z2; z++)
            for (let y = by; y <= by + 3; y++) {
                const isWall = x === bx || x === x2 || z === bz || z === z2;
                const isRoof = y === by + 3;
                if (isWall || isRoof) {
                    // doorway: 2 wide x 2 tall gap in the -Z wall
                    if (z === bz && y <= by + 1 && x >= doorX && x <= doorX + 1) continue;
                    positions.push([x, y, z]);
                }
            }
    const placed = await placeBlockList(bot, block, positions);
    // light the inside: craft torches if needed (charcoal fallback), one in
    // the middle = the whole 5x5 reads 8+ and nothing spawns beside her.
    try { await lightUp(bot); } catch (_) {}
    log(bot, `Built a quick ${block} shelter (${placed} blocks) with a doorway, lit inside.`);
    return placed > 0;
}

// Survival ladder — gear tiers, food ranking, hide routine. One honest path:
// craft what you can, report what you lack (with where-to-go), never pretend.

// Best-first food ranking (cooked > bread > fish/fruit > raw-safe). Raw chicken
// can poison; rotten_flesh / spider_eye / poisonous_potato / pufferfish are
// NEVER food and are excluded everywhere (matches autoEat bannedFood).
const FOOD_RANK = [
    'cooked_beef', 'cooked_porkchop', 'steak', 'cooked_mutton', 'cooked_chicken',
    'bread', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'golden_carrot',
    'apple', 'carrot', 'golden_apple', 'melon_slice', 'cookie',
    'sweet_berries', 'glow_berries', 'dried_kelp', 'beef', 'porkchop',
    'mutton', 'cod', 'salmon', 'rabbit', 'potato', 'beetroot', 'kelp',
];
// chorus_fruit is TELEPORT food, never hunger food: keep it OUT of FOOD_RANK
// (auto-eat/consume must never burn her escape tool as a snack) and eat it
// only via chorusEscape().
const RAW_TO_COOKED = {
    beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton',
    chicken: 'cooked_chicken', cod: 'cooked_cod', salmon: 'cooked_salmon',
    rabbit: 'cooked_rabbit', potato: 'baked_potato', kelp: 'dried_kelp',
};

const GEAR_SETS = {
    wood:  { mat: 'oak_log',  armor: ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'], sword: 'wooden_sword', pick: 'wooden_pickaxe', axe: 'wooden_axe', shield: null },
    stone: { mat: 'cobblestone', armor: ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'], sword: 'stone_sword', pick: 'stone_pickaxe', axe: 'stone_axe', shield: null },
    iron:  { mat: 'iron_ingot',  armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], sword: 'iron_sword', pick: 'iron_pickaxe', axe: 'iron_axe', shield: 'shield' },
    diamond: { mat: 'diamond',   armor: ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'], sword: 'diamond_sword', pick: 'diamond_pickaxe', axe: 'diamond_axe', shield: 'shield' },
};

export async function gearUp(bot, tier = 'iron') {
    /**
     * Craft a full survival set at the given tier and put it on: helmet,
     * chestplate, leggings, boots, sword, pickaxe, axe (+ shield from iron up,
     * off-hand). Uses the existing craft pipeline (prereqs, table handling,
     * shortfall reports), so missing base materials are reported with
     * where-to-go instead of failing silently.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} tier - wood | stone | iron | diamond (default iron).
     * @returns {Promise<boolean>} true if the key pieces are worn.
     * @example
     * await skills.gearUp(bot, 'iron');
     **/
    tier = String(tier || 'iron').toLowerCase();
    if (tier === 'netherite') {
        log(bot, 'Netherite needs a smithing_table + netherite_upgrade template + netherite_ingot on diamond gear — gear up diamond first, then upgrade piece by piece.');
        tier = 'diamond';
    }
    const set = GEAR_SETS[tier];
    if (!set) { log(bot, `Unknown gear tier "${tier}" — pick wood, stone, iron or diamond.`); return false; }
    // pickaxe FIRST: it unlocks the next tier's stone/ore. Then sword, then the rest.
    const order = [set.pick, set.sword, set.axe, ...set.armor, ...(set.shield ? [set.shield] : [])];
    const missing = [];
    for (const piece of order) {
        if (bot.interrupt_code) return false;
        const have = (world.getInventoryCounts(bot)[piece] || 0) > 0;
        if (!have) {
            const ok = await craftRecipe(bot, piece, 1, true);
            if (!ok) missing.push(piece);
        }
    }
    // put it all on: armor via armor manager, sword in hand, shield off-hand.
    try { bot.armorManager.equipAll(); } catch (_) {}
    if (set.sword && world.getInventoryCounts(bot)[set.sword] > 0) await equip(bot, set.sword);
    if (set.shield && world.getInventoryCounts(bot)[set.shield] > 0) await equip(bot, set.shield);
    const worn = [5, 6, 7, 8].map(s => bot.inventory.slots[s] && bot.inventory.slots[s].name).filter(Boolean);
    if (missing.length) {
        log(bot, `Geared ${tier} as far as I could (wearing: ${worn.join(', ') || 'nothing yet'}). Still missing: ${missing.join(', ')} — gather ${set.mat} (!sourcing("${set.mat}") says where) and I will finish.`);
        return false;
    }
    log(bot, `Fully geared in ${tier} (wearing: ${worn.join(', ')}). Ready for anything~ ♥`);
    return true;
}

export async function getFood(bot) {
    /**
     * The food ladder, top to bottom: eat the best thing carried → harvest
     * mature crops (bake wheat into bread) → hunt an animal and cook it →
     * fish → ask players. Stops at the first rung that feeds her.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if she ate (or now holds food).
     * @example
     * await skills.getFood(bot);
     **/
    const inv = () => world.getInventoryCounts(bot);
    const bestHeld = () => FOOD_RANK.find(f => (inv()[f] || 0) > 0);
    // rung 1: eat the best thing she carries
    let best = bestHeld();
    if (best) { await consume(bot, best); return true; }
    if (bot.interrupt_code) return false;
    // rung 2: harvest mature crops; 3+ wheat becomes bread on the spot
    try { await harvestCrops(bot); } catch (_) {}
    if ((inv()['wheat'] || 0) >= 3) {
        await craftRecipe(bot, 'bread', 1, true);
    }
    best = bestHeld();
    if (best) { await consume(bot, best); return true; }
    if (bot.interrupt_code) return false;
    // rung 3: hunt the nearest food animal, cook what it drops
    const prey = world.getNearestEntityWhere(bot, e => mc.isHuntable(e), 24);
    if (prey) {
        log(bot, `No food carried — hunting a ${prey.name}.`);
        try { await attackEntity(bot, prey, true); } catch (_) {}
        await pickupNearbyItems(bot);
        // cook any raw meat if a furnace is reachable
        for (const raw of Object.keys(RAW_TO_COOKED)) {
            if ((inv()[raw] || 0) > 0 && world.getNearestBlock(bot, 'furnace', 16)) {
                try { await smeltItem(bot, raw.startsWith('raw_') ? raw : `raw_${raw}`, inv()[raw]); } catch (_) {}
                try { await smeltItem(bot, raw, inv()[raw] || 1); } catch (_) {}
            }
        }
        best = bestHeld();
        if (best) { await consume(bot, best); return true; }
    }
    if (bot.interrupt_code) return false;
    // rung 4: fish (rod + water)
    if (bot.inventory.findInventoryItem('fishing_rod') && world.getNearestBlock(bot, 'water', 16)) {
        log(bot, 'No crops, no prey — fishing instead.');
        try { await fish(bot, 30000); } catch (_) {}
        best = bestHeld();
        if (best) { await consume(bot, best); return true; }
    }
    if (bot.interrupt_code) return false;
    // rung 5: ask — never starve in silence
    log(bot, 'No food anywhere I can reach — asking for help.');
    await requestItems(bot, 'bread', 3);
    return false;
}

export async function hide(bot) {
    /**
     * Get out of danger like a player: eat first, run to an existing shelter
     * if one is near, else build one from whatever is carried, torch the
     * inside (light 8+ = nothing spawns in with her), shut herself in.
     * Leaves combat modes running — hiding is cover, not surrender.
     * @param {MinecraftBot} bot - the bot.
     * @returns {Promise<boolean>} true if she is under cover.
     * @example
     * await skills.hide(bot);
     **/
    // eat before holing up — a hungry hide is a short hide
    const best = FOOD_RANK.find(f => (world.getInventoryCounts(bot)[f] || 0) > 0);
    if (best && bot.food < 18) { try { await consume(bot, best); } catch (_) {} }
    if (bot.interrupt_code) return false;
    // existing shelter first (bed/door building or roofed spot)
    let underCover = false;
    try { underCover = await findShelter(bot, 40); } catch (_) {}
    if (!underCover) {
        // build from what she carries most of: cobble > dirt > planks
        const inv = world.getInventoryCounts(bot);
        const mat = ['cobblestone', 'dirt', 'oak_planks', 'stone'].find(m => (inv[m] || 0) >= 20) || 'dirt';
        log(bot, `No shelter near — building one from ${mat}.`);
        try { underCover = await buildShelter(bot, mat); } catch (_) {}
    }
    if (!underCover || bot.interrupt_code) return false;
    // light the inside so nothing spawns in with her, then go quiet.
    // lightUp() crafts torches (charcoal fallback) + grids the floor — the
    // one-torch attempt below is just the fast first try.
    try { await lightUp(bot); } catch (_) {
        try {
            if ((world.getInventoryCounts(bot)['torch'] || 0) > 0) {
                const p = bot.entity.position;
                await placeBlock(bot, 'torch', Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 'bottom', true);
            }
        } catch (_) {}
    }
    log(bot, 'Hidden and torched. Staying quiet until it is safe~ ♥');
    return true;
}

export async function askForHelp(bot, topic = 'help') {
    /**
     * Prime yourself to ask nearby players (or your beloved) for help or advice
     * about anything you are stuck on — directions, a recipe, where to find
     * something, a favour. YOU write the actual question in your own words.
     * Save any useful answer with !remember so you can reuse it later (!recall).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} topic - what you need help with.
     * @returns {Promise<boolean>} true.
     * @example
     * await skills.askForHelp(bot, 'finding a village');
     **/
    log(bot, `You decided to ask for help with: ${topic}. Ask the players now, in your own words, being specific about what you need.`);
    return true;
}

export async function requestItems(bot, itemName, count = 1) {
    /**
     * Ask your beloved (or nearby players) in chat for an item you need but don't
     * have, so you are never stuck for materials.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} itemName - the item to request, e.g. 'oak_planks'.
     * @param {number} count - how many.
     * @returns {Promise<boolean>} true.
     * @example
     * await skills.requestItems(bot, 'oak_planks', 10);
     **/
    bot.chat(`I need ${count} ${itemName} — could someone bring me some? ♥`);
    log(bot, `Requested ${count} ${itemName} from players.`);
    return true;
}

// Module-level recursion guard for multi-step crafting (logs -> planks -> chest).
const craftingStack = new Set();

/**
 * Ensure the bot has enough ingredients to craft `itemName` `num` times,
 * crafting intermediate items from more basic ones first. This lets the bot
 * turn oak_log -> oak_planks -> chest automatically instead of getting stuck
 * asking players for intermediate items it can craft itself. Base items
 * (logs, ingots, ...) have no recipe and terminate the recursion.
 */
async function ensureCraftingPrereqs(bot, itemName, num = 1) {
    if (craftingStack.has(itemName)) return;   // cycle guard
    craftingStack.add(itemName);
    try {
        const recipes = mc.getItemCraftingRecipes(itemName);
        if (!recipes || recipes.length === 0) return;  // base item — stop here

        // A recipe can have many variants (e.g. a chest can be made from oak,
        // spruce, birch, ... planks). Try each variant and craft intermediates
        // for the first one the bot can fully source — so it accepts ANY log
        // type instead of demanding oak specifically.
        for (const [ingredients] of recipes) {
            let sourceable = true;
            for (const [ingName, ingPerExec] of Object.entries(ingredients)) {
                const need = ingPerExec * num;
                if ((world.getInventoryCounts(bot)[ingName] || 0) >= need) continue;

                const ingRecipes = mc.getItemCraftingRecipes(ingName);
                if (!ingRecipes || ingRecipes.length === 0) { sourceable = false; break; } // base ingredient — can't craft it

                const ingCraftedCount = ingRecipes[0][1].craftedCount || 1;
                const have = world.getInventoryCounts(bot)[ingName] || 0;
                const ingExecs = Math.ceil((need - have) / ingCraftedCount);

                await craftRecipe(bot, ingName, ingExecs, true);
                if ((world.getInventoryCounts(bot)[ingName] || 0) < need) { sourceable = false; break; }
            }
            if (sourceable) return;  // this variant is fully sourced
        }
    } finally {
        craftingStack.delete(itemName);
    }
}

// Voyager-style craft feedback: report the EXACT per-ingredient shortfall for
// the recipe that needs the fewest missing items (so "craft a chest" says
// "2 more oak_planks" instead of a vague ingredient list).
function _craftingShortfall(bot, itemName) {
    const itemId = mc.getItemId(itemName);
    if (itemId == null) return [];
    const allRecipes = (bot.recipesAll(itemId, null, null) || []).concat(bot.recipesAll(itemId, null, true) || []);
    let bestMissing = null;
    for (const recipe of allRecipes) {
        const missing = [];
        for (const d of recipe.delta) {
            if (d.count >= 0) continue; // only consumed ingredients (negative delta)
            const have = bot.inventory.count(d.id, d.metadata);
            if (have < -d.count) missing.push(`${-d.count - have} more ${mc.getItemName(d.id)}`);
        }
        if (!bestMissing || missing.length < bestMissing.length) bestMissing = missing;
    }
    return bestMissing || [];
}

export async function craftRecipe(bot, itemName, num=1, quiet=false) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        if (!quiet) log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // Multi-step crafting: make sure intermediate ingredients exist (e.g.
    // oak_log -> oak_planks) before we check the recipe, so the bot can craft
    // a chest from raw logs instead of getting stuck asking for planks.
    await ensureCraftingPrereqs(bot, itemName, num);

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                // No crafting table handy — craft one from planks (multi-step),
                // then place it and use it.
                await craftRecipe(bot, 'crafting_table', 1);
                if (world.getInventoryCounts(bot)['crafting_table'] > 0) {
                    let pos = world.getNearestFreeSpace(bot, 1, 6);
                    await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                    craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                    if (craftingTable) {
                        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                        placedTable = true;
                    }
                }
                if (!craftingTable) {
                    if (!quiet) log(bot, `Crafting ${itemName} requires a crafting table.`);
                    return false;
                }
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        if (!quiet) {
            const missing = _craftingShortfall(bot, itemName);
            if (missing.length) {
                log(bot, `You can't craft ${itemName} yet. You still need: ${missing.join(', ')}. Gather these (or ask your beloved for them).`);
            } else {
                log(bot, `${itemName} has no craftable recipe — find it, loot it, or trade for it instead.`);
            }
        }
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function critAttack(bot, entity) {
    /**
     * Jump-crit a single entity: close to 5m, look at chest height, jump,
     * strike mid-air (crit particles = bonus damage), land clean. Ported
     * from Mai-xiyu jumpAttack (lookAt height*0.8, jump 2 ticks, attack).
     * @param {MinecraftBot} bot
     * @param {Entity} entity, the entity to crit.
     * @returns {Promise<boolean>} true if the strike landed.
     * @example
     * await skills.critAttack(bot, enemy);
     **/
    bot.modes.pause('cowardice');
    try {
        await equipHighestAttack(bot);
        const dist = bot.entity.position.distanceTo(entity.position);
        if (dist > 5) {
            await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, 2);
        }
        await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * 0.8, 0));
        bot.setControlState('jump', true);
        await bot.waitForTicks(2);
        await bot.attack(entity);
        await bot.waitForTicks(1);
        bot.setControlState('jump', false);
        return true;
    } catch (e) {
        bot.setControlState('jump', false);
        log(bot, 'Crit attack failed: ' + e.message);
        return false;
    }
}

export async function scoutExplore(bot, radius=50) {
    /**
     * Tolerant explore: pick a random bearing, walk what you can (partial
     * progress is fine), then report ores/POIs + nearby entities. Ported
     * from Mai-xiyu explore (random angle, tolerant move, 17^3 scan).
     * @param {MinecraftBot} bot
     * @param {number} radius, how far to roam. Defaults to 50.
     * @returns {Promise<object>} { moved, interestingBlocks, nearbyEntities }
     * @example
     * await skills.scoutExplore(bot, 40);
     **/
    const pos = bot.entity.position;
    const angle = Math.random() * 2 * Math.PI;
    const dist = 10 + Math.random() * Math.max(10, (radius || 50) - 10);
    let moved = true;
    try {
        await goToPosition(bot, Math.floor(pos.x + Math.cos(angle) * dist), Math.floor(pos.y), Math.floor(pos.z + Math.sin(angle) * dist), 3);
    } catch (_) { moved = false; } // partial progress is fine
    const INTERESTING = new Set([
        'diamond_ore','deepslate_diamond_ore','gold_ore','deepslate_gold_ore',
        'iron_ore','deepslate_iron_ore','coal_ore','deepslate_coal_ore',
        'lapis_ore','deepslate_lapis_ore','redstone_ore','deepslate_redstone_ore',
        'emerald_ore','deepslate_emerald_ore','copper_ore','deepslate_copper_ore',
        'chest','spawner','crafting_table','furnace','anvil',
        'enchanting_table','brewing_stand','village_bell',
    ]);
    const interestingBlocks = [];
    const cp = bot.entity.position;
    for (const b of world.getNearestBlocks(bot, [...INTERESTING], 12, 20)) {
        interestingBlocks.push({ name: b.name, position: { x: b.position.x, y: b.position.y, z: b.position.z } });
        if (interestingBlocks.length >= 20) break;
    }
    const nearbyEntities = world.getNearbyEntities(bot, 16).slice(0, 10).map(e => ({
        name: e.name || e.username || 'unknown', type: e.type,
        distance: bot.entity.position.distanceTo(e.position).toFixed(1),
    }));
    log(bot, `Scouted ${moved ? 'new ground' : 'nearby only'}: ${interestingBlocks.length} POIs, ${nearbyEntities.length} entities.`);
    return { moved, interestingBlocks, nearbyEntities, position: { x: cp.x, y: cp.y, z: cp.z } };
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);

    // Opening volley: a couple arrows at a distant enemy ONCE, before closing to
    // melee. Never inside the loop below — looping arrows at something she can't
    // reach is how she burned through (and spam-/gave) stacks of arrows.
    if (enemy && bot.entity.position.distanceTo(enemy.position) >= 6) {
        try { await shootBow(bot, enemy, 2, true); } catch (e) { console.warn('bow opening failed:', e.message); }
    }

    while (enemy) {
        bot.armorManager.equipAll(); // keep armor on every fight, don't fight naked
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await goToGoal(bot, new pf.goals.GoalFollow(enemy, 3.5));
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await goToGoal(bot, inverted_goal);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}

export async function hawkeyeShot(bot, entity, weapon='bow') {
    /**
     * One aimed shot with the hawkeye trajectory solver (L-C-B/mineflayer-schem
     * review surfaced the pattern; solver is minecrafthawkeye's
     * getMasterGrade, already loaded as bot.hawkEye). Solves gravity drop +
     * target velocity + block interception in one call — strictly better than
     * the flat lead-aim in shootBow for anything past ~10 blocks.
     * Single shot, no listeners, no loops: look, draw, release, done.
     * Returns true if an arrow was loosed, false if no solution (too far),
     * blocked by terrain, or missing gear — caller falls back to legacy aim
     * or melee. NEVER starts the radar (1 OCPU).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, live target entity.
     * @param {string} weapon, 'bow' (default) | 'crossbow' | 'trident'.
     * @returns {Promise<boolean>} true if a shot was loosed.
     * @example
     * await skills.hawkeyeShot(bot, enemy);
     **/
    if (!bot.hawkEye || typeof bot.hawkEye.getMasterGrade !== 'function') return false;
    if (!entity || !entity.position) return false;
    // hawkeye wants per-tick displacement; entity.velocity is close enough —
    // clamp each axis to sane per-tick values so a stale spike can't throw it.
    const clamp1 = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
    const speed = new Vec3(
        clamp1(entity.velocity && entity.velocity.x),
        clamp1(entity.velocity && entity.velocity.y),
        clamp1(entity.velocity && entity.velocity.z));
    let sol = null;
    try { sol = bot.hawkEye.getMasterGrade(entity, speed, weapon); } catch { return false; }
    if (!sol) return false; // no ballistic solution (out of range / no arc)
    if (sol.blockInTrayect) {
        log(bot, 'Hawkeye: shot blocked by terrain — closing in instead.');
        return false;
    }
    const w = bot.inventory.items().find(i => i.name === weapon);
    if (!w) return false;
    try { await bot.equip(w, 'hand'); } catch { return false; }
    await bot.look(sol.yaw, sol.pitch, true);
    await new Promise(r => setTimeout(r, 100));   // let the view settle
    await bot.activateItem();                     // start drawing
    await new Promise(r => setTimeout(r, 1250));  // full draw (bow/crossbow/trident waitTime)
    try { await bot.deactivateItem(); } catch {}  // release -> projectile flies
    return true;
}

export async function shootBow(bot, target, shots=1, fullCharge=true) {
    /**
     * Shoot a bow at a target. Equips a bow (auto-/giving one if she lacks it — she's OP),
     * aims at the target's eyes (leading moving targets by their velocity), draws and fires.
     * Arrows are consumed from inventory/off-hand by the server automatically.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string|Entity} target, a player name, mob type, or an Entity object to shoot.
     * @param {number} shots, how many arrows to fire (default 1).
     * @param {boolean} fullCharge, true = full power draw (~1s), false = rapid weak taps.
     * @returns {Promise<boolean>} true if at least one arrow was loosed.
     * @example
     * await skills.shootBow(bot, "skeleton", 2);
     * await skills.shootBow(bot, "Steve", 1, true);
     **/
    shots = Math.max(1, Math.min(32, Math.floor(shots || 1)));

    // resolve the target to a live entity
    let entity = null;
    if (typeof target === 'string') {
        const player = bot.players && bot.players[target];
        if (player && player.entity) entity = player.entity;
        else entity = world.getNearestEntityWhere(bot, e => e.name === target, 48);
    } else if (target && target.position) {
        entity = target;
    }
    if (!entity || !entity.position) {
        log(bot, typeof target === 'string' ? `No ${target} nearby to shoot.` : 'No target to shoot.');
        return false;
    }

    // ensure a bow — she's OP, but /give only resolves into inventory when there's a
    // free slot. With a full bag the /give DROPS the bow on the ground, the re-check
    // still finds none, and every self-defense/hunting tick /gives another → a pile of
    // bows on the floor. Only /give when there's room; otherwise tell her to make space.
    let bow = bot.inventory.items().find(i => i.name === 'bow');
    if (!bow) {
        if (bot.inventory.items().length < 36) {
            bot.chat(`/give ${bot.username} bow 1`);
            await new Promise(r => setTimeout(r, 350));
            bow = bot.inventory.items().find(i => i.name === 'bow');
        }
    }
    if (!bow) {
        log(bot, 'No bow to shoot with — inventory full (a /give would only drop it on the ground). Free a slot, or craft one: 3 string + 3 sticks.');
        return false;
    }

    // arrows must be in inventory (main or off-hand both feed the bow). Out of
    // arrows = don't shoot — fall back to melee or craft more; never /give-spam
    // (with a full inventory the /give drops arrows on the ground and loops).
    const arrowTypes = ['arrow', 'spectral_arrow', 'tipped_arrow'];
    if (!bot.inventory.items().some(i => arrowTypes.includes(i.name))) {
        log(bot, 'No arrows to shoot with.');
        return false;
    }

    await bot.equip(bow, 'hand');

    let fired = 0;
    for (let i = 0; i < shots; i++) {
        if (bot.interrupt_code) break;
        const pos = entity.position;
        if (!pos) break;
        const dist = bot.entity.position.distanceTo(pos);
        // First arrow: hawkeye solved trajectory (gravity + velocity + block
        // check) when the target is far enough for the solver to beat flat
        // aim. Later arrows keep legacy aim (moving target, quick follow-up).
        if (i === 0 && dist >= 10 && dist <= 48) {
            try {
                if (await hawkeyeShot(bot, entity, 'bow')) { fired++; continue; }
            } catch (e) { console.warn('hawkeye opening failed:', e.message); }
            // hawkeye bow may have been consumed/missing? no — it only reads.
            // fall through to legacy aim below.
            await bot.equip(bow, 'hand');
        }
        // aim at the eyes; lead a moving target by its velocity so the arrow meets it
        const eyeY = entity.height ? entity.height * 0.85 : 1.0;
        let aim = pos.offset(0, eyeY, 0);
        if (entity.velocity && (entity.velocity.x || entity.velocity.y || entity.velocity.z)) {
            const lead = Math.min(0.7, dist / 55);
            aim = aim.offset(entity.velocity.x * lead, entity.velocity.y * lead, entity.velocity.z * lead);
        }
        await bot.lookAt(aim, true);
        await new Promise(r => setTimeout(r, 100));   // let the view settle on target
        await bot.activateItem();                     // start drawing the bow
        await new Promise(r => setTimeout(r, fullCharge ? 1000 : 320));
        try { await bot.deactivateItem(); } catch {}  // release -> arrow flies
        fired++;
        await new Promise(r => setTimeout(r, fullCharge ? 220 : 130));
    }
    log(bot, `Fired ${fired} arrow${fired === 1 ? '' : 's'}.`);
    return fired > 0;
}

export async function throwTrident(bot, target, count=1) {
    /**
     * Throw a trident (spear) at a target — hold to charge, release to hurl.
     * @returns {Promise<boolean>} true if it threw at least once.
     */
    const trident = bot.inventory.items().find(i => i.name === 'trident');
    if (!trident) {
        log(bot, 'No trident. Find one by hunting drowned, or from ocean ruin chests.');
        return false;
    }
    await bot.equip(trident, 'hand');
    let thrown = 0;
    for (let i = 0; i < count; i++) {
        const v = target.velocity || { x: 0, y: 0, z: 0 };
        const dist = bot.entity.position.distanceTo(target.position);
        const lead = Math.min(0.6, dist * 0.05);
        const aim = target.position.offset(v.x * lead, v.y * lead, v.z * lead)
            .offset(0, (target.height || 1.8) * 0.7, 0);
        await bot.lookAt(aim, true);
        await new Promise(r => setTimeout(r, 120));
        await bot.activateItem();                     // start the throw charge
        await new Promise(r => setTimeout(r, 720));   // ~full charge for a hard throw
        try { await bot.deactivateItem(); thrown++; } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    log(bot, `Threw trident ${thrown} time${thrown === 1 ? '' : 's'} (if it doesn't fly back, go pick it up).`);
    return thrown > 0;
}

export async function crystalPvP(bot, target) {
    /**
     * Crystal PvP: set obsidian at the target's feet, place an end crystal on it,
     * then detonate it. Aggressive and self-damaging — the !crystalPvP command
     * gates this behind genuine rage (high hate/annoyance) before it reaches here.
     * @returns {Promise<boolean>} true if the crystal was placed and detonated.
     */
    const crystal = bot.inventory.items().find(i => i.name === 'end_crystal');
    if (!crystal) {
        log(bot, 'No end crystal. Craft one: 7 glass + 1 eye_of_ender + 1 ghast_tear.');
        return false;
    }
    const support = bot.inventory.items().find(i => i.name === 'obsidian' || i.name === 'bedrock');
    if (!support) {
        log(bot, 'Need obsidian (or bedrock) to set the crystal on. Obsidian = water poured over lava.');
        return false;
    }
    const feet = target.position.floored();
    if (!(await placeBlock(bot, support.name, feet.x, feet.y, feet.z, 'bottom'))) {
        log(bot, 'Could not place the support block at their feet.');
        return false;
    }
    await new Promise(r => setTimeout(r, 250)); // let the world state settle
    const base = bot.blockAt(feet);
    if (!base || (base.name !== 'obsidian' && base.name !== 'bedrock')) {
        log(bot, 'Support block did not land as obsidian/bedrock.');
        return false;
    }
    let crystalEntity;
    try {
        await bot.equip(crystal, 'hand');
        crystalEntity = await bot.placeEntity(base, { x: 0, y: 1, z: 0 });
    } catch (e) {
        log(bot, `Could not place the crystal: ${e.message}`);
        return false;
    }
    // step back so the blast doesn't kill us, then detonate
    try {
        if (bot.entity.position.distanceTo(feet) < 5) {
            bot.pathfinder.setMovements(new pf.Movements(bot));
            await goToGoal(bot, new pf.goals.GoalInvert(new pf.goals.GoalFollow(target, 5))).catch(() => {});
        }
    } catch {}
    bot.attack(crystalEntity);
    log(bot, 'Detonated end crystal.');
    return true;
}


export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.allowSprinting = false; movements.allowParkour = false; // 26.3 WALK-ONLY (moved-wrongly gate)
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            // WOOD-SMART (added 05:0x): prefer the LOWEST reachable trunk block
            // (nearest to her feet level) over a high canopy block — the old
            // nearest-first pick targeted leaves-buried canopy (28,76,-26),
            // unwalkable, so every attempt ended "too far". Trunk bases have
            // clear ground paths; felling from the bottom drops the rest.
            // (Ranking applied below via sort, not filter — all stay eligible.)
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 8);
        // wood-smart ranking: lowest Y first, then nearest (canopy last)
        const _isWood = /log|wood/i.test(blockType);
        if (_isWood && blocks.length > 1) {
            const bp = bot.entity.position;
            blocks = [...blocks].sort((a, b) =>
                (a.position.y - b.position.y) ||
                (a.position.distanceTo(bp) - b.position.distanceTo(bp)));
        }

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        // 26.3 FALLBACK (added 21:3x): equipForBlock reads bot.inventory.items()
        // (client Slot decode, often [] even when kitted) and can leave the
        // sword/fist held — then canHarvest fails on ores she HAS the pick for
        // (RCON proves diamond_pickaxe in slot 2). If harvest still fails,
        // equip the best pickaxe/axe/shovel by RCON-truth inventory scan.
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        let itemId = bot.heldItem ? bot.heldItem.type : null
        if (!isLiquid && !block.canHarvest(itemId)) {
            // fallback: equip best tool of the right class by direct lookup
            try {
                const want = /log|wood|plank/i.test(blockType) ? ['diamond_axe', 'iron_axe', 'stone_axe']
                    : /dirt|sand|gravel|soul/i.test(blockType) ? ['diamond_shovel', 'iron_shovel', 'stone_shovel']
                    : ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'];
                for (const w of want) {
                    const found = bot.inventory.findInventoryItem(w);
                    if (found) { await bot.equip(found, 'hand'); break; }
                }
            } catch (_) {}
            itemId = bot.heldItem ? bot.heldItem.type : null;
        }
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        // 26.3: collect-via-dig only. collectblock's collect() path overwrites
        // the bot's pathfinder Movements with its own DEFAULTS (see
        // CollectBlock constructor: `new Movements(bot)` — allowSprinting +
        // allowParkour TRUE) and drives sprint-jump strafe legs at the block
        // face; the 26.3 moved-wrongly gate kicks on those deltas (walk-death
        // logs proved: d1.07-1.32 falls mid-collect). goToPosition walks
        // clean, dig breaks, pickup grabs. Restore ONLY when collectblock
        // accepts injected WALK-ONLY movements — until then, dig path stays.
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 3);
                if (bot.interrupt_code) return false; // stopped mid-walk: out fast
                // 26.3: reach check BEFORE the dig — goToPosition stops 3 out
                // with WALK-ONLY legs, and bot.dig on an out-of-reach block
                // either throws or no-ops into the 25s timeout. Skip and let
                // the brain pick a closer goal instead of burning a cycle.
                try {
                    const eye = bot.entity.position.offset(0, 1.62, 0);
                    if (eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 5.5) {
                        log(bot, `Too far to dig ${block.name} from here, moving on.`);
                        return false;
                    }
                } catch (_) {}
                // 26.3: dig-timeout race — bot.dig() awaits a server ack that
                // may never come; without a cap this wedges the action into
                // the 3min timeout, then mode-interrupts pile on until the 10s
                // stop() -> cleanKill suicide (07:2x: self_preservation
                // interrupting collectBlocks -> 'waiting for code' x13 ->
                // exit 1). Bail the instant interrupt_code fires so stop()
                // always wins fast. On timeout stop digging and report
                // failure so the brain moves on.
                try {
                    await Promise.race([
                        bot.dig(block, true),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), 25000)),
                        new Promise((_, rej) => {
                            const t = setInterval(() => {
                                if (bot.interrupt_code) { clearInterval(t); rej(new Error('interrupted')); }
                            }, 200);
                            setTimeout(() => { clearInterval(t); }, 26000);
                        }),
                    ]);
                } catch (e) {
                    try { bot.stopDigging(); } catch (_) {}
                    if (bot.interrupt_code) return false; // stopped: out fast, no chatter
                    if (String((e && e.message) || e).includes('dig-timeout')) {
                        log(bot, `Dig timed out on ${block.name}, moving on.`);
                        return false;
                    }
                    throw e;
                }
                if (bot.interrupt_code) return false;
                await pickupNearbyItems(bot);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Inventory full and no chest nearby to auto-deposit into. If you have a chest, place it with !placeHere (collecting will then auto-deposit); if not, craft one from 8 planks with !craftRecipe("chest") and place it.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = new pf.Movements(bot);
    movements.allowSprinting = false; movements.allowParkour = false; // 26.3 WALK-ONLY (moved-wrongly gate)
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z, navTimeoutMs = 15000) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    if (bot.interrupt_code) return false; // 26.3: never start work while stopping
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
    movements.allowSprinting = false; movements.allowParkour = false; // 26.3 WALK-ONLY (moved-wrongly gate)
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4), navTimeoutMs);
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        // 26.3: dig-timeout race — bot.dig() awaits a server ack that may never
        // come; without a cap this wedges the action into the 3min timeout.
        // On timeout stop digging and report failure so the brain moves on.
        try {
            await Promise.race([
                bot.dig(block, true),
                new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), 25000)),
            ]);
        } catch (e) {
            try { bot.stopDigging(); } catch (_) {}
            if (String((e && e.message) || e).includes('dig-timeout')) {
                log(bot, `Dig timed out on ${block.name}, moving on.`);
                return false;
            }
            throw e;
        }
        await pickupNearbyItems(bot);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function writeSign(bot, text, blockType='oak_sign') {
    /**
     * Place a standing sign in front of the bot and write text on it.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} text, the sign text; use \n to separate up to 4 lines (max 45 chars each).
     * @param {string} blockType, the standing sign block name (default 'oak_sign').
     * @returns {Promise<boolean>} true if the sign was placed and written.
     * @example await skills.writeSign(bot, "UwU was here\n<3");
     **/
    try {
        const p = bot.entity.position;
        const yaw = bot.entity.yaw || 0;
        // one block directly in front of the bot, at her feet level
        const x = Math.floor(p.x - Math.sin(yaw));
        const z = Math.floor(p.z - Math.cos(yaw));
        const y = Math.floor(p.y);
        if (!(await placeBlock(bot, blockType, x, y, z, 'bottom', false))) {
            log(bot, `Couldn't place a ${blockType} sign to write on.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 300)); // let the sign register server-side
        const pos = new Vec3(x, y, z);
        const sign = bot.blockAt(pos) || { position: pos };
        bot.updateSign(sign, String(text));
        log(bot, `Wrote sign: ${String(text).replace(/\n/g, ' / ')}`);
        return true;
    } catch (e) {
        log(bot, `writeSign failed: ${e.message}`);
        return false;
    }
}

export async function pillarUp(bot, blockType, height = 4) {
    /**
     * Pillar straight UP by jumping + placing a block beneath (schem review:
     * ensureDirtAtPosition pattern — dirt-family scaffold, sneak-aware, verify
     * each layer). The move she needs for roofs, towers, and reaching high
     * build layers. Places `height` blocks max, stops if a layer fails twice.
     * (Named pillarUp: scaffoldUp already means the bamboo tower variant.)
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, scaffold block (dirt/cobble/netherrack — cheap).
     * @param {number} height, blocks to pillar (default 4, cap 12).
     * @returns {Promise<number>} layers actually gained.
     * @example
     * await skills.pillarUp(bot, "dirt", 6);
     **/
    height = Math.max(1, Math.min(12, Math.floor(height || 4)));
    let gained = 0;
    for (let i = 0; i < height; i++) {
        if (bot.interrupt_code) break;
        const feet = bot.entity.position.floored();
        const below = bot.blockAt(feet.offset(0, -1, 0));
        if (!below || below.name === 'air') break; // nothing to stand on — abort
        let ok = await placeBlock(bot, blockType, feet.x, feet.y, feet.z, 'bottom', true);
        if (!ok && !bot.interrupt_code) {
            await new Promise(r => setTimeout(r, 400));
            ok = await placeBlock(bot, blockType, feet.x, feet.y, feet.z, 'bottom', true);
        }
        if (!ok) break;
        gained++;
        await new Promise(r => setTimeout(r, 250)); // let the layer register
    }
    log(bot, gained ? `Pillared up ${gained} block${gained === 1 ? '' : 's'}.` : 'Could not pillar up — no scaffold blocks or no footing.');
    return gained;
}

export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    // World-edit /setblock placement is disabled — she places every block by hand
    // (no instant shortcuts), so blocks are actually consumed from inventory. The
    // real place-by-hand logic below handles the placement.
    if (false && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        // six-way facing blocks (pistons, observers, dispensers, ...) — up/down when
        // placed against the top/bottom face, else a horizontal facing.
        if (['piston', 'sticky_piston', 'observer', 'dispenser', 'dropper', 'hopper'].includes(blockType)) {
            const vertical = placeOn === 'top' ? 'up' : placeOn === 'bottom' ? 'down' : null;
            blockType += `[facing=${vertical || face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!block) continue;
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        // No neighbour to click on (floating block in mid-air). Bridge it:
        // drop a dirt scaffold at the closest air cell adjacent to the target
        // that HAS a neighbour (schem review: attemptOneBlockBridge pattern),
        // place against it, then dig the scaffold away. One block, verified.
        const isAirLike = (b) => !b || b.name === 'air' || b.boundingBox === 'empty';
        let bridged = null;
        const feet = bot.entity.position.floored();
        const cands = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0],[1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1]]
            .map(([dx, dy, dz]) => target_dest.plus(new Vec3(dx, dy, dz)))
            .filter(p => { try { return isAirLike(bot.blockAt(p)); } catch { return false; } })
            .sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
        for (const p of cands) {
            if (bot.interrupt_code) break;
            // scaffold cell needs its own neighbour (can't float either)
            let hasN = false;
            for (const dd of Object.values(dir_map)) {
                try { const n = bot.blockAt(p.plus(dd)); if (n && !isAirLike(n)) { hasN = true; break; } } catch {}
            }
            if (!hasN) continue;
            try {
                if (await placeBlock(bot, 'dirt', p.x, p.y, p.z, 'bottom', true)) {
                    const chk = bot.blockAt(p);
                    if (chk && chk.name !== 'air' && chk.boundingBox !== 'empty') { bridged = p; break; }
                }
            } catch {}
        }
        if (!bridged) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
            return false;
        }
        buildOffBlock = bot.blockAt(bridged);
        // face from the scaffold back toward the target
        faceVec = new Vec3(Math.sign(target_dest.x - bridged.x), Math.sign(target_dest.y - bridged.y), Math.sign(target_dest.z - bridged.z));
        if (!faceVec.x && !faceVec.y && !faceVec.z) faceVec = new Vec3(0, 1, 0);
        // remember to dig the scaffold after the real placement lands
        var _scaffoldToClean = bridged;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far — walk to a STANDABLE spot near the target, not just near it.
        // (schem review: GoalNear can strand her across a 1-gap or on the wrong
        // side of a wall, staring at an unreachable face. canStandAt checks
        // feet+head clear and solid support below, ring1 then ring2.)
        const isAirLike = (b) => !b || b.name === 'air' || b.boundingBox === 'empty';
        const canStandAt = (p) => {
            try {
                const feet = bot.blockAt(p, false), head = bot.blockAt(p.offset(0, 1, 0), false),
                    below = bot.blockAt(p.offset(0, -1, 0), false);
                return isAirLike(feet) && isAirLike(head) && below && below.name !== 'air' && below.boundingBox !== 'empty';
            } catch { return false; }
        };
        let standGoal = null;
        const tp = targetBlock.position;
        const ring = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1],
            [2,0,0],[-2,0,0],[0,0,2],[0,0,-2]];
        for (const [dx, , dz] of ring) {
            for (const dy of [0, 1, -1]) {
                const c = new Vec3(tp.x + dx, tp.y + dy, tp.z + dz);
                if (!canStandAt(c)) continue;
                if (c.distanceTo(tp) > 4.5) continue;
                standGoal = c; break;
            }
            if (standGoal) break;
        }
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
    movements.allowSprinting = false; movements.allowParkour = false; // 26.3 WALK-ONLY (moved-wrongly gate)
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, standGoal
            ? new pf.goals.GoalBlock(standGoal.x, standGoal.y, standGoal.z)
            : new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        // Second chance: still out of reach (GoalNear settled across a gap)?
        // step to the closest standable ring cell directly.
        if (bot.entity.position.distanceTo(targetBlock.position) > 4.5 && standGoal) {
            try {
                bot.pathfinder.setMovements(movements);
                await goToGoal(bot, new pf.goals.GoalBlock(standGoal.x, standGoal.y, standGoal.z));
            } catch (_) {}
        }
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            // 26.3: force-look (zero wire). A wire look+tick_end right after
            // block_place collides with the placement window -> type-0 reject
            // + ghost block (WIRE-ORDER proof). Local angles only here.
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5), true);
            // SNEAK when building against an interactive block (chest, furnace,
            // door, ...) — otherwise the click OPENS it instead of placing.
            // Vendored from mineflayer-schem's interactable.json via
            // schematic.needsSneakToPlaceAgainst.
            let sneaking = false;
            try {
                const { needsSneakToPlaceAgainst } = await import('./schematic.js');
                sneaking = needsSneakToPlaceAgainst(buildOffBlock.name);
            } catch {}
            if (sneaking) { try { bot.setControlState('sneak', true); } catch {} }
            // 26.3 pillar-jump: dest inside own feet while standing still is
            // server-rejected (occupied). Jump first, place mid-air.
            const _dest = buildOffBlock.position.plus(faceVec);
            const _feet = bot.entity.position.floored();
            if (_dest.x === _feet.x && _dest.z === _feet.z && _dest.y <= _feet.y + 1) {
                bot.setControlState('jump', true);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            try {
                await bot.placeBlock(buildOffBlock, faceVec);
            } finally {
                bot.setControlState('jump', false);
                if (sneaking) { try { bot.setControlState('sneak', false); } catch {} }
            }
            // VERIFY the placement actually landed (schem review: placeBlockTracked
            // pattern — the server can reject silently, leaving a hole she thinks
            // is filled). Wrong block or still air = failure, not success.
            try {
                await new Promise(resolve => setTimeout(resolve, 200));
                const chk = bot.blockAt(target_dest);
                if (chk) {
                    const wantBase = String(blockType).split('[')[0];
                    const gotBase = String(chk.name || '').replace(/^wall_/, '').replace(/_wall$/, '');
                    const wantNorm = wantBase.replace(/^(wall_)/, '');
                    if (chk.name === 'air' || chk.boundingBox === 'empty') {
                        log(bot, `Placed ${blockType} at ${target_dest} but it's still air — server rejected it.`);
                        return false;
                    }
                    if (chk.name !== wantBase && gotBase !== wantBase && gotBase !== wantNorm && chk.name !== wantNorm) {
                        log(bot, `Placed ${blockType} at ${target_dest} but found ${chk.name} — wrong block.`);
                        return false;
                    }
                }
            } catch {}
            // Clean the dirt scaffold bridged in above (if any) now that the
            // real block is verified in place.
            try {
                if (typeof _scaffoldToClean !== 'undefined' && _scaffoldToClean) {
                    await breakBlockAt(bot, _scaffoldToClean.x, _scaffoldToClean.y, _scaffoldToClean.z);
                }
            } catch {}
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
}

export async function placeBlockState(bot, blockType, props, x, y, z) {
    /**
     * Place a block with an exact block-state (facing, powered, extended, delay...)
     * using /setblock. For redstone and other orientation-sensitive builds where a
     * wrong facing breaks the whole circuit. Requires operator (cheat mode).
     * @param {MinecraftBot} bot - the bot.
     * @param {string} blockType - the block name, e.g. 'repeater'.
     * @param {object} props - block-state properties, e.g. { facing: 'north', delay: 2 }.
     * @param {number} x, y, z - absolute coordinates.
     * @returns {Promise<boolean>} true on success.
     * @example
     * await skills.placeBlockState(bot, 'repeater', { facing: 'north', delay: 2 }, 10, 64, 10);
     **/
    let block = blockType;
    const keys = props ? Object.keys(props) : [];
    if (keys.length)
        block += '[' + keys.map(k => `${k}=${props[k]}`).join(',') + ']';
    bot.chat(`/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${block}`);
    if (useDelay) await new Promise(resolve => setTimeout(resolve, blockPlaceDelay));
    return true;
}

export async function spamBlock(bot, type, times = 4, intervalMs = 350) {
    /**
     * Repeatedly activate (open/shut/flip/ring) the nearest block of a given type to
     * make noise and get attention — spam a door, a chest, a lever, a bell, a note block.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} type - block type to spam, e.g. 'door', 'chest', 'lever', 'bell' (substring-matched, so 'door' hits any wood door).
     * @param {number} times - how many activate cycles (default 4).
     * @param {number} intervalMs - ms between toggles (default 350).
     * @returns {Promise<boolean>} true if something was spammed.
     * @example
     * await skills.spamBlock(bot, 'door', 6);
     **/
    const blocks = world.getNearestBlocksWhere(bot, b => b && b.name && b.name.includes(type), 8, 1);
    const block = blocks[0];
    if (!block) { log(bot, `No ${type} nearby to spam.`); return false; }
    for (let i = 0; i < times; i++) {
        if (bot.interrupt_code) break;
        try { await bot.activateBlock(block); } catch (e) { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    log(bot, `Spammed ${type} ${times} times.`);
    return true;
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function unequip(bot, destination) {
    /**
     * Remove armor / held items so she can actually "strip" or change outfit.
     * destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' | 'all'
     * @param {MinecraftBot} bot
     * @param {string} destination - which equipment slot to empty, or 'all'.
     * @returns {Promise<boolean>}
     */
    const slots = ['head', 'torso', 'legs', 'feet', 'off-hand', 'hand'];
    if (destination === 'all') {
        for (const p of slots) {
            try { await bot.unequip(p); } catch (e) { /* ignore */ }
        }
        log(bot, 'Removed all armor and equipment.');
        return true;
    }
    if (!slots.includes(destination)) {
        log(bot, `Unknown equipment slot: ${destination}.`);
        return false;
    }
    try {
        await bot.unequip(destination);
        log(bot, `Unequipped ${destination}.`);
        return true;
    } catch (e) {
        log(bot, `Could not unequip ${destination}: ${e.message}`);
        return false;
    }
}

// The spawn survival kit is NEVER droppable: no discard, no giving away, no
// tossing. Guards both by name and by "is it currently equipped".
const PROTECTED_GEAR = new Set([
    'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
    'diamond_sword', 'shield',
    'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe',
    'bow', 'arrow', 'spectral_arrow', 'tipped_arrow', 'chest',
    'elytra', 'firework_rocket',
]);

function isProtectedGear(bot, itemName) {
    if (PROTECTED_GEAR.has(itemName)) return true;
    // mineflayer inventory slot layout: 5-8 armor (head/torso/legs/feet), 45 off-hand.
    // NOTE: hand slot 36 is DELIBERATELY EXCLUDED — she holds blocks (dirt, wood, etc.)
    // in hand while placing/digging, and those must stay discardable so she can free
    // inventory space. Real gear held in hand (sword/tools/bow) is already in PROTECTED_GEAR.
    const equippedSlots = [5, 6, 7, 8, 45];
    return equippedSlots.some(s => bot.inventory.slots[s] && bot.inventory.slots[s].name === itemName);
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the name of the item to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    if (isProtectedGear(bot, itemName)) {
        log(bot, `I can't drop ${itemName} — it's part of my kit, never droppable!`);
        return false;
    }
    let discarded = 0;
    // Burn-after-toss: tossed items despawn in 5 min and litter spawn. She's
    // op, so destroy each tossed stack with /kill right after the toss —
    // same visible throw, nothing left on the ground for anyone to pick up.
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        try { bot.chat(`/kill @e[type=item,distance=..6]`); } catch (e) {}
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest OR ender chest (whichever is
     * near — ender chest = your private cross-world vault, see vaultPut()).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32) || world.getNearestBlock(bot, 'ender_chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest or ender chest nearby (craft a chest from 8 planks, or an ender_chest from 8 obsidian + eye_of_ender).`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        // Fuzzy fallback: the LLM names items loosely ("stone" for cobblestone,
        // "wood"/"log" for oak_log). Match a non-gear item whose name contains (or
        // is contained by) the request — but never auto-match survival gear, so
        // "diamond" won't grab her diamond_sword/helmet.
        const q = itemName.toLowerCase();
        item = bot.inventory.items().find(i =>
            !isProtectedGear(bot, i.name) &&
            (i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase())));
    }
    if (!item) {
        const have = bot.inventory.items()
            .filter(i => !isProtectedGear(bot, i.name))
            .map(i => `${i.name} (${i.count})`)
            .slice(0, 12).join(', ');
        log(bot, `You do not have any ${itemName} to put in the chest.` + (have ? ` You have: ${have}.` : ''));
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToBlockAdjacent(bot, chest);
    const chestContainer = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest (or ender chest vault —
     * whichever is near), potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32) || world.getNearestBlock(bot, 'ender_chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest or ender chest nearby (craft a chest from 8 planks, or an ender_chest from 8 obsidian + eye_of_ender).`);
        return false;
    }
    await goToBlockAdjacent(bot, chest);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest (exact, then loose-name fallback)
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        const q = itemName.toLowerCase();
        matchingItems = chestContainer.containerItems().filter(item =>
            item.name.toLowerCase().includes(q) || q.includes(item.name.toLowerCase()));
    }
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest (or ender chest vault).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    // 26.3 restore: real openContainer is back, but QUIET-WINDOW gated.
    // The kick shape was block_place -> punch(swing) -> look -> tick_end all
    // landing in one server tick next to movement (sequences now increment,
    // but the burst-in-one-tick is still the danger). Gate: only open while
    // physics is unfrozen, not pathfinding, and 3s since the last position
    // send — otherwise fall back to the /data no-touch read (zero packets).
    let chest = world.getNearestBlock(bot, 'chest', 32) || world.getNearestBlock(bot, 'ender_chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const physicsLive = bot.physics && bot.physics.shouldUsePhysics
        ? bot.physics.shouldUsePhysics() : true;
    const moving = bot.pathfinder && bot.pathfinder.isMoving
        ? bot.pathfinder.isMoving() : !!bot.pathfinder.goal;
    const sinceMove = (bot.physics && bot.physics.msSinceMove)
        ? bot.physics.msSinceMove() : 99999;
    if (physicsLive && !moving && sinceMove > 3000) {
        try {
            await goToBlockAdjacent(bot, chest);
            const chestContainer = await bot.openContainer(chest);
            let items = chestContainer.containerItems();
            if (items.length === 0) {
                log(bot, `The chest is empty.`);
            }
            else {
                log(bot, `The chest contains:`);
                for (let item of items) {
                    log(bot, `${item.count} ${item.name}`);
                }
            }
            await new Promise(r => setTimeout(r, 800)); // let window traffic settle before moving
            await chestContainer.close();
            return true;
        } catch (e) {
            log(bot, `Could not open chest (${e.message}), reading via /data instead.`);
        }
    }
    // Fallback: /data no-touch read — zero interaction packets, same info.
    try {
        const p = chest.position;
        bot.chat(`/data get block ${p.x} ${p.y} ${p.z} Items`);
        log(bot, `Reading chest at ${p.x},${p.y},${p.z} via /data (no-touch read).`);
        return true;
    } catch (e) {
        log(bot, `Could not read chest: ${e.message}`);
        return false;
    }
    /* 26.3-disabled openContainer path (kicks: block_place+punch+look in one
       server tick -> Invalid move). Restored above behind the quiet-window
       gate; the raw path is kept here for reference.
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToBlockAdjacent(bot, chest);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
    */ // end 26.3-disabled openContainer path
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item. Omit the name to eat the best thing carried
     * (cooked meat first, bread next, fruit/fish after — never poison).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to eat. Defaults to "" (auto-pick the best food).
     * @returns {Promise<boolean>} true if the item was consumed, false otherwise.
     * @example
     * await skills.consume(bot, "cooked_beef");
     * await skills.consume(bot); // eat the best thing carried
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    } else {
        // no name: eat the best thing carried (cooked > bread > fruit/fish).
        // Same no-poison list as autoEat — never rotten/spider_eye/poison/puffer/chicken.
        const choice = FOOD_RANK.find(f => bot.inventory.findInventoryItem(f));
        item = choice ? bot.inventory.findInventoryItem(choice) : null;
        name = choice || 'food';
    }
    if (!item) {
        log(bot, itemName ? `You do not have any ${name} to eat.` : 'You are not carrying anything edible — !getFood will find some.');
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}

export async function swimUp(bot, timeoutMs = 8000) {
    /**
     * Swim to the surface: hold jump until air or dry land, then stop.
     * The drowning rescue — call it the moment bubbles run low, not after.
     * Also the honest way up from any dive: boats, ruins, clay runs.
     * LAVA version: same inputs SWIM slower + burn — never free-swim lava;
     * fire-res first (!lavaSwim brews + suits up, else refuse the swim).
     * @returns {Promise<boolean>} true if she reaches air.
     **/
    const t0 = Date.now();
    try { bot.setControlState('jump', true); } catch (_) {}
    try {
        while (Date.now() - t0 < timeoutMs) {
            if (bot.interrupt_code) return false;
            const feet = bot.blockAt(bot.entity.position);
            const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const wet = (b) => b && (b.name === 'water' || b.name === 'bubble_column');
            if (!wet(feet) && !wet(head)) return true; // air — breathe
            try { bot.setControlState('jump', true); } catch (_) {}
            await new Promise(r => setTimeout(r, 200));
        }
    } finally { try { bot.setControlState('jump', false); } catch (_) {} }
    const feet = bot.blockAt(bot.entity.position);
    if (feet && feet.name !== 'water') return true;
    log(bot, 'Still underwater — swim failed (blocked above? dig up or pearl out).');
    return false;
}

export async function diveDown(bot, depth = 6, timeoutMs = 12000) {
    /**
     * Dive DOWN to a depth below the surface: sneak-descend (no jump held)
     * until y <= surfaceY - depth, hugging water (never dive blind into a
     * cave mouth). Pair with a door/torch pocket plan — oxygen is finite.
     * @returns {Promise<boolean>} true if she reached the target depth.
     **/
    let surfaceY = null;
    try {
        const p = bot.entity.position;
        for (let y = Math.ceil(p.y); y < Math.ceil(p.y) + 8; y++) {
            const b = bot.blockAt(new Vec3(Math.floor(p.x), y, Math.floor(p.z)));
            if (!b || b.name !== 'water') { surfaceY = y; break; }
        }
    } catch (_) {}
    if (surfaceY === null) surfaceY = Math.ceil(bot.entity.position.y) + 1;
    const targetY = surfaceY - Math.max(2, depth);
    const t0 = Date.now();
    try { bot.setControlState('sneak', true); } catch (_) {}
    try {
        while (Date.now() - t0 < timeoutMs) {
            if (bot.interrupt_code) return false;
            if (bot.entity.position.y <= targetY) return true;
            const feet = bot.blockAt(bot.entity.position);
            if (!feet || (feet.name !== 'water' && feet.name !== 'bubble_column')) return true; // hit floor/air
            await new Promise(r => setTimeout(r, 200));
        }
    } finally { try { bot.setControlState('sneak', false); } catch (_) {} }
    log(bot, `Dove to y ${bot.entity.position.y.toFixed(1)} (wanted ${targetY}) — going back up for air.`);
    return bot.entity.position.y <= targetY + 1;
}

export async function airPocket(bot) {
    /**
     * Breathe underwater WITHOUT surfacing — the hacky ways, honestly ranked:
     * DOOR (best): place any door at head height — carves a lasting 2-block
     * air pocket even on the seabed (crafted from 6 planks if needed). Sign /
     * ladder / fence-gate / trapdoor on a wall work the same (any non-solid
     * hitbox block holds water back). TORCH (one breath): place = instant air
     * + refill, then water pops it — bridge to the surface or a door. BUBBLE
     * COLUMNS: soul-sand column = UPDRAFT elevator (ride up without swimming,
     * bubbles REFILL oxygen on the way); magma-block column = DOWNDRAFT
     * (drags you down fast — + drowning damage inside, never ride without a
     * pocket plan). Sugar cane / glass box / boat-air: niche —
     * door first, torch panic, soul-sand shaft for deep work.
     * LAVA has NO air pocket — fire-res or get out, doors don't save you.
     * @returns {Promise<boolean>} true if she can breathe where she stands.
     **/
    const inv = () => world.getInventoryCounts(bot);
    if (!Object.keys(inv()).some(n => n.endsWith('_door') && (inv()[n] || 0) > 0)) {
        try { await craftRecipe(bot, 'oak_door', 1, true); } catch (_) {}
    }
    const door = Object.keys(inv()).find(n => n.endsWith('_door') && (inv()[n] || 0) > 0);
    if (!door) {
        // torch fallback: one breath, then it pops
        if ((inv()['torch'] || 0) > 0) {
            const p = bot.entity.position;
            try {
                const ok = await placeBlock(bot, 'torch', Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z), 'bottom', true);
                if (ok) { log(bot, 'Torch pocket — one breath (it will pop). Surface or door next.'); return true; }
            } catch (_) {}
        }
        log(bot, 'No door and no planks/torch for an air pocket — surface NOW (!swim up).');
        return false;
    }
    const p = bot.entity.position;
    const px = Math.floor(p.x), py = Math.floor(p.y) + 1, pz = Math.floor(p.z);
    try {
        const ok = await placeBlock(bot, door, px, py, pz, 'bottom', true);
        if (ok) { log(bot, `Air pocket placed (${door}) — breathe here, oxygen refills. Mine/glass around it for a work bell.`); return true; }
    } catch (_) {}
    log(bot, 'Could not place the door pocket (no wall/floor to build off?) — surface instead.');
    return false;
}

export async function makeInfiniteSpring(bot) {
    /**
     * Build a 2x2 INFINITE water spring: dig/fill a 2x2 hole, place water in
     * opposite corners — every scoop from the middle/edge refills itself.
     * Needs 2 water sources carried (2 buckets) OR one nearby source + a
     * bucket to ferry. Diagonal corners, never adjacent.
     * @returns {Promise<boolean>} true if the spring stands.
     **/
    const inv = () => world.getInventoryCounts(bot);
    const buckets = ['water_bucket'].filter(n => (inv()[n] || 0) > 0).length;
    const empties = inv()['bucket'] || 0;
    if ((inv()['water_bucket'] || 0) < 2) {
        // ferry a second source if water is near
        const src = world.getNearestBlock(bot, 'water', 24);
        if (src && (empties > 0 || (inv()['water_bucket'] || 0) > 0)) {
            try {
                if ((inv()['water_bucket'] || 0) < 1) {
                    await goToPosition(bot, src.position.x, src.position.y, src.position.z, 2);
                    await useToolOnBlock(bot, 'bucket', src);
                }
                if ((inv()['bucket'] || 0) > 0) {
                    await goToPosition(bot, src.position.x, src.position.y, src.position.z, 2);
                    await useToolOnBlock(bot, 'bucket', src);
                }
            } catch (_) {}
        }
        if ((inv()['water_bucket'] || 0) < 2) {
            log(bot, `Need 2 water buckets for an infinite spring (have ${inv()['water_bucket'] || 0}) — scoop 2 sources from a river/lake first (!scoop water).`);
            return false;
        }
    }
    // 2x2 pit at her feet: clear 4, keep floor
    const c = bot.entity.position.floored();
    const cells = [[c.x, c.z], [c.x + 1, c.z], [c.x, c.z + 1], [c.x + 1, c.z + 1]];
    for (const [x, z] of cells) {
        try {
            const b = bot.blockAt(new Vec3(x, c.y, z));
            if (b && b.name !== 'air' && b.name !== 'water' && b.diggable) await breakBlockAt(bot, x, c.y, z);
        } catch (_) {}
    }
    // opposite corners: (x,z) + (x+1,z+1)
    try {
        await useToolOnBlock(bot, 'water_bucket', bot.blockAt(new Vec3(cells[0][0], c.y, cells[0][1])) || bot.blockAt(bot.entity.position));
    } catch (_) {}
    try { await goToPosition(bot, cells[3][0], c.y + 1, cells[3][1], 2); } catch (_) {}
    try {
        const tgt = bot.blockAt(new Vec3(cells[3][0], c.y, cells[3][1]));
        if (tgt) await useToolOnBlock(bot, 'water_bucket', tgt);
    } catch (_) {}
    log(bot, `Infinite spring at ${c.x},${c.y},${c.z} (2x2, opposite corners) — scoop anywhere inside, it refills. Cauldron/drips optional, never needed.`);
    return true;
}

export async function scoopAt(bot, what = 'water') {
    /**
     * Scoop a source block into a bucket: 'water' (any source, river/lake/
     * spring), 'lava' (surface pool or deep lake — stand BACK, fire-res if
     * you have it), or 'milk' (aim at the NEAREST cow/goat/mooshroom and use
     * the empty bucket on it — no source block needed). Crafts a bucket from
     * 3 iron if short. Returns the filled bucket name or false.
     **/
    what = String(what || 'water').toLowerCase();
    const inv = () => world.getInventoryCounts(bot);
    if ((inv()['bucket'] || 0) < 1) {
        try { await craftRecipe(bot, 'bucket', 1, true); } catch (_) {}
        if ((inv()['bucket'] || 0) < 1) {
            log(bot, 'No bucket (3 iron_ingot in a V) — mine iron (!sourcing "iron_ore") and craft one first.');
            return false;
        }
    }
    if (what === 'milk') {
        const cow = world.getNearestEntityWhere(bot, e => e && /cow|goat|mooshroom/i.test(e.name || ''), 8);
        if (!cow) { log(bot, 'No cow/goat/mooshroom in reach — lure one close (wheat) then !scoop milk.'); return false; }
        try {
            await goToPosition(bot, cow.position.x, cow.position.y, cow.position.z, 2);
            await equip(bot, 'bucket');
            await bot.activateEntity ? await bot.activateEntity(cow) : await bot.useOnEntity ? await bot.useOnEntity(cow) : null;
            await new Promise(r => setTimeout(r, 400));
        } catch (e) { log(bot, `Milking failed: ${e.message}`); return false; }
        if ((inv()['milk_bucket'] || 0) > 0) { log(bot, 'Milked — milk_bucket clears ALL effects (poison/wither/weakness AND strength/regen — drink it only to cure).'); return 'milk_bucket'; }
        log(bot, 'Milking did not fill — face the cow and retry.');
        return false;
    }
    const target = what === 'lava' ? 'lava' : 'water';
    const src = world.getNearestBlock(bot, target, 24);
    if (!src) { log(bot, `No ${target} source in 24m — walk to a ${target === 'lava' ? 'surface pool / cave lake (level 10-11 deep down)' : 'river/lake/ocean'} first.`); return false; }
    try {
        await goToPosition(bot, src.position.x, src.position.y, src.position.z, 2);
        await useToolOnBlock(bot, 'bucket', src);
    } catch (e) { log(bot, `Scooping ${target} failed: ${e.message}`); return false; }
    const filled = target === 'lava' ? 'lava_bucket' : 'water_bucket';
    if ((inv()[filled] || 0) > 0) {
        log(bot, target === 'lava'
            ? 'Lava scooped — fuel (100 smelts, drains the bucket), portal-lighting (with leaves/planks), or obsidian-making (pour on water). Carry carefully, never near wood home.'
            : 'Water scooped — clutch falls, douse fire, make obsidian (pour on lava), fuel the spring, fill cauldron/bottles.');
        return filled;
    }
    log(bot, `Scoop missed (flowing ${target}, not a source?) — aim at a still surface block and retry.`);
    return false;
}

export async function fillCauldron(bot) {
    /**
     * Fill the nearest cauldron with a water bucket (or place + fill your own:
     * 7 iron in a U). Cauldron = potion lab + dye wash + (nether) the ONLY way
     * to hold water. Potion water also comes from any source with a bottle.
     * @returns {Promise<boolean>} true if the cauldron holds water now.
     **/
    let pot = world.getNearestBlock(bot, 'cauldron', 16) || world.getNearestBlock(bot, 'water_cauldron', 16);
    if (!pot) {
        if ((world.getInventoryCounts(bot)['cauldron'] || 0) > 0) {
            const c = bot.entity.position.floored();
            try { await placeBlock(bot, 'cauldron', c.x + 1, c.y, c.z, 'bottom', true); } catch (_) {}
            pot = world.getNearestBlock(bot, 'cauldron', 16) || world.getNearestBlock(bot, 'water_cauldron', 16);
        } else {
            try { await craftRecipe(bot, 'cauldron', 1, true); } catch (_) {}
            if ((world.getInventoryCounts(bot)['cauldron'] || 0) > 0) {
                const c = bot.entity.position.floored();
                try { await placeBlock(bot, 'cauldron', c.x + 1, c.y, c.z, 'bottom', true); } catch (_) {}
                pot = world.getNearestBlock(bot, 'cauldron', 16) || world.getNearestBlock(bot, 'water_cauldron', 16);
            }
        }
    }
    if (!pot) { log(bot, 'No cauldron (7 iron in a U) — craft/place one, or bottle water straight from any source.'); return false; }
    if (pot.name === 'water_cauldron') { log(bot, 'Cauldron already holds water — bottle/dip away.'); return true; }
    if ((world.getInventoryCounts(bot)['water_bucket'] || 0) < 1) {
        const got = await scoopAt(bot, 'water');
        if (!got) return false;
    }
    try {
        await goToPosition(bot, pot.position.x, pot.position.y, pot.position.z, 2);
        await useToolOnBlock(bot, 'water_bucket', pot);
        log(bot, 'Cauldron filled — glass_bottle dips here for potions, leather armor washes here, nether water bank here.');
        return true;
    } catch (e) { log(bot, `Cauldron fill failed: ${e.message}`); return false; }
}

export async function fillBottle(bot) {
    /**
     * Fill a glass_bottle from water (potion-ready water_bottle): dips the
     * nearest cauldron first, else any source block. Crafts bottles from
     * glass (smelt sand) if short. Brewing stand turns these into potions.
     * @returns {Promise<boolean>} true if a water_bottle is now carried.
     **/
    const inv = () => world.getInventoryCounts(bot);
    if ((inv()['glass_bottle'] || 0) < 1) {
        try { await craftRecipe(bot, 'glass_bottle', 1, true); } catch (_) {}
        if ((inv()['glass_bottle'] || 0) < 1) { log(bot, 'No glass_bottle (smelt sand → glass → 3 glass in a V) — make glass first.'); return false; }
    }
    const pot = world.getNearestBlock(bot, 'water_cauldron', 16);
    if (pot) {
        try {
            await goToPosition(bot, pot.position.x, pot.position.y, pot.position.z, 2);
            await useToolOnBlock(bot, 'glass_bottle', pot);
            if ((inv()['water_bottle'] || 0) > 0 || (inv()['potion'] || 0) > 0) { log(bot, 'Bottle filled at the cauldron — brewing-stand ready.'); return true; }
        } catch (_) {}
    }
    const src = world.getNearestBlock(bot, 'water', 24);
    if (!src) { log(bot, 'No water in 24m — walk to a river/lake first.'); return false; }
    try {
        await goToPosition(bot, src.position.x, src.position.y, src.position.z, 2);
        await useToolOnBlock(bot, 'glass_bottle', src);
        if ((inv()['water_bottle'] || 0) > 0 || (inv()['potion'] || 0) > 0) { log(bot, 'Bottle filled at the source — brewing-stand ready.'); return true; }
    } catch (e) { log(bot, `Bottle fill failed: ${e.message}`); return false; }
    log(bot, 'Bottle dip missed — aim at a still source block and retry.');
    return false;
}

export async function lavaSwim(bot, tx, ty, tz) {
    /**
     * Swim LAVA to reach (tx,ty,tz) — the full prep, no shortcuts: needs
     * fire-resistance ACTIVE first (potion brewed: nether_wart + magma_cream
     * on a brewing stand, drink BEFORE entering), else REFUSE the swim
     * outright (lava = 4-6 hearts/sec, no armor out-tanks it). With fire-res:
     * jump-swim the slow lava toward the target, climb out, wait out the
     * timer on shore. Striders are the honest vehicle (saddle + fungus stick)
     * — this is the no-strider backup. Nether-only thinking; overworld lava
     * lakes = bridge over, never swim.
     * @returns {Promise<boolean>} true if she arrived (fire-res) or refused honestly.
     **/
    const hasRes = () => {
        try {
            const eff = bot.entity && bot.entity.effects;
            if (!eff) return false;
            return Object.values(eff).some(e => e && /fire[_ ]?resistance/i.test(e.name || e.displayName || ''));
        } catch (_) { return false; }
    };
    if (!hasRes()) {
        const inv = world.getInventoryCounts(bot);
        const pot = Object.keys(inv).find(n => /fire|resistance/i.test(n) && /potion|splash|lingering/i.test(n) && (inv[n] || 0) > 0);
        if (pot) {
            log(bot, `Lava swim needs fire-res ACTIVE — drinking ${pot} first, then swimming. (Brew: nether_wart → awkward + magma_cream [blaze_powder + slimeball] on a brewing stand.)`);
            try { await consume(bot, pot); } catch (_) {}
            await new Promise(r => setTimeout(r, 800));
        }
        if (!hasRes()) {
            log(bot, 'REFUSING the lava swim — no fire-resistance active (lava burns 4-6 hearts/sec, armor cannot out-tank it). Honest paths: brew fire-res (nether_wart + magma_cream), ride a saddled strider (!ride strider), bridge over (!build bridge cobble), or pearl across (!glitch pearl).');
            return false;
        }
    }
    log(bot, 'Fire-res active — lava-swimming (slow + blind, timer ticking, shore at the end).');
    try { await goToPosition(bot, tx, ty, tz, 2); } catch (_) { return false; }
    const feet = bot.blockAt(bot.entity.position);
    const ok = !feet || feet.name !== 'lava';
    log(bot, ok ? 'Out of the lava — staying on shore until the timer fades.' : 'Still in lava — keep moving to shore, fire-res is ticking.');
    return ok;
}

export async function lavaSpring(bot) {
    /**
     * "Infinite" LAVA: HONEST — there is NO vanilla infinite-lava spring
     * (lava never regenerates from nothing). The real setups, best first:
     * DRIPSTONE FARM (renewable): pointed_dripstone stalactite + lava source
     * above + cauldron below = drips fill the cauldron over time, scoop with
     * a bucket (needs dripstone cave spikes + cauldron + patience). NETHER
     * LAKE (practical infinite): nether lava oceans never run out for any
     * real need — portal in, scoop, portal out. MINING the lake: scoop source
     * blocks, the edges flow back but sources don't regrow — ferry, don't wait.
     * @returns {Promise<boolean>} true if a path was started/reported.
     **/
    const inv = () => world.getInventoryCounts(bot);
    const drip = bot.blockAt(bot.entity.position) ? world.getNearestBlock(bot, 'pointed_dripstone', 24) : null;
    const pot = world.getNearestBlock(bot, 'cauldron', 16) || ((inv()['cauldron'] || 0) > 0 ? 'carried' : null);
    const lava = world.getNearestBlock(bot, 'lava', 24);
    if (drip && pot && lava) {
        log(bot, 'Lava-farm parts in reach (dripstone + cauldron + lava source): hang the stalactite tip over the cauldron, lava source above the dripstone block — drips fill it, scoop with bucket. Slow but truly renewable.');
        return true;
    }
    const missing = [];
    if (!drip) missing.push('pointed_dripstone (dripstone caves spikes)');
    if (!pot) missing.push('cauldron (7 iron U)');
    if (!lava) missing.push('lava source (!scoop lava near a pool/lake)');
    log(bot, `No infinite lava in vanilla — renewable = DRIPSTONE farm (stalactite + lava above + cauldron below, scoop the drips). Missing here: ${missing.join('; ')}. Practical infinite = nether lava ocean (!portal nether, scoop freely).`);
    return false;
}

export async function cushionSit(bot) {
    /**
     * SIT on the nearest cushion (26.3 entity seat): walk to it, right-click
     * to sit (dismount/stand to get up). Refuses with no cushion near —
     * craft one first (3 same-colour wool slabs in a row; slabs = 3 wool).
     * Sitting is social furniture, not transport.
     * @returns {Promise<boolean>} true if seated.
     **/
    const seat = world.getNearestEntityWhere(bot, e => e && /cushion/.test(e.name || ''), 8);
    if (!seat) { log(bot, 'No cushion in 8m to sit on — place one (useOn with the cushion item on a solid top) then sit.'); return false; }
    try {
        await goToPosition(bot, seat.position.x, seat.position.y, seat.position.z, 2);
        try { await bot.lookAt(seat.position.offset(0, 0.5, 0)); } catch (_) {}
        try {
            if (typeof bot.activateEntity === 'function') await bot.activateEntity(seat);
            else if (typeof bot.useOnEntity === 'function') await bot.useOnEntity(seat);
            else await useToolOnBlock(bot, 'hand', bot.blockAt(seat.position) || bot.blockAt(bot.entity.position));
        } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
        if (bot.vehicle) { log(bot, `Sitting on the ${seat.name}~ ♥ (jump/dismount to get up.)`); return true; }
        log(bot, 'Sat-click sent — if still standing, face the cushion dead-on and click again.');
        return false;
    } catch (e) { log(bot, `Sit failed: ${e.message}`); return false; }
}

export async function boatLadder(bot, seconds = 0) {
    /**
     * BOAT LADDER (vertical fast-travel on a wall): place a boat against the
     * wall base, mount it, look UP + hold jump — the boat climbs its own
     * column (boat-on-wall physics). Steer into the wall the whole ride;
     * dismount at the top edge (jump out onto the ledge). Needs a boat + a
     * tall wall; refuses in open water (nothing to climb).
     * @returns {Promise<boolean>} true if the ride started.
     **/
    let boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest'));
    if (!boatItem) { try { await craftRecipe(bot, 'oak_boat', 1, true); } catch (_) {} boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat') && !i.name.includes('chest')); }
    if (!boatItem) { log(bot, 'No boat for a boat-ladder (5 planks U).'); return false; }
    const f = bot.entity.position.floored();
    const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let wallDir = null;
    for (const [dx, dz] of walls) {
        const w = _parkBlockAt(bot, f.x + dx, f.y, f.z + dz) || _parkBlockAt(bot, f.x + dx, f.y + 1, f.z + dz);
        if (_parkSolid(w)) { wallDir = [dx, dz]; break; }
    }
    if (!wallDir) { log(bot, 'Boat-ladder needs a tall wall at my back — open ground here, ladder/scaffold instead.'); return false; }
    try {
        await bot.equip(boatItem, 'hand');
        const ref = bot.blockAt(new Vec3(f.x, f.y - 1, f.z));
        if (ref) { try { await bot.placeEntity(ref, new Vec3(0, 1, 0)); } catch (_) {} await new Promise(r => setTimeout(r, 300)); }
        const b = world.getNearestEntityWhere(bot, e => /boat/.test(e.name || ''), 6);
        if (b) await bot.mount(b);
        if (!bot.vehicle) { log(bot, 'Could not board the ladder-boat.'); return false; }
        const yaw = Math.atan2(-wallDir[0], -wallDir[1]);
        try { await bot.look(yaw, -1, true); } catch (_) {}
        try { bot.setControlState('jump', true); } catch (_) {}
        try { bot.setControlState('forward', true); } catch (_) {}
        await new Promise(r => setTimeout(r, seconds > 0 ? seconds * 1000 : 4000));
        try { bot.setControlState('jump', false); } catch (_) {}
        try { bot.setControlState('forward', false); } catch (_) {}
        log(bot, 'Boat-ladder ride — steer into the wall, dismount at the top edge onto the ledge.');
        return true;
    } catch (e) { log(bot, `Boat-ladder failed: ${e.message}`); return false; }
}

export async function trapdoorHop(bot, times = 3) {
    /**
     * TRAPDOOR movement (the tricky one — timing + state matter): stand IN a
     * 2-high doorway gap with an OPEN trapdoor at head height, flip it SHUT
     * and JUMP on the same beat — the closing door boosts you up one block
     * (trapdoor elevator). Repeat per block: open → step in → shut + jump.
     * State rules: OPEN = walk through freely; SHUT = solid floor/wall you
     * stand on. Miss the beat = bonk (harmless, retry). Needs a trapdoor (6
     * planks) + a 2-tall shaft. times = blocks to gain.
     * @returns {Promise<boolean>} true if lift gained.
     **/
    times = Math.max(1, Math.min(8, Math.floor(times || 3)));
    const inv = () => world.getInventoryCounts(bot);
    if (!Object.keys(inv()).some(n => n.endsWith('_trapdoor') && (inv()[n] || 0) > 0)) {
        try { await craftRecipe(bot, 'oak_trapdoor', 1, true); } catch (_) {}
    }
    const door = Object.keys(inv()).find(n => n.endsWith('_trapdoor') && (inv()[n] || 0) > 0);
    if (!door) { log(bot, 'No trapdoor (6 planks 2x3) — craft one first.'); return false; }
    const y0 = bot.entity.position.y;
    try {
        for (let i = 0; i < times; i++) {
            if (bot.interrupt_code) break;
            const p = bot.entity.position;
            const px = Math.floor(p.x), py = Math.floor(p.y) + 2, pz = Math.floor(p.z);
            const ok = await placeBlock(bot, door, px, py, pz, 'bottom', true);
            if (!ok) { log(bot, 'No wall to hang the lift door on — stand in a 1-wide shaft and retry.'); break; }
            const blk = bot.blockAt(new Vec3(px, py, pz));
            // OPEN first (walk-through state), step under it...
            try { if (blk) await bot.activateBlock(blk); } catch (_) {}
            await new Promise(r => setTimeout(r, 250));
            // ...then SHUT + JUMP together: the closing slab launches you up
            try { if (blk) await bot.activateBlock(blk); } catch (_) {}
            try { bot.setControlState('jump', true); } catch (_) {}
            await new Promise(r => setTimeout(r, 450));
            try { bot.setControlState('jump', false); } catch (_) {}
            await new Promise(r => setTimeout(r, 250));
        }
    } catch (e) { log(bot, `Trapdoor lift failed: ${e.message}`); }
    const gained = bot.entity.position.y - y0;
    log(bot, gained >= 1 ? `Trapdoor-hopped +${gained.toFixed(1)} blocks (shut+jump on one beat, per block).` : 'No lift — beat was off (shut AND jump together) or no shaft walls. Retry in a 1-wide gap.');
    return gained >= 1;
}

export async function vineClimb(bot, tx = null, ty = null, tz = null) {
    /**
     * VINE / LADDER climbing, done right: walk INTO the vine/ladder face —
     * holding forward climbs automatically (no jump needed; jump = leap OFF
     * at the top). SNEAK on the face = freeze mid-wall (rest, aim, place).
     * Top exit: jump at the last rung to land ON the ledge (forward held).
     * Needs vines (jungle/swamp walls, shears to collect) or ladders (7
     * sticks H, placed on a wall face). tx/ty/tz optional: climbs then walks
     * to the mark (top of the wall usually).
     * @returns {Promise<boolean>} true if climbing happened.
     **/
    const hasTarget = Number.isFinite(Number(tx)) && Number.isFinite(Number(ty)) && Number.isFinite(Number(tz));
    const near = world.getNearestBlock(bot, 'vine', 8) || world.getNearestBlock(bot, 'ladder', 8)
        || world.getNearestBlock(bot, 'weeping_vines', 8) || world.getNearestBlock(bot, 'twisting_vines', 8)
        || world.getNearestBlock(bot, 'cave_vines', 8);
    if (!near) {
        // place her own ladder on the nearest wall
        if (!((world.getInventoryCounts(bot)['ladder'] || 0) > 0)) { try { await craftRecipe(bot, 'ladder', 1, true); } catch (_) {} }
        if (!((world.getInventoryCounts(bot)['ladder'] || 0) > 0)) { log(bot, 'No vines/ladder near and no sticks (7 H) — get to a jungle wall or craft ladders.'); return false; }
        try { await ladderClutch(bot); } catch (_) {}
    } else {
        try { await goToPosition(bot, near.position.x, near.position.y, near.position.z, 2); } catch (_) {}
    }
    try { bot.setControlState('forward', true); } catch (_) {}
    const y0 = bot.entity.position.y;
    const t0 = Date.now();
    const timeout = hasTarget ? Math.abs(Number(ty) - y0) * 1200 + 4000 : 6000;
    try {
        while (Date.now() - t0 < Math.min(timeout, 15000)) {
            if (bot.interrupt_code) break;
            try { bot.setControlState('forward', true); } catch (_) {}
            if (hasTarget && bot.entity.position.y >= Number(ty) - 0.5) break;
            await new Promise(r => setTimeout(r, 250));
        }
    } finally { try { bot.setControlState('forward', false); } catch (_) {} }
    const gained = bot.entity.position.y - y0;
    if (gained > 1 || (hasTarget && bot.entity.position.y >= Number(ty) - 1)) {
        log(bot, `Climbed +${gained.toFixed(1)} (forward = up, sneak = freeze, jump at top = ledge).${hasTarget ? ' Walking to the mark.' : ''}`);
        if (hasTarget) { try { bot.setControlState('jump', true); } catch (_) {} await new Promise(r => setTimeout(r, 400)); try { bot.setControlState('jump', false); } catch (_) {} try { await goToPosition(bot, Number(tx), Number(ty), Number(tz), 2); } catch (_) {} }
        return true;
    }
    log(bot, 'No climb — face planted? Walk INTO the vine/ladder face (forward held, never jump mid-wall).');
    return false;
}

export async function scaffoldUp(bot, height = 8) {
    /**
     * SCAFFOLD tower (fast-travel UP): bamboo scaffolding (6 per craft:
     * bamboo I~I / I I / I I + string) stacked straight up — walk INTO the
     * column bottom to climb it like a ladder, jump at top to mount the rim.
     * Faster + cheaper than pillar-jump: breaks from the BOTTOM (whole column
     * above pops). Falls back to dirt pillar when bamboo/string are dry.
     * @returns {Promise<boolean>} true if the tower stands.
     **/
    height = Math.max(3, Math.min(24, Math.floor(height || 8)));
    const inv = () => world.getInventoryCounts(bot);
    let scaf = inv()['scaffolding'] || 0;
    if (scaf < height) {
        try { await craftRecipe(bot, 'scaffolding', Math.ceil((height - scaf) / 6), true); } catch (_) {}
        scaf = inv()['scaffolding'] || 0;
    }
    if (scaf >= 3) {
        const p = bot.entity.position.floored();
        let placed = 0;
        for (let i = 0; i < Math.min(height, scaf); i++) {
            if (bot.interrupt_code) break;
            try {
                const ok = await placeBlock(bot, 'scaffolding', p.x, p.y + i, p.z, 'bottom', true);
                if (ok) placed++; else break;
            } catch (_) { break; }
        }
        log(bot, placed >= 3 ? `Scaffold tower +${placed} (bamboo) — walk INTO the base to climb, jump at top for the rim. Break the BOTTOM to pop it all.` : 'Scaffold failed (needs a floor to stack on) — dirt pillar instead.');
        if (placed >= 3) return true;
    }
    // fallback: dirt pillar-jump (always available, blocks stay)
    let dirt = inv()['dirt'] || 0;
    if (dirt < height) { try { await collectBlock(bot, 'dirt', height - dirt); } catch (_) {} }
    const p = bot.entity.position.floored();
    let placed = 0;
    for (let i = 0; i < height; i++) {
        if (bot.interrupt_code) break;
        try { bot.setControlState('jump', true); } catch (_) {}
        await new Promise(r => setTimeout(r, 300));
        try {
            const ok = await placeBlock(bot, 'dirt', p.x, p.y + i, p.z, 'bottom', true);
            if (ok) placed++;
        } catch (_) {}
        try { bot.setControlState('jump', false); } catch (_) {}
    }
    log(bot, placed > 0 ? `Dirt pillar +${placed} (no bamboo — scaffold next time: bamboo + string).` : 'No blocks, no tower — gather dirt first.');
    return placed > 0;
}

export async function fish(bot, timeoutMs = 30000) {
    /**
     * Cast a fishing rod and reel in when a fish bites. Uses mineflayer's built-in
     * fishing loop (auto-casts and auto-reels on a bite).
     * @param {MinecraftBot} bot - the bot.
     * @param {number} timeoutMs - how long to wait for a bite before giving up.
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.fish(bot, 30000);
     **/
    const rod = bot.inventory.findInventoryItem('fishing_rod');
    if (!rod) {
        log(bot, 'No fishing rod in inventory.');
        return 'No fishing rod in inventory.';
    }
    await bot.equip(rod, 'hand');

    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    });
    const fishing = bot.fish();
    fishing.catch(() => {}); // swallow the late rejection from reeling in on timeout

    try {
        await Promise.race([fishing, timeout]);
        log(bot, 'Caught a fish.');
        return 'Caught a fish.';
    } catch (err) {
        const msg = (err && err.message === 'timed out')
            ? 'Fishing timed out — no bite.'
            : `Fishing failed: ${err.message}`;
        log(bot, msg);
        return msg;
    } finally {
        clearTimeout(timer);
        try { bot.deactivateItem(); } catch {}
    }
}

export async function pointAt(bot, target, range = 48) {
    /**
     * Turn to look at something and swing the arm (punch air) to gesture toward it,
     * so nearby players can see what you're pointing at.
     * @param {MinecraftBot} bot - the bot.
     * @param {string} target - a player name, mob type (e.g. 'sheep'), or block type (e.g. 'oak_log').
     * @param {number} range - how far to search for mobs/blocks (default 48).
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.pointAt(bot, 'sheep');
     **/
    let pos = null;
    let what = target;

    // 1) a player by name — aim at their eyes
    const player = bot.players && bot.players[target];
    if (player && player.entity) {
        pos = player.entity.position.offset(0, 1.62, 0);
    }

    // 2) nearest mob of that type
    if (!pos) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === target, range);
        if (entity) {
            pos = entity.position.offset(0, entity.height || 1, 0);
            what = entity.name;
        }
    }

    // 3) nearest block of that type
    if (!pos) {
        const block = world.getNearestBlock(bot, target, range);
        if (block) {
            pos = block.position.offset(0.5, 0.5, 0.5);
            what = block.name;
        }
    }

    if (!pos) {
        log(bot, `Couldn't find ${target} to point at.`);
        return `Couldn't find ${target} to point at.`;
    }

    await bot.lookAt(pos);
    for (let i = 0; i < 2; i++) {
        bot.swingArm();
        await wait(bot, 250);
    }
    log(bot, `Pointed at ${what}.`);
    return `Pointed at ${what}.`;
}

export async function pointAtPosition(bot, x, y, z, what = 'there') {
    /**
     * Turn to face a coordinate and swing the arm (punch air) to gesture toward it.
     * @param {MinecraftBot} bot - the bot.
     * @param {number} x - x coordinate.
     * @param {number} y - y coordinate (ground level).
     * @param {number} z - z coordinate.
     * @param {string} what - human-readable label for the target.
     * @returns {Promise<string>} human-readable result.
     * @example
     * await skills.pointAtPosition(bot, 120, 64, -450, 'home');
     **/
    await bot.lookAt(new Vec3(x, y + 1.62, z)); // aim at head height over the spot
    for (let i = 0; i < 2; i++) {
        bot.swingArm();
        await wait(bot, 250);
    }
    log(bot, `Pointed at ${what}.`);
    return `Pointed at ${what}.`;
}

export async function teleportPlayer(bot, playerName) {
    const p = bot.entity.position;
    bot.chat(`/tp ${playerName} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    log(bot, `Teleported ${playerName} to you.`);
    return `Teleported ${playerName} to you.`;
}

export async function teleportSelf(bot, x, y, z) {
    // GO-THERE FAST: /tp HERSELF to x y z (she is OP). Survival-honest order
    // applies — teleport is the LAST resort, not the commute: walk near,
    // sprint far flat, boat water, pearl far+healthy, bridge mid, climb/scaffold
    // walls. She tp's herself when asked by someone trusted, when stuck
    // (buried/no path), or when the trip is pointless walking (rescue, recall).
    // NEVER tp's to dodge a fight she started, into unloaded void, or to
    // snoop on players uninvited. Says /tp aloud (chat-visible anyway).
    x = Math.floor(Number(x)); y = Math.floor(Number(y)); z = Math.floor(Number(z));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { log(bot, '!teleportMe needs x y z — where to?'); return false; }
    if (y < -64 || y > 320) { log(bot, `Y=${y} is outside the world — refusing the tp.`); return false; }
    bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
    log(bot, `Tp'd myself to ${x} ${y} ${z} — the fast road, used sparingly.`);
    return true;
}

export async function comeHere(bot, requester, paced = null) {
    // "COME HERE / GO TO X" brain: someone asks her to come somewhere.
    // Order: (1) trusted voice or beloved = go NOW, no debate; (2) pick the
    // honest road by distance+ground (walk near, sprint far flat, boat water
    // legs, !glitch travel far+healthy, !tidy bridge gaps); (3) tp ONLY if
    // they asked for it ("tp to me") AND the gate allows (friend+ power rule
    // lives on !teleportMe — this function just walks unless told to tp);
    // (4) say what she chose. Returns true if she set off.
    const who = String(requester || 'someone');
    if (paced === 'tp' || paced === 'teleport') { log(bot, `Tp asked — use !teleportMe for that (gated, friend+). I walk unless you say the word + the gate passes.`); return false; }
    try {
        const t = world.getNearestEntityWhere(bot, e => e && (e.username === who || e.name === who), 128);
        if (t && t.position) {
            const d = Math.hypot(t.position.x - bot.entity.position.x, t.position.z - bot.entity.position.z);
            if (d < 3) { log(bot, `Already at ${who}'s side~ ♥`); return true; }
            log(bot, `Coming to ${who} (${d.toFixed(0)} blocks) — ${d > 24 ? 'sprinting the flats, tricking the gaps' : 'walking it careful'}.`);
            if (d > 60) { try { await travelTrick(bot, t.position.x, t.position.y, t.position.z); return true; } catch (_) {} }
            await goToPlayer(bot, who, 3, d > 24 ? 'sprint' : 'walk');
            return true;
        }
    } catch (_) {}
    log(bot, `Can't see ${who} yet — give me coords or a !teleportMe and I'm there.`);
    return false;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    if (isProtectedGear(bot, itemType)) {
        log(bot, `I can't give away ${itemType} — it's part of my kit, never droppable!`);
        return false;
    }
    // OP cheat-give: spawn the item directly into the target's inventory via /give.
    // She's op (level 4) so the command resolves; this avoids (a) needing the item
    // in her own backpack and (b) walking over + tossing, both of which failed here.
    // 26.3: run it via RCON-side silent path — bot.chat('/give...') broadcasts
    // the "Gave X N item" feedback to HER chat (visible), and log() below
    // narrates it to public chat too. The gift itself is silent server-side;
    // only her cute narration should be heard, never the command echo.
    if (bot.modes.isOn('cheat')) {
        silentGive(bot, username, itemType, num);
        return true;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export async function goToGoal(bot, goal, navTimeoutMs = 15000) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @param {number} navTimeoutMs, navigation watchdog budget (default 15s).
     * Attach a profile to the goal instead of flipping global flags:
     *   goal._moveMode = 'sprint' | 'parkour' — the leg runs that profile;
     *   anything else (or unset) walks. goToPosition(mode) sets this for you.
     **/
    const _moveMode = (goal && (goal._moveMode === 'sprint' || goal._moveMode === 'parkour')) ? goal._moveMode : 'walk';

    const nonDestructiveMovements = new pf.Movements(bot);
    // BARITONE-STYLE LEGS (26.3): Baritone's reliability comes from (1) full
    // break+place freedom while planning, (2) generous planning time, (3)
    // segment retries with backoff instead of one-shot give-up. So: the FIRST
    // probe stays clean (no dig/place) for the common open-ground case; the
    // FALLBACK plans with dig+place allowed (digCost high so it prefers clean
    // detours, but stairs/doors/dirt get pathed THROUGH instead of "no path").
    // Sprint/parkour still come only from the leg profile, never blanket-on.
    const _sprintLeg = goal && goal._sprintTrial === true;
    const _profile = moveProfile(bot, _moveMode);
    nonDestructiveMovements.allowSprinting = _profile.allowSprinting; // _sprintLeg when re-armed
    nonDestructiveMovements.allowParkour = _profile.allowParkour;
    nonDestructiveMovements.canDig = false;
    nonDestructiveMovements.canPlaceOn = false;
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = new pf.Movements(bot);
    // destructive fallback inherits the leg's profile (never hotter than asked)
    destructiveMovements.allowSprinting = _profile.allowSprinting;
    destructiveMovements.allowParkour = _profile.allowParkour;
    // Baritone half: MAY dig and place while planning (doors, dirt, leaves —
    // never glass). placeCost low so pillar-ups/stair-steps plan through;
    // digCost high so it detours before it digs.
    destructiveMovements.canDig = true;
    destructiveMovements.canPlaceOn = true;
    destructiveMovements.placeCost = 1;
    destructiveMovements.digCost = 25;
    for (let block of dontBreakBlocks) {
        try { destructiveMovements.blocksCantBreak.add(mc.getBlockId(block)); } catch (_) {}
    }

    let final_movements = destructiveMovements;

    const pathfind_timeout = (goal && Number.isFinite(goal._pathTimeout)) ? goal._pathTimeout : 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        // BARITONE-STYLE RETRY (26.3): one "no path" is a planning miss, not
        // proof — Baritone re-plans with backoff. Retry the dig+place probe
        // with a longer budget (doors/stairs/load-chunks resolve on 2nd try),
        // then a GoalNear-loosened probe (radius+2: "close counts" for
        // doorsteps/ledges the exact goal can't stand on). Only then give up.
        let rescued = false;
        try {
            const retry = await bot.pathfinder.getPathTo(destructiveMovements, goal, Math.max(pathfind_timeout * 3, 4000));
            if (retry && retry.status === 'success') { final_movements = destructiveMovements; log(bot, `Found path on retry (longer planning).`); rescued = true; }
        } catch (_) {}
        if (!rescued) {
            try {
                const loose = new pf.goals.GoalNear(goal.x ?? goal.target?.x ?? bot.entity.position.x, goal.y ?? goal.target?.y ?? bot.entity.position.y, goal.z ?? goal.target?.z ?? bot.entity.position.z, (goal.radius ?? 2) + 2);
                loose._moveMode = goal._moveMode; loose._sprintTrial = goal._sprintTrial; loose._pathTimeout = Math.max(pathfind_timeout * 3, 4000);
                const retry2 = await bot.pathfinder.getPathTo(destructiveMovements, loose, Math.max(pathfind_timeout * 3, 4000));
                if (retry2 && retry2.status === 'success') { final_movements = destructiveMovements; log(bot, `Found near-path on retry (exact spot unreachable, close counts).`); rescued = true; goal = loose; }
            } catch (_) {}
        }
        if (!rescued) {
            log(bot, `No path found after retries — staying put instead of blind navigation (26.3 movement gate).`);
            return false;
        }
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        // 26.3: navigation watchdog — pathfinder.goto() has NO timeout; a
        // goal it can never reach (19:19/19:23: !moveAway hung 3min ->
        // force-stop loop -> 10s stop() -> cleanKill 'Exiting.' suicide ->
        // systemd restart) wedges the action until the 3min action timeout.
        // Race the goto against the watchdog so control always returns.
        // 20:00/20:05 !digDown(10)/(5) hung the same way: digDown's loop calls
        // breakBlockAt per block, each re-pathing through goToGoal — every
        // leg burns pathfind+nav budget and the action never returns.
        let navErr = null;
        const nav = bot.pathfinder.goto(goal).catch(e => { navErr = e; });
        // 26.3: NEVER await the raw goto promise indefinitely — if its goal
        // entity despawns/goal vanishes mid-goto, goto never settles and the
        // old `await nav` hung the action forever (22:49: wedged
        // !mode:item_collecting -> isIdle false forever -> ALL modes + the
        // self-prompt loop dead -> 6h catatonia on a live connection).
        let navDone = false;
        nav.then(() => { navDone = true; }, () => { navDone = true; });
        const t0 = Date.now();
        // 26.3 GRACE: monitorMovement only populates path[] on the next
        // physicsTick AFTER setGoal — checking isMoving() immediately sees
        // an empty path and "times out" instantly, and the timeout's
        // setGoal(null)+stop() then CANCELS the walk that was about to
        // start. Every leg aborted pre-birth: pathfinder plans, feet never
        // move, RCON frozen for hours while logs claim progress (06:1x).
        // So: up to 3s grace for the first path to appear before the
        // watchdog is allowed to judge.
        const graceUntil = t0 + 3000;
        while (Date.now() < graceUntil) {
            if (bot.interrupt_code || navDone) break;
            if (bot.pathfinder.isMoving()) break;
            await new Promise(r => setTimeout(r, 200));
        }
        while (Date.now() - t0 < navTimeoutMs) {
            if (bot.interrupt_code || navDone) break;
            await new Promise(r => setTimeout(r, 200));
            if (Date.now() - t0 >= navTimeoutMs) break;
        }
        const settled = !bot.pathfinder.isMoving();
        if ((!settled || !navDone) && !bot.interrupt_code) {
            try { bot.pathfinder.setGoal(null); } catch (e) {}
            try { bot.pathfinder.stop(); } catch (e) {}
            // 26.3: do NOT toggle interrupt_code to release goto — the OLD code
            // set it true then false, which corrupted stop()/resume state and
            // wedged the NEXT action (20:32: wedged goto -> 10s stop -> suicide).
            // setGoal(null)+stop() releases goto's waiters on its own. Detach
            // the raw promise (never await it) and report.
            nav.catch(() => {});
            log(bot, `Navigation timed out after ${Math.round(navTimeoutMs / 1000)}s — staying put (goal unreachable from here).`);
            clearInterval(doorCheckInterval);
            return false;
        }
        if (bot.interrupt_code) {
            // interrupted mid-nav: detach, clean up, get out fast.
            nav.catch(() => {});
            clearInterval(doorCheckInterval);
            return false;
        }
        // Settled within budget: give the raw promise a short grace to unwind,
        // but never hang on it.
        await Promise.race([nav, new Promise(r => setTimeout(r, 5000))]);
        clearInterval(doorCheckInterval);
        if (navErr) throw navErr;
        // Sprint/parkour legs end hot: drop sprint + forward the moment the goal
        // settles so she stops ON the edge instead of sprinting off it.
        try {
            bot.setControlState('sprint', false);
            bot.setControlState('forward', false);
        } catch (_) {}
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2, mode='walk') {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @param {string} mode, movement profile: 'walk' (careful, default), 'sprint' (flat-out run, needs food+space), 'parkour' (sprint + jumps for gaps/height).
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     * await skills.goToPosition(bot, x, y, z, 2, 'sprint'); // hurry, flat ground
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        // 26.3: cheat-/tp emits a server teleport the 26.3 client stack can't
        // echo cleanly (stale-state positions -> "Invalid move" kick). Walk
        // instead — same destination, no teleport, no kick.
        log(bot, `Cheat-/tp disabled on 26.3, walking to ${x}, ${y}, ${z} instead.`);
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);

    // 26.3: NO sprint, NO sprint-jump by default. Pathfinder's allowSprinting
    // emits sprint+jump fall deltas (d1.0-1.4/tick) that the 26.3 moved-wrongly
    // gate reads as impossible -> "Invalid move" kick mid-walk (walk-death
    // logs proved). Walk speed only — slower, never kicks. Sprint restores one
    // leg at a time via goal.sprint=true (goToPlayer far-leg) once walk proves
    // clean; never blanket-on.
    // PARKOUR UPDATE: she is LAC-exempt (her offline UUID is the exempt one),
    // so the moved-wrongly gate can't touch her; mode='sprint'/'parkour' arms
    // the matching profile per leg. Default stays walk (edges, lava, mobs).
    if (mode === 'sprint' || mode === 'parkour') {
        // sprint needs fuel + a straight-ish leg; parkour additionally needs
        // solid ground under her (never sprint-jump over lava/void/water blind).
        if (bot.food <= 6) {
            log(bot, `Too hungry to ${mode} (food ${bot.food}) — walking instead, feed me first.`);
            mode = 'walk';
        } else if (mode === 'parkour') {
            const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
            const at = bot.blockAt(bot.entity.position);
            const danger = (b) => b && ['lava', 'air', 'cave_air', 'void_air', 'water', 'powder_snow'].includes(b.name);
            if (danger(below) || danger(at)) {
                log(bot, `No solid ground for parkour here — walking instead.`);
                mode = 'walk';
            }
        }
        if (mode !== 'walk') {
            const dist = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z);
            if (dist < 6) {
                // short hop: sprint never pays, walk it
                mode = 'walk';
            }
        }
    } else {
        mode = 'walk';
    }
    const walkMovements = moveProfile(bot, mode);
    if (mode !== 'walk') log(bot, `${mode === 'parkour' ? 'Parkouring' : 'Sprinting'} to ${x}, ${y}, ${z}.`);
    bot.pathfinder.setMovements(walkMovements);
    try {
        const _goal = new pf.goals.GoalNear(x, y, z, min_distance);
        if (mode === 'sprint' || mode === 'parkour') _goal._moveMode = mode;
        await goToGoal(bot, _goal);
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToBlockAdjacent(bot, block, min_distance=2) {
    /**
     * Walk (pathfind) to a spot adjacent to a block — never teleport, and never
     * path INTO the block (which breaks container opening). The cheat /tp in
     * goToPosition lands the bot inside the block, so chests/furnaces must walk.
     */
    try {
        await goToGoal(bot, new pf.goals.GoalNear(block.position.x, block.position.y, block.position.z, min_distance));
        return true;
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    let player = bot.players[username];
    const playerEntity = player && player.entity;
    // 26.3: ALL cheat-/tp paths disabled — server teleports kick this client
    // stack ("Invalid move": stale-state positions after the echo). Walk
    // instead in every case; if the entity isn't loaded we can't pathfind,
    // so say so instead of teleporting.
    // NOTE: this early-return ALSO fires when the mode is on but the entity
    // is missing — the RCON-position fallback below must run INSTEAD, so this
    // branch only returns when RCON also has no position (offline/gone).
    if (bot.modes.isOn('cheat') && !playerEntity) {
        const rpos_cheat = await rconPlayerPos(username).catch(() => null);
        if (!rpos_cheat) {
            log(bot, `Could not find ${username} (entity not loaded, and cheat-/tp is disabled on 26.3).`);
            return false;
        }
        // else: fall through to the RCON-position walker below (rpos re-read
        // there; this probe was only to decide whether they're truly gone).
        log(bot, `Cheat-/tp disabled on 26.3 — walking to ${username} by server position instead.`);
    } else if (playerEntity) {
        let distTxt = '?';
        try {
            const dist = bot.entity.position.distanceTo(playerEntity.position);
            distTxt = Number.isFinite(dist) ? dist.toFixed(1) : '?';
        } catch (_) {}
        if (bot.modes.isOn('cheat'))
            log(bot, `Cheat-/tp disabled on 26.3 — walking ${distTxt} blocks to ${username} instead.`);
    }

    if (!playerEntity) {
        // 26.3 RCON-position fallback (verified 18:24: entities withheld even
        // at 11 blocks): ask the server where they ARE and walk to those
        // coords with normal WALK legs (same kick-safe path as goToPosition).
        // Static goal (not GoalFollow — no entity to track); re-read every
        // leg so she homes in as the cache refreshes.
        const rpos = await rconPlayerPos(username).catch(() => null);
        if (rpos) {
            bot.modes.pause('self_defense');
            bot.modes.pause('cowardice');
            log(bot, `${username} is nearby but out of sight — walking to where they are.`);
            for (let leg = 0; leg < 6; leg++) {
                const fresh = await rconPlayerPos(username).catch(() => null);
                const t = fresh || rpos;
                const dx0 = t.x - bot.entity.position.x, dz0 = t.z - bot.entity.position.z;
                const dist0 = Math.hypot(dx0, dz0);
                if (dist0 <= Math.max(distance, 2) + 1) break; // already there — no path needed
                // SPRINT-TRIAL: far legs (>12 blocks) sprint flat-out
                // (parkour still off — no sprint-jumps, no fall deltas).
                let legGoal = null;
                try {
                    legGoal = new pf.goals.GoalNear(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z), Math.max(distance, 2));
                    // vertical or long legs get more planning time: the default
                    // 1s budget fails indoor→outdoor stairs/doors on first try
                    // and reports "no path" while a path exists.
                    legGoal._pathTimeout = (Math.abs(t.y - bot.entity.position.y) > 3 || dist0 > 24) ? 4000 : 1000;
                    if (dist0 > 12) {
                        legGoal._sprintTrial = true;
                        log(bot, `Sprinting this leg (far, flat).`);
                    }
                } catch (_) {}
                let ok = false;
                if (legGoal) {
                    try { ok = await goToGoal(bot, legGoal); }
                    catch (e) { ok = false; log(bot, `Leg stopped: ${e.message}.`); }
                } else {
                    ok = await goToPosition(bot, Math.floor(t.x), Math.floor(t.y), Math.floor(t.z), Math.max(distance, 2));
                }
                if (!ok) {
                    // one honest retry with a fresh read before giving up — the
                    // player may have stepped around a corner mid-leg.
                    const retry = await rconPlayerPos(username).catch(() => null);
                    const rt = retry || t;
                    log(bot, `Leg blocked — one retry toward fresh position.`);
                    ok = await goToPosition(bot, Math.floor(rt.x), Math.floor(rt.y), Math.floor(rt.z), Math.max(distance, 2));
                    if (!ok) {
                        log(bot, `Still can't reach ${username} (walls/doors between us?) — ask them to step outside, or say "!teleportMe" and I'll tp.`);
                        break;
                    }
                }
                // entity rendered mid-walk? switch to live follow
                const ent = bot.players[username] && bot.players[username].entity;
                if (ent) {
                    const goal = new pf.goals.GoalFollow(ent, Math.max(distance, 0.5));
                    await goToGoal(bot, goal);
                    break;
                }
                const d = bot.entity.position.distanceTo(new Vec3(t.x, t.y, t.z));
                if (d <= Math.max(distance, 2) + 1) break;
            }
            log(bot, `You have reached ${username}.`);
            return true;
        }
        log(bot, `Could not find ${username}.`);
        return false;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(playerEntity, distance);

    await goToGoal(bot, goal);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4, mode='walk') {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @param {number} distance, the goal distance (default 4).
     * @param {string} mode, movement profile: 'walk' (default), 'sprint' (keep up on flat ground), 'parkour' (chase over gaps).
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     * await skills.followPlayer(bot, "player", 4, 'sprint'); // hurry after them
     **/
    let player = bot.players[username] && bot.players[username].entity;
    if (!player)
        return false;

    // 26.3: re-resolve the entity every tick. The old code captured ONE entity
    // object at follow start — when the player relogs/respawns/teleports the
    // handle goes stale, GoalFollow chases a ghost forever, and any interrupt
    // of the stuck follow wedged stop() into the 10s cleanKill suicide
    // (05:37: new !followPlayer interrupting old !followPlayer -> 10s of
    // "waiting for code" -> exit 1 -> restart, right in front of you).
    // 26.3: WALK, never sprint. Pathfinder's default allowSprinting emits
    // sprint+jump fall deltas (d1.0-1.4/tick) that the moved-wrongly gate
    // reads as impossible (walk-death proved). Follow legs are long, so this
    // is exactly where a kick would land. Sprint restores only as a proven
    // per-leg opt-in, never blanket-on.
    // PARKOUR UPDATE: profile follows the requested mode (LAC-exempt, no kick
    // risk); sprint/parkour still refuse when starving (food <= 6).
    if (mode !== 'sprint' && mode !== 'parkour') mode = 'walk';
    if ((mode === 'sprint' || mode === 'parkour') && bot.food <= 6) {
        log(bot, `Too hungry to ${mode} after them (food ${bot.food}) — walking instead.`);
        mode = 'walk';
    }
    const move = moveProfile(bot, mode);
    if (mode !== 'walk') log(bot, `Following ${username} at a ${mode} (${mode === 'parkour' ? 'sprint+jumps' : 'run'}).`);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    log(bot, `You are now actively following player ${username}.`);

    let lastGoalReset = 0;
    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // refresh the handle; player gone = follow over, return cleanly.
        const fresh = bot.players[username] && bot.players[username].entity;
        if (!fresh) {
            log(bot, `${username} is gone — stopped following.`);
            break;
        }
        player = fresh;
        // re-issue the goal every 5s so it never chases a stale snapshot.
        if (Date.now() - lastGoalReset > 5000) {
            try {
                const _fg = new pf.goals.GoalFollow(player, distance);
                if (mode === 'sprint' || mode === 'parkour') _fg._moveMode = mode;
                bot.pathfinder.setGoal(_fg, true);
            } catch (e) {}
            lastGoalReset = Date.now();
        }
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance, mode='walk') {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @param {string} mode, movement profile: 'walk' (default) or 'sprint' (flee fast — needs food > 6).
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     * await skills.moveAway(bot, 16, 'sprint'); // run for it
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    if (mode === 'sprint' && bot.food > 6) {
        inverted_goal._moveMode = 'sprint';
        log(bot, `Sprinting away (${distance} blocks).`);
    } else {
        if (mode === 'sprint') log(bot, `Too hungry to sprint (food ${bot.food}) — walking away instead.`);
    }
    const mv = moveProfile(bot, inverted_goal._moveMode === 'sprint' ? 'sprint' : 'walk');
    bot.pathfinder.setMovements(mv);

    if (bot.modes.isOn('cheat')) {
        // 26.3: cheat-/tp disabled — server teleports kick this client stack.
        // Fall through to normal pathfinder walking below.
        log(bot, 'Cheat-/tp disabled on 26.3, walking instead.');
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16, mode='walk') {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, the bot reference.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @param {string} mode, movement profile: 'walk' (default) or 'sprint' (flee fast — needs food > 6).
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    if (mode === 'sprint' && bot.food > 6) {
        inverted_goal._moveMode = 'sprint';
        log(bot, `Sprinting away from ${entity.name || 'it'}.`);
    }
    const mvFE = moveProfile(bot, inverted_goal._moveMode === 'sprint' ? 'sprint' : 'walk');
    bot.pathfinder.setMovements(mvFE);
    // 26.3: same watchdog as goToGoal — raw goto() never times out.
    await goToGoal(bot, inverted_goal);
    return true;
}

// ============================================================================
// ELYTRA FLIGHT — glide, boost with firework rockets, and land.
// mineflayer exposes bot.elytraFly() (deploy), bot.entity.elytraFlying (state),
// and rocket boost = hold a firework_rocket in hand + bot.activateItem().
// ============================================================================

export function countFireworkRockets(bot) {
    return bot.inventory.items().filter(i => i.name === 'firework_rocket').reduce((a, i) => a + i.count, 0);
}

export function isElytraEquipped(bot) {
    const torso = bot.getEquipmentDestSlot('torso');
    const worn = bot.inventory.slots[torso];
    return !!worn && worn.name === 'elytra';
}

export async function equipElytra(bot) {
    if (isElytraEquipped(bot)) {
        log(bot, 'Already wearing elytra.');
        return true;
    }
    const elytra = bot.inventory.items().find(i => i.name === 'elytra');
    if (!elytra) {
        log(bot, "I don't have an elytra. I can find one in an End City ship, or /give myself one since I'm op.");
        return false;
    }
    await bot.equip(elytra, 'torso');
    log(bot, 'Elytra equipped.');
    return true;
}

export async function equipFireworkRocket(bot) {
    const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket');
    if (!rocket) {
        log(bot, "I don't have any firework rockets — I need to craft some (paper + gunpowder).");
        return false;
    }
    await bot.equip(rocket, 'hand');
    log(bot, 'Firework rocket in hand.');
    return true;
}

export async function boostWithFirework(bot) {
    // Boost while gliding: right-click a firework rocket. Requires elytra flying.
    if (!bot.entity.elytraFlying) {
        log(bot, "Can't boost — not currently gliding.");
        return false;
    }
    if (countFireworkRockets(bot) === 0) {
        log(bot, 'Out of firework rockets.');
        return false;
    }
    const held = bot.heldItem;
    if (!held || held.name !== 'firework_rocket') {
        if (!await equipFireworkRocket(bot)) return false;
    }
    bot.activateItem();
    log(bot, 'Boosted with a firework rocket.');
    return true;
}

export async function buildLiftoffTower(bot, height = 20) {
    // Build a vertical pillar at her feet and get on top — a ready-made launch
    // point when there's no cliff or tower nearby.
    height = Math.max(4, Math.min(64, Math.floor(height)));
    const feet = Math.floor(bot.entity.position.y);
    const bx = Math.floor(bot.entity.position.x);
    const bz = Math.floor(bot.entity.position.z);
    const block = 'cobblestone';

    const baseY = feet - 1;          // ground block she's standing on
    const topBlockY = baseY + height; // highest block of the pillar
    const standY = topBlockY + 1;     // her feet once standing on top

    let placed = 0;
    for (let y = baseY + 1; y <= topBlockY; y++) {
        if (bot.interrupt_code) break;
        try {
            if (await placeBlock(bot, block, bx, y, bz, 'bottom')) placed++;
        } catch (e) { break; }
    }
    if (placed < 3) {
        log(bot, "Couldn't build a liftoff tower.");
        return false;
    }

    if (bot.modes.isOn('cheat')) {
        // 26.3: cheat-/tp disabled — server teleports kick this client stack.
        // Survival pillar-jump works in both modes.
        log(bot, 'Cheat-/tp disabled on 26.3, pillar-jumping instead.');
    }
    {
        // Survival: pillar-jump up by placing a block under our feet each step.
        for (let i = 0; i < height && !bot.interrupt_code; i++) {
            const f = bot.entity.position.floored();
            await placeBlock(bot, block, f.x, f.y - 1, f.z, 'bottom');
            bot.setControlState('jump', true);
            await new Promise(resolve => setTimeout(resolve, 160));
            bot.setControlState('jump', false);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    log(bot, `Built a ${height}-block liftoff tower and climbed on top.`);
    return true;
}

export async function getAirborne(bot, height = 10) {
    // Get her airborne with real falling velocity, which the server needs before it
    // will accept an elytra deploy. In cheat mode, teleport straight up — the server
    // processes the /tp itself, so this is reliable (a client-side pillar-jump is
    // flaky and often leaves her onGround). Survival falls back to a simple hop.
    // 26.3: cheat-/tp disabled — server teleports kick this client stack.
    // Hop for falling velocity in both modes (pillar path above for height).
    {
        bot.setControlState('jump', true);
        bot.setControlState('jump', false);
        await new Promise(resolve => setTimeout(resolve, 260));
    }
    return true;
}

export async function takeOff(bot) {
    // Deploy the elytra and start gliding. Preferred launch is the vanilla
    // rocket-hop (no teleport): hop, look up, then use a firework rocket to launch
    // and auto-deploy the wings. Falls back to a teleport-up + explicit deploy when
    // there are no rockets or the rocket-hop doesn't engage.
    if (bot.entity.elytraFlying) {
        log(bot, 'Already flying.');
        return true;
    }
    if (!await equipElytra(bot)) return false;

    const hasRockets = countFireworkRockets(bot) > 0;
    const fail = async (msg) => { log(bot, msg); bot.modes.unpause('self_preservation'); bot.modes.unpause('unstuck'); await rearmorAfterFlight(bot); return false; };
    bot.modes.pause('self_preservation'); // don't MLG-clutch while falling to deploy the elytra
    bot.modes.pause('unstuck');

    const confirmEngaged = async (ms) => {
        const deadline = Date.now() + ms;
        while (!bot.entity.elytraFlying && !bot.interrupt_code && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return bot.entity.elytraFlying;
    };

    if (hasRockets) {
        // Vanilla flat takeoff: hop, look up, use a rocket to launch + auto-deploy.
        await equipFireworkRocket(bot);
        bot.setControlState('jump', true);
        bot.setControlState('jump', false);
        await new Promise(resolve => setTimeout(resolve, 150)); // airborne
        await bot.look(bot.entity.yaw, 45 * Math.PI / 180);
        bot.activateItem(); // rocket launches her up and opens the wings
        if (!await confirmEngaged(1500)) {
            log(bot, 'Rocket-hop did not engage — teleporting up to retry.');
            await getAirborne(bot);
            try { await bot.elytraFly(); } catch (e) { return fail(`Take-off failed: ${e.message}`); }
        }
    } else {
        log(bot, 'No rockets — teleporting up to glide.');
        await getAirborne(bot);
        try { await bot.elytraFly(); } catch (e) { return fail(`Take-off failed: ${e.message}`); }
    }

    if (!await confirmEngaged(2000)) {
        return fail('Elytra never engaged — the server did not accept the take-off.');
    }

    // Boost up before she loses altitude. A gentle 30° climb gives the rocket lift.
    if (hasRockets) {
        await bot.look(bot.entity.yaw, 30 * Math.PI / 180);
        for (let i = 0; i < 3 && countFireworkRockets(bot) > 0 && !bot.interrupt_code; i++) {
            bot.activateItem();
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }

    log(bot, 'Took off — elytra deployed, gliding!');
    bot.modes.unpause('self_preservation'); // flying now; elytra glide is fall-safe
    bot.modes.unpause('unstuck');
    return true;
}

export async function rearmorAfterFlight(bot) {
    // Swap the elytra back for a chestplate now that she's on the ground, then
    // top up any other missing armor. Keeps her from wandering around without
    // chest protection after flying.
    if (isElytraEquipped(bot)) {
        const chest = bot.inventory.items().find(i => i.name.includes('chestplate'));
        if (chest) {
            await bot.equip(chest, 'torso');
            log(bot, 'Re-equipped chestplate after flight.');
        }
    }
    if (bot.armorManager) {
        try { bot.armorManager.equipAll(); } catch (e) { /* non-fatal */ }
    }
}

export async function landWithElytra(bot) {
    // Descend and touch down gently. The elytra deactivates when she hits ground.
    if (!bot.entity.elytraFlying) {
        log(bot, 'Already on the ground.');
        await rearmorAfterFlight(bot);
        return true;
    }
    const start = Date.now();
    while (bot.entity.elytraFlying && !bot.interrupt_code && Date.now() - start < 30000) {
        const pos = bot.entity.position;
        const below = bot.blockAt(pos.offset(0, -3, 0));
        const groundDist = below ? pos.y - below.position.y : 99;
        // Dive (45° down) while high, level out when close so we land on our feet.
        const pitch = groundDist > 6 ? Math.PI / 4 : 0;
        await bot.look(bot.entity.yaw, pitch);
        if (bot.entity.onGround) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    bot.clearControlStates();
    await rearmorAfterFlight(bot);
    log(bot, 'Landed.');
    return true;
}

export async function flyWithElytra(bot, x, y, z, min_distance = 3) {
    // Fly (glide + auto-boost) to a destination and land near it.
    if (x == null || y == null || z == null) {
        log(bot, 'Missing destination coordinates.');
        return false;
    }
    if (!bot.entity.elytraFlying && !await takeOff(bot)) return false;

    const target = new Vec3(x, y, z);
    const hasRockets = countFireworkRockets(bot) > 0;
    const start = Date.now();
    const MAX_MS = 120000;
    let lastBoost = 0;

    if (hasRockets) await equipFireworkRocket(bot);

    while (!bot.interrupt_code) {
        if (Date.now() - start > MAX_MS) {
            log(bot, 'Flight timed out — landing.');
            break;
        }
        const pos = bot.entity.position;
        const horizontal = Math.hypot(pos.x - x, pos.z - z);
        if (horizontal <= min_distance) break; // overhead the target

        if (!bot.entity.elytraFlying) {
            log(bot, 'Elytra deactivated mid-flight.');
            break;
        }

        // Face the destination (pitch aims us at it, which also controls descent).
        try { await bot.lookAt(target.offset(0, 1.5, 0), true); } catch (e) { /* ignore */ }

        // Keep speed/altitude with a rocket every ~2.5s when we have them.
        if (hasRockets && Date.now() - lastBoost > 2500) {
            await boostWithFirework(bot);
            lastBoost = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    bot.clearControlStates();
    await landWithElytra(bot);
    log(bot, `Flew to ${x}, ${y}, ${z}.`);
    return true;
}

export async function cruiseWithElytra(bot, seconds = 12) {
    // Sustained no-destination flight: launch, then cruise forward firing a
    // rocket every ~2.5s to hold altitude, then glide down and land. Makes "fly"
    // actually look like flying instead of a single rocket-hop.
    seconds = Math.max(2, Math.min(60, Math.floor(seconds)));
    if (!bot.entity.elytraFlying && !await takeOff(bot)) return false;

    const hasRockets = countFireworkRockets(bot) > 0;
    if (hasRockets) await equipFireworkRocket(bot);

    // Pitch slightly down so she keeps forward speed and never stalls; the
    // periodic rockets buy the altitude back.
    await bot.look(bot.entity.yaw, -10 * Math.PI / 180);

    const start = Date.now();
    const maxMs = seconds * 1000;
    let lastBoost = 0;

    while (!bot.interrupt_code && Date.now() - start < maxMs) {
        if (!bot.entity.elytraFlying) {
            log(bot, 'Elytra deactivated mid-cruise.');
            break;
        }
        if (hasRockets && Date.now() - lastBoost > 2500) {
            await boostWithFirework(bot);
            lastBoost = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    await landWithElytra(bot);
    log(bot, `Cruised for ~${Math.round((Date.now() - start) / 1000)}s.`);
    return true;
}

export async function avoidEnemies(bot, distance=16, mode='walk') {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @param {string} mode, movement profile: 'walk' (default) or 'sprint' (flee fast — needs food > 6).
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     * await skills.avoidEnemies(bot, 16, 'sprint'); // run for it
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    if (mode === 'sprint' && bot.food > 6) log(bot, `Sprinting clear of enemies.`);
    else if (mode === 'sprint') { log(bot, `Too hungry to sprint (food ${bot.food}) — walking clear instead.`); mode = 'walk'; }
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        if (mode === 'sprint') inverted_goal._moveMode = 'sprint';
        const mvAE = moveProfile(bot, mode === 'sprint' ? 'sprint' : 'walk');
        bot.pathfinder.setMovements(mvAE);
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'pale_oak_door', 'poplar_door',
                               'crimson_door', 'warped_door',
                               'copper_door', 'exposed_copper_door', 'weathered_copper_door', 'oxidized_copper_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function sleepNearPlayer(bot, playerName, distance=3) {
    /**
     * Follow a player into bed: go to them, sleep in a nearby empty bed, or place one if needed.
     * @param {MinecraftBot} bot
     * @param {string} playerName
     * @param {number} distance - how close to get to the player
     * @returns {Promise<boolean>} true if she got in a bed, false otherwise.
     **/
    const player = bot.players[playerName]?.entity;
    if (!player) {
        log(bot, `Cannot find player ${playerName} to sleep next to.`);
        return false;
    }
    await goToPlayer(bot, playerName, distance);

    // prefer an existing empty bed near the player
    const beds = bot.findBlocks({
        matching: (block) => block.name.includes('bed'),
        maxDistance: 16,
        count: 8,
    });
    for (const loc of beds) {
        const bed = bot.blockAt(loc);
        if (!bed) continue;
        try {
            await bot.sleep(bed);
            log(bot, `Sleeping next to ${playerName}.`);
            bot.modes.pause('unstuck');
            while (bot.isSleeping) await new Promise(resolve => setTimeout(resolve, 500));
            log(bot, `Woke up.`);
            return true;
        } catch {
            // bed occupied / not night / already sleeping — try the next one
            continue;
        }
    }

    // no empty bed: place one next to her (cheat mode = /setblock, she's OP)
    const pos = bot.entity.position.floored();
    const offsets = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dz] of offsets) {
        const x = pos.x + dx, y = pos.y, z = pos.z + dz;
        const placed = await placeBlock(bot, 'red_bed', x, y, z, 'bottom', true);
        if (!placed) continue;
        await new Promise(resolve => setTimeout(resolve, 400));
        const bed = bot.blockAt(new Vec3(x, y, z));
        if (!bed) continue;
        try {
            await bot.sleep(bed);
            log(bot, `Placed a bed and sleeping next to ${playerName}.`);
            bot.modes.pause('unstuck');
            while (bot.isSleeping) await new Promise(resolve => setTimeout(resolve, 500));
            log(bot, `Woke up.`);
            return true;
        } catch {
            continue;
        }
    }
    return false;
}

// Bounded burst of alternating sneak + jump — reads as playful copy/excitement.
// Self-terminating (never a persistent loop): clears control states when done.
export async function spamJumpCrouch(bot, durationMs = 3000) {
    const end = Date.now() + durationMs;
    let crouch = true;
    while (Date.now() < end) {
        bot.setControlState('sneak', crouch);
        if (crouch) {
            bot.setControlState('jump', true);
            await new Promise(resolve => setTimeout(resolve, 180));
            bot.setControlState('jump', false);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        crouch = !crouch;
    }
    bot.setControlState('sneak', false);
    bot.setControlState('jump', false);
}

export async function bounceOnBed(bot, playerName, durationMs = 3500) {
    /**
     * Cheeky yandere gesture: hop over to a sleeping player and bounce on their bed
     * with a short jump + spam-crouch burst. One-off by design (non-persistent).
     * @param {MinecraftBot} bot
     * @param {string} playerName
     * @param {number} durationMs
     * @returns {Promise<boolean>} true if she went over and bounced, false otherwise.
     **/
    const player = bot.players[playerName]?.entity;
    if (!player) return false;
    await goToPlayer(bot, playerName, 1);
    try { await bot.lookAt(player.position.offset(0, 1, 0)); } catch (e) { /* non-fatal */ }
    await spamJumpCrouch(bot, durationMs);
    log(bot, `Bounced on ${playerName}'s bed.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type: flip a lever/button, open a
     * door/trapdoor/fence_gate, ring a bell, pop a chest, toggle a copper bulb.
     * Accepts family shorthands: 'door' hits any door incl. copper/oxidized,
     * 'trapdoor' any hatch, 'button' any button, 'plate' any pressure plate,
     * 'gate' any fence gate, 'bed' any bed, 'chest' any chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    const FAMILY = {
        door: (n) => n.endsWith('_door'),
        trapdoor: (n) => n.endsWith('_trapdoor'),
        button: (n) => n.endsWith('_button'),
        plate: (n) => n.endsWith('_pressure_plate'),
        gate: (n) => n.endsWith('_fence_gate'),
        bed: (n) => n.endsWith('_bed') || n === 'bed',
        chest: (n) => n === 'chest' || n === 'trapped_chest' || n.endsWith('_copper_chest'),
    };
    const match = FAMILY[String(type || '').toLowerCase()];
    let blocks;
    if (match) {
        blocks = world.getNearestBlocksWhere(bot, b => b && b.name && match(b.name), 16, 1);
    } else {
        const found = world.getNearestBlock(bot, type, 16);
        blocks = found ? [found] : [];
    }
    let block = blocks[0];
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function findWantedTrade(bot, wantName, maxVillagers = 5) {
    /**
     * Goal-driven trade finder ("I want X emeralds→Y"): scan nearby villagers,
     * open each one's offers, and return the first that SELLS wantName —
     * { villager, villagerId, index (1-based), trade } — or null with a spoken
     * reason. Checks the static VILLAGER_TRADES table first so she walks to
     * the right profession instead of opening every villager blind.
     * Caps opens at maxVillagers (each open is a window + server round-trip).
     * The GUI Query chain (mineflayer-gui, vendored) is the fallback path when
     * bot.openVillager isn't available: Hotbar.Equip → Window.Open against the
     * villager entity id, then read bot.currentWindow trade slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} wantName, item name she wants to buy, e.g. 'mending' book or 'saddle'.
     * @param {number} maxVillagers, max villagers to open (default 5).
     * @returns {Promise<object|null>} match or null.
     * @example
     * await skills.findWantedTrade(bot, "saddle");
     **/
    const want = String(wantName || '').toLowerCase().replace(/ /g, '_');
    if (!want) { log(bot, 'Trade for what? Give me an item name.'); return null; }
    const hint = mc.getItemVillagerTrade(want);
    const nearby = world.getNearbyEntities(bot, 32).filter(e => e.name === 'villager');
    if (!nearby.length) {
        log(bot, 'No villagers in sight — find a village first (!locate village), or check a wandering trader.');
        return null;
    }
    // Profession-first ordering when the static table knows who sells it.
    const profOf = (e) => { try { return (world.getVillagerProfession(e) || '').toLowerCase(); } catch { return ''; } };
    nearby.sort((a, b) => {
        if (!hint) return bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
        const pa = profOf(a).includes(hint.profession) ? 0 : 1, pb = profOf(b).includes(hint.profession) ? 0 : 1;
        return pa - pb || bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
    });
    if (hint) log(bot, `${want}: a ${hint.profession} sells it (${hint.price}) — checking ${hint.profession}s first.`);
    const norm = (s) => String(s || '').toLowerCase().replace(/ /g, '_');
    let opened = 0;
    for (const v of nearby.slice(0, Math.max(1, maxVillagers))) {
        if (bot.interrupt_code) break;
        let villager = null;
        try {
            if (typeof bot.openVillager === 'function') {
                villager = await bot.openVillager(v);
            } else if (bot.gui) {
                // GUI fallback: open the villager window through the query chain.
                const q = bot.gui.Query();
                await q.Hotbar.Equip((name, item) => item && item.name === 'villager_spawn_egg').end().run().catch(() => {});
                villager = await bot.openVillager(v).catch(() => null);
            }
        } catch { villager = null; }
        if (!villager || !villager.trades) continue;
        opened++;
        for (let i = 0; i < villager.trades.length; i++) {
            const t = villager.trades[i];
            const out = t.outputItem ? (t.outputItem.name || '') : '';
            if (norm(out) === want || norm(out).includes(want) || want.includes(norm(out))) {
                try { villager.close(); } catch {}
                return { villager: v, villagerId: v.id, index: i + 1, trade: t };
            }
        }
        try { villager.close(); } catch {}
    }
    log(bot, opened ? `Checked ${opened} villager${opened === 1 ? '' : 's'} — none sells ${want}.` : 'Could not open any villager (sleeping, baby, or jobless?).');
    return null;
}

export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    // 26.3: per-call block cap + interrupt checks. digDown(10) with a 45s nav
    // leg per block wedged past the 3min action timeout (20:00/20:05 suicides).
    // 6 blocks max per call — the brain re-issues to continue deeper.
    const capped = Math.min(Math.max(distance, 1), 6);
    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= capped; i++) {
        if (bot.interrupt_code) {
            log(bot, `Dig interrupted after ${i-1} blocks.`);
            return false;
        }
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 12000);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    if (capped < distance)
        log(bot, `Dug down ${capped} blocks (capped per call — re-issue to go deeper).`);
    else
        log(bot, `Dug down ${capped} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

// ===== ENCHANTING / ANVIL / BOOK / FARMING (normal-player depth) =====

export async function enchantItem(bot, itemName, choice=null) {
    /**
     * Enchant an item at the nearest enchanting table. Puts the item + lapis,
     * waits for the enchantment choices, picks one (highest level by default, or
     * the 0-based `choice` index), and takes the enchanted item back.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item in inventory to enchant (e.g. diamond_sword).
     * @param {number} [choice], optional 0-based index of which enchant to take; defaults to the highest-level option.
     * @returns {Promise<boolean>} true if enchanted, false otherwise.
     * @example await skills.enchantItem(bot, "diamond_sword");
     **/
    const tableBlock = world.getNearestBlock(bot, 'enchanting_table', 32);
    if (!tableBlock) {
        log(bot, 'No enchanting table nearby. Craft one (4 obsidian + 2 diamond + 1 book) and place it.');
        return false;
    }
    await goToNearestBlock(bot, 'enchanting_table', 4, 32);

    const item = bot.inventory.items().find(i => i.name === itemName)
        || bot.inventory.items().find(i => i.name.includes(itemName));
    if (!item) {
        log(bot, `No ${itemName} in inventory to enchant.`);
        return false;
    }
    const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli');
    if (!lapis) {
        log(bot, 'No lapis_lazuli to spend on enchanting (mine it, or trade with a cleric villager).');
        return false;
    }

    try {
        const table = await bot.openEnchantmentTable(tableBlock);
        await table.putTargetItem(item);
        await table.putLapis(lapis);

        // wait until the server sends real enchantment levels (the 'ready' event
        // fires once all three choices have a level >= 0)
        if (!table.enchantments || table.enchantments[0].level < 0) {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('timed out waiting for enchantments')), 5000);
                table.once('ready', () => { clearTimeout(t); resolve(); });
            });
        }

        const choices = table.enchantments || [];
        if (!choices.length) {
            log(bot, 'No enchantments available — place bookshelves around the table for better options.');
            table.close();
            return false;
        }
        let idx = choice != null ? parseInt(choice) : choices.reduce((best, c, i) => (c.level > choices[best].level ? i : best), 0);
        if (idx < 0 || idx >= choices.length) idx = 0;

        await table.enchant(idx);
        await table.takeTargetItem();
        table.close();
        log(bot, `Enchanted ${itemName} (cost ${choices[idx].level} levels).`);
        return true;
    } catch (err) {
        log(bot, `Enchanting failed: ${err.message}`);
        return false;
    }
}

export async function useAnvil(bot, action, itemName1, itemName2=null, rename=null) {
    /**
     * Use the nearest anvil to rename an item or combine two items (merge
     * enchantments / repair / apply an enchanted book).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} action, 'rename' or 'combine'.
     * @param {string} itemName1, first item (the tool/gear, or the item to rename).
     * @param {string} [itemName2], second item (enchanted book or matching tool) for 'combine'.
     * @param {string} [rename], new display name (optional).
     * @returns {Promise<boolean>} true if the anvil action succeeded.
     * @example await skills.useAnvil(bot, "combine", "diamond_sword", "enchanted_book");
     **/
    const anvilBlock = world.getNearestBlock(bot, 'anvil', 16)
        || world.getNearestBlock(bot, 'chipped_anvil', 16)
        || world.getNearestBlock(bot, 'damaged_anvil', 16);
    if (!anvilBlock) {
        log(bot, 'No anvil nearby. Craft one (3 iron_block + 4 iron_ingot) and place it.');
        return false;
    }
    await goToPosition(bot, anvilBlock.position.x, anvilBlock.position.y, anvilBlock.position.z, 3);

    const item1 = bot.inventory.items().find(i => i.name === itemName1)
        || bot.inventory.items().find(i => i.name.includes(itemName1));
    if (!item1) {
        log(bot, `No ${itemName1} in inventory.`);
        return false;
    }

    try {
        const anvil = await bot.openAnvil(anvilBlock);
        if (action === 'rename') {
            if (!rename) {
                log(bot, 'Rename needs a new name. Use !anvil(rename, <item>, , "<new name>").');
                anvil.close();
                return false;
            }
            await anvil.rename(item1, rename);
        } else {
            const item2 = bot.inventory.items().find(i => i.name === itemName2)
                || bot.inventory.items().find(i => i.name.includes(itemName2));
            if (!item2) {
                log(bot, `No ${itemName2} in inventory to combine with.`);
                anvil.close();
                return false;
            }
            await anvil.combine(item1, item2, rename || null);
        }
        anvil.close();
        log(bot, `Anvil ${action} done for ${itemName1}.`);
        return true;
    } catch (err) {
        log(bot, `Anvil failed: ${err.message}`);
        return false;
    }
}

export async function writeBook(bot, title, pages) {
    /**
     * Write a book-and-quill in inventory. `pages` is a string or array of
     * strings (one per page). After writing it becomes a signed written_book.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} title, the book's title.
     * @param {string|string[]} pages, page text (string) or array of page strings.
     * @returns {Promise<boolean>} true if written, false otherwise.
     * @example await skills.writeBook(bot, "For my beloved", "I love you ~ nya ♥");
     **/
    const book = bot.inventory.items().find(i => i.name === 'writable_book');
    if (!book) {
        log(bot, 'No writable_book in inventory. Craft one (book + ink_sac + feather -> book_and_quill / writable_book).');
        return false;
    }
    const pageList = Array.isArray(pages) ? pages : [pages];
    try {
        // signBook writes AND signs, so she produces a titled, signed written_book
        await bot.signBook(book.slot, pageList, bot.username, title);
        log(bot, `Wrote and signed "${title}".`);
        return true;
    } catch (err) {
        log(bot, `Book writing failed: ${err.message}`);
        return false;
    }
}

const MATURE_CROP_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
function _cropAge(block) {
    if (!block) return -1;
    const props = typeof block.getProperties === 'function' ? block.getProperties() : null;
    if (props && props.age != null) return props.age;
    return block.metadata ?? -1;
}

export async function harvestCrops(bot, maxDistance=16) {
    /**
     * Find and harvest all mature crops (wheat, carrots, potatoes, beetroot)
     * within maxDistance, collecting the drops. Only digs fully-grown crops.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [maxDistance], search radius (default 16).
     * @returns {Promise<number>} number of crops harvested.
     * @example await skills.harvestCrops(bot);
     **/
    let harvested = 0;
    for (const crop of Object.keys(MATURE_CROP_AGE)) {
        const maxAge = MATURE_CROP_AGE[crop];
        const mature = world.getNearestBlocksWhere(
            bot,
            (b) => b && b.name === crop && _cropAge(b) >= maxAge,
            maxDistance,
            10000
        );
        for (const block of mature) {
            try {
                await bot.dig(block, true);
                harvested++;
            } catch (e) {
                log(bot, `Failed to harvest ${crop}: ${e.message}`);
                break;
            }
        }
    }
    if (harvested) {
        await pickupNearbyItems(bot);
        log(bot, `Harvested ${harvested} mature crops.`);
    } else {
        log(bot, 'No mature crops nearby to harvest.');
    }
    return harvested;
}

export async function breedAnimals(bot, maxDistance=16) {
    /**
     * Feed two nearby animals of the same type their breeding food to breed them.
     * Handles sheep/cows (wheat), pigs/carrots, chickens/seeds, etc.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [maxDistance], search radius (default 16).
     * @returns {Promise<boolean>} true if a pair was fed, false otherwise.
     * @example await skills.breedAnimals(bot);
     **/
    const BREED_FOOD = {
        sheep: 'wheat', cow: 'wheat', mooshroom: 'wheat', goat: 'wheat',
        pig: 'carrot', rabbit: 'carrot',
        chicken: 'wheat_seeds',
        horse: 'golden_apple', donkey: 'golden_apple',
        cat: 'cod', wolf: 'bone',
        turtle: 'seagrass', axolotl: 'tropical_fish', panda: 'bamboo',
    };
    const animals = Object.keys(bot.entities)
        .map(id => bot.entities[id])
        .filter(e => e && e.type === 'mob' && BREED_FOOD[e.name])
        .filter(e => bot.entity.position.distanceTo(e.position) <= maxDistance);

    // find two of the same type
    const byType = {};
    for (const a of animals) (byType[a.name] ||= []).push(a);
    for (const [type, list] of Object.entries(byType)) {
        if (list.length < 2) continue;
        const foodName = BREED_FOOD[type];
        const food = bot.inventory.items().find(i => i.name === foodName);
        if (!food) {
            log(bot, `Would breed ${type}s but have no ${foodName}.`);
            continue;
        }
        await bot.equip(food, 'hand');
        for (const a of list.slice(0, 2)) {
            await bot.lookAt(a.position.offset(0, 1, 0));
            await bot.useOn(a);
            await new Promise(r => setTimeout(r, 400));
        }
        log(bot, `Fed two ${type}s to breed.`);
        return true;
    }
    log(bot, 'No breedable pair of animals nearby (need 2 of the same type + their food).');
    return false;
}

export async function brewPotion(bot, ingredientName, count=1) {
    /**
     * Brew potions at the nearest brewing stand. Puts water bottles (or an
     * existing potion base) in the bottom slots, the ingredient on top, and
     * blaze_powder fuel, then waits ~20s and takes the result. Call it once per
     * step of the chain: nether_wart -> awkward_potion, then the effect
     * ingredient (sugar=swiftness, blaze_powder=strength, etc.) per your brewing
     * knowledge.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} ingredientName, the ingredient to brew with (e.g. nether_wart, sugar, blaze_powder, fermented_spider_eye).
     * @param {number} [count], how many potions to brew (1-3, default 1).
     * @returns {Promise<boolean>} true if potions were brewed, false otherwise.
     * @example await skills.brewPotion(bot, "sugar", 3);
     **/
    count = Math.max(1, Math.min(3, parseInt(count) || 1));
    const stand = world.getNearestBlock(bot, 'brewing_stand', 16);
    if (!stand) {
        log(bot, 'No brewing_stand nearby. Craft one (1 blaze_rod + 3 cobblestone) and place it.');
        return false;
    }
    const ingredient = bot.inventory.items().find(i => i.name === ingredientName)
        || bot.inventory.items().find(i => i.name.includes(ingredientName));
    if (!ingredient) {
        log(bot, `No ${ingredientName} in inventory to brew with.`);
        return false;
    }
    const fuel = bot.inventory.items().find(i => i.name === 'blaze_powder');
    if (!fuel) {
        log(bot, 'No blaze_powder to fuel the brewing stand (craft it from a blaze_rod, dropped by blazes).');
        return false;
    }
    const potionId = mc.getItemId('potion');
    const havePotionBottles = bot.inventory.items().some(i => i.name === 'potion');

    await goToNearestBlock(bot, 'brewing_stand', 3, 16);

    try {
        const w = await bot.openBlock(stand);

        // ensure potion bottles sit in the bottom slots 0-2 (only if empty)
        const standHasPotion = [0, 1, 2].some(s => w.slots[s] && w.slots[s].type === potionId);
        if (!standHasPotion) {
            if (!havePotionBottles) {
                log(bot, 'No water bottles to brew. Craft glass_bottle and fill with water first.');
                w.close();
                return false;
            }
            await bot.transfer({ window: w, itemType: potionId, metadata: null, count, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: 0, destEnd: 3 });
        }

        // ingredient -> top slot 3
        await bot.transfer({ window: w, itemType: ingredient.type, metadata: null, count: 1, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: 3, destEnd: 4 });

        // fuel -> blaze powder slot 4
        await bot.transfer({ window: w, itemType: fuel.type, metadata: null, count: 1, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: 4, destEnd: 5 });

        // brewing takes 400 ticks (~20s); keep the window open so slots update
        log(bot, `Brewing ${count} potion(s) with ${ingredientName}...`);
        await wait(bot, 22000);

        let took = 0;
        for (const s of [0, 1, 2]) {
            const item = w.slots[s];
            if (item && item.type === potionId) {
                await bot.putAway(s);
                took++;
            }
        }
        w.close();
        log(bot, `Brewed ${took} potion(s) with ${ingredientName}.`);
        return took > 0;
    } catch (err) {
        log(bot, `Brewing failed: ${err.message}`);
        return false;
    }
}

// ---- summoning (gated operator power — runs through !summon, never raw chat) ----
function normalizeEntityName(name) {
    return String(name || '').toLowerCase().trim()
        .replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
}

function resolveEntity(bot, name) {
    const norm = normalizeEntityName(name);
    if (!norm) return null;
    try { if (mc.getEntityId(norm) != null) return norm; } catch (_) {}
    try {
        const byName = (bot && bot.registry && bot.registry.entitiesByName) || {};
        if (byName[norm] || byName['minecraft:' + norm]) return norm;
        for (const k of Object.keys(byName)) {
            if (String(k).toLowerCase().replace(/^minecraft:/, '') === norm) return norm;
        }
    } catch (_) {}
    return null;
}

function levenshteinSmall(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        let cur = [i];
        for (let j = 1; j <= n; j++)
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

function suggestEntityNames(bot, name, limit = 4) {
    const t = normalizeEntityName(name);
    if (!t) return [];
    let keys = [];
    try { keys = Object.keys((bot && bot.registry && bot.registry.entitiesByName) || {}); } catch (_) {}
    const scored = [];
    for (const k of keys) {
        const n = String(k).toLowerCase().replace(/^minecraft:/, '');
        if (n === t) continue;
        const d = levenshteinSmall(t, n);
        if (d <= Math.max(2, Math.floor(t.length / 3))) scored.push({ n, d });
    }
    scored.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
    return scored.slice(0, limit).map(s => s.n);
}

export async function summonMob(bot, entityType, count = 1) {
    const resolved = resolveEntity(bot, entityType);
    // No count cap by design — she is the judger. Her summoning notes teach
    // what each mob costs (lag, destruction, deaths); the number is her call.
    count = Math.max(1, Math.floor(Number(count) || 1));
    if (!resolved) {
        const s = suggestEntityNames(bot, entityType);
        const msg = `Invalid entity type: ${entityType}.${s.length ? ` Did you mean: ${s.join(', ')}?` : ''}`;
        log(bot, msg);
        return msg;
    }
    const p = bot.entity.position;
    let ok = 0;
    for (let i = 0; i < count; i++) {
        const a = (i / Math.max(1, count)) * Math.PI * 2;
        const r = 3 + (i % 3);
        const x = Math.floor(p.x + Math.cos(a) * r), y = Math.floor(p.y), z = Math.floor(p.z + Math.sin(a) * r);
        try { bot.chat(`/summon minecraft:${resolved} ${x} ${y} ${z}`); ok++; }
        catch (e) { log(bot, `Summon failed: ${e.message}`); break; }
        if (count > 1) await new Promise(res => setTimeout(res, 350)); // never burst-spawn; one summon per ~7 ticks
    }
    const msg = ok === count ? `Summoned ${ok} ${resolved}.` : `Summoned ${ok}/${count} ${resolved}.`;
    log(bot, msg);
    return msg;
}

export async function despawnEntities(bot, entityType, radius = 64) {
    const resolved = resolveEntity(bot, entityType);
    radius = Math.max(8, Math.min(200, Math.floor(Number(radius) || 64)));
    if (!resolved) {
        const s = suggestEntityNames(bot, entityType);
        const msg = `Invalid entity type: ${entityType}.${s.length ? ` Did you mean: ${s.join(', ')}?` : ''}`;
        log(bot, msg);
        return msg;
    }
    try { bot.chat(`/kill @e[type=minecraft:${resolved},distance=..${radius}]`); }
    catch (e) { const msg = `Despawn failed: ${e.message}`; log(bot, msg); return msg; }
    const msg = `Removed ${resolved} within ${radius} blocks.`;
    log(bot, msg);
    return msg;
}

// ---- material sourcing report (powers !sourcing) ----
// Hand-table key sets for known() — filled from the real tables at runtime
// (static import would cycle: buildsense imports mc, skills imports buildsense
// only inside functions). ensureSourcingKeys runs first in sourcingReport.
let FIND_HINT_KEYS = new Set(), VILLAGER_TRADE_KEYS = new Set(), LOOT_ONLY_KEYS = new Set();
async function ensureSourcingKeys() {
    if (FIND_HINT_KEYS.size) return;
    try {
        const bs = await import('./buildsense.js');
        if (bs.FIND_HINT_KEYS) FIND_HINT_KEYS = new Set(bs.FIND_HINT_KEYS);
        if (bs.CRAFT_FALLBACK_KEYS) for (const k of bs.CRAFT_FALLBACK_KEYS) FIND_HINT_KEYS.add(k);
    } catch (_) {}
    try {
        if (mc.VILLAGER_TRADE_KEYS) VILLAGER_TRADE_KEYS = new Set(mc.VILLAGER_TRADE_KEYS);
        if (mc.LOOT_ONLY_KEYS) LOOT_ONLY_KEYS = new Set(mc.LOOT_ONLY_KEYS);
    } catch (_) {}
    // Fallback so canonicalMaterial works even if the tables failed to load:
    // seed the obvious keys directly (craft-fallback chains + common drops).
    if (!FIND_HINT_KEYS.size) {
        for (const k of ['torch', 'stick', 'oak_planks', 'string', 'glass', 'iron_ingot', 'diamond_ore', 'oak_log',
            'crafting_table', 'chest', 'furnace', 'ladder', 'glass_pane', 'glowstone']) FIND_HINT_KEYS.add(k);
    }
    if (!VILLAGER_TRADE_KEYS.size) VILLAGER_TRADE_KEYS.add('mending');
    if (!LOOT_ONLY_KEYS.size) for (const k of ['elytra', 'netherite_sword', 'music_disc_cat', 'dragon_egg']) LOOT_ONLY_KEYS.add(k);
}
function canonicalMaterial(bot, name) {
    // Cheap normalizer: lowercase/underscores + the two slips she makes most
    // (trailing-s, stray spaces). Known = live registry OR static mcdata OR the
    // hand tables below (FIND_HINTS covers items like diamond/redstone/lapis
    // that have no block/item id of their own). Also resolves common shorthand
    // (diamond = the gem from diamond_ore) so those answer instead of 404ing.
    let n = String(name || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (!n) return null;
    const blocks = (bot && bot.registry && bot.registry.blocksByName) || {};
    const items = (bot && bot.registry && bot.registry.itemsByName) || {};
    const known = (x) => !!(blocks[x] || items[x] || (() => { try { return mc.getItemId(x) != null; } catch (_) { return false; } })() || (() => { try { return mc.getBlockId(x) != null; } catch (_) { return false; } })() || FIND_HINT_KEYS.has(x) || VILLAGER_TRADE_KEYS.has(x) || LOOT_ONLY_KEYS.has(x));
    const SHORTHAND = { plank: 'oak_planks', planks: 'oak_planks', log: 'oak_log', wood: 'oak_log', diamond: 'diamond_ore', diamonds: 'diamond_ore', emerald: 'emerald_ore', iron: 'iron_ore', gold: 'gold_ore', coal: 'coal_ore', redstone: 'redstone_ore', lapis: 'lapis_ore', quartz: 'nether_quartz_ore', netherite: 'ancient_debris' };
    if (SHORTHAND[n] && known(SHORTHAND[n])) return SHORTHAND[n];
    if (known(n)) return n;
    if (known(n + 's')) return n + 's'; // oak_plank -> oak_planks
    if (n.endsWith('s') && known(n.slice(0, -1))) return n.slice(0, -1);
    return null;
}

function suggestMaterialNames(bot, name, limit = 4) {
    const t = String(name || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (!t) return [];
    let keys = [];
    try {
        keys = [...Object.keys((bot && bot.registry && bot.registry.itemsByName) || {}),
                ...Object.keys((bot && bot.registry && bot.registry.blocksByName) || {})];
    } catch (_) {}
    const seen = new Set(), scored = [];
    for (const k of keys) {
        const n = String(k).toLowerCase().replace(/^minecraft:/, '');
        if (seen.has(n) || n === t) continue;
        seen.add(n);
        const d = levenshteinSmall(t, n);
        if (d <= Math.max(2, Math.floor(t.length / 3))) scored.push({ n, d });
    }
    scored.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
    return scored.slice(0, limit).map(s => s.n);
}

export async function sourcingReport(bot, rawName) {
    // One material in -> the full chain out: where, what tool, smelt/craft/
    // trade/loot path, what she carries, and whether source blocks are near.
    // Every lookup is fail-soft so a half-ready registry degrades, never throws.
    const fail = (msg) => { log(bot, msg); return msg; };
    try { await ensureSourcingKeys(); } catch (_) {}
    let name = null;
    try { name = canonicalMaterial(bot, rawName); } catch (_) { name = null; }
    if (!name) {
        let s = [];
        try { s = suggestMaterialNames(bot, rawName); } catch (_) {}
        return fail(`Unknown material: ${rawName}.${s.length ? ` Did you mean: ${s.join(', ')}?` : ''}`);
    }
    const lines = [`SOURCING ${name}`];
    const safe = (fn) => { try { return fn(); } catch (_) { return null; } };

    // 0. crafting-table verdict FIRST (only for things with a recipe): she must
    // know WHERE to stand before gathering a single ingredient.
    let tableVerdict = null;
    try { tableVerdict = mc.recipeNeedsTable(name); } catch (_) {}
    if (tableVerdict === true) lines.push('Craft at: a crafting table (3x3) — place or find one first.');
    else if (tableVerdict === false) lines.push('Craft at: your 2x2 inventory grid — no table needed.');

    // 1. where it comes from (biome / depth / structure / mob / trade / loot)
    let where = null;
    try { const { sourcingHint } = await import('./buildsense.js'); where = sourcingHint(name); } catch (_) {}
    if (!where) where = 'unknown source';
    lines.push(`Where: ${where}.`);

    // 2. tool needed (for blocks: simplest tool + full capable set).
    // dataReady is computed below; the hand-table Where line answers regardless.
    const isBlockHeuristic = name.endsWith('_ore') || name.endsWith('_log') || ['obsidian', 'stone', 'deepslate', 'crying_obsidian'].includes(name);
    if (isBlockHeuristic) {
        const tool = safe(() => { try { return mc.getBlockTool(name); } catch (_) { return null; } });
        const tools = safe(() => { try { return mc.getBlockHarvestTools(name); } catch (_) { return null; } });
        if (tool) lines.push(`Tool: ${tool}${tools && tools.length > 1 ? ` (also works: ${tools.filter(t => t !== tool).slice(0, 4).join(', ')})` : ''} — mine by hand otherwise, slowly.`);
        else lines.push('Tool: none needed — break by hand.');
    }

    // 3. acquisition chains (smelt / craft / animal / trade / loot)
    // NOTE: mcdata lookups need the static registry, which is null until the
    // bot logs in — headless/early calls skip them and the Where line above
    // (hand tables) still answers.
    const dataReady = safe(() => { try { return mc.getItemId('stone') != null; } catch (_) { return false; } }) === true;
    const chains = [];
    const smeltFrom = dataReady ? safe(() => { try { return mc.getItemSmeltingIngredient(name); } catch (_) { return null; } }) : null;
    if (smeltFrom) chains.push(`smelt ${smeltFrom} in a furnace`);
    let recipe = null;
    try { recipe = dataReady ? safe(() => mc.getItemCraftingRecipes(name)) : null; } catch (_) {}
    if (recipe && recipe[0] && recipe[0][0]) {
        const ing = Object.entries(recipe[0][0]).map(([k, v]) => `${k} x${v}`);
        if (ing.length) chains.push(`craft from ${ing.slice(0, 5).join(', ')}`);
    }
    const animal = safe(() => mc.getItemAnimalSource(name));
    if (animal) chains.push(`from ${animal}s (breed or hunt)`);
    const trade = safe(() => mc.getItemVillagerTrade(name));
    if (trade) chains.push(`trade: ${trade.profession} villager (${trade.price})`);
    const loot = safe(() => mc.getItemLootOnly(name));
    if (loot) chains.push('loot/boss-only: no craft, no gather — explore structures, kill the boss, open vaults');
    const sources = dataReady ? (safe(() => { try { return mc.getItemBlockSources(name); } catch (_) { return []; } }) || []) : [];
    if (sources.length && !chains.some(c => c.startsWith('craft'))) {
        const extra = sources.slice(1, 3).length ? ` (also: ${sources.slice(1, 3).join(', ')})` : '';
        if (!where || where.startsWith('mine ' + sources[0]) === false) chains.push(`drops from ${sources[0]}${extra}`);
    }
    if (chains.length) lines.push(`How: ${chains.join(' | ')}.`);
    else if (!isBlockHeuristic) lines.push('How: no craft/smelt/drop path in data — check Where above (trade/loot/mob).');

    // 4. what she carries right now
    let have = 0;
    try {
        for (const it of (bot.inventory?.items() || [])) if (it.name === name) have += it.count;
    } catch (_) {}
    lines.push(have > 0 ? `You carry: ${have}.` : 'You carry: none.');

    // 5. source blocks near her (bounded scan, first source only)
    if (sources.length) {
        let found = -1;
        try {
            const worldMod = await import('./world.js');
            const getNearest = worldMod.getNearestBlocksWhere
                || (worldMod.default && worldMod.default.getNearestBlocksWhere);
            if (getNearest) found = getNearest(bot, b => b && b.name === sources[0], 48, 32).length;
        } catch (_) {}
        if (found >= 0) lines.push(found > 0 ? `Nearby: ${found} ${sources[0]} within ~48m.` : `Nearby: no ${sources[0]} in your loaded area — explore.`);
    }

    const out = lines.join('\n');
    log(bot, out);
    return out;
}

