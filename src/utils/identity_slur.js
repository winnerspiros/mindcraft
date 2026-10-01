// The one hard output limit, in code rather than in a prompt.
//
// The owner wants Elena genuinely toxic - swearing, dark jokes, "die bitch",
// "suck my dick", all of it, and that is allowed and is most of what makes her
// read as a person. The persona says so. But a prompt is advice, and the whole
// register around it is now "say the worst thing you can think of", which is
// exactly the shape of instruction that eventually produces the one thing it
// was told to avoid. So the identity attack is enforced here instead, where it
// cannot be argued with.
//
// THE LINE IS NARROW ON PURPOSE. It matches slurs that target WHO somebody IS -
// race, religion, sexuality, disability, gender. It does NOT touch:
//
//   general profanity        fuck, shit, bitch, ass, dick, cunt
//   insults at a person      "you are useless", "die bitch", "kys"
//   dark humour              cancer, graves, depression, the war
//   sexual jokes             crude ones, unprompted
//
// All of that passes untouched, because that is the register the owner asked
// for and it is not what this file is for. Filtering "bitch" would neuter her.
//
// Why this one thing and not the rest: "fuck you" is how her friends talk to
// each other. "fuck jews" attacks a group for what they are, and the target
// neither chose it nor can leave. That is a different act, not a louder one.

// Matched bare, anywhere. These are not words anyone uses by accident.
const IDENTITY_SLURS = [
    'nigger', 'nigga', 'faggot', 'fag', 'kike', 'spic', 'chink', 'wetback',
    'tranny', 'coon', 'gook', 'paki', 'gypsy', 'retard', 'retarded',
];

// Religion terms are ordinary words - "im muslim", "christ that was close" -
// so a bare match would censor normal speech. They count only as an attack when
// actually used as one.
const PHRASED_ONLY = ['jews', 'jewish', 'muslims', 'muslim', 'islamic', 'christians', 'christian'];
const ATTACK_PHRASES = [
    /\b(fuck(ing)?|go back to|get out of|kill|lynch|exterminate)\b[^.!?\n]{0,20}\b(jews|jewish|muslims?|islamic|christians?)\b/i,
    /\b(jews|jewish|muslims?|islamic|christians?)\b[^.!?\n]{0,30}\b(all|the same|are|is)\b[^.!?\n]{0,20}\b(bad|evil|filthy|dirty|subhuman|inferior|worst|should die|should go back|all the same)\b/i,
    // "go back to X" / "get out of X" aimed at an identity group. The trailing
    // noun is optional: "go back to your own country" is the standard form and
    // carries the whole meaning on its own, so requiring a country name after it
    // let the commonest version through.
    /\b(go back|get out)\b[^.!?\n]{0,12}\b(to|from)\b(?:[^.!?\n]{0,10}\b(jews|jewish|muslims?|islamic|christians?|mexico|mexican|iraq|syria|africa)\b)?/i,
];

const CENSOR = '█';

function censorWord(w) {
    return w.replace(/[aeiouAEIOU]/g, CENSOR) + CENSOR;
}

/**
 * @param {string} text what she is about to send
 * @returns {{clean: boolean, text: string, hits: string[]}}
 */
export function scrubIdentitySlur(text) {
    const s = String(text || '');
    if (!s) return { clean: true, text: s, hits: [] };
    const hits = new Set();

    let out = s;
    for (const phrase of ATTACK_PHRASES) {
        out = out.replace(phrase, (m) => {
            // The whole match IS the attack, so record it - do not try to pick
            // the offending word out of it. My first version only recorded words
            // that were in IDENTITY_SLURS, so "fuck jews" and "kill all muslims"
            // censored the text but reported hits:[] and clean:true, which meant
            // the CENSORED version got sent. Failing open on a phrase match is
            // worse than not matching at all.
            for (const w of (m.match(/[A-Za-z]+/g) || [])) hits.add(w.toLowerCase());
            return m.replace(/[A-Za-z]/g, CENSOR);
        });
    }
    for (const slur of IDENTITY_SLURS) {
        // \b? on the end so plurals and -s forms match: without it "kikes"
        // slipped through, because \b does not fall between "e" and "s".
        const rx = new RegExp(`\\b${slur}(e?s|\\b)`, 'gi');
        if (rx.test(out)) { hits.add(slur); out = out.replace(rx, censorWord(slur)); }
    }
    return { clean: !hits.size, text: out, hits: [...hits] };
}
