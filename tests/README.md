# tests/

Two kinds of file, deliberately separated.

## `*.test.mjs` — offline, in `bun run test`

No network, no model calls, no API cost. These are the regression guards: they
assert what the code and the persona script must keep doing, and they run in
~2 seconds so they can be run on every change. Anything that reads
`personas/normal.json`, `bots/UwU/`, or the source tree belongs here.

## `probes/*.mjs` — live, costs money, NOT in `bun run test`

These call the real model through the same pipeline the agent uses, so they
measure behaviour rather than asserting intent. They are how the persona work is
actually validated: an offline test can only prove the script says the right
thing, and the whole history of this repo is prompt rules that looked right and
did nothing.

Run them deliberately:

```bash
node tests/probes/disagree_probe.mjs      # does she push back when wrong
node tests/probes/selfcenter_probe.mjs    # does she agree with the user / self-centre
node tests/probes/revision_probe.mjs      # does she hold a belief, then revise it
node tests/probes/pressure_probe.mjs      # does she fold to a bare push with no reason
node tests/probes/banter_probe.mjs        # jokes, roasts, banter register
node tests/probes/normal_voice_probe.mjs  # length, casing, punctuation, emoji
```

When one of these finds a real problem, the fix usually lands as an offline
guard too, so the behaviour cannot silently regress.

### Two things that have actually bitten

- **A prompt rule is not a fix.** "She changes her mind because the reason was
  good, not because someone was confident" changed nothing measurable: 2/5 caved
  before and after. Instructions lose to the distribution. Where the shape of a
  reply matters (empty acks, rant length), it is enforced in code.
- **A probe can be the thing that is wrong.** The pressure probe scored
  `"how's it wrong?"` and `"yeah? seen me get lost?"` as capitulation. Both are
  her arguing. Every detector here was wrong at least once; the numbers in a
  report mean nothing until the detector is validated against a control.