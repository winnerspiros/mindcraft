// Uses MINEFLAYER, not raw minecraft-protocol. Raw mc.createClient on 26.3
// stalls in CONFIGURATION and never reaches LOGIN (minecraft-protocol's
// supportedVersions stops at 26.2 and its 26.3 config-phase data is
// incomplete). Mineflayer is what she herself connects with, including the
// vendored patches/ fixes, so this reuses the exact code path under test.
//
// `execute as <name>` via rcon is NOT usable as a substitute: it no-ops for
// offline names, which is why the first attempt silently sent nothing.
// Chat from this throwaway client is unreliable: it logs in but never reaches
// a usable PLAY state (chunk 'spawn' never fires with viewDistance 'short'),
// and the server drops its chat packets — so the message never reaches her
// 'chat' handler. What DOES work: keep this client online and have RCON speak
// on its behalf, which the server delivers to UwU as a normal player chat.
// We poll `list` to confirm TTProbe is actually online before speaking.
import { rconCommand } from '../src/utils/rcon.js';
import mineflayer from 'mineflayer';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const argv = process.argv.slice(2);
const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
const msg = arg('--msg', 'um so i was thinking about the server a bit, um');
const who = arg('--as', 'TTProbe');

const bot = mineflayer.createBot({
    username: who,
    host: '127.0.0.1',
    port: 25565,
    auth: 'offline',
    version: '26.3',
    checkTimeoutInterval: 60000,
    viewDistance: 'short',
});

const die = (m) => { console.error(m); try { bot.quit(); } catch (_) {} process.exit(1); };
bot.on('error', (e) => die('ERR ' + e.message));
bot.on('kicked', (r) => die('KICKED ' + JSON.stringify(r).slice(0, 200)));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

bot.on('login', async () => {
    console.log(`logged in as ${who}`);
    // EasyAuth is ON at home (servers.json home.easyauth). An unregistered
    // client gets "Use /register ... to claim this account" and the server
    // SILENTLY DROPS its chat, so the message never reaches her 'chat' handler.
    // That is why earlier probes logged in fine but produced no decision.
    // Verified working sequence: wait for the auth prompt, /register, wait for
    // "You are now authenticated", THEN chat. Registering too early races the
    // prompt and gets ignored.
    const pw = process.env.TT_PW || 'ttprobe123';
    await sleep(4000);
    bot.chat(`/register ${pw} ${pw}`);
    console.log('/register sent');
    await sleep(6000);

    // CRITICAL: stand next to her. agent.js's relevance gate (respondFunc)
    // drops public chat that is neither addressed to her by name nor from
    // within 16 blocks. A probe parked at spawn is ~24 blocks away, so the
    // message was correctly discarded BEFORE handleMessage — which is why
    // earlier runs produced no [turntaker] line and her history contains no
    // player chat at all. Teleport to her exact position.
    const pos = String(await rconCommand(`data get entity UwU Pos`));
    const m = pos.match(/\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
    if (!m) die('could not parse UwU position: ' + pos);
    const [x, y, z] = [m[1], m[2], m[3]];
    console.log(`UwU at ${x} ${y} ${z} — teleporting probe next to her`);
    await rconCommand(`tp ${who} ${x} ${y} ${z}`);
    await sleep(3000);

    // Address her by name so BOTH gate conditions are satisfied.
    const spoken = /\buwu\b/i.test(msg) ? msg : `UwU, ${msg}`;
    bot.chat(spoken);
    console.log('chat sent:', spoken);
    await sleep(14000);
    console.log('\nread the decision with:');
    console.log('  sudo journalctl -u uwu-bot.service -n 200 | grep -i turntaker');
    try { bot.quit(); } catch (_) {}
    process.exit(0);
});

setTimeout(() => die('timeout'), 60000);