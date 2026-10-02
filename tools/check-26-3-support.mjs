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

// --- 4. protodef must not spam the undecodable update_light frame ----------
// The 26.3 server sends update_light frames protodef cannot decode. They are
// dropped and retried forever, and protodef stack-traces each one: 26 traces
// per 35 minutes on a 1-OCPU box, burying every real error. light data only
// feeds chunk lighting, which the bot never reads.
//
// Checked here because this is a node_modules patch applied by
// fix-26.2-protocol.py, and a reinstall silently reverts it. The check is for
// the NARROW suppression (matching this frame only) - the blanket
// noErrorLogging flag is deliberately not acceptable, because it also hides
// decode failures that mean real world-data corruption.
const protodefCands = [
    path.join(ROOT, 'node_modules', 'protodef', 'src', 'serializer.js'),
    path.join(ROOT, 'node_modules', 'minecraft-protocol', 'node_modules', 'protodef', 'src', 'serializer.js'),
];
let checkedSerializer = false;
for (const ser of protodefCands) {
    if (!existsSync(ser)) continue;
    checkedSerializer = true;
    const txt = readFileSync(ser, 'utf8');
    if (/packet_update_light\/.test/.test(txt)) continue;
    fail(`protodef at ${rel(ser)} has no narrow update_light suppression`,
        'Run: python3 fix-26.2-protocol.py');
}
if (!checkedSerializer) fail('could not find any protodef/src/serializer.js under node_modules',
    'checked: ' + protodefCands.map(rel).join(', '));

// ── The stock digging flow must SURVIVE postinstall ──────────────────
//
// fix-26.2-protocol.py runs on every `bun install` (postinstall) and SIX of its
// installers write to mineflayer/lib/plugins/digging.js: seqtruth, digaim,
// digaimc, ghostbreak, deathtruth, toolproof, stopproof. That script grew the
// file to 519 lines of interlocking workarounds (stock is 267) and those fixes
// did not work anyway - 594 stone digs, 0 blocks broken.
//
// digging.js is now stock + the one field 26.3 requires, so the installers
// must all decline to touch it. Verified by running every ensure_* from the
// script against a copy: 310 lines before, 310 after, byte-identical.
//
// This check exists because the opposite would be silent. The installers bail
// out on missing anchors with a WARNING rather than an error, so a future
// stock-file change that happens to match an anchor would silently reinstate
// the 519-line version on the next install.
{
    const digPath = path.join(ROOT, 'node_modules', 'mineflayer', 'lib', 'plugins', 'digging.js');
    if (existsSync(digPath)) {
        // Strip comments first. Stock digging.js carries comments that NAME the
        // removed workarounds ("...RESTOP, GHOST-BREAK, NOSWING..."), and a
        // plain includes() over the whole file flags its own explanation of the
        // bug. That is the same comment-vs-code trap this repo has now hit three
        // times; make it structurally impossible here.
        const raw = readFileSync(digPath, 'utf8');
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const lines = code.split('\n').length;
        // Unique to the removed rewrite; none appear in stock. (bot.targetDigBlock
        // is genuine stock and was the first wrong marker tried here.)
        const rewritten = ['26.3 SEQ-TRUTH', 'ANIM-SUMMARY', '26.3 RESTOP-SCHED',
                           'STOPWAIT-UPDATE', 'SEQ-SKIP', '_schedRestop',
                           '_digStartClientTool', 'dig-trace', 'dig-effects',
                           '_serverAckSeq']
            .filter(m => code.includes(m));
        if (rewritten.length) {
            fail(`digging.js carries ${rewritten.length} reinstated 26.3 dig workaround(s): ${rewritten.join(', ')}`,
                'postinstall re-applied fix-26.2-protocol.py over the stock file');
        }
        if (lines > 400) {
            fail(`digging.js is ${lines} lines (stock is ~288); the hand-rewrite is back`,
                'the six-workaround version is what broke digging');
        }
        // Count sequence fields INSIDE block_dig writes specifically. A bare
        // /sequence:/ test passed even with the START's sequence deleted, because
        // the FINISH and CANCEL writes still had one - and START is the packet
        // that actually begins the dig. Counted per-write, as mutation-tested.
        const digWrites = code.match(/write\('block_dig',\s*\{[\s\S]*?\}\s*\)/g) || [];
        const withSeq = digWrites.filter(w => /sequence:/.test(w)).length;
        if (digWrites.length < 3) {
            fail(`digging.js has ${digWrites.length} block_dig writes; expected 3 (start/finish/cancel)`,
                'stock mineflayer sends all three');
        }
        if (withSeq !== digWrites.length) {
            fail(`${digWrites.length - withSeq} of ${digWrites.length} block_dig writes send no sequence; 26.3 requires it`,
                'see 26.3/protocol.json packet_block_dig');
        console.log(`   digging.js: stock flow, ${lines} code lines, sequence present`);
    }
}

console.log('OK — 26.3 support intact (protocol data, chunk mapping, section header)');
console.log(`   minecraft-data: ${rel(resolved)}`);
        }