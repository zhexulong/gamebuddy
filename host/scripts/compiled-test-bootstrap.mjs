import { bindWindowsStaleLockReclaimer } from "../dist-test/path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../dist-test/windows-stale-lock-reclaimer/index.js";

/**
 * The one prerequisite this bootstrap cannot run without, spelled once so the refusal here and the phase that reports
 * it name the same thing.
 *
 * The requirement is NOT weakened when it is unmet: `createBuildWindowsStaleLockReclaimer()` still verifies the
 * complete pair - both regular non-reparse files, a manifest byte-equal to the canonical manifest of the helper's own
 * sha256, and no `.build-test-*-aside` leftover beside them. Only the shape of the refusal changes: one named blocker
 * the phase runner can report, instead of the same import failure in every compiled test file.
 */
export const reclaimerHelperPairRequirement = Object.freeze({
  code: "windows_stale_lock_reclaimer_unavailable",
  requirement:
    "the verified build helper pair host/native/windows-stale-lock-reclaimer/.dist/win-x64 (GameBuddy.WindowsStaleLockReclaimer.exe and windows-stale-lock-reclaimer.manifest.json): two regular non-reparse files whose manifest is the canonical manifest of the helper's own sha256, with no .build-test-*-aside leftover beside them",
  publish: "node host/scripts/build-windows-stale-lock-reclaimer.mjs (on Windows, with the .NET SDK pinned by global.json)",
});

/**
 * Mint the repository build pair and bind it for every compiled test in this process - or refuse with the named
 * blocker above.
 *
 * The refusal travels as an error carrying `.blocker`, which is the record the suite runner reads to report the whole
 * phase as `blocked` rather than turning one missing prerequisite into one failure per test file. On any non-Windows
 * runtime the mint returns the unavailable capability instead of throwing, so nothing here changes that platform.
 */
export async function bindVerifiedReclaimerHelperPair() {
  try {
    bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const { code, requirement, publish } = reclaimerHelperPairRequirement;
    const blocker = new Error(`${code}: ${requirement} · publish: ${publish} · cause: ${cause}`);
    blocker.blocker = Object.freeze({ ...reclaimerHelperPairRequirement, cause });
    throw blocker;
  }
}

await bindVerifiedReclaimerHelperPair();
