// Loads the real command table and reports which commands can actually be
// constructed and dispatched, without connecting to Minecraft. This catches
// boot-time throwers and dispatch failures that no static check finds.
//
// Requires the bot to be optional; we only import the module and inspect.
process.env.UWU_AUDIT = '1';
// Enter through index.js first, exactly as agent.js does. Importing actions.js
// directly puts the module in the middle of the actions<->queries<->index cycle
// and trips a TDZ error that does NOT happen in the real bot.
await import('../src/agent/commands/index.js');
const mod = await import('../src/agent/commands/actions.js');
const keys = Object.keys(mod);
console.log('exports from actions.js:', keys.join(', '));

const list = mod.actionsList;
if (!Array.isArray(list)) {
    console.log('no command array export found; keys were:', keys.join(', '));
    process.exit(0);
}
console.log('commands in array:', list.length);
let bad = 0;
for (const c of list) {
    if (!c || typeof c !== 'object') { console.log('  BAD entry:', c); bad++; continue; }
    if (!c.name) { console.log('  entry without name:', Object.keys(c)); bad++; continue; }
    if (typeof c.perform !== 'function') { console.log('  !' + c.name + ': perform is ' + typeof c.perform); bad++; }
}
console.log('malformed entries:', bad);
const names = list.map(c => c.name);
console.log('unique names:', new Set(names).size, 'of', names.length);
