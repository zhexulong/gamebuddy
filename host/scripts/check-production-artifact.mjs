import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assertCompleteProductionArtifact } from "./production-artifact.mjs";
/**
 * Guard: the generation this checkout publishes must pass the publisher's own complete re-verification.
 *
 * WHY (measured 2026-11-07)
 *
 * This file existed and NOTHING ran it: `grep` over `package.json` scripts and `.github/workflows` found no
 * command naming it, so the only thing that ever verified `host/dist` was a live run that happened to need it.
 * Measured today it exits 1 with `production_dynamic_external_module_missing:composition/companion-session-reflection.js`
 * - the published generation is dated 2026-10-15 and the module landed 2026-10-16 - and because no gate read
 * the artifact, every suite kept passing against `host/dist-test`. A gate nobody calls is indistinguishable
 * from a passing one.
 *
 * It is now named by `check:production-artifact` in package.json and by the `gates` job in ci.yml, beside
 * `check-release-generation-self-contained.mjs`, which reads the same artifact from the declaration side. CI
 * has no published generation (`host/dist` is gitignored and `build:test` writes `host/dist-test`), so on a
 * checkout without one this reports `not_measured` and exits 0 with its reason printed: "there is no artifact
 * here" is a prerequisite fact, not a verdict, and a green line about an artifact nobody read is the shape this
 * whole entry exists to remove.
 *
 * red-proof: history the 2026-11-07 artifact (g-mv94khq7-...) -> exit 1 with
 *                    `production_dynamic_external_module_missing:composition/companion-session-reflection.js`,
 *                    the same injected-missing-module finding
 *                    tools/check-release-generation-self-contained.test.mjs pins
 */
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(hostRoot, "dist");
if (!existsSync(resolve(outputRoot, "current.json"))) {
  console.log(JSON.stringify({ gate: "production-artifact", status: "not_measured", reason: "generation_not_published", outputRoot }, null, 2));
  process.stderr.write("production_artifact not_measured: no published generation at host/dist\n");
  process.exit(0);
}
console.log(JSON.stringify(await assertCompleteProductionArtifact({ hostRoot, outputRoot }), null, 2));
