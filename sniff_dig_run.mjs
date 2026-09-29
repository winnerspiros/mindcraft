import mineflayer from '/home/ubuntu/uwu-bot/node_modules/mineflayer/index.js';
const bot = mineflayer.createBot({
  host: '127.0.0.1', port: 25565, username: "MFverify", auth: 'offline', version: '26.3',
});
const log = (...a) => console.log('[sniff]', ...a);
bot.on('login', () => { log('LOGGED_IN'); setTimeout(() => { try { bot.chat('/register STVNs3vwWffmZS0qWPnf STVNs3vwWffmZS0qWPnf'); log('sent /register'); } catch (e) { log('reg chat fail', e.message); } }, 3000); });
bot.on('chat', (user, msg) => { log('CHAT', user + ':', String(msg).slice(0, 120)); });
bot.on('spawn', async () => {
  log('SPAWNED at', String(bot.entity.position));
  await new Promise(r => setTimeout(r, 8000));
  log('POS after settle', String(bot.entity.position));
  // find a grass_block near but NOT the watched (6,67,19) / (5,66,18)
  const blocks = bot.findBlocks({ matching: (b) => b && b.name === 'grass_block', maxDistance: 16, count: 20 }) || [];
  log('found', blocks.length, 'grass near');
  let target = null;
  for (const p of blocks) {
    if ((p.x === 6 && p.y === 67 && p.z === 19) || (p.x === 5 && p.y === 66 && p.z === 18)) continue;
    target = p; break;
  }
  if (!target) { log('NO TARGET'); bot.quit(); process.exit(0); }
  const b = bot.blockAt(target);
  log('TARGET', target.x, target.y, target.z, 'name=', b.name, 'diggable=', b.diggable, 'hardness=', b.hardness);
  let dt = null;
  try { dt = bot.digTime(b); } catch (e) { dt = 'ERR ' + e.message; }
  log('digTime=', dt, 'held=', bot.heldItem ? bot.heldItem.name : 'none');
  const seen = [];
  bot._client.on('acknowledge_player_digging', (p) => { seen.push('ACK seq=' + p.sequenceId); log('IN ACK', JSON.stringify(p)); });
  bot._client.on('block_change', (p) => { seen.push('CHANGE t=' + p.type); log('IN CHANGE', JSON.stringify(p).slice(0, 200)); });
  bot._client.on('multi_block_change', (p) => { seen.push('MULTI'); log('IN MULTI', JSON.stringify(p).slice(0, 200)); });
  bot._client.on('block_break_animation', (p) => { seen.push('ANIM'); log('IN ANIM', JSON.stringify(p).slice(0, 200)); });
  log('digging...');
  const t0 = Date.now();
  try {
    await Promise.race([
      bot.dig(b, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT10')), 10000)),
    ]);
    log('DIG RESOLVED in', Date.now() - t0, 'ms');
  } catch (e) { log('DIG END:', e.message, 'after', Date.now() - t0, 'ms'); }
  await new Promise(r => setTimeout(r, 2000));
  log('PACKETS SEEN:', JSON.stringify(seen));
  try { const b2 = bot.blockAt(target); log('after name=', b2.name); } catch (e) { log('reread fail'); }
  bot.quit(); process.exit(0);
});
bot.on('kicked', (r) => { log('KICKED', r); process.exit(1); });
bot.on('error', (e) => { log('ERR', e.message); });
setTimeout(() => { log('GLOBAL TIMEOUT'); try { bot.quit(); } catch (_) {} process.exit(2); }, 90000);
