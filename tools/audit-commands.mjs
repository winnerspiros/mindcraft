import { promises as fsp } from 'node:fs';

// A command is only real if it is in the exported array AND every command in
// that array is a well-formed object with a perform function. A malformed
// entry throws at boot or silently never runs, which is how "I typed it and
// nothing happened" bugs start.
const t = await fsp.readFile('./src/agent/commands/actions.js', 'utf8');

const names = [...t.matchAll(/name:\s*'!([a-zA-Z_][\w]*)'/g)].map(m => m[1]);
console.log('commands defined:', names.length);

// duplicates would silently shadow each other
const seen = new Map();
const dupes = [];
for (const n of names) {
    if (seen.has(n)) dupes.push(n);
    seen.set(n, (seen.get(n) || 0) + 1);
}
console.log('duplicate command names:', dupes.length, dupes.join(', ') || '(none)');

// each entry should have a description and a perform
const blocks = t.split(/\n\s*\{\n/).slice(1);
let noDesc = 0, noPerform = 0;
for (const b of blocks) {
    const nm = (b.match(/name:\s*'!([a-zA-Z_][\w]*)/) || [])[1];
    if (!nm) continue;
    if (!/description:/.test(b)) { console.log('  no description:', nm); noDesc++; }
    if (!/perform:/.test(b)) { console.log('  no perform:', nm); noPerform++; }
}
console.log(`missing description: ${noDesc}, missing perform: ${noPerform}`);
