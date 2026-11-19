import { rm } from "node:fs/promises";
import { join } from "node:path";

import { bindWindowsStaleLockReclaimer, withPathLock } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { canonicalTestRoot } from "./canonical-test-root.test-support.js";

/**
 * Binds the Windows stale-lock reclaimer every durable release in THIS process goes through, and proves the release
 * path works before anything else in the process depends on it.
 *
 * The defect it closes is one lie in two costumes: a suite's correctness depending on something outside it. A suite
 * that binds nothing leans on `host/scripts/compiled-test-bootstrap.mjs` having been handed to this process as
 * `--import`, so `node --test dist-test/<file>` on its own answers `windows_reclaimer_unavailable` from a release deep
 * inside a fixture instead of at the top; and a forked fixture worker leans on inheriting its parent's
 * `process.execArgv` the same way. Binding alone is not enough to catch either, because a bind whose capability
 * was minted but never exercised looks exactly like one that took effect until the first release happens - so a lock
 * is taken and released here through the same {@link withPathLock} the product's stores use.
 *
 * `setup` names the caller, so the failure reads as "this suite binds the Windows lock reclaimer it releases through,
 * and the release failed" rather than as a bare capability code from a helper.
 */
export async function bindVerifiedWindowsLockReclaimerForTest(setup: string): Promise<void> {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const root = await canonicalTestRoot("windows-lock-reclaimer-probe-");
  try {
    await withPathLock(join(root, "probe.json"), async () => undefined, { containmentRoot: root });
  } catch (error) {
    throw new Error(
      `${setup}: this suite binds the Windows lock reclaimer it releases through, and the release failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
