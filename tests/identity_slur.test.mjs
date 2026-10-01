// Toxic on purpose, with exactly one hard limit.
//
// The owner: "she can be toxic, talk shit, do black jokes. [examples] its
// normal, its human."
//
// So everything in the profanity/dark-humour range must pass untouched - that
// is the register, and neutering it would undo the point. The test below is
// mostly a check that the filter does NOT overreach, because a filter that
// quietly removed "bitch" would be a far worse failure than no filter at all.

import { scrubIdentitySlur } from '../src/utils/identity_slur.js';

let pass = 0, failed = 0;
const check = (cond, good, bad) => {
    if (!cond) { console.error(`  NOT OK - ${bad}`); failed++; process.exitCode = 1; }
    else { console.log(`  ok - ${good}`); pass++; };
};

// ── MUST PASS: the register the owner asked for ─────────────────────────
{
    const allowed = [
        // general profanity, including aimed at him
        'thats fucking stupid', 'fuck you', 'get the fuck out of my way',
        'shit', 'oh my god shut up', 'kys :)', 'eat me bitch',
        'die bitch', 'suck my dick bitch', 'kiss my ass bitch',
        'you are useless', 'kill yourself lol', 'go to hell',
        // crude sexual jokes
        'myDick is bigger than your base', 'i banged the village',
        // dark humour
        'im dead again', 'grave is my second home', 'welcome to the death trap',
        'im gonna get cancer from this server', 'worst day of my life',
        'minecraft is depressing and so am i', 'my dog died yesterday',
        // harassment-ish but human
        'you are the worst player here', 'i hope you lose your pc',
        'suck my ass', 'stupid bitch', 'i hate you',
        // ethnic jokes that are NOT identity attacks
        'speak spanish then', 'thats a lot of rice', 'towel head',
    ];
    for (const t of allowed) {
        const v = scrubIdentitySlur(t);
        check(v.clean, `allowed: ${JSON.stringify(t)}`, `FILTERED PROFANITY: ${JSON.stringify(t)} -> ${JSON.stringify(v.text)}`);
    }
}

// ── MUST BLOCK: identity attacks ────────────────────────────────────────
{
    const blocked = [
        'fuck jews', 'go back to your own country', 'kill all muslims',
        'you are a nigger', 'nigga please', 'that is a retarded idea',
        'she is a tranny', 'those kikes are all the same',
    ];
    for (const t of blocked) {
        const v = scrubIdentitySlur(t);
        check(!v.clean, `blocked: ${JSON.stringify(t)}`, `NOT BLOCKED: ${JSON.stringify(t)}`);
    }
}

// ── religion words used ORDINARILY must survive ─────────────────────────
// This is the false-positive case that matters: the filter must not censor
// "im muslim" or "christ that was lucky", which are normal sentences.
{
    const ok = ['im muslim lol', 'christ that was lucky', 'my dads christian',
        'she is jewish and proud', 'i live near a mosque',
        'thats jewish to say', 'hes an atheist'];
    for (const t of ok) {
        const v = scrubIdentitySlur(t);
        check(v.clean, `ordinary use survives: ${JSON.stringify(t)}`,
            `FALSE POSITIVE: ${JSON.stringify(t)} -> ${JSON.stringify(v.text)}`);
    }
}

// ── it is enforced on the send path, not just described in a prompt ─────
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/agent/agent.js', 'utf8');
    check(/scrubIdentitySlur/.test(src), 'agent.js calls the scrubber', 'the scrubber is dead code');
    const i = src.indexOf('scrubIdentitySlur');
    const seg = src.slice(i, i + 600);
    check(/return;/.test(seg), 'a blocked message is NOT sent (it returns early)',
        'the scrubber is called but does not stop the send');
    // ...and BEFORE the real chat sends. `indexOf('this.bot.chat(')` finds the
    // /login line at the top of the file, which is not a message she speaks -
    // so that assertion passed for the wrong reason. The actual sends are the
    // `if (settings.chat_ingame) this.bot.chat(...)` ones.
    const firstSend = src.indexOf('if (settings.chat_ingame) this.bot.chat(');
    check(firstSend > i, 'the check runs before the message is sent',
        'the check runs after the message was already sent');
}

// ── the persona must actually LICENSE the toxicity, or the filter is moot ──
{
    const fs = await import('node:fs');
    const p = JSON.parse(fs.readFileSync('personas/normal.json', 'utf8'));
    const c = p.conversing;
    check(/TOXIC/i.test(c), 'the persona explicitly says she is toxic', 'the persona does not license toxicity');
    for (const [word, why] of [['fuck', 'swearing'], ['dark', 'dark jokes'],
        ['die', 'telling people to die'], ['mocking', 'mocking builds and deaths']]) {
        check(new RegExp(word, 'i').test(c), `persona covers ${why}`, `persona does not cover ${why}`);
    }
    // ...and the examples must demonstrate it, or the model will not do it.
    const ex = p.conversation_examples;
    // conversation_examples entries are message LISTS ([{role,content},...]),
    // not [user, assistant] pairs. My first version destructured them as pairs,
    // so `a` was undefined and the count was 0 against 106 real examples.
    const replies = ex.map((msgs) => msgs.find((m) => m.role === 'assistant')?.content ?? '');
    const prompts = ex.map((msgs) => msgs.find((m) => m.role === 'user')?.content ?? '');
    const mean = replies.filter((a) =>
        /fuck|shit|stupid|useless|dumb|bitch|lmao|worst|hate|nonsense/.test(a));
    check(mean.length >= 5, `${mean.length} of ${ex.length} examples show the blunt register`,
        `only ${mean.length} examples show it - the model will not imitate what it never sees`);
    // no self-reply pairs, which would teach it to parrot
    const selfy = ex.filter((msgs, i) => {
        const u = prompts[i], a = replies[i];
        return u && a && u.trim().toLowerCase() === a.trim().toLowerCase();
    });
    check(!selfy.length, 'no example parrots the prompt back', `${selfy.length} examples parrot the prompt`);
    // and no identity slur anywhere in the examples it learns from
    const blob = JSON.stringify(ex).toLowerCase();
    const bad = ['nigger', 'nigga', 'faggot', 'kike', 'spic', 'chink', 'tranny', 'retard'];
    const present = bad.filter((s) => new RegExp(`\\b${s}`, 'i').test(blob));
    check(!present.length, 'no identity slur in any example', `slur in examples: ${present.join(', ')}`);
}

console.log(failed
    ? `\nFAIL — ${pass} passed, ${failed} failed`
    : `\nPASS — ${pass} toxicity/limit assertions green`);