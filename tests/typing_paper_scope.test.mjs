// What arXiv 2510.08912 does and does NOT license us to build.
//
// Paper: "Beyond Words: Infusing Conversational Agents with Human-like Typing
// Behaviors" (Zhou, Hu et al.). Headline result: the agent combining hesitation
// AND self-editing was preferred (6/11) and scored highest on naturalness
// (M=3.00) and human-likeness (M=2.91).
//
// THAT RESULT ONLY HOLDS WHEN THE TYPING PROCESS IS VISIBLE. The whole
// apparatus - per-character streaming, a visible caret, backspaces, mid-word
// corrections - requires the user to watch the message being built. Elena's
// replies land in Minecraft public chat: one atomic block, read-only, no caret,
// no streaming, no retraction. None of it is observable.
//
// So the useful output of reading this paper is mostly a list of things NOT to
// build, plus the evidence that the paper's own preferred configuration is
// unreachable for us. This file pins both, because the pull toward implementing
// the headline result is strong and the result does not transfer.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'path';

// globSync only exists on Node 22+. `bun run test` resolves node to v26, but a
// bare `node tests/...` on this box is v19.8.1 and would die on the import
// before running a single assertion - which is exactly what happened the first
// time. So the corpus walk uses readdirSync and works on every version.
const globSync = (dir) => readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => dir + '/' + f);

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── the non-transferable machinery must NOT be in the source ──────────────
// If any of these appear, someone has tried to implement the visible-typing
// model in a medium that cannot show it.
const src = ['src/agent/agent.js', 'src/agent/modes.js', 'src/agent/self_prompter.js',
    'src/utils/chat_fragment.js', 'src/utils/speak_gate.js', 'src/utils/empty_ack.js',
    'src/utils/voice_monitor.js']
    .map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');

const NOT_TRANSFERABLE = [
    ['characterTypingPace', 'per-character typing speed (needs a visible caret)'],
    ['spaceLagPace', 'per-word hesitation (needs a visible caret)'],
    ['characterDeletionPace', 'backspace speed (needs a visible caret)'],
    ['cursorMovingSpeed', 'caret navigation (needs a visible caret)'],
    ['backspace', 'backspace simulation (message cannot be retracted)'],
    ['selfEdit', 'visible self-editing (message is delivered finished)'],
    ['streamChar', 'character-by-character streaming (chat renders a block)'],
];
for (const [needle, why] of NOT_TRANSFERABLE) {
    check(!new RegExp(needle, 'i').test(src),
        `no ${needle} in production source`,
        `${needle} is implemented but ${why}`);
}

// ── the survivors must actually be present ────────────────────────────────
// 1. reply-latency VARIANCE (not a fixed delay). This is the one lever from the
//    paper that survives: the interval before the message lands is observable
//    even though the composition is not.
check(/jitter|logUniform|rand\(\)|Math\.random/.test(src),
    'reply latency varies rather than being a fixed timer',
    'no latency variance in the send path');
check(!/setTimeout\([^)]*,\s*(15000|30000|45000)\s*\)/.test(src),
    'no single hardcoded fixed reply delay',
    'a fixed reply delay is back (robot cadence)');

// 2. message structure: bursts instead of one block.
check(readFileSync(new URL('../src/utils/chat_fragment.js', import.meta.url), 'utf8')
    .includes('fragmentForChat'),
    'long replies are fragmented into a burst',
    'bursting removed');

// ── what the corpus REFUTES, measured here so it cannot be re-added ────────
// These are the subagent's implementation suggestions. I measured each against
// this server's 868 real unique player lines and each one is wrong by a wide
// margin. The numbers are recomputed in this file, not hardcoded, so if the
// corpus changes the verdicts change with it.
const SYS = /^(Gave |Found \d+|Set the |Successfully|Unknown|You are not|Changed |Game mode|Time|Weather|Test |Removed |Cleared |Could not|Teleport|Spawn|Server |\[|Error|Your |Cannot|Invalid|Expected|No |Please|Usage)/i;
const lines = new Set();
for (const f of globSync('bots/UwU/histories')) {
    let d; try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    for (const m of (Array.isArray(d) ? d : (d.messages || []))) {
        if (!m || m.role !== 'user') continue;
        const c = String(m.content || '').replace(/^\s*\w{2,20}\s*:\s*/, '').trim();
        if (c && !SYS.test(c) && !c.startsWith('(AUTO')) lines.add(c);
    }
}
const n = lines.size;
check(n > 700, `corpus loaded for the refutation checks (${n} lines)`, `corpus too small: ${n}`);

// REFUTED: "inject 'actually,' / 'wait,' / 'I mean' into 10-15% of replies as
// residue of self-editing". Real rate on this server is 0.2%. Injecting at 10-15%
// would be 50-70x the human rate and instantly readable as a tic.
const ED = /\b(i mean|actually|wait|correction|hold on|erm+|uh |no i mean|sorry i meant|typo|or rather)\b/i;
const edRate = [...lines].filter((s) => ED.test(s)).length / n;
check(edRate < 0.01,
    `editing-residue rate measured at ${(edRate * 100).toFixed(1)}% — do NOT inject it at 10-15%`,
    `editing residue rate is ${(edRate * 100).toFixed(1)}%, which would change the persona rule`);

// REFUTED: "mirror the user's verbosity (paper reports R2=0.79)". Measured on
// 1024 real sessions / 30262 consecutive turn pairs, the correlation between
// one turn's length and the next is r=0.010. The paper's R2 is agent-word-count
// vs user-word-count inside a 5-message scripted study, which is not the same
// quantity as turn-to-turn length coupling in free chat.
const sess = [];
for (const f of globSync('bots/UwU/histories').sort()) {
    let d; try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    const seq = [];
    for (const m of (Array.isArray(d) ? d : (d.messages || []))) {
        if (!m) continue;
        const c = String(m.content || '').replace(/^\s*\w{2,20}\s*:\s*/, '').trim();
        if (c && !SYS.test(c) && !c.startsWith('(AUTO')) seq.push(c.split(/\s+/).length);
    }
    if (seq.length > 2) sess.push(seq);
}
const pairs = sess.flatMap((s) => s.slice(0, -1).map((v, i) => [v, s[i + 1]]));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
let cov = 0, sx = 0, sy = 0;
for (const [a, b] of pairs) { cov += (a - mx) * (b - my); sx += (a - mx) ** 2; sy += (b - my) ** 2; }
const r = cov / Math.sqrt(sx * sy);
check(Math.abs(r) < 0.15,
    `length-mirroring correlation r=${r.toFixed(3)} over ${pairs.length} turn pairs — no mirroring signal`,
    `length-mirroring r=${r.toFixed(3)}; if this rose, mirroring would be worth implementing`);

// ── the paper's own headline config must not be claimed as our result ──────
const persona = readFileSync(new URL('../personas/normal.json', import.meta.url), 'utf8');
check(!/hesitat|self-?edit|typing speed|backspace/i.test(persona),
    'persona makes no claim to reproduce the paper\'s typing model',
    'persona claims typing-behaviour behaviour we cannot actually deliver');

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} typing-paper applicability assertions green`);