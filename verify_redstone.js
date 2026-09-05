import { loadSchematic } from './src/agent/library/schematic.js';
import * as skills from './src/agent/library/skills.js';
import path from 'path';

// 1) every trap/gate schematic loads + stateful detection works
const names = ['tnt_mine', 'arrow_turret', 'fall_trap', 'piston_door', 'or_gate', 'not_gate'];
for (const n of names) {
    const sch = await loadSchematic(path.resolve('./schematics/' + n + '.json'));
    const stateful = sch.blocks.some(b => b.props && Object.keys(b.props).length > 0);
    const oriented = sch.blocks.filter(b => b.props && b.props.facing).map(b => `${b.name}[facing=${b.props.facing}]`);
    console.log(`${n}: ${sch.blocks.length} blocks, size ${sch.size.x}x${sch.size.y}x${sch.size.z}, stateful=${stateful}`);
    if (oriented.length) console.log(`   oriented: ${oriented.join(', ')}`);
}

// 2) placeBlockState emits correct /setblock
let cmds = [];
const fakeBot = { chat: m => cmds.push(m), interrupt_code: false, output: '' };
await skills.placeBlockState(fakeBot, 'dispenser', { facing: 'west' }, 3, 64, 0);
await skills.placeBlockState(fakeBot, 'repeater', { facing: 'north', delay: 2 }, 1, 64, 0);
await skills.placeBlockState(fakeBot, 'redstone_wire', {}, 1, 65, 0);
console.log('setblock commands:');
cmds.forEach(c => console.log('   ' + c));

// 3) spamBlock finds the nearest block and toggles it N times
let activated = 0;
const fakeBot2 = {
    interrupt_code: false, output: '',
    findBlocks: () => [{ x: 10, y: 64, z: 10 }],
    blockAt: () => ({ name: 'oak_door', position: { x: 10, y: 64, z: 10 } }),
    activateBlock: async () => { activated++; },
};
await skills.spamBlock(fakeBot2, 'oak_door', 3, 1);
console.log('spamBlock activated count:', activated, '(expect 3)');
