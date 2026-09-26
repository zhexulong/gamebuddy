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
const counts = { shared: 0, lease: 0, facade: 0, session: 0, coordinator: 0, presentationStarts: 0, presentationCloses: 0, providerLookups: 0, readyPublished: 0, readyUrl: null as string | null, mountOptionsNonce: null as string | null };
const constructionFailure = new Error("game_owner_construction_failed");

const gateReadyNonce = "a".repeat(64);

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
    counts.providerLookups += 1;
    if (name !== "stardew") return undefined;
    return Object.freeze({
      createLifecycleCoordinator: async () => {
        if (scenario === "coordinator-failure") throw constructionFailure;
        if (scenario === "presentation-missing") {
          return Object.freeze({ close: async () => { counts.coordinator += 1; } });
        }
        if (scenario === "presentation-failure") {
          return Object.freeze({
            close: async () => { counts.coordinator += 1; },
            presentation: Object.freeze({}),
          });
        }
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

const input = Object.freeze(
  scenario === "chat-only-surface" || scenario === "management-surface" || scenario === "gate-chat-only-surface"
    ? {
        manifest: Object.freeze({}) as unknown as HostDeploymentManifest,
        gameSessionMode: "fresh" as const,
        surface: (scenario === "management-surface" ? "management" : "chat-only") as "chat-only" | "management",
        ...(scenario === "gate-chat-only-surface"
          ? {
              tavernNarrativeGateNonceSha256: gateReadyNonce,
              publishLaunchUrl: (launchUrl: string) => {
                counts.readyPublished += 1;
                counts.readyUrl = launchUrl;
              },
            }
          : {}),
      }
    : {
        manifest: Object.freeze({}) as unknown as HostDeploymentManifest,
        gameSessionMode: "fresh" as const,
      },
);
const rootLayoutCapability = Object.freeze({}) as DesktopRootLayoutCapability;

async function main(): Promise<void> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  await mock.module(pathToFileURL(join(moduleDirectory, "..", "continuity-semantic-production-coordinator", "continuity-semantic-production-coordinator.js")).href, {
    namedExports: {
      createSharedSemanticProductionAuthorityFromDeploymentManifest: async (_manifest: unknown, _mode: unknown, options?: Readonly<{ tavernNarrativeGateNonceSha256?: string }>) => {
        counts.mountOptionsNonce = options?.tavernNarrativeGateNonceSha256 ?? null;
        return sharedAuthority;
      },
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
  // ADR-0007 Shape B moved the platform binding and the folder picker into this
  // composition root, so the hermetic fixture has to mock them too. Without
  // these the real folder picker runs (and fails on a machine with no published
  // picker binary), which reported different_failure instead of the injected
  // construction failure these drain assertions expect.
  await mock.module(pathToFileURL(join(moduleDirectory, "..", "windows-stardew-folder-picker", "index.js")).href, {
    namedExports: {
      createPublishedWindowsStardewFolderPicker: async () => Object.freeze({ kind: "fixture_folder_picker" }),
    },
  });
  await mock.module(pathToFileURL(join(moduleDirectory, "stardew", "stardew-guardian-platform.js")).href, {
    namedExports: {
      createDesktopGuardianGameRuntimePlatform: () => Object.freeze({ kind: "fixture_guardian_platform" }),
      createStardewPlayerHostRuntimeLaunchCollaboratorFactory: () => Object.freeze({ kind: "fixture_runtime_collaborator" }),
    },
  });
  await mock.module(pathToFileURL(join(moduleDirectory, "desktop-presentation-admission-owner.js")).href, {
    namedExports: {
      startDesktopPresentationAdmission: async () => {
        if (scenario === "presentation-failure") throw constructionFailure;
        counts.presentationStarts += 1;
        return Object.freeze({
          launchUrl: "http://127.0.0.1:1/#profile=composed-reference-game&boot=fixture",
          close: async () => { counts.presentationCloses += 1; },
        });
      },
      startChatOnlyPresentationAdmission: async () => {
        if (scenario === "presentation-failure") throw constructionFailure;
        counts.presentationStarts += 1;
        return Object.freeze({
          launchUrl: "http://127.0.0.1:1/#profile=reference&boot=fixture",
          close: async () => { counts.presentationCloses += 1; },
        });
      },
      startTavernManagementPresentationAdmission: async () => {
        if (scenario === "presentation-failure") throw constructionFailure;
        counts.presentationStarts += 1;
        return Object.freeze({
          launchUrl: "http://127.0.0.1:1/#profile=management&boot=fixture",
          close: async () => { counts.presentationCloses += 1; },
        });
      },
    },
  });
  const { createDesktopProductComposition } = await import(pathToFileURL(join(moduleDirectory, "desktop-host-composition.js")).href);
  let outcome: "unexpected_success" | "original_failure_propagated" | "different_failure" | "constructed";
  let errorMessage: string | undefined;
  try {
    const composition = await createDesktopProductComposition(rootLayoutCapability, session, input);
    if (scenario === "chat-only-surface" || scenario === "management-surface" || scenario === "gate-chat-only-surface") {
      // Surface-selected construction succeeds: close through the one product
      // facade so the test can observe the exact children close order.
      outcome = "constructed";
      await composition.close();
    } else {
      outcome = "unexpected_success";
    }
  } catch (error) {
    outcome = error === constructionFailure ? "original_failure_propagated" : "different_failure";
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  process.stdout.write(`${JSON.stringify({ scenario, outcome, errorMessage, ...counts })}\n`, () => process.exit(0));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? String(error.stack ?? error) : String(error));
  process.exit(1);
});
