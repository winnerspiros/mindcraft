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
// Facing north -> east -> south -> west matches the coordinate rotation below.
const FACING_CW = ['north', 'east', 'south', 'west'];

function rotateProps(props, steps) {
    if (!props || steps === 0) return props || {};
    const p = { ...props };
    if (typeof p.facing === 'string' && FACING_CW.includes(p.facing)) {
        p.facing = FACING_CW[(FACING_CW.indexOf(p.facing) + steps) % 4];
    }
    if (typeof p.axis === 'string' && (p.axis === 'x' || p.axis === 'z') && steps % 2 === 1) {
        p.axis = p.axis === 'x' ? 'z' : 'x';
    }
    if (p.rotation !== undefined) {
        const r = parseInt(p.rotation, 10);
        if (!isNaN(r)) p.rotation = String((r + steps * 4) % 16);
    }
    return p;
}

function rotateRelative(x, z, sx, sz, steps) {
    // rotate a relative (x,z) inside an (sx,sz) footprint, clockwise steps*90.
    switch (steps % 4) {
        case 0: return { x, z };
        case 1: return { x: sz - 1 - z, z: x };
        case 2: return { x: sx - 1 - x, z: sz - 1 - z };
        case 3: return { x: z, z: sx - 1 - x };
    }
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
 * Cheat mode (OP) emits /setblock per block (instant, any distance); otherwise
 * falls back to survival placement via skills.placeBlock (loses block-state props).
 * Returns the number of blocks placed.
 */
export async function placeSchematic(bot, schematic, origin, rotationDeg = 0, dontCheat = false) {
    const steps = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
    const { x: sx, y: sy, z: sz } = schematic.size;
    if (schematic.blocks.length > MAX_BLOCKS) {
        throw new Error(`Schematic has ${schematic.blocks.length} blocks (cap ${MAX_BLOCKS}). Split it or use a smaller one.`);
    }

    const rotated = schematic.blocks.map((b) => {
        const { x, z } = rotateRelative(b.x, b.z, sx, sz, steps);
        return { ...b, x, z, props: rotateProps(b.props, steps) };
    });
    // bottom-up so the lower layers are set first (matters for the survival path)
    rotated.sort((a, b) => a.y - b.y);

    const cheat = !dontCheat && bot.modes && bot.modes.isOn && bot.modes.isOn('cheat');
    let placed = 0;
    for (const b of rotated) {
        if (bot.interrupt_code) break;
        const wx = Math.floor(origin.x) + b.x;
        const wy = Math.floor(origin.y) + b.y;
        const wz = Math.floor(origin.z) + b.z;
        if (cheat) {
            const state = Object.entries(b.props || {})
                .map(([k, v]) => `${k}="${v}"`).join(',');
            bot.chat(`/setblock ${wx} ${wy} ${wz} ${b.name}${state ? `[${state}]` : ''}`);
            placed++;
        } else {
            // survival: placeBlock handles inventory + support; props are dropped
            const ok = await skills.placeBlock(bot, b.name, wx, wy, wz, 'bottom', true);
            if (ok) placed++;
        }
    }
    return placed;
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


