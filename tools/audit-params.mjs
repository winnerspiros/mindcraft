import { promises as fsp } from 'node:fs';

// The classic "nothing happens" bug is a perform signature that disagrees with
// the declared params: perform(a, b, c) while params only has a, or perform()
// reading params it never declares. Both are invisible to node --check and to a
// dangling-reference scan, and both only fail when a human types the command.
const t = await fsp.readFile('./src/agent/commands/actions.js', 'utf8');

const entries = [];
const re = /name:\s*'!([a-zA-Z_][\w]*)'([\s\S]*?)(?=\n\s{4}\{\n|\n\s*\];)/g;
let m;
while ((m = re.exec(t))) entries.push({ name: m[1], body: m[2] });

console.log('entries parsed:', entries.length);

let mismatch = 0;
for (const e of entries) {
    // declared params
    const pm = e.body.match(/params:\s*\{/);
    const declared = [];
    if (pm) {
        // take the object literal up to its matching close
        let depth = 0, i = e.body.indexOf('params:', pm.index), start = e.body.indexOf('{', i), end = start;
        for (let k = start; k < e.body.length; k++) {
            if (e.body[k] === '{') depth++;
            else if (e.body[k] === '}') { depth--; if (!depth) { end = k; break; } }
        }
        const obj = e.body.slice(start, end + 1);
        for (const q of obj.matchAll(/['"]?([a-zA-Z_][\w]*)['"]?\s*:\s*\{\s*type:/g)) declared.push(q[1]);
    }
    // perform signature
    const sig = e.body.match(/perform:\s*runAsAction\(\s*async\s*\(([^)]*)\)/);
    if (!sig) continue;
    const args = sig[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/[\s=]/)[0]);

    // agent is implicit; every OTHER arg must be a declared param
    for (const a of args.slice(1)) {
        if (!declared.includes(a)) {
            console.log(`  !${e.name}: perform uses '${a}' but params declares [${declared.join(', ') || 'none'}]`);
            mismatch++;
        }
    }
    // declared params the perform never reads are harmless but worth seeing
    const unused = declared.filter(d => !args.includes(d));
    if (unused.length && declared.length) {
        console.log(`  !${e.name}: declared but unused params: ${unused.join(', ')}`);
    }
}
console.log('signature mismatches:', mismatch);
