// IS THE MACHINE FREE FOR THIS RUN - by the kit's own ownership rule, for a poller that has to wait for a window.
//
// WHY THIS PROBE EXISTS. A poller outside the kit used to answer this question with its own substring test, and on
// 2026-11-26 that test reported this run's OWN capture driver as a foreign process: the kit spawns a driver as
// `node <kit>/capture/w-game-launch.cjs`, whose command line carries the kit and not the run's stage root, so a
// test written as "the command line must name my run" cannot see it (`.tmp/lane-roundw.md` §5.3: `12408(node.exe)`
// listed as foreign while the run's own ledger named it `capture:w-game-launch`; §6 names it a defect in that
// instrument). The rule is `lib/run-game.mjs::runOwnership` - command line names this run's stage root, or its
// PARENT's does - and `lib/machine-quiet.mjs::machinePollReading` applies it to the population a poller needs:
// games AND the shells a sibling lane's kit runs under.
//
// WHAT IT PRINTS: one line per process on the machine that could be a game or a driver, saying whose it is and
// why, then the tally with the state on it. Exit 0 quiet, 1 busy, 3 unreadable (a table that did not answer is not
// a quiet machine). A poller reads the state from the exit code and the reasons from the lines.
//
//   node tools/live-run/frontend/probes/quiet-poll.mjs D:\gb-runs\roundw-out.stage
import { machinePollReading } from "../lib/machine-quiet.mjs";

const reading = machinePollReading({ stageRoot: process.argv[2] });
for (const line of reading.lines) console.log(line);
if (reading.state === "quiet") process.exit(0);
if (reading.state === "busy") process.exit(1);
process.exit(3);
