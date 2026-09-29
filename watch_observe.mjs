import mineflayer from '/home/ubuntu/uwu-bot/node_modules/mineflayer/index.js';
import fs from 'node:fs';
// Observer probe: sits near UwU's pit, logs server-side break progress.
// Catches: block_break_animation (server->tracking clients per stage 0-9),
// block_change resyncs/breaks, and entityId->username map for anims.
const sniff = fs.readFileSync('/home/ubuntu/sniff_dig.mjs', 'utf8');
const pw = sniff.match(/\/register (\S+) \1/)[1];
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'MFw26301', auth: 'offline', version: '26.3' });
const log = (...a) => console.log('[watch]', ...a);
const id2name = new Map();
bot.on('login', () => { setTimeout(() => { try { bot.chat('/register ' + pw + ' ' + pw); } catch (_) {} }, 3000); });
bot.on('entitySpawn', (e) => {
  try { if (e && e.username) { id2name.set(e.id, e.username); log('MAP id=' + e.id + ' user=' + e.username); } } catch (_) {}
});
bot._client.on('block_break_animation', (p) => {
  let nm = id2name.get(p.entityId) || '';
  try {
    const ent = bot.entities ? bot.entities[p.entityId] : null;
    if (ent && ent.username) { nm = ent.username; id2name.set(p.entityId, nm); }
  } catch (_) {}
  log('ANIM entityId=' + p.entityId + ' user=' + (nm || '?') + ' stage=' + p.destroyStage + ' at ' + p.location.x + ',' + p.location.y + ',' + p.location.z);
});
bot._client.on('block_change', (p) => {
  log('CHANGE type=' + p.type + ' at ' + p.location.x + ',' + p.location.y + ',' + p.location.z);
});
bot.on('spawn', async () => {
  await new Promise(r => setTimeout(r, 30000));
  try {
    const bp = bot.entity.position;
    log('POS', bp.x.toFixed(1), bp.y.toFixed(1), bp.z.toFixed(1), 'onGround=', bot.entity.onGround);
    try {
      for (const [id, e] of Object.entries(bot.entities || {})) {
        if (e && e.username) { id2name.set(Number(id), e.username); log('MAP id=' + id + ' user=' + e.username); }
      }
    } catch (_) {}
  } catch (e) { log('POS-ERR', e.message); }
  // observe ~4 min while UwU grinds, then exit
  await new Promise(r => setTimeout(r, 240000));
  log('DONE');
  bot.quit(); process.exit(0);
});
bot.on('kicked', (r) => { log('KICKED', r); process.exit(1); });
bot.on('error', (e) => { log('ERR', e.message); });
setTimeout(() => { log('GLOBAL TIMEOUT'); try { bot.quit(); } catch (_) {} process.exit(2); }, 330000);
