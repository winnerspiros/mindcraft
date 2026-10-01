// Threat response: what Elena does about danger, and WHEN.
//
// The owner, across three reports:
//   "a phantom attacjs her, she should fight, not complain"
//   "she is not fighting nothing"
//   "about enemies she needs to be aware and act before. lets say a creeper
//    approach her, deal with it before it just comes and explodes"
//
// The third one is the real requirement, and it is categorically different from
// the first two. A hurt reflex reacts AFTER a hit. That is already too late for a
// creeper: it is already primed, already drifting toward her, and the fuse is
// already lit. So threat handling is split into two layers here:
//
//   1. reactToHurt()      - something already hit her. Fight or get clear.
//   2. assessThreats()    - something is approaching and has not hit her yet.
//                           Deal with it BEFORE it arrives.
//
// A separate module because the previous version of this lived inline in
// agent.js's entityHurt handler, and that was wrong twice over:
//
//   - it read the attacker from `source` inside bot.on('health'), which is emitted
//     with NO arguments at all, so the attacker was always null and the fight
//     branch was unreachable. That is precisely why a phantom produced a complaint
//     and no command: the only event carrying an attacker is entityHurt, and the
//     only path from it to her was a text injection ("phantom just hit YOU!").
//   - a test could not exercise it, so nothing caught that. Slicing the handler
//     out of agent.js source to eval it failed four different ways before I
//     stopped and made it a function instead.
//
// Every function here is PURE with respect to the world: it returns what should
// happen and never calls the model. A model round-trip is far too slow to answer
// a hit or a priming creeper, and letting the model decide is what produced
// "of course, a phantom now? this is just fantastic" in the first place.

// ── ranges, in blocks ───────────────────────────────────────────────────
// Measured, not guessed. See refs/threat_ranges.md.
export const MELEE_RANGE = 3.0;      // a creeper inside this is lethal
export const HOSTILE_NOTICE = 16.0;  // start dealing with a threat by here
export const URGENT_RANGE = 6.0;     // too late to be casual
export const FLEE_HEALTH = 14;       // below this, run rather than trade

/**
 * Mobs that need active handling rather than patience.
 *
 * `explodes` is the important one: a creeper that has begun its approach is
 * already on a timer, so "wait and see" is not a strategy. The rest are hostile
 * but do not force the issue, so she deals with them on her own schedule.
 */
const HOSTILE_BEHAVIOUR = {
    creeper:     { explodes: true,  priority: 1 },
    skeleton:    { explodes: false, priority: 3 },
    zombie:      { explodes: false, priority: 3 },
    husk:        { explodes: false, priority: 3 },
    pillager:    { explodes: false, priority: 3 },
    vindicator:  { explodes: false, priority: 4 },
    witch:       { explodes: false, priority: 2 },
    stray:       { explodes: false, priority: 3 },
    phantom:     { explodes: false, priority: 2 },
    wither_skeleton: { explodes: false, priority: 4 },
};

/** Normalise a Mineflayer entity to a bare mob name, or null if it is not a mob. */
export function mobName(entity) {
    if (!entity || entity.type !== 'mob') return null;
    const raw = String(entity.name || entity.displayName || '').toLowerCase();
    return raw.replace(/^minecraft:/, '').trim() || null;
}

function distanceBetween(a, b) {
    if (!a || !b) return Infinity;
    if (typeof a.distanceTo === 'function') {
        const d = a.distanceTo(b);
        return typeof d === 'number' ? d : Infinity;
    }
    if (typeof b.distanceTo === 'function') {
        const d = b.distanceTo(a);
        return typeof d === 'number' ? d : Infinity;
    }
    return Infinity;
}

export function isArmed(bot) {
    const items = bot?.inventory?.items?.() || [];
    // Anchor the weapon names. /axe$/ alone also matches "iron_pickaxe", because
    // "pickaxe" ends in "axe" - so she counted herself armed with a pickaxe and
    // would pick a fight with a zombie while holding a tool. Caught by the test
    // that asserts a pickaxe does NOT count.
    return items.some((i) => {
        const n = String(i?.name || '');
        return /sword$/.test(n) || /_axe$/.test(n);
    });
}

export function hasShield(bot) {
    const items = bot?.inventory?.items?.() || [];
    return items.some((i) => /shield/i.test(String(i?.name || '')));
}

/**
 * Something just hit her. Fight or get clear - never narrate.
 *
 * @returns {{action:'fight'|'flee'|'ignore', goal?:string, reason:string}}
 */
export function reactToHurt({ bot, attacker, distance } = {}) {
    try {
        const self = bot?.entity?.position;
        const d = distance ?? distanceBetween(attacker?.position, self);
        const threat = attacker && d < 12 ? attacker : null;
        if (!threat) {
            return { action: 'ignore', reason: 'no attacker in range' };
        }
        if (isArmed(bot)) {
            return {
                action: 'fight',
                goal: 'get the thing that just hit me',
                reason: `armed and the attacker is ${d.toFixed(1)} blocks away`,
            };
        }
        return {
            action: 'flee',
            goal: 'get away from this and get my health back',
            reason: `unarmed, attacker ${d.toFixed(1)} blocks away`,
        };
    } catch (e) {
        // Never take the bot down, and never fail silently either: a bare catch is
        // how a broken reflex looks exactly like a working one.
        console.warn('[threat] reactToHurt failed:', e?.message);
        return { action: 'ignore', reason: 'reflex error' };
    }
}

/**
 * Something is approaching and has NOT hit her yet.
 *
 * This is the "act before" layer. A priming creeper is the motivating case: it is
 * already on a timer, so the correct response is to create distance or kill it
 * now, not to notice the explosion afterwards.
 *
 * @param {object} o
 * @param {object} o.bot
 * @param {Array}  o.entities  nearby entities (Mineflayer bot.entities)
 * @param {boolean} o.busy      she is mid-task; a threat still outranks it
 * @returns {{action:'fight'|'avoid'|'ignore', target?:object, goal?:string, reason:string, urgency:number}}
 */
export function assessThreats({ bot, entities, busy = false } = {}) {
    try {
        const self = bot?.entity?.position;
        if (!self) return { action: 'ignore', reason: 'no position', urgency: 0 };

        const armed = isArmed(bot);
        let worst = null;

        for (const e of entities || []) {
            const name = mobName(e);
            if (!name) continue;
            const behaviour = HOSTILE_BEHAVIOUR[name];
            if (!behaviour) continue;
            const d = distanceBetween(e.position, self);
            if (!Number.isFinite(d) || d > HOSTILE_NOTICE) continue;

            // Urgency = how dangerous it is, weighted by how close.
            //
            // The first version summed a small priority for exploders with a
            // large proximity term, so a nearby ZOMBIE (priority 3) outranked a
            // very close CREEPER (priority 1) - exactly backwards, since the
            // creeper is the one that can end her. Exploders now carry a floor
            // well above the non-exploding range, so nothing outranks them on
            // proximity alone.
            const proximity = 1 - Math.min(d, HOSTILE_NOTICE) / HOSTILE_NOTICE;
            const urgency = behaviour.explodes
                ? 10 + proximity * 10
                : behaviour.priority * proximity;

            if (!worst || urgency > worst.urgency) {
                worst = { entity: e, name, behaviour, distance: d, urgency };
            }
        }

        if (!worst) return { action: 'ignore', reason: 'no hostiles nearby', urgency: 0 };

        // A creeper inside melee range with the fuse lit: get off its approach line
        // NOW. Killing it is a coin flip at that distance; distance is not.
        if (worst.behaviour.explodes && worst.distance < MELEE_RANGE + 1.5) {
            return {
                action: 'avoid',
                target: worst.entity,
                goal: 'get away from that creeper before it goes off',
                reason: `${worst.name} is priming at ${worst.distance.toFixed(1)} blocks`,
                urgency: worst.urgency,
            };
        }
        if (armed) {
            return {
                action: 'fight',
                target: worst.entity,
                goal: `deal with the ${worst.name} before it gets to me`,
                reason: `armed, ${worst.name} at ${worst.distance.toFixed(1)} blocks`,
                urgency: worst.urgency,
            };
        }
        // Unarmed: do not pick a fight with a mob just because it is nearby. Keep
        // working and let it come to her, or leave. Ordinary player sense.
        if (worst.behaviour.explodes) {
            return {
                action: 'avoid',
                target: worst.entity,
                goal: 'keep my distance from that creeper',
                reason: `unarmed, ${worst.name} at ${worst.distance.toFixed(1)} blocks`,
                urgency: worst.urgency,
            };
        }
        return {
            action: 'ignore',
            target: worst.entity,
            reason: `unarmed, no reason to start a fight with a ${worst.name}`,
            urgency: worst.urgency,
        };
    } catch (e) {
        console.warn('[threat] assessThreats failed:', e?.message);
        return { action: 'ignore', reason: 'assessment error', urgency: 0 };
    }
}

export { HOSTILE_BEHAVIOUR, distanceBetween };
