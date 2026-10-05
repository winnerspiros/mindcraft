// `execute if block ... run data get entity <p> Pos` prints the entity data when
// the test PASSES -- but the entity may be dead/offline at the moment of the
// probe, and RCON then reports nothing even though the test itself succeeded.
// That makes the test result indistinguishable from a failed test, which is
// exactly the "clean number instead of an error" shape again.
//
// Use a command whose SUCCESS is its own output and cannot be confused: a
// scoreboard add. The objective is created once; `run scoreboard players set`
// only happens if the block test passed, and the read-back proves it.
import { rconCommand } from '../src/utils/rcon.js';

const SB = 'probe601';
await rconCommand(`scoreboard objectives add ${SB} dummy`).catch(() => {});

async function isBlock(x, y, z, name) {
    // Set to 1 only if the block matches, then read it back. No ambiguity:
    // a failed test leaves the previous value alone, so we reset first.
    await rconCommand(`scoreboard players set ${SB} ${SB} 0`);
    await rconCommand(
        `execute if block ${x} ${y} ${z} minecraft:${name} run scoreboard players set ${SB} ${SB} 1`).catch(() => {});
    const out = String(await rconCommand(`scoreboard players get ${SB} ${SB}`));
    const m = /has (-?\d+)/.exec(out);
    return !!m && Number(m[1]) === 1;
}

// Calibrate against cells whose content we are certain about before trusting it.
const far_air = [0, 200, 0];        // nothing is ever built at y=200
const STONE = ['deepslate', 'stone', 'andesite', 'dirt', 'grass_block', 'water', 'oak_planks', 'oak_fence', 'cobblestone', 'stone_bricks'];

console.log('calibration:');
console.log('  y=200 must be air, bedrock, or unknown:');
for (const n of ['air', 'bedrock', 'stone', 'dirt']) {
    console.log(`    ${n}: ${await isBlock(far_air[0], far_air[1], far_air[2], n)}`);
}
console.log(`  (expect air=true, and stone/dirt=false -- anything else means this probe is still broken)`);

console.log('\nprobing x=60, y=74..78, z=28..31:');
async function classify(x, y, z) {
    for (const n of ['air', 'cave_air', 'void_air', 'water', 'dirt', 'grass_block', 'oak_planks', 'oak_fence', 'cobblestone', 'stone_bricks', 'oak_log', 'oak_leaves', 'gravel', 'sand', ...STONE]) {
        if (await isBlock(x, y, z, n)) return n;
    }
    return 'UNKNOWN';
}
for (const y of [74, 75, 76, 77, 78]) {
    const row = [];
    for (const z of [28, 29, 30, 31]) row.push(`z${z}=${await classify(60, y, z)}`);
    console.log(`  y=${y}  ${row.join('  ')}`);
}

console.log('\nrow y=76, z=29, across x:');
const across = [];
for (const x of [57, 58, 59, 60, 61, 62, 63]) across.push(`x${x}=${await classify(x, 76, 29)}`);
console.log('  ' + across.join('  '));
