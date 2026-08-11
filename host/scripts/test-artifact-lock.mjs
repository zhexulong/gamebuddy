import { open, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(hostRoot, ".test-artifact.lock");

/** Exclusively own dist-test for an entire supported package-script operation. */
export async function withTestArtifactLock(run) {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    return await run();
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("host_test_artifact_already_in_use");
    throw error;
  } finally {
    await handle?.close();
    if (handle !== undefined) await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
