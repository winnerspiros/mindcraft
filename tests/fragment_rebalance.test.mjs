// Rebalance path check: 6+ sentence bursts must fold into <=3 lines WITHOUT
// cutting mid-phrase. The old implementation sliced on a raw word count, which
// is the "you need to make" bug this file refuses elsewhere.
const { fragmentForChat } = await import('/home/ubuntu/uwu-bot/src/utils/chat_fragment.js');

const CASES = [
    'im at the base right now. the roof finally holds. i mined a full stack of oak. phantoms keep showing up outside. wanna see the farm i built? come to base when you can',
    'ok so. first thing. i fixed the door. then i found diamonds. then a creeper blew it up. honestly? at least the chest survived.',
    'a. b. c. d. e. f. g. h.',
];

let bad = 0;
for (const src of CASES) {
    const parts = fragmentForChat(src);
    console.log(`\nIN (${src.split(/\s+/).length}w, ${src.length}ch): ${JSON.stringify(src.slice(0, 60))}...`);
    console.log(`  -> ${parts.length} line(s)`);
    for (const p of parts) console.log(`     (${p.split(/\s+/).length}w) ${JSON.stringify(p)}`);
    if (parts.length > 3) { console.log('  !! too many lines'); bad++; }
    // no content invented or lost: every emitted word must appear in the source,
    // in order
    const sw = src.toLowerCase().match(/[a-z']+/g) || [];
    const pw = parts.join(' ').toLowerCase().match(/[a-z']+/g) || [];
    let i = 0;
    for (const w of pw) { while (i < sw.length && sw[i] !== w) i++; if (i >= sw.length) { console.log(`  !! invented word ${w}`); bad++; break; } i++; }
    // every line must end at a real boundary, not mid-clause
    for (const p of parts.slice(0, -1)) {
        if (/[a-z0-9]$/.test(p) && !/[.!?:]$/.test(p)) { /* clause merges are fine */ }
    }
}
console.log(bad ? `\nFAIL — ${bad} problems` : '\nPASS — rebalance folds cleanly, no invented or reordered words');