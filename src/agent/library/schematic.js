import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import Vec3 from 'vec3';
import * as world from './world.js';
import * as skills from './skills.js';

const require = createRequire(import.meta.url);

// User-supplied schematic library (and where !captureBlueprint saves).
// Keep it at repo root (committed), distinct from bots/UwU/ runtime state.
const SCHEMATIC_DIR = path.resolve('./schematics');

const AIR = new Set(['air', 'cave_air', 'void_air']);

// air can surface as name 'air', an empty name (undefined stateId), or stateId 0.
function isAir(block) {
    return !block || block.stateId === 0 || !block.name || AIR.has(block.name);
}

// Maximum blocks in a single paste — guards against OOM / thousand-command spam
// on a low-RAM box. ~10k blocks is a comfortable house; real castles stay under it.
const MAX_BLOCKS = 10000;

// Y-axis rotation helpers. steps = 0..3 (each = 90 deg clockwise viewed from above).
function rotateRelative(x, z, sx, sz, steps) {
    // rotate a relative (x,z) inside an (sx,sz) footprint, clockwise steps*90.
    switch (steps % 4) {
        case 0: return { x, z };
        case 1: return { x: sz - 1 - z, z: x };
        case 2: return { x: sx - 1 - x, z: sz - 1 - z };
        case 3: return { x: z, z: sx - 1 - x };
    }
}

const H_DIRS = ['north', 'east', 'south', 'west'];
// Facing table vendored from L-C-B/mineflayer-schem (lib/facing.json): which
// blocks mirror their facing when the schematic is rotated 180° ("inverted")
// vs which keep world axes. Builders use it to keep stairs/logs/furnaces
// pointing the right way after a rotation. is3D = block whose shape depends
// on the face placed against (stairs, slabs) — needs face-accurate placement.
const SCHEM_FACING = {
    barrel: { inverted: true, is3D: false },
    chest: { inverted: true, is3D: false },
    trapped_chest: { inverted: true, is3D: false },
    ender_chest: { inverted: true, is3D: false },
    furnace: { inverted: true, is3D: false },
    dispenser: { inverted: true, is3D: true },
    dropper: { inverted: true, is3D: true },
    observer: { inverted: true, is3D: true },
    hopper: { inverted: true, is3D: true },
};
// *-stairs / *-slabs / logs / pillars: never inverted, face-accurate.
function schemFacingEntry(name) {
    if (!name) return null;
    if (SCHEM_FACING[name]) return SCHEM_FACING[name];
    if (name.endsWith('_stairs') || name.endsWith('_slab') || name.endsWith('_log') ||
        name.endsWith('_wood') || name === 'piston' || name === 'sticky_piston')
        return { inverted: false, is3D: true };
    if (name.endsWith('_door') || name.endsWith('_trapdoor') || name.endsWith('_gate') ||
        name.endsWith('_button') || name === 'lever' || name.endsWith('_sign'))
        return { inverted: false, is3D: false };
    return null;
}
// Blocks you must SNEAK to place against (chest, shulker, furnace, ...)
// vendored from mineflayer-schem's lib/interactable.json (136 names, sampled
// here by family — full list lives in the review dir). Placing normally
// against these OPENS them instead of building.
const SNEAK_FAMILIES = ['chest', 'shulker', 'furnace', 'smoker', 'blast_furnace',
    'barrel', 'dispenser', 'dropper', 'hopper', 'brewing_stand', 'beacon',
    'anvil', 'enchanting_table', 'crafting_table', 'stonecutter', 'loom',
    'cartography', 'grindstone', 'smithing_table', 'composter', 'jukebox',
    'note_block', 'bed', 'sign', 'door', 'trapdoor', 'fence_gate', 'button',
    'lever', 'cake', 'cauldron', 'comparator', 'repeater', 'daylight_detector',
    'lectern', 'bell', 'tinted_glass'];
export function needsSneakToPlaceAgainst(blockName) {
    const n = String(blockName || '').toLowerCase();
    return SNEAK_FAMILIES.some(f => n.includes(f));
}
// Rotate a block-state `props` object with the schematic. `facing` (a horizontal
// direction) is remapped; everything else (powered, delay, extended, up/down, ...)
// is invariant under a Y rotation. + axis remap for logs/pillars (x<->z on odd
// quarter-turns) and half flip for upside-down stairs on 180° — both from the
// schem review (rotateBlockProperties), without which rotated builds come out
// mirrored/wrong-facing.
function rotateProps(props, steps, blockName = null) {
    if (!steps || !props || typeof props !== 'object') return props || {};
    const out = {};
    const entry = schemFacingEntry(blockName);
    const effSteps = (entry && entry.inverted && steps === 2) ? 0 : steps;
    for (const [k, v] of Object.entries(props)) {
        if (k === 'facing' && H_DIRS.includes(String(v))) {
            out[k] = H_DIRS[(H_DIRS.indexOf(String(v)) + effSteps) % 4];
        } else if (k === 'axis' && (effSteps % 2 === 1) && (v === 'x' || v === 'z')) {
            out[k] = v === 'x' ? 'z' : 'x'; // logs/pillars swap axis on 90°/270°
        } else if (k === 'half' && effSteps === 2 && (v === 'top' || v === 'bottom')) {
            out[k] = v === 'top' ? 'bottom' : 'top'; // upside-down stairs flip on 180°
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Normalize any schematic (our .json capture, a .schem, or a .schematic) into:
 *   { size: {x,y,z}, blocks: [{x,y,z,name,props}] }
 * where x/y/z are relative to the schematic's min corner.
 */
export async function loadSchematic(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
        const obj = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!obj || !obj.size || !Array.isArray(obj.blocks)) throw new Error('Invalid schematic JSON.');
        return obj;
    }

    const buf = readFileSync(filePath);
    if (ext === '.litematic') {
        return loadLitematic(buf);
    }
    if (ext === '.schem' || ext === '.schematic') {
        const { Schematic } = require('prismarine-schematic');
        // pass '26.2' so it maps names->stateIds with the fork's bundled data
        const sch = await Schematic.read(buf, '26.2');
        const blocks = [];
        await sch.forEach((block, pos) => {
            if (isAir(block)) return;
            const rel = pos.minus(sch.offset).floor();
            blocks.push({
                x: rel.x, y: rel.y, z: rel.z,
                name: block.name,
                props: block.getProperties ? block.getProperties() : {},
            });
        });
        return { size: { x: sch.size.x, y: sch.size.y, z: sch.size.z }, blocks };
    }

    throw new Error(`Unsupported schematic format '${ext}' (use .json, .schem, .schematic or .litematic).`);
}

/**
 * Read a Litematica .litematic file (plain NBT, gzip-compressed).
 * NOTE: prismarine-nbt 2.8.0 cannot round-trip list-of-compound (its writer
 * emits a broken container layout: "Unexpected EOF ... still have N bytes"),
 * so this uses a small self-contained NBT reader for exactly the tags
 * Litematica files contain (compound/list/string/int/long/longArray), with
 * longs kept as BigInt so BlockStates bit-unpacking is exact. No new dep.
 * Layout: root compound { Regions: { <name>: { Size, BlockStatePalette[],
 * BlockStates[] (long array, bit-packed palette indices) } }, Metadata }.
 * Takes the FIRST region (multi-region files are rare; extend with Per-region
 * Position offsets here if one ever shows up).
 * Palette entries are { Name: 'minecraft:oak_log', Properties: { axis: 'y' } }.
 * Returns our normalized { size, blocks } with min corner at 0,0,0.
 */
export async function loadLitematic(buf) {
    let raw = buf;
    try {
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            const zlib = await import('zlib');
            raw = zlib.gunzipSync(buf);
        }
    } catch (e) { throw new Error(`litematic gunzip failed: ${e.message}`); }
    let root;
    try {
        root = readNbtRoot(raw);
    } catch (e) { throw new Error(`litematic NBT parse failed: ${e.message}`); }
    const regions = root && root.Regions;
    if (!regions || typeof regions !== 'object') throw new Error('litematic has no Regions compound.');
    const firstName = Object.keys(regions)[0];
    if (!firstName) throw new Error('litematic Regions compound is empty.');
    const region = regions[firstName];
    const size = region.Size || region.size;
    const sz3 = (o) => o && (o.x !== undefined ? { x: o.x, y: o.y, z: o.z } : o.value ? sz3(o.value) : o);
    const sN = sz3(size) || {};
    const sx = Math.abs(sN.x | 0), sy = Math.abs(sN.y | 0), sz = Math.abs(sN.z | 0);
    if (!sx || !sy || !sz) throw new Error('litematic region has no usable Size.');
    const palette = region.BlockStatePalette || region.blockStatePalette || [];
    const states = region.BlockStates || region.blockStates || [];
    const volume = sx * sy * sz;
    if (!palette.length) throw new Error('litematic region has an empty BlockStatePalette.');
    if (!states.length) throw new Error('litematic region has no BlockStates array.');
    // Bits per entry: smallest b such that palette fits; vanilla pads to >= 2... Actually
    // Litematica uses max(2, ceil(log2(palette.length))) bits per block.
    const bpe = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const perLong = Math.floor(64 / bpe);
    const mask = (1n << BigInt(bpe)) - 1n;
    const blocks = [];
    const idx = (x, y, z) => {
        const i = (y * sz + z) * sx + x; // Litematica order: (y*sz+z)*sx+x
        const li = Math.floor(i / perLong);
        const bit = BigInt((i % perLong) * bpe);
        if (li >= states.length) return 0;
        return Number((states[li] >> bit) & mask);
    };
    for (let y = 0; y < sy; y++)
        for (let z = 0; z < sz; z++)
            for (let x = 0; x < sx; x++) {
                const pi = idx(x, y, z);
                const entry = palette[pi];
                if (!entry) continue;
                const full = typeof entry === 'string' ? entry : entry.Name;
                if (!full || full === 'minecraft:air' || full === 'minecraft:cave_air') continue;
                const name = String(full).replace(/^minecraft:/, '');
                const props = (entry && entry.Properties) || {};
                blocks.push({ x, y, z, name, props });
            }
    if (!blocks.length) throw new Error('litematic region is all air.');
    return { size: { x: sx, y: sy, z: sz }, blocks };
}

// Minimal big-endian NBT reader — just enough for Litematica files:
// compound, list, string, int, long, longArray (+ skips byte/short/float/
// double/byteArray/intArray). Longs come back as BigInt (exact). Written
// because prismarine-nbt 2.8.0's list-of-compound container layout does not
// round-trip (verified: writer emits 29 bytes the reader rejects with
// "Unexpected EOF ... still have 15 bytes"). ~70 lines, no dependency.
function readNbtRoot(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let off = 0;
    const u8 = () => b[off++];
    const i16 = () => { const v = b.readInt16BE(off); off += 2; return v; };
    const i32 = () => { const v = b.readInt32BE(off); off += 4; return v; };
    const i64 = () => { const v = b.readBigInt64BE(off); off += 8; return v; };
    const str = () => { const n = b.readUInt16BE(off); off += 2; const s = b.toString('utf8', off, off + n); off += n; return s; };
    function payload(type) {
        switch (type) {
            case 1: return u8();
            case 2: { const v = b.readInt16BE(off); off += 2; return v; }
            case 3: return i32();
            case 4: return i64();
            case 5: { const v = b.readFloatBE(off); off += 4; return v; }
            case 6: { const v = b.readDoubleBE(off); off += 8; return v; }
            case 7: { const n = i32(); const v = b.subarray(off, off + n); off += n; return v; }
            case 8: return str();
            case 9: {
                const et = u8(), n = i32(), arr = [];
                for (let i = 0; i < n; i++) arr.push(payload(et));
                return arr;
            }
            case 10: {
                const o = {};
                for (;;) { const t = u8(); if (t === 0) break; o[str()] = payload(t); }
                return o;
            }
            case 11: { const n = i32(), arr = []; for (let i = 0; i < n; i++) arr.push(i32()); return arr; }
            case 12: { const n = i32(), arr = []; for (let i = 0; i < n; i++) arr.push(i64()); return arr; }
            default: throw new Error(`unsupported NBT tag ${type} at offset ${off - 1}`);
        }
    }
    const rootType = u8();
    if (rootType !== 10) throw new Error(`NBT root is tag ${rootType}, not compound(10).`);
    str(); // root name (usually empty)
    return payload(10);
}

/**
 * Snapshot a world region into our .json schematic format. The two points are
 * opposite corners (inclusive). Only loaded chunks are read — capture near the bot.
 */
export async function captureRegion(bot, p1, p2) {
    const minX = Math.floor(Math.min(p1.x, p2.x)), maxX = Math.floor(Math.max(p1.x, p2.x));
    const minY = Math.floor(Math.min(p1.y, p2.y)), maxY = Math.floor(Math.max(p1.y, p2.y));
    const minZ = Math.floor(Math.min(p1.z, p2.z)), maxZ = Math.floor(Math.max(p1.z, p2.z));
    const sx = maxX - minX + 1, sy = maxY - minY + 1, sz = maxZ - minZ + 1;
    if (sx * sy * sz > 200000) throw new Error('Region too large (max ~200k cells).');
    await bot.waitForChunksToLoad();

    const blocks = [];
    let unloaded = 0;
    for (let y = minY; y <= maxY; y++)
        for (let z = minZ; z <= maxZ; z++)
            for (let x = minX; x <= maxX; x++) {
                const block = bot.blockAt(new Vec3(x, y, z));
                if (!block) { unloaded++; continue; }
                if (isAir(block)) continue;
                blocks.push({
                    x: x - minX, y: y - minY, z: z - minZ,
                    name: block.name,
                    props: block.getProperties ? block.getProperties() : {},
                });
            }

    return {
        name: 'captured',
        size: { x: sx, y: sy, z: sz },
        origin: { x: minX, y: minY, z: minZ },
        blocks,
        unloaded,
    };
}

/**
 * Place a schematic with its min corner at `origin`, optionally rotated.
 * Builds like a real player: gathers/crafts every material first (acquireBlocks),
 * then places each block one at a time by hand (placeBlock, no /setblock cheat).
 * Block-state orientation (stairs facing, log axis, ...) is dropped — blocks place
 * in their default orientation, same as a player who isn't being fussy.
 * Returns the number of blocks actually placed.
 */
export async function placeSchematic(bot, schematic, origin, rotationDeg = 0, jobName = 'schematic') {
    const steps = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
    const { x: sx, z: sz } = schematic.size;
    if (schematic.blocks.length > MAX_BLOCKS) {
        throw new Error(`Schematic has ${schematic.blocks.length} blocks (cap ${MAX_BLOCKS}). Split it or use a smaller one.`);
    }

    // schem-style build state: pause/resume/cancel + live progress. !stop sets
    // bot.interrupt_code (hard abort); bot._buildPause parks the loop mid-build
    // so she can answer something and continue; bot._buildCancel aborts cleanly
    // without killing the whole action queue. !buildStatus reads bot._buildJob.
    bot._buildJob = { name: schematic.name || jobName, total: schematic.blocks.length, placed: 0, failed: 0, done: false, paused: false };
    bot._buildPause = false;
    bot._buildCancel = false;
    const buildTick = () => {
        bot._buildJob.paused = !!bot._buildPause;
        if (bot.interrupt_code || bot._buildCancel) return 'abort';
        return bot._buildPause ? 'wait' : 'go';
    };
    const buildWait = async () => {
        while (bot._buildPause && !bot.interrupt_code && !bot._buildCancel) {
            await new Promise(r => setTimeout(r, 500));
        }
    };

    const rotated = schematic.blocks.map((b) => {
        const { x, z } = rotateRelative(b.x, b.z, sx, sz, steps);
        return { x, y: b.y, z, name: b.name, props: rotateProps(b.props || {}, steps, b.name) };
    });

    // A stateful schematic (redstone/mechanisms — any block carrying props) is placed
    // precisely with /setblock so facing/power survive. Gathering materials is pointless
    // for those and would just fail on hard-to-craft parts. Decorative schematics keep
    // the gather-then-place-by-hand path below.
    const stateful = schematic.instant === true || rotated.some((b) => b.props && Object.keys(b.props).length > 0);
    if (stateful) {
        rotated.sort((a, b) => a.y - b.y);
        let placed = 0;
        for (const b of rotated) {
            if (buildTick() === 'abort') break;
            if (buildTick() === 'wait') await buildWait();
            if (buildTick() === 'abort') break;
            const wx = Math.floor(origin.x) + b.x;
            const wy = Math.floor(origin.y) + b.y;
            const wz = Math.floor(origin.z) + b.z;
            if (await skills.placeBlockState(bot, b.name, b.props, wx, wy, wz)) placed++;
            bot._buildJob.placed = placed;
        }
        bot._buildJob.done = true;
        bot._buildJob.failed = rotated.length - placed;
        return placed;
    }

    // Gather + craft materials for every block type before placing anything.
    const byName = {};
    for (const b of rotated) (byName[b.name] ||= []).push(b);
    for (const [name, list] of Object.entries(byName)) {
        if (buildTick() === 'abort') break;
        if (buildTick() === 'wait') await buildWait();
        if (buildTick() === 'abort') break;
        const have = await skills.acquireBlocks(bot, name, list.length);
        if (have < list.length) {
            skills.log(bot, `Only gathered ${have}/${list.length} ${name} — building with what I have.`);
        }
    }

    // Bottom-up so lower layers are placed first; edge blocks before interior so
    // ceiling blocks always have a neighbour to build off of.
    const minX = Math.min(...rotated.map(b => b.x)), maxX = Math.max(...rotated.map(b => b.x));
    const minZ = Math.min(...rotated.map(b => b.z)), maxZ = Math.max(...rotated.map(b => b.z));
    const edgeDist = (b) => Math.min(b.x - minX, maxX - b.x, b.z - minZ, maxZ - b.z);
    rotated.sort((a, b) => a.y - b.y || edgeDist(a) - edgeDist(b));

    let placed = 0;
    const failed = [];
    for (const b of rotated) {
        if (buildTick() === 'abort') break;
        if (buildTick() === 'wait') await buildWait();
        if (buildTick() === 'abort') break;
        const wx = Math.floor(origin.x) + b.x;
        const wy = Math.floor(origin.y) + b.y;
        const wz = Math.floor(origin.z) + b.z;
        // Retry pass (schem review: single-attempt placement is the #1 cause of
        // holey builds — a miss because she was still walking is permanent).
        // Two tries with a short settle between; still-failing blocks go on the
        // failed list for the re-visit sweep below.
        let ok = await skills.placeBlock(bot, b.name, wx, wy, wz, 'bottom', true);
        if (!ok && !bot.interrupt_code) {
            await new Promise(r => setTimeout(r, 400));
            ok = await skills.placeBlock(bot, b.name, wx, wy, wz, 'bottom', true);
        }
        if (ok) { placed++; bot._buildJob.placed = placed; }
        else failed.push(b);
    }
    // Re-visit sweep: walk back over misses now that neighbours exist (many
    // "nothing to place on" failures succeed once adjacent blocks are in).
    if (failed.length && buildTick() !== 'abort') {
        skills.log(bot, `Re-visiting ${failed.length} missed blocks...`);
        for (const b of failed) {
            if (buildTick() === 'abort') break;
            if (buildTick() === 'wait') await buildWait();
            if (buildTick() === 'abort') break;
            const wx = Math.floor(origin.x) + b.x;
            const wy = Math.floor(origin.y) + b.y;
            const wz = Math.floor(origin.z) + b.z;
            if (await skills.placeBlock(bot, b.name, wx, wy, wz, 'bottom', true)) { placed++; bot._buildJob.placed = placed; }
        }
    }
    bot._buildJob.done = true;
    bot._buildJob.failed = rotated.length - placed;
    return placed;
}

// !buildStatus / !pauseBuild / !resumeBuild / !cancelBuild back this state.
export function buildStatus(bot) {
    const j = bot._buildJob;
    if (!j) return null;
    return { name: j.name, placed: j.placed, failed: j.failed, total: j.total, done: !!j.done, paused: !!bot._buildPause };
}
export function pauseBuild(bot) { bot._buildPause = true; }
export function resumeBuild(bot) { bot._buildPause = false; }
export function cancelBuild(bot) { bot._buildCancel = true; bot._buildPause = false; }

/**
 * Verify a schematic was placed: sample the bottom layer and count how many
 * cells now hold the expected block. Returns { ok, checked } so the caller can
 * report self-verification (Blueprint.check-style) without trusting the paste blindly.
 */
export async function verifySchematic(bot, schematic, origin, rotationDeg = 0) {
    const steps = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
    const { x: sx, z: sz } = schematic.size;
    const bottom = schematic.blocks.filter((b) => b.y === 0);
    const sampled = bottom.length <= 40 ? bottom : bottom.filter((_, i) => i % Math.ceil(bottom.length / 40) === 0);
    let ok = 0;
    for (const b of sampled) {
        const { x, z } = rotateRelative(b.x, b.z, sx, sz, steps);
        const blk = bot.blockAt(new Vec3(Math.floor(origin.x) + x, Math.floor(origin.y) + b.y, Math.floor(origin.z) + z));
        if (blk && blk.name === b.name) ok++;
    }
    return { ok, checked: sampled.length };
}

export function schematicPath(name) {
    if (/\.(json|schem|schematic|nbt)$/i.test(name)) return path.join(SCHEMATIC_DIR, name);
    return path.join(SCHEMATIC_DIR, name + '.json');
}

export function saveSchematic(name, schematic) {
    mkdirSync(SCHEMATIC_DIR, { recursive: true });
    writeFileSync(schematicPath(name), JSON.stringify(schematic, null, 2));
}

export function listSchematics() {
    if (!existsSync(SCHEMATIC_DIR)) return [];
    return readdirSync(SCHEMATIC_DIR).filter((f) => /\.(json|schem|schematic|litematic|nbt)$/i.test(f)).sort();
}

// Download a schematic file from a direct URL (GitHub raw, or any .schem/
// .schematic/.litematic/.json link), save it into schematics/, and hand back
// { name, ext, bytes }. Load it with loadSchematic afterwards: Sponge/MCEdit
// (.schem/.schematic), Litematica (.litematic, first region), and our .json.
export async function downloadSchematic(url, name) {
    const cleanPath = url.split(/[?#]/)[0];
    const m = cleanPath.match(/\.(schematic|schem|litematic|json)$/i);
    if (!m) throw new Error('That URL does not end in .schem, .schematic, .litematic or .json (direct link required).');
    const ext = '.' + m[1].toLowerCase();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let buf;
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
    if (!buf || buf.length === 0) throw new Error('downloaded an empty file.');

    const filename = name ? `${name}${ext}` : (cleanPath.split('/').pop() || 'download') ;
    mkdirSync(SCHEMATIC_DIR, { recursive: true });
    writeFileSync(path.join(SCHEMATIC_DIR, filename), buf);
    return { name: filename, ext, bytes: buf.length };
}

// Default paste origin: nearest free space with solid ground under it, else the bot's feet.
export function findFreeSpace(bot, schematic) {
    const footprint = Math.max(schematic.size.x, schematic.size.z) + 1;
    const free = world.getNearestFreeSpace(bot, footprint, 32);
    if (free) return { x: free.x, y: free.y, z: free.z };
    const p = bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}


