// Speak-gate tests.
//
// The suppressed cases below are VERBATIM lines from her own live log
// (journalctl -u uwu-bot.service, 71 replies sampled on 2026-10-01). Testing
// invented strings here would test nothing: the gate exists because those exact
// messages reached chat.

import { readFileSync } from 'node:fs';
import { gateNormalChat } from '../src/utils/speak_gate.js';

let pass = 0;
const ok = (m) => { console.log(`  ok - ${m}`); pass++; };
const bad = (m) => { console.error(`  NOT OK - ${m}`); process.exitCode = 1; };

const R = { self_prompt: false, human_replied: true, any_human: true, to_player: 'YandereDev' };
const v = (msg, over = {}) => gateNormalChat({ ...R, message: msg, ...over });

// ── must survive: real replies ────────────────────────────────────────────
const KEEP = [
    'ill go grab some wood',
    'my bad. its off now :/',
    'yeah i broke it. ill fix it',
    'no',
    "can't help it it's my charm",
    'gg',
    'wait what',
    // Banter and bite. The owner: "an all friendly, never verbal person is not
    // human for sure." The gate must NEVER be the thing that softens her — if a
    // rule here ever blocks a roast, she becomes a customer service bot.
    'kys',
    'skill issue',
    'lmao yeah',
    'no',
    'shut up',
    'ok and?',
    'who asked',
    'ur so bad at pvp',
    'thats dumb and you know it',
    'its a farm. it grows food. relax',
    'bro why would you do that :/',
    'which part? the one where i fell?',
];
for (const m of KEEP) {
    v(m).ok ? ok(`keeps reply: "${m}"`) : bad(`blocked a real reply: "${m}" (${v(m).why})`);
}

// ── must survive: commands, even long or self-initiated ───────────────────
// An action is not chatter. Gating it would break gameplay, which is the whole
// point of the self-prompt loop.
for (const m of ['!collectBlocks("oak_log", 10)', '!goToPlayer("YandereDev", 4)']) {
    const r = v(m, { self_prompt: true, human_replied: false });
    r.ok ? ok(`keeps command: ${m}`) : bad(`blocked a command: ${m} (${r.why})`);
}
// command + chat from a self-prompt turn: the chat is the problem, and it is
// narration aimed at nobody, so it goes.
{
    const r = v('im going to find YandereDev now !goToPlayer("YandereDev", 3)',
        { self_prompt: true, human_replied: false });
    r.ok ? bad('let narration through with a command attached')
         : ok(`suppresses narration wrapped around a command (${r.why})`);
}

// ── must be blocked: verbatim live failures ────────────────────────────────
const BLOCK = [
    ["hey yandereDev! it's me, your favorite clingy player 😅",
        { self_prompt: true, human_replied: false }, 'clingy opener'],
    ["where are you, YandereDev? I need you right now! these phantoms are relentless!",
        { self_prompt: true, human_replied: false }, 'pleading at nobody'],
    ["ok, i gotta find yandereDev now! heading to where i last saw them. this clingy v",
        { self_prompt: true, human_replied: false }, 'narrating intent'],
    ['ugh, another day, another phantom attack. hey everyone, just trying to survive out here. anyone got a plan for these things?',
        { self_prompt: true, human_replied: false }, 'room announcement'],
];
for (const [m, over, label] of BLOCK) {
    const r = v(m, over);
    !r.ok ? ok(`blocks ${label} (${r.why})`) : bad(`live failure got through: ${label}`);
}

// ── must be blocked: the generic classes ───────────────────────────────────
const CASES = [
    ['sooo i just woke up in this weird place. anyone want to show me around?', 'boot intro'],
    ['ugh, why are these phantoms everywhere?!', 'mood report to the room'],
    ['im definitely following yandereDev now', 'narration'],
];
for (const [m, label] of CASES) {
    const r = v(m, { self_prompt: true, human_replied: false });
    !r.ok ? ok(`blocks ${label} (${r.why})`) : bad(`got through: ${label}`);
}

// The one thing that must NEVER be gated: an empty server.
{
    const r = v('hey', { any_human: false });
    !r.ok ? ok(`blocks all chat when nobody is online (${r.why})`) : bad('spoke to an empty server');
}

// Silence must not become death: with a human present and having spoken to her,
// she talks freely.
{
    let n = 0;
    for (const m of KEEP) if (v(m).ok) n++;
    n === KEEP.length ? ok('every real reply passes — gate is not over-tight')
                      : bad(`gate is too tight: ${KEEP.length - n} real replies blocked`);
}

// ── regression: the boot path must not reintroduce a self-intro ───────────
// Setting settings.init_message to "" (how normal mode stopped announcing
// itself) used to fall into an unconditional else that called
// openChat("Hello world! I am " + name) — so silencing one message silently
// enabled a worse one. Assert no unconditional intro survives in normal mode.
{
    const src = readFileSync('src/agent/agent.js', 'utf8');
    // matches both template and concat forms: openChat("Hello world! I am " + name)
    const intro = /openChat\(\s*["'`]Hello world! I am ["'`]\s*(?:\+\s*|\$\{\s*)?(?:this\.)?name/;
    if (!intro.test(src)) bad('hardcoded Hello-world intro is gone entirely');
    else {
        const idx = src.search(intro);
        const before = src.slice(Math.max(0, idx - 400), idx);
        /else\s+if\s*\(\s*isYandere\(\)\s*\)/.test(before)
            ? ok('boot intro is yandere-only')
            : bad('boot intro is reachable in NORMAL mode');
    }
    // and the gate itself must exist at the choke point
    /gateNormalChat\(/.test(src)
        ? ok('gate is wired into agent.js')
        : bad('gate is never called');
}

console.log(`\nPASS — ${pass} speak-gate assertions green`);
