// REGRESSION: the owner's "come to me" must interrupt her goals.
// 2026-10-09: five "come to me"/"i need you" from YandereDev in a row never
// fired the come/go/tp directive interrupt — zero "directive from YandereDev"
// in 2h of logs — and she answered "no way, got stuff to do here" from her
// mining goal. Root cause: the gate was `isBeloved || isYandere()`, but the
// beloved slot is empty and the persona is normal, so it failed closed for
// the server owner. The owner must always be trusted, regardless of persona.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');

test('owner is trusted for directives regardless of persona', () => {
    assert.match(src, /_isOwner\s*=/, 'an owner check must exist at the directive gate');
    assert.match(src, /yanderedev/i, 'the owner name must be recognised');
    assert.match(src, /isBeloved \|\| isYandere\(\) \|\| _isOwner/,
        'the trust gate must include the owner alongside beloved/persona');
});

test('the come-directive pattern still matches plain "come to me"', () => {
    const start = src.indexOf('if (/\\b(come|come');
    assert.ok(start > 0, 'the directive pattern was not found');
    const end = src.indexOf('.test(_dir)', start);
    const lit = src.slice(start + 5, end - 1); // strip `if (/` ... `/`
    const re = new RegExp(lit, 'i');
    for (const msg of ['uwu come to me', 'come to me uwu', 'come here', 'can you come here']) {
        assert.ok(re.test(msg.toLowerCase()), `"${msg}" must match the directive pattern`);
    }
});

test('the interrupt sets a reach goal naming the player', () => {
    assert.match(src, /Go to \$\{username\} and stand near them/,
        'the interrupt goal must name the requesting player');
    assert.match(src, /self_prompter\.interruptTo\(_goal\)/,
        'the directive must interrupt the current goal with resume');
});
