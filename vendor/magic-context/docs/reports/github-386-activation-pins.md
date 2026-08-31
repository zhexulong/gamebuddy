# GitHub issue #386 — v0.41.0 activation pins

Date: 2026-08-29

## Verdict

The three activation pins from the Athena consultation are closed.

- Pi now uses the same force-pressure episode contract as the TypeScript OpenCode lane.
- The newest-20 supersession owner floor is stable across provider-projection contraction and re-expansion.
- A full TypeScript transform scenario proves that the episode latch cannot suppress provider-overflow recovery at the 95% wall.

No schema, authority fence, package version, or release artifact changed in this worktree.

## P1 — Pi episode contract

Pi already passed `hasPriorDrop: priorInputSample > 0` to the shared emergency planner, so fresh forward usage did not itself release the latch. The residual divergence was at the episode boundaries: Pi only cleared the sample on model changes, while the OpenCode lane also rearms after pressure exits the force band or an independent provider-visible mutation prices the pass.

The Pi handler now:

1. clears the persisted sample after usage leaves the force band;
2. clears it immediately before heuristics when a queued drop or completed hard fold already changed provider-visible bytes; and
3. deliberately excludes frozen dropped-status replay from the independent-mutation set, because Pi rebuilds raw messages every pass and replay would otherwise reintroduce one emergency drop per pass.

The regression exercises all three required arms: fresh 85%→90% growth stays latched, a 70% pressure exit rearms the next 90% entry, and a queued mutation at 93% lets accumulated candidates ride the same priced pass.

## P2 — contraction-stable newest-20 floor

The adversarial drift is real. Before the fix, both test shapes permanently changed a temporarily absent owner's persisted tag status during an independently priced execute pass:

- head contraction temporarily omitted `owner-3`;
- tail contraction temporarily omitted `owner-22`.

In each case the live served-array floor omitted that owner, supersession admitted its `bash_status` output, and the tag became `dropped`. Re-expansion then replayed the frozen drop mode against bytes that had been full before contraction. Ride-only admission prevented an extra bust but did not prevent this permanent byte drift.

The floor now comes from persisted tag chronology. All persisted statuses participate, distinct known owner IDs are ordered by their highest tag number, and the newest 20 are withheld. Message/file content IDs are normalized back to their owner message IDs. Legacy tool rows with a null owner continue to fail safe in both selectors and do not consume a known-owner floor slot.

The regression runs a real queued mutation, supersession selection, status persistence, dropped-status replay, and full projection re-expansion for both contraction shapes. It asserts both that the temporarily absent owner's status remains active and that its re-expanded bytes remain unchanged.

## P3 — liveness composition

The transform-level scenario establishes a cache-stable baseline, enters a scheduler-deferred but force-eligible episode with a persisted emergency latch and 30 accumulated tool candidates, and grows usage from 90% to 94%. No independent mutation occurs, no tool is reclaimed, and the emergency sample remains latched.

A provider-proven overflow then arms durable recovery at 96%. The same top-level transform reaches `evaluateEmergencyFailClosed`, sends recovery notification through the existing path, confirms the session abort, and clears the stale emergency sample for retry. The episode latch therefore cannot starve the provider-overflow-backed 95% recovery path.

## Verification

- OpenCode plugin: 4,228 tests passed with 21,267 assertions.
- Pi plugin: 879 tests passed with 3,108 assertions.
- OpenCode and Pi TypeScript typechecks passed.
- Biome checks passed for every changed TypeScript file. Pi still reports the pre-existing non-null assertion warning in `context-handler.ts` outside this delta.
- No shared Rust golden changed, so the `mc-module` cargo gate was not applicable.

## Regression and mutation evidence

Every executed deliberate mutation used the exact `NON-VACUITY BREAK` marker and was restored immediately:

| Deliberate break | Focused red evidence |
|---|---|
| Disabled Pi pressure-exit rearming | `packages/pi-plugin/src/context-handler.test.ts:2537`: emergency sample was `90000`, expected `0`. |
| Removed the persisted supersession owner floor | `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.test.ts:2249`: both head and tail contraction cases observed `dropped`, expected `active`. |
| Disabled provider-overflow fail-closed admission | `packages/plugin/src/hooks/magic-context/transform.test.ts:3190`: abort call count was `0`, expected `1`. |

The pre-fix empirical contraction run failed at the same line for both shapes, establishing that the drift was not merely theoretical. No `NON-VACUITY BREAK` marker remains in source or tests.
