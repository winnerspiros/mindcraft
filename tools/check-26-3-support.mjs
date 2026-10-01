// Fails LOUDLY if 26.3 support is missing, so a broken install can never
// silently reach the running service again.
//
// The failure was invisible twice: she crash-looped with "unsupported
// protocol version: 26.3", and (after a partial hand-fix) she CONNECTED
// while logging hundreds of "Bits per block is too big" per minute with
// corrupted world data. Neither looked like a missing patch on inspection.
//
// Run: node tools/check-26-3-support.mjs   (exit 0 = healthy, 1 = broken)
// Wired into `npm test`, so `hermes verify --phase test` catches it too.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// createRequire explicitly: a bare `require(...)` is undefined in an ESM
// module under node (bun tolerates it) and `npm test` runs with node, so the
// bare form threw "cannot resolve" on a perfectly healthy tree.
const { createRequire } = await import('node:module');

const NESTED = path.join(ROOT, 'node_modules/minecraft-protocol/node_modules/minecraft-data');
const rel = (p) => path.relative(ROOT, p);

const fail = (msg, detail) => {
    console.error(`\nFAIL: ${msg}`);
    if (detail) console.error(detail);
    console.error('\nFix: python3 fix-26.2-protocol.py  (npm run reinstall runs it via postinstall)\n');
    process.exit(1);
};

// --- 1. the minecraft-data that minecraft-protocol resolves must know 26.3 --
// Resolved the way minecraft-protocol itself would, so a nested older copy
// correctly shadows the top-level one and we notice.
const resolved = (() => {
    try {
        return createRequire(path.join(ROOT, 'node_modules/minecraft-protocol/index.js')).resolve('minecraft-data');
    } catch { return null; }
})();

if (!resolved) fail('cannot resolve minecraft-data from minecraft-protocol');

let knows263 = false;
try {
    knows263 = !!createRequire(resolved)('minecraft-data')('26.3');
} catch (e) {
    // Name the shadowing explicitly: the raw error here is a bare
    // "Cannot find module ./minecraft-data/data/pc/26.3/blocks.json", which
    // says nothing about the cause.
    fail(existsSync(NESTED)
        ? `minecraft-data resolves to the NESTED copy, which lacks 26.3\n` +
          `   nested: ${rel(NESTED)}\n   resolving: ${rel(resolved)}\n` +
          `   A plain \`bun install\` nests an older minecraft-data here that\n` +
          `   shadows the one carrying the generated 26.3 data.`
        : `could not load minecraft-data at ${rel(resolved)}`,
        e.message);
}
if (!knows263) fail(`minecraft-data at ${rel(resolved)} cannot resolve 26.3`);

// --- 2. a nested copy that exists must itself carry 26.3 -------------------
// Half-installed state: the nested copy is present but has no 26.3 data, and
// it shadows the healthy top-level one.
//
// A nested copy that is entirely ABSENT is NOT a fault - verified by removing
// it and booting: resolution falls back to the top-level copy and she spawns
// with zero world-data errors.
if (existsSync(NESTED) && !existsSync(path.join(NESTED, 'minecraft-data/data/pc/26.3'))) {
    fail(`the NESTED minecraft-data exists but has no 26.3 data directory\n   at ${rel(NESTED)}`);
}

// --- 3. prismarine-chunk must map 26.3 AND read its section header ---------
// Both are required. The mapping alone connects her but decodes every chunk at
// the wrong palette offset; hasFluidCount alone leaves pc['26.3'] undefined and
// she crash-loops. Only the pair works.
const chunk = {
    impl: path.join(ROOT, 'node_modules/prismarine-chunk/src/index.js'),
    column: path.join(ROOT, 'node_modules/prismarine-chunk/src/pc/1.18/ChunkColumn.js'),
};
if (!/26\.3\s*:/.test(readFileSync(chunk.impl, 'utf8'))) {
    fail('prismarine-chunk has no 26.3 implementation mapping',
        "Needs: 26.3: require('./pc/1.18/chunk')");
}
if (!/'26\.3'/.test(readFileSync(chunk.column, 'utf8'))) {
    fail('ChunkColumn.js does not handle 26.3',
        'hasFluidCount must include "26.3". Without it she connects but logs\n' +
        '"Bits per block is too big" continuously and her inventory reads back empty.');
}

console.log('OK — 26.3 support intact (protocol data, chunk mapping, section header)');
console.log(`   minecraft-data: ${rel(resolved)}`);