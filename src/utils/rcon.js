import net from 'node:net';
import fs from 'node:fs';

// RCON arbiter for gear-up (26.3): client-side Slot/SlotComponent decode is
// broken (dozens of identical packet_set_slot -> Slot -> SlotComponent
// PartialReadErrors every boot), so bot.inventory.items() reads permanently
// empty while the server holds a real kit. RCON `data get entity` is the
// arbiter: silent (zero chat, zero LLM turns), authoritative, no decode
// needed. Kit via RCON `give` / `item replace` (proven live, no spam gate).
const RCON_HOST = '127.0.0.1';
const RCON_PORT = 25575;
const RCON_PW_FILE = '/home/ubuntu/kenoi-fabric/rcon.password';

function encode(id, type, payload) {
    const body = Buffer.from(payload, 'utf8');
    const buf = Buffer.alloc(12 + body.length + 2); // 4 len + 4 id + 4 type + body + 2 nulls
    buf.writeInt32LE(4 + 4 + body.length + 2, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    body.copy(buf, 12);
    return buf; // trailing 2 bytes already zero
}

export function rconCommand(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let pw;
        try { pw = fs.readFileSync(RCON_PW_FILE, 'utf8').trim(); }
        catch (e) { reject(new Error('rcon pw unreadable: ' + e.message)); return; }
        const sock = net.createConnection({ host: RCON_HOST, port: RCON_PORT }, () => {
            sock.write(encode(1, 3, pw));
        });
        const timer = setTimeout(() => { try { sock.destroy(); } catch (_) {} reject(new Error('rcon timeout: ' + cmd.slice(0, 40))); }, timeoutMs);
        let stage = 'auth';
        let chunks = [];
        let parts = [];
        let drained = false;
        const finish = () => { if (drained) return; drained = true; clearTimeout(timer); try { sock.destroy(); } catch (_) {} resolve(parts.join('')); };
        sock.on('data', (d) => {
            chunks.push(d);
            let buf = Buffer.concat(chunks);
            const out = [];
            while (buf.length >= 4) {
                const len = buf.readInt32LE(0);
                if (buf.length < 4 + len) break;
                const id = buf.readInt32LE(4);
                const type = buf.readInt32LE(8);
                // Empty auth-echo packets (id 1 / type 2, zero body) carry no
                // data — the rcon.py arbiter ignores them and drains on
                // timeout. Mirror that: only keep real response bodies.
                const body = buf.slice(12, 4 + len - 2).toString('utf8', 'replace');
                out.push({ id, type, body });
                buf = buf.slice(4 + len);
            }
            chunks = [buf];
            let gotResponse = false;
            for (const p of out) {
                if (stage === 'auth') {
                    if (p.id === -1 || p.type === -1) { clearTimeout(timer); try { sock.destroy(); } catch (_) {} reject(new Error('rcon auth failed')); return; }
                    stage = 'cmd';
                    sock.write(encode(2, 2, cmd));
                    // safety net only: the real finish fires on type-0 packet
                    setTimeout(finish, 1500);
                } else if (p.type === 0) {
                    parts.push(p.body);
                    gotResponse = true;
                }
            }
            if (gotResponse) finish();
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

const ARMOR_SLOT = { diamond_helmet: 'armor.head', diamond_chestplate: 'armor.chest', diamond_leggings: 'armor.legs', diamond_boots: 'armor.feet' };
const KIT_GIVE = [ // [item, count]
    ['cooked_beef', 16], ['diamond_pickaxe', 1], ['diamond_axe', 1],
    ['diamond_shovel', 1], ['diamond_hoe', 1], ['bow', 1], ['arrow', 64],
    ['chest', 1], ['water_bucket', 1], ['elytra', 1], ['firework_rocket', 64],
];

// RCON position read: where IS a player, even when the 26.3 server withholds
// their entity from bot.entities (verified 18:24: YandereDev 11 blocks away,
// invisible). Returns {x,y,z} floats or null. Cached 1.2s per name: fresh
// enough for per-tick stare/social gating (a 5s cache froze her gaze on a
// stale spot for seconds after the player moved), still cheap enough that a
// walk leg doesn't spam RCON.
const _posCache = {};
const POS_CACHE_MS = 1200;
export async function rconPlayerPos(name) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return null;
    const now = Date.now();
    if (_posCache[safe] && now - _posCache[safe].t < POS_CACHE_MS) return _posCache[safe].pos;
    let out;
    try { out = await rconCommand(`data get entity ${safe} Pos`); }
    catch (e) { return null; }
    const m = String(out).match(/\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
    if (!m) return null;
    const pos = { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
    _posCache[safe] = { t: now, pos };
    return pos;
}

function parseIds(text) {
    const have = new Set();
    const re = /minecraft:([a-z_]+)"/g;
    let m;
    while ((m = re.exec(text))) have.add(m[1]);
    return have;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Ensure the full OP survival kit via RCON only. Returns { ok, gave, detail }.
// ok=false means RCON itself failed -> caller falls back to legacy chat path.
export async function rconEnsureKit(name) {
    const safe = String(name).replace(/[^A-Za-z0-9_]/g, '');
    if (!safe) return { ok: false, gave: false, detail: 'bad name' };
    let inv, eq;
    try {
        inv = await rconCommand(`data get entity ${safe} Inventory`);
        eq = await rconCommand(`data get entity ${safe} equipment`);
    } catch (e) {
        return { ok: false, gave: false, detail: 'rcon read failed: ' + e.message };
    }
    const have = new Set([...parseIds(inv), ...parseIds(eq)]);
    const actions = [];
    for (const [piece, slot] of Object.entries(ARMOR_SLOT))
        if (!have.has(piece)) actions.push(`item replace entity ${safe} ${slot} with minecraft:${piece} 1`);
    if (!have.has('diamond_sword')) actions.push(`item replace entity ${safe} weapon.mainhand with minecraft:diamond_sword 1`);
    if (!have.has('shield')) actions.push(`item replace entity ${safe} weapon.offhand with minecraft:shield 1`);
    for (const [item, n] of KIT_GIVE)
        if (!have.has(item)) actions.push(`give ${safe} minecraft:${item} ${n}`);
    if (actions.length === 0) return { ok: true, gave: false, detail: 'already kitted per RCON, silent' };
    let done = 0;
    for (const c of actions) {
        try { await rconCommand(c); done++; } catch (e) { return { ok: true, gave: done > 0, detail: `gave ${done}/${actions.length}, stopped: ${e.message}` }; }
        await sleep(150);
    }
    return { ok: true, gave: true, detail: `RCON kitted ${done} missing pieces, silent` };
}
