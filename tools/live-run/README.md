# The live-run template

What `tools/live-run/chat/run-post-history-live.mjs` establishes, and what every live run in this repository should copy.
The point of a live run is to settle the claims a unit test structurally cannot: that a fact survives the **real**
composition, on a **real** turn, and that it changes when the thing it comes from changes.

## 1. Launch the product, do not simulate it

`launchDesktopCompositionGateChild` (from `tools/desktop-composition-launch.mjs`) starts the composition the desktop
actually ships, with a run root this process owns. Reuse it; do not write a second launcher, and do not hand-assemble a
"close enough" composition - the seams under test are exactly the ones a hand-assembled one replaces.

`tools/live-run/memory/run-memory-live-loop.mjs` is the reference for the plumbing: launch, wait for readiness, drive
turns through the product's own routes, read evidence, tear down only its own pids, and keep the run root for inspection.

## 2. Print readings, do not assert silently

A run that only exits 0 cannot be argued with later. Each claim gets a labelled reading printed on every run:

```
reading 1  tailBlock   the last outgoing message ends with the framed block, carrying the card's sentence verbatim
reading 2  secondTurn  after the field changes, the next turn carries the new text and none of the old
reading 3  prefix      m[0] bytes and the stable publication hash are identical with and without the field
control                a run whose source declares nothing appends nothing
```

Two rules follow from that, and both are load-bearing:

- **a control reading**: the case where the feature is absent must be measured, not assumed - that is how a "no-op when
  unused" claim stops being folklore;
- **a paired reading**: when a claim is about not disturbing something (a cached prefix, a hash, a baseline), print both
  sides in the same run. Two runs on different days are not a comparison.

## 3. Prove it can fail, once, in the same script

`--declared-field=` (empty) must turn the same readings red: `[tailBlock] FAIL`, `[secondTurn] FAIL`, 2 of 4, exit 1;
restoring the value puts it back to 4 of 4. A live run nobody has seen fail is a live run that will one day pass for the
wrong reason - the same lesson the totality audit learned class by class.

## 4. Be explicit about what you stubbed

A stub provider (the product's own escape-hatch provider pointed at a local OpenAI-compatible endpoint) makes the
**assembly** under test and leaves the model out. That is usually the right trade for a context claim, and it must be
printed in the run's own output - not buried in a commit message. Say what is proven, and say what is not: "the assembly
on a driven composition, not a commercial provider's live reply".

## 5. Cost and shape

Seconds, not minutes: three turns and four readings run in about 0.2 s of wire time. Deterministic, runnable by hand,
no gate. Name it `run:<thing>-live` in `package.json` so it is discoverable next to the other loops; keep it out of CI
unless it can run without a provider or a game.

## 6. What a live run is not for

Not for logic that a unit test can pin, and not for anything whose subject is the model's output - a live run asserts what
the product **sends**, never what a model **says**. If the claim is about wording, it belongs beside the frame's own test.

## Checklist for a new live run

- [ ] launches the real composition through `launchDesktopCompositionGateChild`, owns its run root
- [ ] drives the turn(s) through the product's own routes, never by calling the service directly
- [ ] prints every reading, including the control and the paired one
- [ ] fails non-zero on any wrong reading, and has been seen red once
- [ ] says in its own output what was stubbed
- [ ] cleans up only its own processes, and leaves the run root behind for whoever reads the evidence next
- [ ] named `run:<thing>-live`, documented by a line in the run's header comment saying which claim it settles
