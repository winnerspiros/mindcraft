// Does the REAL world report water sources the way the offline fake assumes?
import mineflayer from 'mineflayer';
import * as mcdata from '../src/utils/mcdata.js';
import * as landwork from '../src/agent/library/landwork.js';

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'FloodProbe', version: (() => {
     const list = mineflayer.testedVersions || mineflayer.supportedVersions || [];
     if (list.includes('26.3')) return '26.3';
     return list.length ? list[list.length - 1] : '1.21.4';
 })(), auth: 'offline' });
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
bot.on('chat', (m) => log('CHAT', m));
const done = (code) => { console.log('RESULT ' + JSON.stringify(out.slice(-40))); process.exit(code); };
bot.once('error', e => { log('ERR', e.message); done(1); });
const t0 = Date.now();
const iv = setInterval(() => {
  if (bot.entity && bot.entity.position) {
    clearInterval(iv);
    const p = bot.entity.position;
    log('pos', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1));
    const g = landwork.terrainSampler(bot);
    // Read the raw water cells ourselves first, then compare with the survey.
    const seen = [];
    const R = 14;
    for (let x = Math.round(p.x-R); x <= Math.round(p.x+R); x++)
      for (let z = Math.round(p.z-R); z <= Math.round(p.z+R); z++)
        for (let y = Math.round(p.y-8); y <= Math.round(p.y+8); y++) {
          const st = g.getState(x,y,z);
          if (st && (st.name==='water'||st.name==='flowing_water')) seen.push({x,y,z,level:st.level});
        }
    log('raw water blocks found:', seen.length);
    log('levels seen:', JSON.stringify([...new Set(seen.map(s=>s.level))]));
    const survey = landwork.surveyFlood(g, {x:p.x,y:p.y,z:p.z}, R, 8);
    log('survey dry:', survey.dry, 'sources:', survey.sources.length, 'flowing:', survey.flowing.length);
    // Which sources are worth plugging? A whole lake is not a leak.
    if (survey.sources.length) {
      const ys = survey.sources.map(s => s.y);
      const byY = {};
      for (const s of survey.sources) byY[s.y] = (byY[s.y]||0)+1;
      log('source y-distribution:', JSON.stringify(byY));
      log('flood extent:', JSON.stringify(survey.extent));
      // An isolated source (no other source within 4) is a real leak.
      const isolated = survey.sources.filter(a =>
        survey.sources.every(b => b===a || Math.abs(b.x-a.x)>4 || Math.abs(b.z-a.z)>4 || Math.abs(b.y-a.y)>2));
      log('isolated sources (likely real leaks):', isolated.length, JSON.stringify(isolated.slice(0,8)));
      // The lowest sources drain the whole thing.
      const low = Math.min(...ys);
      log('lowest source y:', low, 'sources at that level:', byY[low]);
    }
    if (survey.sources.length) {
      const cls = landwork.classifySources(survey, {});
      log('CLASSIFY -> plugs:', cls.plugs.length, 'ponds left alone:', cls.ponds.length, 'clusters:', cls.clusters);
      log('the plugs:', JSON.stringify(cls.plugs));
      const aggressive = landwork.classifySources(survey, { aggressive: true });
      log('aggressive -> plugs:', aggressive.plugs.length, 'ponds:', aggressive.ponds.length);
      const plan = landwork.floodPlugPlan(survey, {x:Math.round(p.x),y:Math.round(p.y),z:Math.round(p.z)}, {material:'cobblestone'});
      log('plug plan blocks:', plan.blocks.length, JSON.stringify(plan.report));
    }
    done(0);
  }
  if (Date.now()-t0 > 90000) { clearInterval(iv); log('TIMEOUT no spawn'); done(1); }
}, 500);
