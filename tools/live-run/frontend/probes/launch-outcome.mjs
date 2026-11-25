// DID THIS RUN'S LAUNCH ATTACH - one line, decided from the driver's own field, for a script to branch on.
//
// WHY A PROBE AND NOT A TEXT MATCH. A retry loop that waits for a quiet window and then fires a capture has to
// answer one question between attempts, and on 2026-11-26 it answered it wrongly: the loop `tee`'d the capture
// log and tested `$text -match 'attachment=attached'`, stopped one attempt early and printed
// `RETRY END verdict=attached` over a run whose own verdict was `FAILED
// game_never_reached_ready:instance=crashed/attachment=none` (`.tmp/lane-roundw.md` §5.6). The failure sentence
// it read contains the chain's own target as a quotation - "the surface never reached
// instance=running/attachment=attached within 300000ms" - so the test could only ever say yes.
//
// The classifier is `capture/game-launch-verdict.mjs::readLaunchOutcome`, which reads the driver's result line
// (`GAME-LAUNCH w: <verdict> <code>; steps=<chain> records=<cells>`) and calls a run attached only when that
// verdict is `measured` AND the chain on the same line carries the `attach` rung. This probe is its command-line
// form so a poller calls the kit instead of re-inventing the test - the same reason `probes/quiet-poll.mjs`
// exists for the machine's ownership rule.
//
// WHAT IT TAKES: the driver's facts file (`<out>/w-game-launch.txt`) or the capture log a loop `tee`'d; the
// result line is found in either. WHAT IT ANSWERS, on stdout and in its exit code:
//
//   launch_outcome: verdict=measured attached=yes ...       exit 0
//   launch_outcome: verdict=failed attached=no ...          exit 1   (also not_measured, blocked_by_product)
//   launch_outcome: verdict=unreadable attached=no ...      exit 3   (no result line: nothing measured)
//
// A text with no result line is exit 3, never exit 0: the one answer a loop must not receive from silence is
// "it attached".
import { readFileSync } from "node:fs";
import { readLaunchOutcome } from "../capture/game-launch-verdict.mjs";

const file = process.argv[2];
let text = null;
try {
  text = readFileSync(String(file), "utf8");
} catch {
  text = null;
}
const outcome = readLaunchOutcome(text);
console.log(
  `launch_outcome: verdict=${outcome.verdict} attached=${outcome.attached ? "yes" : "no"} code=${outcome.code} steps=${outcome.steps.join(">") || "none"}`,
);
console.log(`launch_outcome_reason: ${outcome.reason}`);
if (outcome.attached) process.exit(0);
if (outcome.verdict === "unreadable") process.exit(3);
process.exit(1);
