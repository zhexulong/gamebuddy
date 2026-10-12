/**
 * The prerequisite every mounted browser journey shares: a *published Host
 * generation*.
 *
 * `management-pipeline-browser.spec.ts`, `reference-pipeline-browser.spec.ts`
 * and `companion-turn-browser.spec.ts` do not compose the Host from the working
 * tree. They open a real loopback listener from the shipped artifact tree - the
 * immutable `generations/<id>/` directory the release job builds
 * (`host build:release` -> `host/dist/current.json`) - and load its browser-shell
 * modules. That is what makes them release-lane gates rather than unit tests.
 *
 * A source checkout publishes no generation: `host/dist` is not in the tree and
 * no `dist-*` directory carries a `current.json`. Reading the pointer there
 * raises ENOENT inside setup, which Playwright reports as one failed test per
 * journey - a red that means "there is no artifact here", not "this journey
 * found a defect".
 *
 * `requirePublishedShell` declares the real prerequisite instead:
 *
 * - without a generation the journey skips, naming the missing artifact, so a
 *   checkout with nothing built reports a declared skip rather than a failure
 *   that means nothing;
 * - with a generation that exists but does not publish the shell module the
 *   journey mounts, the journey fails with a precise message, so a genuine red
 *   is never hidden behind the skip.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "@playwright/test";

export function requirePublishedShell(outputRoot: string, shellModule: string): void {
  const pointerPath = resolve(outputRoot, "current.json");
  if (!existsSync(pointerPath)) {
    test.skip(
      true,
      `requires a published Host generation: no current.json at ${outputRoot}. ` +
        "This journey mounts the shipped browser-shell modules out of a built generation, which only the release lane produces " +
        "(host build:release; GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT names it). A checkout with no built generation skips it by name.",
    );
    return;
  }
  const generation = (JSON.parse(readFileSync(pointerPath, "utf8")) as { generation?: unknown }).generation;
  if (typeof generation !== "string" || generation.length === 0)
    throw new Error(`published_generation_pointer_invalid: ${pointerPath} names no generation`);
  if (!existsSync(resolve(outputRoot, "generations", generation, shellModule)))
    throw new Error(
      `published_generation_missing_shell: generation ${generation} does not publish ${shellModule}, so this journey cannot ` +
        "mount the shell it is written against. The reference and management browser shells were removed with the single-frontend " +
        "convergence (13c4c70a 'the two extra browser shells are gone'; 6406dd0a 'the product shell is the only browser entry'), " +
        "so this suite must be retired or re-pointed at the surviving composed shell before it can run.",
    );
}
