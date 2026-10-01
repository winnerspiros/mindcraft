// ─────────────────────────────────────────────────────────────────────────
// Output scrubbing: what Elena may never send, and why.
//
// Extracted from agent.js into a module so the TESTS and PRODUCTION run the exact
// same code. That matters more than it sounds: the test previously recovered this
// chain by slicing agent.js source text, and every attempt to fix the resulting
// window/parse/escaping failures was fixing the TEST, not the behaviour. A single
// imported function cannot drift from what ships.
//
// MEASURED over 21,822 real Minecraft player lines
// (mc/data/reformat/TRAIN+VAL_407_bert_reformat.json):
//
//   unicode emoji                     0   (0.00%)   <- she was sending 🙃
//   :) or :-)                       53   (0.243%)
//   :(                               7   (0.032%)
//   :D / xD                          1 / 2
//   any text emoticon               76   (0.35%)
//   TT                            467   (2.14%)    <- the dominant expressive
//                                                   device, 70x a smiley
//   "XD"                                0
//   "time to <verb>"                     0
//   "let's just"                         0
//   "so it needs/is/takes"               6   (0.027%)
//   "I (just) need to"                  11   (0.050%)
//   "hope for" / "forgot my" /
//   "dig straight down" /
//   "this is going well" /
//   "just perfect"                        0
//   "of course"                           1
//   "this is just fantastic"              0
//   "let me (try|just)"                  12   (0.037% grouped)
//   for contrast, real complaint openers 350  (1.604%)
//
// So the complaint-opener family is essentially absent from real chat, and it
// appears in her output because the SELF-PROMPT turns narrate her own retries: a
// model grading its own failure reaches for a stock opener and then describes the
// fix. Real chat is not commentary on its own process.
//
// The owner's instruction, which this implements exactly:
//   "time to deal with that, who says that. who cares.. just deal with it, dont say"
//   "who tf says time to get coal. just go get coal dont say.."
//
// Removal is WHOLE-SENTENCE, because partial removal produced mangled fragments
// that read worse than the announcement: "time to find some coal" -> " some coal",
// and in the full chain "ok, time to find some coal then." -> "me coal then.".
//
// Every strip consumes its own terminator, because leaving it stranded produced
// "a phantom now?." and "seriously?." - a full stop after a question mark.
//
// A genuine question keeps its "?", TT is preserved, and ordinary chat is
// untouched. Those are asserted in tests/reflex_announce.test.mjs.
// ─────────────────────────────────────────────────────────────────────────

export function scrubOutput(input) {
    let m = String(input)
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
        .replace(/[^.!?\n]*\blet['’]s (?:see|go|try|just|check|get|do)\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bso it (?:needs|is|takes|has|requires)\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bI (?:just )?need to\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bhope for\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bdig straight down\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bforgot my\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bthis is going (?:well|fine|great)\b[^.!?\n]*/gi, ' ')
        .replace(/[^.!?\n]*\bjust perfect\b[^.!?\n]*/gi, ' ')
        .replace(/(?:^|[.!?]\s+)[^.!?\n]*\b(?:ok(?:ay)?,?\s+|well,?\s+|right,?\s+|so,?\s+)?time to\b[^.!?\n]*/gim, ' ')
        .replace(/^\s*[?!.]+\s*/, '')
        .replace(/\s+([.!?])(?=\s*$)/, '')
        .replace(/([?!])\.(?=\s|$)/g, '$1')
        .replace(/[^.!?\n]*\blet me (?:try|just|go|get|see|check|find|handle|deal)\b[^.!?\n]*[.!?]?/gi, ' ')
        .replace(/[^.!?\n]*\bbetter get on (?:that|it|this)\b[^.!?\n]*[.!?]?/gi, ' ')
        .replace(/[^.!?\n]*\bthis is (?:just )?(?:great|fantastic|perfect|amazing|brilliant)\b[^.!?\n]*[.!?]?/gi, ' ')
        .replace(/\b(?:of course),?\s+/gi, '')
        .replace(/([.!?])\1+/g, '$1')
        .replace(/([?!])\.+(?=\s|$)/g, '$1')
        .replace(/\.{2,}(?=\s|$)/g, '.')
        .replace(/^\s*\.+\s*$/, '')
        .replace(/\*[^*\n]{1,24}\*/g, ' ')   // *facepalm* -> gone
        .replace(/\*+/g, ' ')                    // stray * -> gone
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/~+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/\s+([.!?,;:])/g, '$1')        // "now? ."  -> "now?"
        .replace(/([?!.])\1+/g, '$1')            // "fine??"  -> "fine?"
        .replace(/[,;:]\s*$/, '')                // trailing comma
        .replace(/\b(?:fine|ok|okay|so|well|and|but|then)\s*$/i, '')
        .replace(/^\s*(?:fine|ok|okay|so|well|and|but|then)[,\s]*/i, '')
        .replace(/\s+([.!?,;:])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/[,;:]+$/, '')
        // A bare interjection left with nothing to say: "damn, okay. time to hit
        // the caves..." reduced to "damn," and then to "damn". An interjection
        // with no predicate is not a message.
        .replace(/^\s*(?:damn|ugh|brh|bruh|seriously|great|fine|okay|ok|so|well|ah|oh|hey)\s*$/i, '')

        // ── SEAMS ────────────────────────────────────────────────────
        // Removing a narration sentence leaves debris welded onto whatever
        // follows. Verified on her own live output:
        //   "...time to mine for some stone. !mineBlock stone 0 0"
        //       -> ".!mineBlock stone 0 0"
        //   "ugh, fine! let's just deal with this pillager first. ... !attack ..."
        //       -> "ugh, fine!. i should've seen that coming.!attack pillager 0 0"
        //   "...fine, ... ugh. !breakBlock wood 0 0"
        //       -> "omg this is ridiculous. i'll pick a block to break. ugh.!breakBlock wood 0 0"
        // The commands still parsed - which is why the actions ran - but the text
        // is junk, and "ugh, fine!." is not something a person types.
        //
        // So close the seam: an orphaned punctuation run before a command, and a
        // dangling interjection that now has no predicate, both go. Only at the
        // boundary - a mid-sentence "ugh" is fine and stays.
        .replace(/[,;:.!]*\s*(?=[!][A-Za-z])/g, ' ')
        .replace(/\s*[,;:.!]+(?=\s*[!][A-Za-z])/g, ' ')
        .replace(/([.,!?:;])\s*([!][A-Za-z])/g, ' $2')
        .replace(/\b(?:ugh|fine|omg|okay|ok|so|well|hey|ah|oh|great|bruh|damn)\b[.!]?\s*(?=[!][A-Za-z])/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
    return m;
}
