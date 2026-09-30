import { promises as fsp } from 'node:fs';

const files = {
    skills:   './src/agent/library/skills.js',
    world:    './src/agent/library/world.js',
    mc:       './src/utils/mcdata.js',
    K:        './src/utils/mcknowledge.js',
    L:        './src/agent/library/furnace_ledger.js',
    pathfinder: './src/agent/library/pathfinder.js',
};
const exportsOf = {};
for (const [k, f] of Object.entries(files)) {
    const s = new Set();
    try {
        const t = await fsp.readFile(f, 'utf8');
        for (const m of t.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) s.add(m[1]);
        for (const m of t.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) s.add(m[1]);
        for (const m of t.matchAll(/export\s*\{([^}]*)\}/g))
            for (const p of m[1].split(',')) {
                const n = p.trim().split(/\s+as\s+/).pop().trim();
                if (n) s.add(n);
            }
        exportsOf[k] = s;
    } catch (e) { exportsOf[k] = new Set(); console.log('READ FAIL', f, e.message); }
}
// NOTE: Array.prototype.flat does NOT flatten Sets. Build the union explicitly.
const all = new Set();
for (const s of Object.values(exportsOf)) for (const n of s) all.add(n);
console.log('exports:', Object.entries(exportsOf).map(([k, s]) => `${k}=${s.size}`).join(' '));
console.log('craftRecipe in set?', all.has('craftRecipe'), '| smeltItem?', all.has('smeltItem'));

const src = await fsp.readFile('./src/agent/commands/actions.js', 'utf8');
const ids = ['skills', 'world', 'mc', 'K', 'L', 'pathfinder', 'mcknowledge', 'mc_knowledge'];
const missing = new Map();
for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, obj, fn] = m;
    if (!ids.includes(obj)) continue;
    if (!all.has(fn) && !missing.has(fn)) missing.set(fn, obj);
}
console.log('DANGLING:', missing.size);
for (const [fn] of missing) console.log('  ' + fn);
