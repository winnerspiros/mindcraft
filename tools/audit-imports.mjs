import { promises as fsp } from 'node:fs';
import path from 'node:path';

// Resolve each relative import against the file that contains it, not a fixed
// base directory — earlier passes did this wrong and reported files that do
// exist (reliability.js, psyche.js, mcdata.js -> mcknowledge.js all resolve).
const files = [
    'src/agent/commands/actions.js',
    'src/agent/library/skills.js',
    'src/agent/library/furnace_ledger.js',
    'src/agent/agent.js',
    'src/utils/mcknowledge.js',
    'src/utils/mcdata.js',
    'src/utils/rcon.js',
];
const bad = [];
let checked = 0;
for (const f of files) {
    const t = await fsp.readFile('./' + f, 'utf8');
    const dir = path.dirname('./' + f);
    for (const m of t.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const spec = m[1];
        checked++;
        try { await fsp.access(path.resolve(dir, spec)); }
        catch { bad.push(`${f}  ->  ${spec}`); }
    }
}
console.log(`checked ${checked} relative imports across ${files.length} files`);
console.log(`unresolvable: ${bad.length}`);
bad.forEach(b => console.log('  ' + b));
