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
// Rotate a block-state `props` object with the schematic. `facing` (a horizontal
// direction) is remapped; everything else (powered, delay, extended, up/down, ...)
// is invariant under a Y rotation.
function rotateProps(props, steps) {
    if (!steps || !props || typeof props !== 'object') return props || {};
    const out = {};
    for (const [k, v] of Object.entries(props)) {
        if (k === 'facing' && H_DIRS.includes(String(v))) {
            out[k] = H_DIRS[(H_DIRS.indexOf(String(v)) + steps) % 4];
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

    throw new Error(`Unsupported schematic format '${ext}' (use .json, .schem or .schematic).`);
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
export async function placeSchematic(bot, schematic, origin, rotationDeg = 0) {
    const steps = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
    const { x: sx, z: sz } = schematic.size;
    if (schematic.blocks.length > MAX_BLOCKS) {
        throw new Error(`Schematic has ${schematic.blocks.length} blocks (cap ${MAX_BLOCKS}). Split it or use a smaller one.`);
    }

    const rotated = schematic.blocks.map((b) => {
        const { x, z } = rotateRelative(b.x, b.z, sx, sz, steps);
        return { x, y: b.y, z, name: b.name, props: rotateProps(b.props || {}, steps) };
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
            if (bot.interrupt_code) break;
            const wx = Math.floor(origin.x) + b.x;
            const wy = Math.floor(origin.y) + b.y;
            const wz = Math.floor(origin.z) + b.z;
            if (await skills.placeBlockState(bot, b.name, b.props, wx, wy, wz)) placed++;
        }
        return placed;
    }

    // Gather + craft materials for every block type before placing anything.
    const byName = {};
    for (const b of rotated) (byName[b.name] ||= []).push(b);
    for (const [name, list] of Object.entries(byName)) {
        if (bot.interrupt_code) break;
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
    for (const b of rotated) {
        if (bot.interrupt_code) break;
        const wx = Math.floor(origin.x) + b.x;
        const wy = Math.floor(origin.y) + b.y;
        const wz = Math.floor(origin.z) + b.z;
        if (await skills.placeBlock(bot, b.name, wx, wy, wz, 'bottom', true)) placed++;
    }
    return placed;
}

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
    return readdirSync(SCHEMATIC_DIR).filter((f) => /\.(json|schem|schematic|nbt)$/i.test(f)).sort();
}

// Default paste origin: nearest free space with solid ground under it, else the bot's feet.
export function findFreeSpace(bot, schematic) {
    const footprint = Math.max(schematic.size.x, schematic.size.z) + 1;
    const free = world.getNearestFreeSpace(bot, footprint, 32);
    if (free) return { x: free.x, y: free.y, z: free.z };
    const p = bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}


