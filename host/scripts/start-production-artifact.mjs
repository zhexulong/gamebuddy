import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { recheckProductionEntry, resolveProductionEntry } from "./production-artifact.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [entry, ...configArgs] = process.argv.slice(2);
if (!entry) throw new Error("production_entry_required");
// The first argument is exclusively the reviewed entry root. Every remaining
// argument is passed unchanged to that entrypoint's own configuration parser.
const selected = await resolveProductionEntry({ hostRoot, outputRoot: resolve(hostRoot, "dist"), entry });
// Pin the immutable generation selected from verified current. Recheck its
// inventory immediately before spawn; a later publisher may advance current
// but cannot alter the selected generation through this protocol.
await recheckProductionEntry({ hostRoot, selected });
// This does not defend against arbitrary same-user filesystem mutation between
// the final check and Node's file open; deployment-root ACL/operational trust is
// the residual TCB boundary documented in design/30.
// Keep the launcher as the exact owner of the selected entrypoint. In
// particular, a bounded live/test runner that stops this launcher must also
// stop the entrypoint; otherwise killing only the wrapper leaves an orphaned
// server with its port and runtime root still live.
const child = spawn(process.execPath, [selected.entryPath, ...configArgs], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
if (typeof process.send === "function") {
  child.on("message", (message, sendHandle) => {
    if (process.connected === true) process.send(message, sendHandle);
  });
}
let stopping = false;
let forcedStopTimer;
function stopChild(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  forcedStopTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  forcedStopTimer.unref();
}
child.once("error", () => process.exit(1));
child.once("exit", (code, signal) => {
  if (forcedStopTimer !== undefined) clearTimeout(forcedStopTimer);
  process.exit(code ?? (signal ? 1 : 0));
});
process.once("SIGINT", () => stopChild("SIGINT"));
process.once("SIGTERM", () => stopChild("SIGTERM"));
