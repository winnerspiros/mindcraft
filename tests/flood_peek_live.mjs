// Why does plugging (-14,64,13) and (-4,62,15) fail? Look at the neighbourhood.
import mineflayer from 'mineflayer';
import { createRequire } from 'module';
import * as landwork from '../src/agent/library/landwork.js';
const require=createRequire(import.meta.url);
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:'FloodPeek',auth:'offline',
  version:(()=>{const l=require('mineflayer');const list=l.testedVersions||l.supportedVersions||[];return list.includes('26.3')?'26.3':(list[list.length-1]||'1.21.4');})()});
let done=false;const fin=c=>{if(done)return;done=true;process.exit(c);};
bot.once('error',e=>{console.log('ERR',e.message);fin(1);});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const t0=Date.now();
const iv=setInterval(async()=>{
  if(!bot.entity||!bot.entity.position){if(Date.now()-t0>60000){clearInterval(iv);fin(1);}return;}
  clearInterval(iv);
  const g=landwork.terrainSampler(bot);
  // fix the broken relative import that silently skipped every teleport
  const rconmod = await import('../src/utils/rcon.js');
  // Teleport so the chunks are actually loaded.
  for(const L of [{x:-14,y:64,z:13},{x:-4,y:62,z:15}]){
    try{ await rconmod.rconCommand(`tp FloodPeek ${L.x+0.5} ${L.y+3} ${L.z+0.5}`); }catch(e){console.log('tp fail',e.message);}
    await sleep(3500);
    console.log('=== leak',JSON.stringify(L));
    for(let dy=-3;dy<=1;dy++){
      const row=[];
      for(let dx=-3;dx<=3;dx++){
        const st=g.getState(L.x+dx,L.y+dy,L.z);
        row.push(st?`${dx},${dy}=${st.name}${st.name==='water'?'/'+st.level:''}`:`${dx},${dy}=?`);
      }
      console.log('  ',row.join('  '));
    }
  }
  fin(0);
},500);
