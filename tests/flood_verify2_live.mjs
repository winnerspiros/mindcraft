// Plug the two remaining leaks and confirm the flood keeps stopping.
import mineflayer from 'mineflayer';
import { createRequire } from 'module';
import * as landwork from '../src/agent/library/landwork.js';
import * as rconmod from '../src/utils/rcon.js';
import fs from 'fs';
const REPORT='/home/ubuntu/.hermes/cache/scratch/flood_verify2.txt';
const log=(...a)=>{const s=a.join(' ');console.log(s);fs.appendFileSync(REPORT,s+'\n');};
fs.writeFileSync(REPORT,'');
const require=createRequire(import.meta.url);
function plugin(mod,...keys){if(typeof mod==='function')return mod;for(const k of [...keys,'default','plugin'])if(typeof mod?.[k]==='function')return mod[k];throw new Error('no plugin');}
const BOT='FloodStop2';
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:BOT,auth:'offline',
  version:(()=>{const l=require('mineflayer');const list=l.testedVersions||l.supportedVersions||[];return list.includes('26.3')?'26.3':(list[list.length-1]||'1.21.4');})()});
bot.loadPlugin(plugin(require('mineflayer-pathfinder'),'pathfinder'));
bot.loadPlugin(plugin(require('mineflayer-collectblock'),'plugin'));
bot.loadPlugin(plugin(require('mineflayer-tool'),'tool'));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let done=false; const fin=(c)=>{if(done)return;done=true;log('DONE');process.exit(c);};
bot.once('error',e=>{log('ERR',e.message);fin(1);});
bot.on('chat',m=>log('CHAT',m));
const LEAKS=[{x:-14,y:64,z:13},{x:-4,y:62,z:15}];
const t0=Date.now();
const iv=setInterval(async()=>{
  if(!bot.entity||!bot.entity.position){ if(Date.now()-t0>60000){clearInterval(iv);log('TIMEOUT');fin(1);} return; }
  clearInterval(iv);
  const g=landwork.terrainSampler(bot);
  await sleep(3500);
  try{await rconmod.rconCommand('/register flo2test flo2test');}catch(_){}
  await sleep(3500);
  // TWO stacks, and one in the hotbar: pre-clear scoops water with whatever is
  // held, so a single stack in slot 9 ended up held and then spent. "must be
  // holding an item to place" is the symptom of that.
  await rconmod.rconCommand(`item replace entity ${BOT} hotbar.0 with minecraft:cobblestone 64`);
  await rconmod.rconCommand(`item replace entity ${BOT} inventory.9 with minecraft:cobblestone 64`);
  await sleep(2500);
  log('cobblestone on server:',await rconmod.rconItemCount(BOT,'cobblestone'));
  for (const L of LEAKS){
    const st=g.getState(L.x,L.y,L.z);
    log('leak',JSON.stringify(L),'is now:',JSON.stringify(st));
    if(!st||st.name!=='water'){log('  already dry, skipping');continue;}
    try{await rconmod.rconCommand(`tp ${BOT} ${L.x+1.5} ${L.y+1} ${L.z+0.5}`);}catch(e){log('tp fail',e.message);}
    await sleep(2500);
    const survey={sources:[L],flowing:[],volume:1,extent:{minX:L.x,maxX:L.x,minY:L.y,maxY:L.y,minZ:L.z,maxZ:L.z},dry:false};
    const plan=landwork.floodPlugPlan(survey,{x:L.x,y:L.y,z:L.z},{plugs:[L],ground:g});
    log('  plan blocks:',plan.blocks.length,'clearBefore:',JSON.stringify(plan.clearBefore),JSON.stringify(plan.report));
    const sum=await landwork.placeGenerated(bot,plan);
    log('  placed',sum.placed,'/',sum.of,'faults',sum.faults,'cleared',sum.cleared,'-> now:',JSON.stringify(g.getState(L.x,L.y,L.z)));
    log('  cell below now:',JSON.stringify(g.getState(L.x,L.y-1,L.z)));
  }
  await sleep(9000);
  const p=bot.entity.position;
  const s=landwork.surveyFlood(g,{x:p.x,y:p.y,z:p.z},14,8);
  log('FINAL survey: sources',s.sources.length,'flowing',s.flowing.length,'volume',s.volume);
  const cls=landwork.classifySources(s,{});
  log('FINAL leaks remaining:',cls.plugs.length,JSON.stringify(cls.plugs));
  log('output tail:',String(bot.output||'').split('\n').slice(-5).join(' | '));
  fin(0);
},500);
