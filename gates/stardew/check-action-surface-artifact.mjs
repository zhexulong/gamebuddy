#!/usr/bin/env node
/**
 * The artifact the Mod exports, judged by the reader its own package already owns.
 *
 * <p>
 * WHY IT EXISTS. Measured 2026-11-25: the Mod published a 595-character argument sentence
 * (`use_mine_ladder.expectedTargetId`), the Host's `isValidActionDescriptor` bounded an argument description at 512,
 * and ONE refused descriptor refuses the WHOLE `hello_ack` registration list - so the attach died on a sentence and the
 * round mounted no tool. Nothing in the entry point had noticed, because `action-surface-check` - the reader that had
 * been refusing that very artifact - ran in no rung: the Mod's own publish-time contract was green nowhere.
 * </p>
 *
 * <p>
 * IT DELEGATES, IT DOES NOT REIMPLEMENT. The reader is `runActionSurfaceCheck` from the package that owns the artifact
 * and the schema it is read against; a copy here would be the second spelling this whole unit is about. What this file
 * adds is the SCHEDULING half: a path `gates/registry.mjs` derives as a gate, so the ladder can name it. 54 ms, one
 * 96 KB read.
 * </p>
 *
 * red-proof: history  the `49104c70`-era artifact (120,907 bytes, the Mod's own bytes) -> `runActionSurfaceCheck` refuses
 *   with `stardew_action_surface_bounds` and this gate exits 1; measured 2026-11-25 by handing that exact artifact to a
 *   copy of the package's own reader.
 * red-proof: inject  this artifact with one argument's `description` inflated to the 595 characters
 *   `use_mine_ladder.expectedTargetId` published on 2026-11-25 (`travel.x`) -> the same `stardew_action_surface_bounds`,
 *   this time from the projection's own description bound rather than the byte budget; measured 2026-11-25.
 * red-proof: history  the `49104c70`-era C# catalog, judged by `check-head-build` instead: the producer's own refusal
 *   fires first (`farmhand action 'use_mine_ladder' argument 'expectedTargetId' description is 595 characters, over the
 *   512 ...`), which is why the artifact cannot be exported at all.
 */
import { runActionSurfaceCheck } from "../../integrations/stardew/action-development/src/action-surface-check.mjs";

const report = await runActionSurfaceCheck();
process.stdout.write(
  `actions examined ${report.actions} · executable ${report.executable} · readOnly ${report.readOnly}\n`,
);
process.stdout.write(`${JSON.stringify(report)}\n`);
