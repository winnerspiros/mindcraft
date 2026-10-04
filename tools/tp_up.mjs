// Teleport a player to a safe standing spot up in spawn.
//
// WHY THIS SHAPE (learned the hard way on 2026-10-04):
//   * `data get block <x> <y> <z> id` does NOT work on 26.3 — every call
//     returns "The target block is not a block entity" for air AND stone, so
//     it cannot tell the two apart and a probe built on it is silently blind.
//   * `execute if block ... run say` returns an empty string too, and empty is
//     indistinguishable from "did not run", so it is equally unusable.
//   * What DOES work: reading a PLAYER's Pos, and `tp`.
//
// So this never scans terrain. Pick a height, tp, then READ THE POSITION BACK:
// tp exits 0 even into empty air, so only the server's own position report
// says whether there was floor. A drop of more than 2 blocks means no floor —
// try the next height.
//
// Usage: node tools/tp_up.mjs <player> [x] [z]
import { rconCommand } from '../src/utils/rcon.js';

const out = (s) => console.log(s);
const t = async (cmd, ms = 8000) => {
  try { return String(await rconCommand(cmd, ms)); }
  catch (e) { return `ERR ${e.message}`; }
};
const posOf = async (name) => {
  const m = (await t(`data get entity ${name} Pos`))
    .match(/\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};
const settle = () => new Promise(r => setTimeout(r, 700));

const player = process.argv[2];
if (!player) { out('usage: node tools/tp_up.mjs <player> [x] [z]'); process.exit(1); }

const before = await posOf(player);
if (!before) { out(`could not read ${player}'s position`); process.exit(1); }
out(`${player} is at ${before.x.toFixed(1)}, ${before.y.toFixed(1)}, ${before.z.toFixed(1)}`);

// Stay on their own XZ: a vertical-only move is the least surprising thing to
// do, and it cannot drop them into a neighbouring cave.
const X = Math.floor(process.argv[3] ?? before.x);
const Z = Math.floor(process.argv[4] ?? before.z);

// Heights above the spawn plateau (~y64), nearest first. Verified live:
// 72 and 70 had no floor and dropped, 68 held. So try the tight ones before
// the lofty ones — someone 3 blocks up reads as "lifted", not "launched".
for (const y of [68, 70, 66, 72, 64, 80, 90]) {
  const tp = await t(`tp ${player} ${X} ${y} ${Z}`);
  await settle();
  const now = await posOf(player);
  if (!now) { out(`y=${y}: tp said ${tp.trim().slice(0, 60)}, position unreadable`); continue; }
  if (now.y < y - 2) {
    out(`y=${y}: fell to ${now.y.toFixed(1)}, no floor — next height`);
    continue;
  }
  out(`OK — ${player} is at ${now.x.toFixed(1)}, ${now.y.toFixed(1)}, ${now.z.toFixed(1)}`);
  out(`tp: ${tp.trim() || '(silent)'}`);
  process.exit(0);
}

out('no candidate height held — nothing was left in a bad spot, but the move did not land');
process.exit(1);
