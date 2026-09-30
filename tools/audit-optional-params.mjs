// Verify commands whose optional params use `default: null`. The audit harness
// serialized null literally, which is not how a real invocation looks: a caller
// either omits the trailing args or supplies real numbers.
const idx = await import('../src/agent/commands/index.js');

const cases = [
    ['!pasteSchematic("cozy_house")', 5],
    ['!pasteSchematic("cozy_house", 10, 64, -20, 90)', 5],
    ['!planBuild("cozy_house")', 2],
    ['!planBuild("oak_planks", 32)', 2],
    ['!teleportMe()', 3],
    ['!teleportMe(10, 64, -20)', 3],
    ['!summon("cow")', 3],
    ['!summon("cow", 2)', 3],
    ['!summon("wither", 1, "boss-ok")', 3],
];

let bad = 0;
for (const [msg, want] of cases) {
    const parsed = idx.parseCommandMessage(msg);
    if (typeof parsed === 'string') { console.log(`  REJECT ${msg} -> ${parsed}`); bad++; continue; }
    const got = parsed.args ? parsed.args.length : 0;
    const vals = (parsed.args || []).map(a => JSON.stringify(a)).join(',');
    if (got !== want) { console.log(`  ARGC ${msg}: got ${got} want ${want}`); bad++; continue; }
    console.log(`  ok   ${msg}  -> [${vals}]`);
}
console.log(bad ? `\nfailures: ${bad}` : '\nall default:null commands parse correctly');
