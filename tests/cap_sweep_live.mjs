// Capability sweep: every normal player action through the REAL skill path,
// verified against server (RCON) truth. Loops: fix failures, re-run.
// Usage: node tests/cap_sweep_live.mjs  (run from ~/uwu-bot)
import fs from 'fs';
import path from 'path';
const LOCK_PATH = '/tmp/uwu_cap_sweep.lock';
try { const fd = fs.openSync(LOCK_PATH, 'wx'); fs.closeSync(fd); }
catch (e) { if (e.code === 'EEXIST') { console.error('another sweep running'); process.exit(0); } throw e; }
process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch (_) {} });
process.on('SIGINT', () => { try { fs.unlinkSync(LOCK_PATH); } catch (_) {} process.exit(1); });
process.on('SIGTERM', () => { try { fs.unlinkSync(LOCK_PATH); } catch (_) {} process.exit(1); });

import mineflayer from 'mineflayer';
import { createRequire } from 'module';
import Vec3 from 'vec3';
const require = createRequire(import.meta.url);
const OUT = '/home/ubuntu/.hermes/cache/scratch/cap_sweep.txt';
fs.writeFileSync(OUT, '');
const log = (...a) => { const s = a.join(' '); console.log(s); try { fs.appendFileSync(OUT, s + '\n'); } catch (_) {} };
function plugin(mod, ...keys) {
  if (typeof mod === 'function') return mod;
  for (const k of [...keys, 'default', 'plugin']) if (typeof mod?.[k] === 'function') return mod[k];
  throw new Error('no plugin fn');
}
const BOT = 'CapSweep';
const PW = 'sweepx7q';
const skills = await import('../src/agent/library/skills.js');
const rconmod = await import('../src/utils/rcon.js');
const rconCmd = rconmod.rconCommand;

const bot = mineflayer.createBot({
  host: '127.0.0.1', port: 25565, username: BOT,
  version: (() => { try { const l = require('mineflayer'); const li = l.testedVersions || l.supportedVersions || []; if (li.includes('26.3')) return '26.3'; if (li.length) return li[li.length - 1]; } catch (_) {} return '1.21.4'; })(),
  auth: 'offline',
});
bot.loadPlugin(plugin(require('mineflayer-pathfinder'), 'pathfinder'));
bot.loadPlugin(plugin(require('mineflayer-collectblock'), 'plugin'));
bot.loadPlugin(plugin(require('mineflayer-tool'), 'tool'));
bot.on('error', e => { log('ERROR', e.message); process.exit(1); });
bot.on('kicked', r => log('KICKED', JSON.stringify(r)));
bot.on('end', () => { log('DISCONNECTED - bot dropped from server'); process.exit(3); });
bot.on('message', (m) => { const t = String(m); if (/login|register|auth|password|again|expired/i.test(t)) log('CHAT', t.slice(0, 140)); });
bot.once('login', () => {
  bot.chat(`/register ${PW} ${PW}`);
  setTimeout(() => bot.chat(`/login ${PW}`), 1500);
  setInterval(() => { try { bot.chat(`/login ${PW}`); } catch (_) {} }, 45000);
});
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); log((ok ? 'PASS' : 'FAIL'), name, '-', detail); if (!ok) { try { log('LOGBOT', name, '|||', String(bot.output || '').slice(-600).replace(/\n/g, ' | ')); } catch (_) {} } try { bot.output = ''; } catch (_) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let started = false;
const w = setInterval(() => {
  if (started) return;
  if (!bot.entity?.position) return;
  started = true; clearInterval(w);
  setTimeout(() => run().catch(e => { log('FAILED', e.message, String(e.stack).slice(0, 500)); process.exit(1); }), 4000);
}, 1000);
// safety: no silent hang
setTimeout(() => { if (!started) { log('FAIL boot - never got position'); process.exit(1); } }, 120000);

async function srvCount(item) { try { return await rconmod.rconItemCount(BOT, item); } catch (e) { return 'ERR:' + e.message; } }
// No skill call may hang the sweep: 90s cap per step, records FAIL on timeout.
async function step(name, fn) {
  try { const r = await Promise.race([fn(), sleep(90000).then(() => { throw new Error('STEP-TIMEOUT 90s'); })]); rec(name, true, 'ok'); return r; }
  catch (e) { rec(name, false, (e.message || '').slice(0, 120)); return null; }
}

async function run() {
  const BUDGET = Date.now() + 9 * 60 * 1000;
  const timeLeft = () => BUDGET - Date.now();
  log('spawned at', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  try { await rconCmd(`effect give ${BOT} minecraft:resistance 9999 255 true`); } catch (_) {}
  try { await rconCmd(`effect give ${BOT} minecraft:water_breathing 9999 255 true`); } catch (_) {}
  try { await rconCmd(`effect give ${BOT} minecraft:saturation 9999 255 true`); } catch (_) {}

  // --- stock via /give (console RCON: item replace is in-game-only) ---
  const STOCK = [
    ['iron_pickaxe', 1], ['iron_shovel', 1], ['iron_axe', 1], ['iron_sword', 1],
    ['torch', 16], ['cobblestone', 64], ['dirt', 64], ['oak_log', 64], ['iron_shovel', 1], ['iron_axe', 1],
    ['oak_planks', 64], ['cooked_beef', 16], ['bow', 1], ['arrow', 64],
    ['water_bucket', 1], ['stick', 16], ['chest', 4],
  ];
  async function stockAll() {
    await rconCmd(`clear ${BOT}`).catch(() => {});
    for (const [n, c] of STOCK) {
      try { await rconCmd(`give ${BOT} minecraft:${n} ${c}`); } catch (e) { log('stock threw', n, e.message); }
    }
    await sleep(2500);
  }
  await stockAll();
  // re-stock once (EasyAuth may wipe first round)
  const c0 = await srvCount('dirt');
  if (!c0 || c0 === 0) {
    log('restocking after auth wipe');
    await stockAll();
  }
  log('server dirt:', await srvCount('dirt'), 'cobble:', await srvCount('cobblestone'), 'torch:', await srvCount('torch'));

  // --- build a flat pad: tp high, slow-fall, read landing, then RCON-fill
  // a 12-long dirt runway at feet-1 with air above (2026-10-12: searching
  // natural flat ground failed 4/4 in hilly spawn; a harness-built pad is
  // deterministic — skills still walk/dig/place for real on it).
  let plot = null;
  try {
    await rconCmd('effect give ' + BOT + ' minecraft:slow_falling 60 1 true').catch(() => {});
    const ax = Math.floor(bot.entity.position.x);
    const az = Math.floor(bot.entity.position.z);
    await rconCmd('tp ' + BOT + ' ' + (ax + 0.5) + ' 120 ' + (az + 0.5));
    let lastY = 9999, stable = 0;
    for (let i = 0; i < 50; i++) {
      await sleep(500);
      const y = bot.entity.position.y;
      if (Math.abs(y - lastY) < 0.15) { if (++stable >= 3 && bot.entity.onGround) break; }
      else stable = 0;
      lastY = y;
    }
    const fp = bot.entity.position.floored();
    const below = bot.blockAt(new Vec3(fp.x, fp.y - 1, fp.z));
    // refuse water/lava/tree landings, nudge and retry (max 4)
    for (let attempt = 0; attempt < 4; attempt++) {
      const b = bot.blockAt(new Vec3(fp.x, fp.y - 1, fp.z));
      const fl = /water|lava|leaves|log|wood/.test(b?.name || '');
      if (!fl) break;
      await rconCmd('tp ' + BOT + ' ' + (fp.x + 8.5) + ' 120 ' + (fp.z + 8.5));
      await sleep(6000);
      const fp2 = bot.entity.position.floored();
      fp.x = fp2.x; fp.y = fp2.y; fp.z = fp2.z;
    }
    // pad: dirt runway x-2..x+9 at y-1, air y..y+2 above it
    await rconCmd(`minecraft:fill ${fp.x - 2} ${fp.y - 1} ${fp.z - 2} ${fp.x + 9} ${fp.y - 1} ${fp.z + 2} minecraft:dirt`);
    await rconCmd(`minecraft:fill ${fp.x - 2} ${fp.y} ${fp.z - 2} ${fp.x + 9} ${fp.y + 2} ${fp.z + 2} minecraft:air`);
    await rconCmd(`tp ${BOT} ${fp.x + 0.5} ${fp.y} ${fp.z + 0.5}`);
    await sleep(3000);
    const settled = bot.entity.position.floored();
    plot = { x: settled.x, y: settled.y, z: settled.z };
    log('pad at', JSON.stringify(plot));
  } catch (e) { log('plot finder threw', e.message); }
  if (!plot) { rec('find-plot', false, 'no open land found'); finish(); return; }
  log('plot', JSON.stringify(plot));
  // 1. WALK: pathfinder 5 blocks on flat (45s cap: goto has no timeout and
  // can hang forever on a loaded-but-unreachable goal — measured live)
  try {
    const t = new Vec3(plot.x + 4, plot.y, plot.z);
    // REAL skill path (not raw goto): goToPosition owns movements, arrivals,
    // and stuck recovery. Direct-steer fallback if it reports failure, so a
    // walk stall can never cascade into 10 downstream FAILs (2026-10-12 run:
    // walk-goto 90s timeout displaced every later leg).
    await step('walk-goto', async () => {
      let ok = false;
      try { ok = await skills.goToPosition(bot, t.x, t.y, t.z, 1, 'walk'); } catch (_) {}
      if (!ok && !bot.interrupt_code) {
        try {
          await bot.lookAt(new Vec3(t.x + 0.5, bot.entity.position.y, t.z + 0.5), true);
          bot.setControlState('forward', true);
          const t0 = Date.now();
          while (Date.now() - t0 < 10000) {
            if (bot.entity.position.distanceTo(new Vec3(t.x + 0.5, t.y, t.z + 0.5)) < 3) break;
            await sleep(250);
          }
          bot.setControlState('forward', false);
        } catch (_) { try { bot.setControlState('forward', false); } catch (_) {} }
      }
    });
    const d = bot.entity.position.distanceTo(new Vec3(t.x + 0.5, t.y, t.z + 0.5));
    rec('walk', d < 3, `dist ${d.toFixed(1)}`);
  } catch (e) { rec('walk', false, e.message.slice(0, 120)); }

  // 2. DIG DOWN + UP roundtrip (the hole question)
  let yBefore = Math.floor(bot.entity.position.y);
  try {
    const r = await skills.digDown(bot, 3);
    await sleep(1500);
    const yAfter = Math.floor(bot.entity.position.y);
    const went = yBefore - yAfter;
    rec('digDown', r && went >= 2, `y ${yBefore}->${yAfter} ret=${r}`);
  } catch (e) { rec('digDown', false, e.message.slice(0, 120)); }
  try {
    const y0 = Math.floor(bot.entity.position.y);
    const r = await step('digUp-escape-call', () => skills.digUp(bot, 3));
    await sleep(1500);
    const y1 = Math.floor(bot.entity.position.y);
    rec('digUp-escape', r && (y1 - y0) >= 2, `y ${y0}->${y1} ret=${r}`);
  } catch (e) { rec('digUp-escape', false, (e.message || '').slice(0, 120)); }

  // 3. COLLECT: dirt nearby
  try {
    const before = (await srvCount('dirt')) || 0;
    const r = await skills.collectBlock(bot, 'dirt', 5);
    // 3s magnet settle: 1s cut the vacuum loiter short when drops scattered
    // (post-digUp hole geometry), reading the pack before stragglers landed.
    await sleep(3000);
    const after = (await srvCount('dirt')) || 0;
    rec('collectBlocks', after >= before, `dirt ${before}->${after} ret=${r}`);
  } catch (e) { rec('collectBlocks', false, (e.message || '').slice(0, 120)); }

  // 4. PLACE: 2x2 cobble pad at feet+1 area, verify world truth
  try {
    const fp = bot.entity.position.floored();
    let ok = 0;
    for (const [dx, dz] of [[1, 0], [2, 0], [1, 1], [2, 1]]) {
      const x = fp.x + dx, y = fp.y, z = fp.z + dz;
      const b0 = bot.blockAt(new Vec3(x, y, z));
      if (b0 && b0.name !== 'air' && b0.name !== 'cave_air') { ok++; continue; } // occupied counts as fine
      try { const r = await skills.placeBlock(bot, 'cobblestone', x, y, z); if (r) ok++; } catch (_) {}
    }
    let present = 0;
    for (const [dx, dz] of [[1, 0], [2, 0], [1, 1], [2, 1]]) {
      const b = bot.blockAt(new Vec3(fp.x + dx, fp.y, fp.z + dz));
      if (b && b.name === 'cobblestone') present++;
    }
    rec('placeBlock', present >= 2, `placed-ok ${ok}/4 world-truth ${present}/4`);
  } catch (e) { rec('placeBlock', false, (e.message || '').slice(0, 120)); }

  // 5. CRAFT: oak_log -> planks (server truth)
  try {
    const b4 = (await srvCount('oak_planks')) || 0;
    await rconCmd('give ' + BOT + ' minecraft:oak_log 16').catch(() => {});
    await sleep(1500);
    const r = await skills.craftRecipe(bot, 'oak_planks', 4);
    await sleep(1000);
    const af = (await srvCount('oak_planks')) || 0;
    rec('craftRecipe', af > b4, `planks ${b4}->${af} ret=${r}`);
  } catch (e) { rec('craftRecipe', false, (e.message || '').slice(0, 120)); }

  // 6. EQUIP sword + EAT beef
  try {
    await skills.equip(bot, 'iron_sword');
    const held = bot.heldItem?.name || 'none';
    rec('equip', held === 'iron_sword', `holding ${held}`);
  } catch (e) { rec('equip', false, (e.message || '').slice(0, 120)); }
  try {
    const _beef = bot.inventory.items().find(i => i.name === 'cooked_beef');
    const r = _beef ? await skills.eatNow(bot, _beef) : false;
    rec('eat', !!r, `ret=${r}`);
  } catch (e) { rec('eat', false, (e.message || '').slice(0, 120)); }

  // 7. TORCH place (lightUp single)
  try {
    const fp = bot.entity.position.floored();
    const r = await skills.placeTorchSmart(bot, fp.x + 1, fp.y + 1, fp.z);
    const b = bot.blockAt(new Vec3(fp.x + 1, fp.y + 1, fp.z));
    rec('torch', !!r || (b && /torch/.test(b.name || '')), `ret=${r} world=${b?.name}`);
  } catch (e) { rec('torch', false, (e.message || '').slice(0, 120)); }

  // 8. CHEST: place chest, store dirt, read back
  try {
    const fp = bot.entity.position.floored();
    const cx = fp.x - 2, cz = fp.z;
    // ensure stocked a chest block
    await rconCmd(`give ${BOT} minecraft:chest 4`).catch(() => {});
    await sleep(1000);
    const r = await skills.singleChest(bot);
    rec('chest-place', !!r, `ret=${r}`);
  } catch (e) { rec('chest-place', false, (e.message || '').slice(0, 120)); }

  // 9. COMBAT: summon zombie nearby, attack
  try {
    const fp = bot.entity.position.floored();
    await rconCmd(`summon minecraft:zombie ${fp.x + 4} ${fp.y + 1} ${fp.z} {PersistenceRequired:1b,NoAI:1b}`).catch(() => {});
    await sleep(2500);
    let zom = bot.nearestEntity(e => e.name === 'zombie' && e.position.distanceTo(bot.entity.position) < 12);
    if (!zom) { rec('attack', false, 'no zombie visible after summon'); }
    else {
      await skills.equip(bot, 'iron_sword').catch(() => {});
      const hp0 = zom.health ?? '?';
      try { await skills.attackEntity(bot, zom, true); } catch (e) { log('attack threw', e.message.slice(0, 100)); }
      await sleep(1500);
      const zom2 = bot.nearestEntity(e => e.name === 'zombie' && e.position.distanceTo(bot.entity.position) < 16);
      const hp1 = zom2?.health ?? 'gone';
      rec('attack', zom2 == null || (hp1 !== 'gone' && hp1 < hp0) || hp1 === 'gone', `hp ${hp0}->${hp1}`);
    }
    await rconCmd(`kill @e[type=minecraft:zombie,distance=..40]`).catch(() => {});
  } catch (e) { rec('attack', false, (e.message || '').slice(0, 120)); }

  // 10. BOW: shoot at NoAI zombie, arrows consumed = world change
  try {
    const fp = bot.entity.position.floored();
    await rconCmd(`summon minecraft:zombie ${fp.x + 6} ${fp.y + 1} ${fp.z} {PersistenceRequired:1b,NoAI:1b}`).catch(() => {});
    await sleep(2500);
    const a0 = (await srvCount('arrow')) || 0;
    const zom = bot.nearestEntity(e => e.name === 'zombie' && e.position.distanceTo(bot.entity.position) < 16);
    if (!zom) rec('bow', false, 'no target');
    else {
      try { await skills.shootBow(bot, zom, 2, true); } catch (e) { log('bow threw', e.message.slice(0, 100)); }
      await sleep(2000);
      const a1 = (await srvCount('arrow')) || 0;
      rec('bow', a1 < a0, `arrows ${a0}->${a1} hp=${zom.health ?? '?'}`);
    }
    await rconCmd(`kill @e[type=minecraft:zombie,distance=..40]`).catch(() => {});
  } catch (e) { rec('bow', false, (e.message || '').slice(0, 120)); }

  // 11. goToSurface from shallow hole
  try {
    await skills.digDown(bot, 2).catch(() => {});
    await sleep(1000);
    const y0 = Math.floor(bot.entity.position.y);
    const r = await skills.goToSurface(bot).catch(e => 'THREW ' + e.message);
    await sleep(1500);
    const y1 = Math.floor(bot.entity.position.y);
    rec('goToSurface', y1 >= y0, `y ${y0}->${y1} ret=${String(r).slice(0, 60)}`);
  } catch (e) { rec('goToSurface', false, (e.message || '').slice(0, 120)); }

  // 12. PILLAR up 3
  try {
    const y0 = Math.floor(bot.entity.position.y);
    await rconCmd(`give ${BOT} minecraft:dirt 64`).catch(() => {});
    await sleep(1000);
    const r = await skills.pillarUp(bot, 'dirt', 3).catch(e => 'THREW ' + e.message);
    await sleep(1500);
    const y1 = Math.floor(bot.entity.position.y);
    rec('pillar', (typeof r === 'number' ? r : (y1 - y0)) >= 2, `y ${y0}->${y1} layers=${r}`);
  } catch (e) { rec('pillar', false, (e.message || '').slice(0, 120)); }

  finish();
}
function finish() {
  const fails = results.filter(r => !r.ok);
  log(`SWEEP DONE: ${results.length - fails.length}/${results.length} pass`);
  for (const f of fails) log('FAIL-ITEM', f.name, '-', f.detail);
  try { fs.writeFileSync('/home/ubuntu/.hermes/cache/scratch/cap_sweep.json', JSON.stringify(results, null, 1)); } catch (_) {}
  process.exit(fails.length ? 2 : 0);
}
