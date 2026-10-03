// Regression: only one thing may drive eating.
//
// mineflayer-auto-eat registers its own bot.on('health') that calls eat(), and
// its isEating lock cannot see ours. Both handlers then equip food into the one
// hand at the same time; mineflayer cancels the chew on the slot change, so the
// food is never consumed. Measured on the live server: with auto-eat enabled she
// failed 5 of 7 eats under attack and logged "failed to consume" each time;
// with it disabled, 9 of 9 landed and health rose 17.9 -> 18.8 -> 19.4 while a
// zombie was still hitting her.
//
// The invariant is that agent.js must disable auto-eat at startup, because
// _maybeEat is a strict superset: auto-eat only fires below food 14, whereas
// _maybeEat also tops saturation, which is what buys regeneration.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const agent = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
const skills = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');

// A commented-out guard still satisfies a naive regex, so match executable code
// only: strip line comments and block comments before asserting on it.
const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const agentCode = stripComments(agent);
const skillsCode = stripComments(skills);

test('auto-eat is disabled so it cannot race _maybeEat for the hand', () => {
    const idx = agentCode.indexOf('this.bot.autoEat.options');
    assert.ok(idx > -1, 'auto-eat options are still configured');
    const disable = agentCode.indexOf('this.bot.autoEat.disable();');
    assert.ok(disable > -1, 'auto-eat is never disabled - it will race _maybeEat');
    assert.ok(
        disable > idx,
        'auto-eat must be disabled after its options are set, and before any eating'
    );
});

test('auto-eat is disabled exactly once, at startup', () => {
    const count = (agentCode.match(/this\.bot\.autoEat\.disable\(\);/g) || []).length;
    assert.strictEqual(count, 1, 'disabling per-chew would re-open the race with the plugin');
    assert.ok(
        !/autoEat\?\.(enable|disable)/.test(agentCode),
        'auto-eat must not be re-enabled or toggled per chew'
    );
});

test('a chew claims the hand so no combat caller can steal it mid-bite', () => {
    assert.ok(
        /export async function eatNow[\s\S]*?bot\._eating = true;/.test(skillsCode),
        'eatNow must claim the hand for the whole bite'
    );
    assert.ok(
        /export async function eatNow[\s\S]*?} finally \{\s*bot\._eating = false;/.test(skillsCode),
        'the claim must be released in a finally, or a throw locks combat out of equipping forever'
    );
    // An explicit flag, not bot.usingHeldItem: mineflayer clears that from seven
    // separate paths (set_cooldown, entity_status, heldItemChanged, deactivateItem,
    // ...), so it was already false for most of the bite.
    assert.ok(
        /bot\._eating = false;/.test(skillsCode),
        'the claim must be released'
    );
});

test('a chew owns the hand at bot.equip itself, not at each call site', () => {
    // Guarding individual callers kept missing one: the pathfinder reached
    // bot.equip() from monitorMovement with no way to ask permission. The
    // wrapper is the only thing that covers callers we do not own.
    assert.ok(
        /export function claimHand\(bot\)/.test(skillsCode),
        'claimHand is missing'
    );
    // Behaviour, not shape: tests/claim_hand.test.mjs proves the wrapper defers
    // other equips, releases a wedged claim and bounds its queue. Asserting the
    // literal source here only re-pinned the implementation and broke when the
    // safety limits were added - so just require the interception exists.
    assert.ok(
        /bot\.equip = async \(\.\.\.args\) =>/.test(skillsCode) &&
        /_handQueue\.push/.test(skillsCode),
        'claimHand must intercept bot.equip and queue while a chew is active'
    );
    assert.ok(
        /_handClaimInstalled/.test(skillsCode),
        'claimHand must be idempotent - installing twice would wrap equip twice'
    );
    assert.ok(
        /_releaseHand[\s\S]*?bot\._handQueue\.splice/.test(skillsCode),
        'queued equips must run once the chew ends, or deferred work is lost'
    );
    assert.ok(
        /export async function eatNow[\s\S]*?bot\._eating = true;[\s\S]*?await bot\.equip\(item, 'hand'\)/.test(skillsCode),
        'the hand must be claimed BEFORE the equip that brings food to it'
    );
});

test('every hand-taking caller honours an in-progress chew', () => {
    // equipHighestAttack is the shared choke point for melee, and shootBow is a
    // separate one. Both were measured swapping a weapon or bow into the hand
    // between the 32 ticks of a bite.
    // The per-caller guards are gone by design - claimHand() covers them, plus
    // the pathfinder and anything added later. What must survive is that no
    // caller bypasses equip() to take the hand directly.
    const bypass = [...skillsCode.matchAll(/bot\._client\.write\('hold_item_slot'/g)];
    assert.strictEqual(bypass.length, 0,
        'a raw hold_item_slot write would bypass the hand claim entirely');
    assert.ok(
        !/if \(bot\._eating\) return;/.test(skillsCode),
        'stale per-caller guard: claimHand() is the single chokepoint now'
    );
});

test('the respawn gear-up yields to a chew instead of cancelling it', () => {
    // Every `item replace`/`give` in _gearUp resyncs the whole inventory, which
    // blanks the held slot and cancels the bite. Measured: 10 failed eats in a
    // row after one respawn, each straddling a 17-piece gear-up.
    const fn = agentCode.match(/async _gearUp\(\)[\s\S]*?\n    \}/);
    assert.ok(fn, '_gearUp not found');
    assert.ok(
        /if \(this\.bot\._eating\) \{[\s\S]*?return;/.test(fn[0]),
        '_gearUp runs mid-chew and resyncs the inventory out from under the bite'
    );
    assert.ok(
        /_gearUpDeferred[\s\S]*?_gearUp\(\)/.test(fn[0]),
        'a deferred gear-up must still happen - she needs the kit, just not mid-bite'
    );
});

test('the movement-driven fight paths defer to a chew', () => {
    // Both drive pathfinder and control states, which cancel the bite
    // server-side. self_defense mode reaches avoidEnemies directly
    // (modes.js:378), so guarding only attackEntity still lost the bite.
    for (const fn of ['attackEntity', 'avoidEnemies']) {
        const start = skillsCode.indexOf(`export async function ${fn}(`);
        assert.ok(start > -1, `${fn} not found`);
        // Walk to the method's own closing brace rather than slicing a fixed
        // length - a fixed slice silently scanned past the guard once already.
        let d = 0, end = start;
        for (; end < skillsCode.length; end++) {
            if (skillsCode[end] === '{') d++;
            else if (skillsCode[end] === '}') { d--; if (d === 0) { end++; break; } }
        }
        const body = skillsCode.slice(start, end);
        assert.ok(
            /if \(bot\._eating\) return false;/.test(body),
            `${fn} runs mid-chew and cancels it`
        );
    }
});

test('consumption is proven by the stack shrinking, never by activateItem', () => {
    const fn = skillsCode.match(/export async function eatNow[\s\S]*?\n}/);
    assert.ok(fn, 'eatNow not found');
    assert.ok(
        /if \(!now \|\| \(now\.count \|\| 0\) < before\)/.test(fn[0]),
        'success must require the food stack to actually decrease'
    );
    assert.ok(
        /return true;/.test(fn[0]),
        'eatNow must report success'
    );
});