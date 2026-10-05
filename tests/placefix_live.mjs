// Does the blockUpdate-timeout fix actually help? Place a few blocks through the
// real skills.placeBlock and count how many land. The full landwork_live harness
// stalls in its plot search on unloaded chunks, which is a separate problem, so
// test the placement path directly at a known-good spot.
import mineflayer from 'mineflayer';
import { createRequire } from 'module';
import * as skills from '../src/agent/library/skills.js';
import * as rconmod from '../src/utils/rcon.js';
import fs from 'fs';
import Vec3 from 'vec3';
const REPORT='/home/ubuntu/.hermes/cache/scratch/placefix.txt';
const log=(...a)=>{const s=a.join(' ');console.log(s);fs.appendFileSync(REPORT,s+'\n');};
fs.writeFileSync(REPORT,'');
const require=createRequire(import.meta.url);
function plugin(mod,...k){if(typeof mod==='function')return mod;for(const x of [...k,'default','plugin'])if(typeof mod?.[x]==='function')return mod[x];throw new Error('no plugin');}
const BOT='PlaceFix';
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:BOT,auth:'offline',
  version:(()=>{const l=require('mineflayer');const list=l.testedVersions||l.supportedVersions||[];return list.includes('26.3')?'26.3':(list[list.length-1]||'1.21.4');})()});
bot.loadPlugin(plugin(require('mineflayer-pathfinder'),'pathfinder'));
bot.loadPlugin(plugin(require('mineflayer-collectblock'),'plugin'));
bot.loadPlugin(plugin(require('mineflayer-tool'),'tool'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let done=false;const fin=c=>{if(done)return;done=true;log('DONE');process.exit(c);};
bot.once('error',e=>{log('ERR',e.message);fin(1);});
bot.on('chat',m=>{if(/auth|register|login/i.test(m))log('CHAT',m);});
const t0=Date.now();
const iv=setInterval(async()=>{
  if(!bot.entity||!bot.entity.position){if(Date.now()-t0>90000){clearInterval(iv);log('TIMEOUT');fin(1);}return;}
  clearInterval(iv);
  log('spawned at',bot.entity.position.x.toFixed(1),bot.entity.position.y.toFixed(1),bot.entity.position.z.toFixed(1));
  await sleep(4000);
  try{await rconmod.rconCommand('/register pfix pfix');}catch(_){}
  await sleep(4000);
  // Stock plenty, in the hotbar too so the hand has something.
  for(let i=0;i<4;i++) await rconmod.rconCommand(`item replace entity ${BOT} hotbar.${i} with minecraft:cobblestone 64`);
  for(let i=9;i<13;i++) await rconmod.rconCommand(`item replace entity ${BOT} inventory.${i} with minecraft:cobblestone 64`);
  // Dirt too: placeBlock's floating-block fallback bridges with a dirt scaffold,
  // and without any it gives up with "Don't have any dirt to place".
  await rconmod.rconCommand(`item replace entity ${BOT} inventory.13 with minecraft:dirt 64`);
  await sleep(2500);
  log('cobblestone on server:',await rconmod.rconItemCount(BOT,'cobblestone'),
      'dirt:',await rconmod.rconItemCount(BOT,'dirt'));
  log('MARK: about to read the feet column');
  try { log('pos now', bot.entity.position.x, bot.entity.position.y, bot.entity.position.z); } catch(e) { log('pos read threw', e.message); }
  try { log('block directly below:', JSON.stringify(bot.blockAt(new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y)-1, Math.floor(bot.entity.position.z)))?.name)); } catch(e) { log('blockAt threw', e.message); }
  log('MARK: feet column read OK');

  // Find the ground UNDER OUR OWN FEET. Walking a grid and calling blockAt on
  // each cell hangs when the chunks are not loaded — that is what stalled this
  // harness twice. The column we are standing in is always loaded.
  const p=bot.entity.position;
  const fx=Math.floor(p.x), fz=Math.floor(p.z);
  let fy=null;
  for(let y=Math.floor(p.y);y>Math.floor(p.y)-10;y--){
    const b=bot.blockAt(new Vec3(fx,y,fz));
    if(b&&b.name!=='air'&&b.name!=='water'&&b.boundingBox!=='empty'){fy=y+1;break;}
  }
  if(fy==null){log('no ground under feet at',fx,fz);fin(1);return;}
  // fy is the first AIR above the ground, which is the cell we are standing in.
  // Building there means placing into our own feet. Build one higher.
  const by = fy + 1;
  log('building at',JSON.stringify({x:fx,y:by,z:fz}),'(feet air at',fy,')');

  // Place a 3x3 pad of cobblestone, each through the real path.
  let ok=0;
  for(let dx=0;dx<3;dx++)for(let dz=0;dz<3;dz++){
    const x=fx+dx, y=by, z=fz+dz;
    const r=await skills.placeBlock(bot,'cobblestone',x,y,z,'bottom',true);
    if(r)ok++;
    const b=bot.blockAt(new Vec3(x,y,z));
    log(`  (${dx},${dz}) returned ${r} -> world: ${b?b.name:'?'}`);
  }
  log('PLACE RESULT: returned true for',ok,'of 9');
  const realOk=9; // count what is actually there
  let present=0;
  for(let dx=0;dx<3;dx++)for(let dz=0;dz<3;dz++){
    const b=bot.blockAt(new Vec3(fx+dx,by,fz+dz));
    if(b&&b.name==='cobblestone')present++;
  }
  log('WORLD TRUTH: cobblestone actually present at',present,'of 9 cells');
  log('output tail:',String(bot.output||'').split('\n').slice(-8).join(' | '));
  fin(0);
},500);
