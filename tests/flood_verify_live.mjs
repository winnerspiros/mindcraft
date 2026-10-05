// Did the water recede after the plug? Measure with the CACHED sampler — the
// first version scanned thousands of blocks with raw blockAt and took so long the
// run was killed before it finished. getState through terrainSampler hits the
// same world, just memoised.
import mineflayer from 'mineflayer';
import { createRequire } from 'module';
import * as landwork from '../src/agent/library/landwork.js';
import fs from 'fs';
const REPORT='/home/ubuntu/.hermes/cache/scratch/flood_verify.txt';
const log=(...a)=>{const s=a.join(' ');console.log(s);fs.appendFileSync(REPORT,s+'\n');};
fs.writeFileSync(REPORT,'');
const require=createRequire(import.meta.url);
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:'FloodVerify',auth:'offline',
  version:(()=>{const l=require('mineflayer');const list=l.testedVersions||l.supportedVersions||[];return list.includes('26.3')?'26.3':(list[list.length-1]||'1.21.4');})()});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let done=false; const fin=(c)=>{if(done)return;done=true;process.exit(c);};
bot.once('error',e=>{log('ERR',e.message);fin(1);});
const T={x:7,y:67,z:19};
const t0=Date.now();
const iv=setInterval(async()=>{
  if(!bot.entity||!bot.entity.position){ if(Date.now()-t0>60000){clearInterval(iv);log('TIMEOUT');fin(1);} return; }
  clearInterval(iv);
  const g=landwork.terrainSampler(bot);
  const p=bot.entity.position;
  log('probe at',p.x.toFixed(1),p.y.toFixed(1),p.z.toFixed(1));
  // 1. Is the plug still there?
  log('plug cell now:',JSON.stringify(g.getState(T.x,T.y,T.z)));
  // 2. Count water in a 10-block box around the old source, using cached reads.
  const cnt=(cx,cy,cz,R=10,H=6)=>{let n=0;for(let x=cx-R;x<=cx+R;x++)for(let z=cz-R;z<=cz+R;z++)for(let y=cy-H;y<=cy+H;y++){const st=g.getState(x,y,z);if(st&&(st.name==='water'||st.name==='flowing_water'))n++;}return n;};
  const now=cnt(T.x,T.y,T.z);
  log('water in 10-block box now:',now,'(was 32 before the plug)');
  // 3. Whole-area survey: sources and total volume.
  const s=landwork.surveyFlood(g,{x:p.x,y:p.y,z:p.z},14,8);
  log('survey: sources',s.sources.length,'flowing',s.flowing.length,'volume',s.volume);
  const cls=landwork.classifySources(s,{});
  log('classify: plugs',cls.plugs.length,'ponds',cls.ponds.length);
  log('remaining plugs:',JSON.stringify(cls.plugs));
  fin(0);
},500);
