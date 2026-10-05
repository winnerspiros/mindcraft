// A large RCON reply is split across MULTIPLE type-0 packets. rconCommand used
// to call finish() the moment it saw the first one, so a long reply came back
// cut short -- silently, mid-list.
//
// This is the actual mechanism behind "63 blocks of dirt vanished every twenty
// seconds": the inventory reply is long enough to span packets, the client
// returned only the first packet, and every entry after the cut was invisible.
// Smaller replies (health, position, a nearly-empty pack) fit in one packet and
// read fine, which is why the bug looked random and time-dependent.
import { test } from 'node:test';
import assert from 'node:assert';

// What the current implementation does with a multi-packet reply.
function collectCurrentStyle(packets) {
    const parts = [];
    let gotResponse = false;
    for (const p of packets) {
        if (p.type === 0) { parts.push(p.body); gotResponse = true; }
        if (gotResponse) return parts.join('');   // returns on the FIRST response
    }
    return parts.join('');
}

// What it must do: take every response packet the server sent.
function collectAll(packets) {
    return packets.filter(p => p.type === 0).map(p => p.body).join('');
}

const one = { type: 0, body: 'A'.repeat(10) };

test('a single-packet reply is returned whole', () => {
    assert.equal(collectCurrentStyle([one]), 'AAAAAAAAAA');
});

test('a two-packet reply currently returns only the first packet', () => {
    // Documents the bug: this is the shape a long inventory reply takes.
    const packets = [{ type: 0, body: 'FIRST' }, { type: 0, body: 'SECOND' }];
    assert.equal(collectCurrentStyle(packets), 'FIRST',
        'current behaviour: stops at the first response packet');
    assert.equal(collectAll(packets), 'FIRSTSECOND',
        'correct behaviour: every response packet is part of one reply');
});

test('non-response packets are never treated as reply content', () => {
    const packets = [{ type: 2, body: 'SERVER-ECHO' }, { type: 0, body: 'REAL' }];
    assert.equal(collectAll(packets), 'REAL');
});

test('an auth echo is not content', () => {
    const packets = [{ id: 1, type: 2, body: '' }, { type: 0, body: 'REAL' }];
    assert.equal(collectAll(packets), 'REAL');
});

test('a packet arriving split across TCP segments is reassembled', () => {
    // Byte-level framing: each packet declares its own length, so a partial
    // buffer must be kept rather than parsed. This is what makes the reply
    // arrive whole once all packets are collected.
    const frame = (body) => {
        const payload = Buffer.from(body, 'utf8');
        // length counts everything after the length field itself:
        //   id(4) + type(4) + body + 2 nulls.  Buffer total = 4 + length.
        const len = 4 + 4 + payload.length + 2;
        const buf = Buffer.alloc(4 + len);
        buf.writeInt32LE(len, 0);
        buf.writeInt32LE(2, 4);
        buf.writeInt32LE(0, 8);
        payload.copy(buf, 12);
        return buf;
    };
    const stream = Buffer.concat([frame('PART1'), frame('PART2')]);
    const got = [];
    let off = 0;
    while (off + 4 <= stream.length) {
        const l = stream.readInt32LE(off);
        if (stream.length < off + 4 + l) break;   // incomplete: wait for more
        const id = stream.readInt32LE(off + 4);
        const type = stream.readInt32LE(off + 8);
        // Same slice production uses: absolute end = 4 + l - 2 within the buffer.
        if (type === 0) got.push(stream.slice(off + 12, off + 4 + l - 2).toString('utf8'));
        off += 4 + l;
    }
    assert.deepEqual(got, ['PART1', 'PART2'],
        'both framed packets must be recovered from the byte stream');
});
