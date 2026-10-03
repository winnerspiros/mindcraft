// Regression: a variable used in a function body must be DECLARED in that body.
//
// execute() was split into execute() + runMode() so the goal loop could be
// returned from a finally. The declaration of interrupted_action lived in the
// old execute() and was not carried over, while its two uses stayed in
// runMode().
//
// The whole suite passed - 519 assertions, exit 0 - and the bot ran normally
// for several minutes, because the reference only resolves when a mode actually
// INTERRUPTS an existing action, which is rare. It then died:
//
//   ReferenceError: interrupted_action is not defined
//   Main process exited, code=exited, status=1/FAILURE
//
// systemd crash-looped it 9 times to "Failed to start", and a 10-minute
// movement soak run in that window silently measured a dead process.
//
// Source-slicing tests do not catch this: every slice was syntactically valid and
// the assertion was about control flow, not about names resolving. So this
// checks the thing that actually broke - that every identifier a function body
// reads as a bare name is either declared there or is an import/module global.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
const code = src.replace(/\/\/[^\n]*/g, '');

const fn = (name) => {
    const start = code.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    const end = code.indexOf('\n}', start);
    // Strip string and template literals: their contents are not code, and a
    // naive scan finds "Your", "system", "Mode" in the reprompt message text.
    return code.slice(start, end)
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
};

test('the two functions from the execute() split both exist', () => {
    assert.ok(fn('execute').length > 0);
    assert.ok(fn('runMode').length > 0);
});

test('interrupted_action is DECLARED in the function that uses it', () => {
    // This is the exact crash. runMode() reads it twice, at should_reprompt and
    // in the reprompt message.
    const rm = fn('runMode');
    const raw = src.slice(src.indexOf('async function runMode('), src.indexOf('\n}', src.indexOf('async function runMode(')));
    assert.match(rm, /interrupted_action &&/, 'the guard that reads it is gone - the test no longer covers the crash path');
    assert.match(raw, /\$\{interrupted_action\}/, 'the reprompt message must still name the interrupted action');
    assert.match(rm, /let interrupted_action\s*=\s*agent\.actions\.currentActionLabel/,
        'runMode() reads interrupted_action but never declares it - ReferenceError when a mode interrupts an action');
});

test('every bare identifier runMode() reads is declared or global', () => {
    const rm = fn('runMode');
    const declared = new Set();
    for (const m of rm.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of rm.matchAll(/\b(?:let|const|var)\s*\{([^}]*)\}/g))
        for (const n of m[1].split(',')) declared.add(n.split(':').pop().trim());
    for (const m of rm.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g)) declared.add(m[1]);
    for (const m of rm.matchAll(/\(([^)]*)\)\s*=>/g))
        for (const p of m[1].split(',')) {
            const n = p.trim().split('=')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
        }
    // Read as a bare name: not after a dot, not a property, not a keyword.
    const read = new Set();
    for (const m of rm.matchAll(/(^|[^.\w$'\`"])([A-Za-z_$][\w$]*)(?![\w$])/g)) read.add(m[2]);
    const globals = new Set([
        // module-level imports and helpers
        'mode', 'agent', 'func', 'timeout', 'convoManager', 'Vec3', 'skills',
        'world', 'mc', 'modes_list', 'execute', 'runMode',
        // reserved words, never bare reads
        'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
        'break', 'continue', 'new', 'delete', 'typeof', 'void', 'in', 'of', 'instanceof',
        'this', 'super', 'class', 'extends', 'try', 'catch', 'finally', 'throw',
        'async', 'await', 'yield', 'let', 'const', 'var', 'import', 'export',
        'null', 'true', 'false', 'undefined',
        // globals
        'console', 'Math', 'Object', 'Array', 'JSON', 'Number', 'String', 'Boolean',
        'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'Symbol',
        'log', 'say',
    ]);

    read.delete('runMode');
    const undeclared = [...read].filter(n => !declared.has(n) && !globals.has(n)
        && !/^[A-Z_]{2,}$/.test(n) && !/^(log|say)$/.test(n));
    assert.deepEqual(undeclared, [],
        `runMode() reads names it never declares: ${undeclared.join(', ')} - each would throw a ReferenceError when reached`);
});

test('runMode() is reachable, not dead code shadowed by execute()', () => {
    // execute() must delegate to it; otherwise the declaration is in a function
    // nothing calls and the crash is back.
    assert.match(fn('execute'), /return await runMode\(/,
        'execute() must delegate to runMode(), or the restored declaration is unreachable');
});
