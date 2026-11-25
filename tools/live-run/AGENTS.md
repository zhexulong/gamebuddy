# Live Run & Action Verification Guidelines

## Action Live Run vs. Game Live Run
- **Action Live Run** (`node tools/live-action.mjs --action <actionId>`, `node tools/live-program.mjs --scenario <scenario> --script <file>`, ≤60 s): Verifies one action or one plan form end-to-end (`request → admission → native commit → terminal receipt → fresh postcondition → teardown`). Never spend a multi-day game run to test whether a single action works.
- **Game Live Run** (`tools/live-run/chat/`, `tools/live-run/frontend/`, `tools/start-farmhand-launcher.ps1`):
  - *Composition / Frontend / Chat live runs* (seconds): Launch the real product composition via `launchDesktopCompositionGateChild`, drive real routes with a stub provider, print labelled **control** (absent feature = no-op) and **paired** (same-run comparison) readings, and prove the script fails non-zero when the target input is emptied.
  - *Multi-day Game live runs*: Measure companion decision breadth, cross-day continuity, settlement delivery, and pacing only. Freeze quantitative criteria beforehand; on any new failure code, stop by exact PID and turn it into a ≤60 s slice + gate before running long again.

## Action Live Run Requirements (Defect-Catching Rules)
1. **Wait for actionable state & distinguish 4 target outcomes**: Wait for `actionable: true` before first observation (do not mistake warp fade-in for a missing family). Distinguish `action_not_advertised`, `family_absent`, `family_empty`, and `target_chosen`; never print `count: 0` when unmeasured.
2. **Fresh re-read**: Always re-read world/snapshot state after the receipt (inventory delta, stamina, target absence); never trust a receipt's self-report alone.
3. **Held-state perturbation**: Test with both wrong tool (`--held <tool>`) and ordinary held item (`--held-item <qualifiedItemId>`) to prove the action either switches/succeeds or refuses by name—never stalls silently.
4. **Executor-matched terminal**: Match the terminal carrying the executor's `reasonCode` so intentional negative/repeat-refusal probes are not misread as failures.
5. **Clean world & measured teardown**: Refuse dirty working saves before launch; stop processes by exact PID and verify process exit + fixture restoration before reporting success.

## Measurement Discipline
- Print `population`, `source`, `method`, and `window` for every reading.
- Key comparison identities on content (never on line number, list position, or reflection order), or explicitly mark ceiling readings.
- Clean up only PIDs this run started, and leave the run root on disk for inspection.
