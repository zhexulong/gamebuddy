import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDesktopHostBootstrap } from "./desktop-runtime-bootstrap.internal.js";

if (import.meta.main) {
  void runDesktopHostBootstrap(dirname(fileURLToPath(import.meta.url))).catch(() => {
    process.exitCode = 1;
  });
}
