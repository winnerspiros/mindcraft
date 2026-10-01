// Is that player addressing her, physically?
//
// The owner: "unless addresses i mean physically or by text you can build that
// i think"
//
// Naming somebody in chat is the obvious form of addressing them. The physical
// form is standing close and LOOKING at them, and it is a real cue - people
// decide to speak to someone they are near far more often than people decide
// to speak to someone across the map.
//
// The trap is that Minecraft players collide constantly. Walking through
// someone on a corridor, or jumping on a block someone is standing on, is not
// being addressed and happens all day. So proximity ALONE is far too loose -
// measured on a busy server, "a player is within 8 blocks" is true most of the
// time and means nothing.
//
// The second cue is what makes it work: ORIENTATION. Someone facing you is
// engaging; someone facing away while standing next to you is not. Requiring
// both is what separates "he walked over and is looking at me" from "he is
// mining two blocks away with his back to me".

const CLOSE_BLOCKS = 4.0;    // close enough to be talking to
const FACING_COS = 0.5;      // ~60 degrees either side of straight-on

function dot(ax, az, bx, bz) {
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    return (ax * bx + az * bz) / (la * lb);
}

/**
 * @param {object} her      {x, z} her position and the direction she faces
 * @param {object} them     {x, z} the other player's position
 * @param {object} [theirFacing] {x, z} where they are looking; omit = unknown,
 *        which counts as NOT addressing (silence is the safe default)
 * @returns {{addressed: boolean, why: string, distance: number}}
 */
export function isAddressingMe(her, them, theirFacing) {
    if (!her || !them) return { addressed: false, why: 'no_position', distance: Infinity };
    const dx = them.x - her.x;
    const dz = them.z - her.z;
    const distance = Math.hypot(dx, dz);

    if (distance > CLOSE_BLOCKS) {
        return { addressed: false, why: 'too_far', distance };
    }
    // Direction from them to her, and where they are looking.
    if (!theirFacing) return { addressed: false, why: 'facing_unknown', distance };
    const toHer = dot(dx, dz, theirFacing.x, theirFacing.z);
    if (toHer < FACING_COS) {
        return { addressed: false, why: 'not_facing_me', distance };
    }
    return { addressed: true, why: 'close_and_facing', distance };
}

export { CLOSE_BLOCKS, FACING_COS };
