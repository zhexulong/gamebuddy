import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDesktopHostBootstrap } from "../wire/desktop-runtime-bootstrap.internal.js";

/**
 * The bootstrap wire reports a single bounded failure code for every rejected
 * frame, and its callers (the Desktop launcher, the gate runners) classify a
 * pre-ready child exit by reading one bare code token from stderr. Swallowing
 * the error here therefore turned every startup failure into an unattributable
 * `exited_before_ready` with no stderr at all. Emit only the bounded code: the
 * error message may carry a path, and the stack never belongs on this channel.
 */
function boundedFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_.:-]{2,159}$/i.test(message)
    ? message
    : "desktop_host_entry_failed";
}

if (import.meta.main) {
  void runDesktopHostBootstrap(dirname(fileURLToPath(import.meta.url))).catch((error: unknown) => {
    process.stderr.write(`${boundedFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
