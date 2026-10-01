// Fails LOUDLY if 26.3 support is missing, so a broken install can never
// silently reach the running service again.
//
// This exists because the failure was invisible twice: she crash-looped with
// "unsupported protocol version: 26.3", and (after a partial hand-fix) she
// CONNECTED while logging hundreds of "Bits per block is too big" per minute
// with corrupted world data. Neither looked like a missing patch on inspection.
//
// Run: node tools/check-26-3-support.mjs   (exit 0 = healthy, 1 = broken)
// Wire into `npm test` so `hermes verify --phase test` catches it too.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const fail = (msg, detail) => {
    console.error(`\nFAIL: ${msg}`);
    if (detail) console.error(detail);
    console.error('\nFix: python3 fix-26.2-protocol.py   (or: npm run reinstall, which runs it via postinstall)\n');
    process.exit(1);
};

// --- 1. protocol data must resolve 26.3 -----------------------------------
const resolved = (() => {
    try {
        return require('node:module').createRequire(path.join(ROOT, 'node_modules/minecraft-protocol/index.js')).resolve('minecraft-data');
    } catch (e) { return null; }
})();

if (!resolved) fail('cannot resolve minecraft-data from minecraft-protocol');
if (!existsSync(resolved)) fail('minecraft-data path does not exist', resolved);

let knows263 = false;
try {
    const { createRequire } = await import('node:module');
    const req = createRequire(resolved);
    const md = req('minecraft-data');
    knows263 = !!md('26.3');
} catch (e) {
    // A nested older minecraft-data resolves here but throws on the missing
    // 26.3 data dir. Report the shadowing explicitly - that is the actual bug,
    // and a raw "Cannot find module ./data/pc/26.3/blocks.json" does not say so.
    const nested = path.join(ROOT, 'node_modules/minecraft-protocol/node_modules/minecraft-data');
    if (existsSync(nested)) {
        fail(`minecraft-data resolves to the NESTED copy, which lacks 26.3\n` +
            `   nested: ${path.relative(ROOT, nested)}\n` +
            `   resolving: ${path.relative(ROOT, resolved)}`,
            'This is the bug a plain `bun install` reintroduces. It nests an older\n' +
            'minecraft-data inside minecraft-protocol/node_modules/ that shadows the\n' +
            'copy carrying the generated 26.3 data, so createClient() gets\n' +
            'mcData("26.3") === undefined and throws "unsupported protocol version".\n' +
            '\nfix-26.2-protocol.py writes 26.3 into BOTH trees on purpose.\n' +
            'Do NOT just delete the nested directory - that breaks resolution too.');
    }
    fail('could not load minecraft-data', e.message);
}
if (!knows263) {
    fail(`minecraft-data at ${path.relative(ROOT, resolved)} cannot resolve 26.3`,
        'This is the bug a plain `bun install` reintroduces: it nests an older\n' +
        'minecraft-data inside minecraft-protocol/node_modules/ that shadows the\n' +
        'copy carrying the generated 26.3 data. fix-26.2-protocol.py writes 26.3\n' +
        'into BOTH trees on purpose - do not just delete the nested one.');
}

// --- 2. prismarine-chunk must know the 26.3 section header ---------------
// Without hasFluidCount extended to '26.3', chunks are decoded at the wrong
// palette offset: she connects fine and every block comes back garbage.
const chunkFile = path.join(ROOT, 'node_modules/prismarine-chunk/src/pc/1.18/ChunkColumn.js');
if (!existsSync(chunkFile)) fail('prismarine-chunk ChunkColumn.js not found', chunkFile);
const chunkSrc = readFileSync(chunkFile, 'utf8');
if (!/'26\.3'/.test(chunkSrc)) {
    fail('ChunkColumn.js does not handle 26.3',
        'hasFluidCount must include "26.3". Without it she connects but logs\n' +
        '"Bits per block is too big" continuously and her inventory reads back empty.');
}

const idx = path.join(ROOT, 'node_modules/prismarine-chunk/src/index.js');
if (!existsSync(idx)) fail('prismarine-chunk index.js not found');
if (!/26\.3\s*:/.test(readFileSync(idx, 'utf8'))) {
    fail('prismarine-chunk has no 26.3 implementation mapping',
        "Needs: 26.3: require('./pc/1.18/chunk')");
}

console.log('OK — 26.3 support intact (protocol data, chunk mapping, section header)');
console.log(`   minecraft-data: ${path.relative(ROOT, resolved)}`);