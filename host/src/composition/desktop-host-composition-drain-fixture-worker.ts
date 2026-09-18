import { dirname, join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { DesktopRootLayoutCapability } from "./desktop-host-composition.js";

/**
 * Hermetic construction-failure fixture for the real desktop product
 * composition. It is spawned by desktop-host-composition.test.ts with
 * `--experimental-test-module-mocks`: the shared-authority, Chat-facade, and
 * catalog modules are mocked by URL before the real composition module is
 * imported, so `createDesktopProductComposition` runs for real while the
 * failure point is injected. The worker prints one JSON result line carrying
 * the close counts and the propagation outcome; it never mints or consumes a
 * production capability.
 */

const scenario = process.argv[2] ?? "";
const counts = { shared: 0, lease: 0, facade: 0, session: 0 };
const constructionFailure = new Error("game_owner_construction_failed");

const sharedAuthority = Object.freeze({
  chat: Object.freeze({}),
  game: Object.freeze({}),
  close: async () => { counts.shared += 1; },
});

const chatFacade = Object.freeze({
  authority: "SEMANTIC" as const,
  startChatRuntime: async () => { throw new Error("semantic_lane_unused"); },
  startMountedChatRuntime: async () => {
    if (scenario === "mount-failure") throw constructionFailure;
    return Object.freeze({
      runtimeSession: Object.freeze({ profile: Object.freeze({}) }),
      chatThreadId: "desktop-composition-drain",
      chatSurfaceSessionId: "desktop-composition-drain",
      close: async () => { counts.lease += 1; },
    });
  },
  close: async () => { counts.facade += 1; },
});

const catalog = Object.freeze({
  getProvider: (name: string) => {
    if (name !== "stardew") return undefined;
    return Object.freeze({
      createLifecycleCoordinator: async () => {
        if (scenario === "coordinator-failure") throw constructionFailure;
        throw new Error("unexpected_coordinator_success");
      },
    });
  },
});

const session = Object.freeze({
  arm: async () => { throw new Error("unused"); },
  launch: async () => { throw new Error("unused"); },
  contain: async () => { throw new Error("unused"); },
  close: async () => { counts.session += 1; },
});

const input = Object.freeze({
  manifest: Object.freeze({}) as unknown as HostDeploymentManifest,
  gameSessionMode: "fresh" as const,
});
const rootLayoutCapability = Object.freeze({}) as DesktopRootLayoutCapability;

async function main(): Promise<void> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  await mock.module(pathToFileURL(join(moduleDirectory, "..", "continuity-semantic-production-coordinator", "continuity-semantic-production-coordinator.js")).href, {
    namedExports: {
      createSharedSemanticProductionAuthorityFromDeploymentManifest: async () => sharedAuthority,
    },
  });
  await mock.module(pathToFileURL(join(moduleDirectory, "..", "continuity-semantic-deployment-composition", "continuity-semantic-chat-facade.internal.js")).href, {
    namedExports: {
      createChatSemanticFacadeFromSharedAuthority: async () => chatFacade,
    },
  });
  await mock.module(pathToFileURL(join(moduleDirectory, "..", "integration-catalog-product.js")).href, {
    namedExports: {
      PRODUCT_INTEGRATION_CATALOG: catalog,
    },
  });
  const { createDesktopProductComposition } = await import(pathToFileURL(join(moduleDirectory, "desktop-host-composition.js")).href);
  let outcome: "unexpected_success" | "original_failure_propagated" | "different_failure";
  try {
    await createDesktopProductComposition(rootLayoutCapability, session, input);
    outcome = "unexpected_success";
  } catch (error) {
    outcome = error === constructionFailure ? "original_failure_propagated" : "different_failure";
  }
  process.stdout.write(`${JSON.stringify({ scenario, outcome, ...counts })}\n`, () => process.exit(0));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? String(error.stack ?? error) : String(error));
  process.exit(1);
});