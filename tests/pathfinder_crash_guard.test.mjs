// CRASH GUARD: a pathfinder plan that cannot start is a no-path, never a
// process kill. 2026-10-09: stock getPathTo destructures
//   const { value: { result } } = generator.next()
// When the world is unloaded around her (respawn/warp/chunk gap) the
// generator yields NOTHING — .next() = {value: undefined} — and the
// destructuring throws "TypeError: {} is not iterable", which escapes the
// physics tick and kills the process (crash-loop 18:52+, 12 restarts,
// systemd rate limit). The guard wraps getPathTo and returns a no-path.
import test from 'node:test';
import assert from 'node:assert';
import { installPathfinderGuard } from '../src/utils/mcdata.js';

function fakeBot(impl) {
    return { pathfinder: { getPathTo: impl } };
}

test('the stock crash shape becomes a no-path, not a throw', () => {
    const bot = fakeBot(() => {
        // exactly what stock code does with an empty generator
        const generator = { next: () => ({ value: undefined, done: true }) };
        const { value: { result } } = generator.next();
        return result;
    });
    installPathfinderGuard(bot);
    let out;
    assert.doesNotThrow(() => { out = bot.pathfinder.getPathTo({}, {}, 1000); },
        'must not throw — the process died on this');
    assert.equal(out.status, 'no-path');
    assert.deepEqual(out.path, []);
});

test('real plans pass through untouched, other errors still throw', () => {
    const plan = { status: 'success', cost: 10, path: [1, 2, 3] };
    const bot = fakeBot(() => plan);
    installPathfinderGuard(bot);
    assert.equal(bot.pathfinder.getPathTo({}, {}, 1000), plan, 'success must pass through by reference');
    const bot2 = fakeBot(() => { throw new Error('something else broke'); });
    installPathfinderGuard(bot2);
    assert.throws(() => bot2.pathfinder.getPathTo({}, {}, 1000), /something else/,
        'only the not-iterable shape is caught — everything else still throws');
});
