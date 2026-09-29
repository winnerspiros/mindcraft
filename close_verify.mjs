import mineflayer from '/home/ubuntu/uwu-bot/node_modules/mineflayer/index.js';
import fs from 'node:fs';
// Controlled probe: digs a buried close-range stone like UwU's failing targets.
// Password is read from the historical working probe at runtime (never logged).
const sniff = fs.readFileSync('/home/ubuntu/sniff_dig.mjs', 'utf8');
const pw = sniff.match(/\/register (\S+) \1/)[1];
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: "MFv81193", auth: 'offline', version: '26.3' });
const log = (...a) => console.log('[verify]', ...a);
bot.on('login', () => { setTimeout(() => { try { bot.chat('/register ' + pw + ' ' + pw); } catch (_) {} }, 3000); });
bot.on('spawn', async () => {
  // Long settle: operator TPs this probe next to the buried target via RCON.
  await new Promise(r => setTimeout(r, 25000));
  const bp = bot.entity.position;
  log('POS', String(bp), 'onGround=', bot.entity.onGround);
  const eye = bp.offset(0, 1.62, 0);
  const blocks = bot.findBlocks({ matching: (b) => b && b.name === 'stone', maxDistance: 10, count: 40 }) || [];
  let best = null, bestD = 1e9;
  for (const p of blocks) {
    const d = Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y, p.z + 0.5 - eye.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best || bestD > 3.0) { log('NO CLOSE STONE bestD=', bestD === 1e9 ? 'none' : bestD.toFixed(2)); bot.quit(); process.exit(0); }
  const b = bot.blockAt(best);
  let dt = null;
  try { dt = bot.digTime(b); } catch (e) { dt = 'ERR'; }
  log('TARGET', best.x, best.y, best.z, 'eyeDist=', bestD.toFixed(2), 'clientDigTime=', dt, 'held=', bot.heldItem ? bot.heldItem.name : 'none');
  try { const above = bot.blockAt(best.offset(0, 1, 0)); log('ABOVE=', above ? above.name : 'none'); } catch (_) {}
  bot._client.on('acknowledge_player_digging', (p) => { log('IN ACK seq=' + p.sequenceId); });
  bot._client.on('block_change', (p) => { log('IN CHANGE type=' + p.type + ' at ' + p.location.x + ',' + p.location.y + ',' + p.location.z); });
  bot._client.on('block_break_animation', (p) => { log('IN ANIM stage=' + p.destroyStage); });
  bot.on('diggingCompleted', () => { log('EVENT diggingCompleted'); });
  bot.on('diggingAborted', () => { log('EVENT diggingAborted'); });
  const t0 = Date.now();
  try {
    await Promise.race([bot.dig(b, true), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT30')), 30000))]);
    log('DIG RESOLVED in', Date.now() - t0, 'ms');
  } catch (e) { log('DIG END:', e.message, 'after', Date.now() - t0, 'ms'); }
  await new Promise(r => setTimeout(r, 2000));
  try { log('after name=', bot.blockAt(best).name); } catch (e) { log('reread fail'); }
  bot.quit(); process.exit(0);
});
bot.on('kicked', (r) => { log('KICKED', r); process.exit(1); });
bot.on('error', (e) => { log('ERR', e.message); });
setTimeout(() => { log('GLOBAL TIMEOUT'); try { bot.quit(); } catch (_) {} process.exit(2); }, 150000);
