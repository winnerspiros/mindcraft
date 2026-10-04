// Every entry in the model map must point at a file that exists.
//
// Why this needs a test: the upstream GLHF removal deleted
// src/models/glhf.js but left `glhf: 'glhf.js'` behind in this map, so
// selecting that model would have thrown ERR_MODULE_NOT_FOUND on a
// missing import. Nothing caught it -- the suite was 96/96 green with the
// dangling entry still in place, because no test ever walked the map.
//
// The failure is silent until someone sets "model": "glhf" (or upstream
// drops a backend again), and then it is a runtime crash rather than a
// clear error. Cheap to check, so check it on every run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(HERE, '..', 'src', 'models', '_model_map.js');

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; }
};

// Parse the `createModel`-adjacent literal rather than importing it: the
// map is a plain object of name -> './file.js', and reading it as text
// keeps this test independent of the module's own import graph (which is
// exactly what broke when glhf.js went missing).
const src = fs.readFileSync(MAP, 'utf8');
const entries = [...src.matchAll(/([A-Za-z_]\w*)\s*:\s*'([^']+\.js)'/g)];

check(entries.length > 0, `parsed ${entries.length} model mappings`, 'no model mappings parsed at all');

const missing = [];
for (const [, name, file] of entries) {
    if (!fs.existsSync(path.join(path.dirname(MAP), file))) missing.push(`${name} -> ${file}`);
}
check(missing.length === 0,
    `all ${entries.length} mappings resolve to real files`,
    `dangling model mappings: ${missing.join(', ')}`);

// The specific regression, so a re-added glhf entry fails loudly with a
// reason rather than as one item in a list.
check(!entries.some(([, n]) => n === 'glhf'),
    'no glhf entry (upstream removed src/models/glhf.js)',
    'glhf is mapped again but src/models/glhf.js does not exist');

// Every shipped backend should have a key in keys.example.json, except the
// local/self-hosted ones that deliberately need no credential. A few
// backends use a different env name than their id implies, so map those
// explicitly instead of guessing an uppercase transformation.
const LOCAL = new Set(['ollama', 'vllm', 'lmstudio', 'azure']);
const ENV = { google: 'GEMINI_API_KEY', groq: 'GROQCLOUD_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const example = fs.readFileSync(path.join(HERE, '..', 'keys.example.json'), 'utf8');
const undeclared = entries
    .map(([, n]) => n)
    .filter(n => !LOCAL.has(n) && !example.includes(ENV[n] ?? `${n.toUpperCase()}_API_KEY`));
check(undeclared.length === 0,
    'every keyed backend is declared in keys.example.json',
    `backends with no matching key in keys.example.json: ${undeclared.join(', ')}`);

console.log(`\n${pass} passed, ${failed} failed`);
if (failed === 0) console.log('model map is consistent with the files on disk');
