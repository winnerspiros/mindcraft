import { classifyAct, InteractionTracker, RELATION } from '../../src/utils/interaction.js';

const her = [10, 64, 10];
const show = (label, act) => {
    const r = classifyAct(act);
    console.log(`  ${label.padEnd(42)} ${r.relation.padEnd(9)} v=${String(r.valence).padStart(2)}  ${r.why}`);
};

console.log('classifyAct — the owner\'s list, all interactions:');
show('help them build (placed block, her area)', { blockPos: [14, 64, 10], herPos: her, blockRemoved: false });
show('grief them (broke HER block)', { blockPos: [12, 64, 12], herPos: her, herWorkPos: [12, 64, 12], was_her_block: true, blockRemoved: true });
show('destroy what they are doing (at her feet)', { blockPos: [11, 64, 11], herPos: her, blockRemoved: true });
show('give them items', { herPos: her, gave_her_item: true });
show('fuck them up (hit her)', { herPos: her, hit_her: true });
show('took from her inventory', { herPos: her, took_her_item: true });
show('ordinary mining, unrelated', { blockPos: [40, 64, 40], herPos: her, blockRemoved: true });
show('no position data', { blockRemoved: true });
show('an act 30s old', { blockPos: [11, 64, 11], herPos: her, blockRemoved: true, at: Date.now() - 30000 });

console.log('\nInteractionTracker flags:');
const cases = [
    ['griefed her block', { blockPos: [12, 64, 12], herPos: her, herWorkPos: [12, 64, 12], was_her_block: true, blockRemoved: true }],
    ['given an item', { herPos: her, gave_her_item: true }],
    ['hit her', { herPos: her, hit_her: true }],
    ['working beside her', { blockPos: [15, 64, 10], herPos: her, blockRemoved: false }],
];
for (const [label, act] of cases) {
    const t = new InteractionTracker();
    t.note(act);
    const f = t.flags();
    console.log(`  ${label.padEnd(24)} interfering=${String(f.interfering).padEnd(5)} helping=${String(f.helping).padEnd(5)} coordinating=${f.coordinating}`);
}
console.log(`  ${'nothing at all'.padEnd(24)} ${JSON.stringify(new InteractionTracker().flags())}`);
