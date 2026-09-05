// Generate UwU's redstone schematics (traps + gates) with correct block states.
// Run: node gen_redstone_schematics.js
// Writes JSON files into ./schematics/ that she can build with !pasteSchematic.
// Only `facing`-style orientation is set explicitly; power/lit/extended auto-resolve
// when the circuit is triggered in-game.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const DIR = path.resolve('./schematics');
mkdirSync(DIR, { recursive: true });

// Build a schematic from a list of [x,y,z,name,props?] entries.
function make(name, size, entries, description) {
    const blocks = entries.map(([x, y, z, n, props]) => ({ x, y, z, name: n, props: props || {} }));
    return { name, description, size, instant: true, blocks };
}

const schematics = [];

// --- 1. tnt_mine: step on the plate -> buried TNT goes off -----------------
schematics.push(make(
    'tnt_mine',
    { x: 3, y: 2, z: 1 },
    [
        [0, 0, 0, 'stone'],
        [1, 0, 0, 'stone'],                    // pedestal under the plate
        [2, 0, 0, 'tnt'],                      // buried payload, adjacent to pedestal
        [1, 1, 0, 'stone_pressure_plate'],     // trigger
    ],
    'A pressure-plate mine: step on the plate and the buried TNT next to it ignites. Bury it under a path and cover the plate to hide it.'
));

// --- 2. arrow_turret: step on the plate -> dispenser fires at you ----------
schematics.push(make(
    'arrow_turret',
    { x: 4, y: 2, z: 1 },
    [
        [0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone'], [3, 0, 0, 'stone'],
        [0, 1, 0, 'stone_pressure_plate'],
        [1, 1, 0, 'redstone_wire'],
        [2, 1, 0, 'redstone_wire'],
        [3, 1, 0, 'dispenser', { facing: 'west' }],   // fires back toward the plate
    ],
    'An arrow turret: step on the plate, the dust fires the dispenser back at you. Fill the dispenser first with !fillDispenser("arrow", 64) (or splash_potion / lava_bucket).'
));

// --- 3. fall_trap: step on the plate -> trapdoor opens, drop into the shaft -
schematics.push(make(
    'fall_trap',
    { x: 4, y: 2, z: 1 },
    [
        [0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [3, 0, 0, 'stone'],
        [0, 1, 0, 'stone_pressure_plate'],
        [1, 1, 0, 'redstone_wire'],
        [2, 1, 0, 'oak_trapdoor', { half: 'bottom', facing: 'south' }],  // over the shaft (air below)
    ],
    'A pitfall: the plate powers the dust, which opens the trapdoor over an empty cell — step on it and you drop through. Paste it over a real drop/lava pit for the full effect.'
));

// --- 4. piston_door: lever toggles a sticky-piston door --------------------
schematics.push(make(
    'piston_door',
    { x: 4, y: 2, z: 1 },
    [
        [0, 0, 0, 'stone'],
        [1, 0, 0, 'sticky_piston', { facing: 'east' }],
        [2, 0, 0, 'stone'],                        // the "door" block the piston pushes
        [3, 0, 0, 'air'],                          // the doorway gap
        [0, 1, 0, 'lever', { face: 'floor' }],
    ],
    'A hidden piston door: flip the lever and the sticky piston pushes the stone block into the gap (closed); flip back and it retracts, opening the way. A 1x1 showcase you can scale up.'
));

// --- 5. or_gate: either lever lights the lamp ------------------------------
{
    const floor = [];
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 2; z++) floor.push([x, 0, z, 'stone']);
    schematics.push(make(
        'or_gate',
        { x: 4, y: 2, z: 3 },
        [
            ...floor,
            [0, 1, 0, 'lever', { face: 'floor' }],   // input A
            [0, 1, 2, 'lever', { face: 'floor' }],   // input B
            [1, 1, 0, 'redstone_wire'], [2, 1, 0, 'redstone_wire'],
            [1, 1, 2, 'redstone_wire'], [2, 1, 2, 'redstone_wire'],
            [2, 1, 1, 'redstone_wire'],              // merge point
            [3, 1, 1, 'redstone_lamp'],              // output
        ],
        'An OR gate: flip EITHER lever and the lamp lights. A teaching build — read it to see how dust merges.'
    ));
}

// --- 6. not_gate: lever on -> torch off (inverter) -------------------------
schematics.push(make(
    'not_gate',
    { x: 2, y: 2, z: 1 },
    [
        [0, 0, 0, 'stone'],
        [1, 0, 0, 'redstone_wall_torch', { facing: 'east' }],  // attached to the stone
        [0, 1, 0, 'lever', { face: 'floor' }],
    ],
    'A NOT gate (inverter): with the lever OFF the torch is lit; flip the lever ON and the torch goes dark. The building block of every logic gate.'
));

for (const s of schematics) {
    const fp = path.join(DIR, s.name + '.json');
    writeFileSync(fp, JSON.stringify(s, null, 2));
    console.log(`wrote ${fp} (${s.blocks.length} blocks, size ${s.size.x}x${s.size.y}x${s.size.z})`);
}
console.log('done.');
