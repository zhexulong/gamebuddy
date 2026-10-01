import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TavernBrowserFixtureV1 } from "../tavern/browser-contract/index.js";
import { createChatEventStream } from "../tavern/chat-event-stream.js";
import { createTestWindowsReparseInspector } from "../windows-reparse-inspector/index.test-support.js";

/**
 * Hermetic fixture for the composition-owned Tavern-management presentation
 * admission variant. It is spawned by desktop-presentation-admission-owner.test.ts
 * with `--experimental-test-module-mocks`: only the durable Chat-owned service
 * builders (state facade, management, Memory, World Info binding service, and
 * the managed repository) are mocked by URL, so the real management static
 * shell composition still verifies a real browser artifact and serves a real
 * loopback listener. No game projection is ever supplied to the variant. The
 * worker prints one JSON line of observations; the test owns every assertion.
 */

const scenario = process.argv[2] ?? "";
const bootstrapToken = `${"A".repeat(42)}A`;
const constructionFailure = new Error("management_lane_construction_failed");
const counts = {
  stateFacadeCreated: 0,
  managementCreated: 0,
  memoryCreated: 0,
  worldInfoCreated: 0,
  repositoryCreated: 0,
  managementClosed: 0,
  memoryClosed: 0,
  worldInfoClosed: 0,
};
const observedProfileIds: Record<string, string | null> = {
  facade: null,
  management: null,
  memory: null,
  worldInfo: null,
};
let facadeSawWorldInfoService = false;
let repositoryRuntimeRoot: string | null = null;
let eventStream: ReturnType<typeof createChatEventStream> | undefined;

const handle = `${"B".repeat(42)}A`;
const base = TavernBrowserFixtureV1.snapshot();
const fakeStateFacade = Object.freeze({
  read: async () => {
    return Object.freeze({
      selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
      companionDisplayName: "Mira",
      title: "Exact Chat",
      transcript: Object.freeze([]),
      draft: Object.freeze({ revision: 1, text: null }),
      turn: null,
      operations: base.operations,
      worldInfo: Object.freeze({ state: "none", revision: handle, items: [] }),
    });
  },
  // The real facade owns its store and releases it on close; the composition
  // owner's close chain calls this, so the fixture must model it.
  close: async () => undefined,
});
const fakeManagementService = Object.freeze({
  listChats: async () => {
    throw new Error("unused_list");
  },
  renameChatTitle: async () => {
    throw new Error("unused_rename");
  },
  readDraft: async () => {
    throw new Error("unused_draft_read");
  },
  saveDraft: async () => {
    throw new Error("unused_draft_save");
  },
  discardDraft: async () => {
    throw new Error("unused_draft_discard");
  },
  close: async () => {
    counts.managementClosed += 1;
  },
});
const fakeMemoryService = Object.freeze({
  read: async () => Object.freeze({ projectionRevision: handle }),
  mutate: async () => {
    throw new Error("unused_memory_mutate");
  },
  close: async () => {
    counts.memoryClosed += 1;
  },
});
const fakeWorldInfoService = Object.freeze({
  read: async () => Object.freeze({ state: "none", revision: handle, items: [] }),
  setBinding: async () => {
    throw new Error("unused_bind");
  },
  close: async () => {
    counts.worldInfoClosed += 1;
  },
});

function inspector() {
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on("data", () => {
      child.stdout.end('{"schemaVersion":1,"result":"regular"}\n');
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    return child as unknown as ChildProcess;
  });
}

async function artifactFixture(withManifest = true): Promise<{ hostArtifactRoot: string; dispose(): Promise<void> }> {
  const hostArtifactRoot = await mkdtemp(join(tmpdir(), "gamebuddy-management-admission-"));
  const root = join(hostArtifactRoot, "browser", "tavern", "v1");
  await mkdir(join(root, "assets"), { recursive: true });
  if (withManifest) {
    const script = Buffer.from("console.log('shell');\n", "utf8");
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><script src="/assets/app-abcdef12.js"></script>',
      "utf8",
    );
    await writeFile(join(root, "assets", "app-abcdef12.js"), script);
    await writeFile(
      join(root, "tavern-browser-artifact-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        browserContract: "tavern_browser_api/v1",
        profileId: "gamebuddy.tavern.browser.v1",
        entryHtml: "index.html",
        assets: [
          {
            path: "assets/app-abcdef12.js",
            sha256: createHash("sha256").update(script).digest("hex"),
            bytes: script.length,
            mime: "text/javascript",
          },
        ],
      }),
    );
  }
  return {
    hostArtifactRoot,
    dispose: async () => await rm(hostArtifactRoot, { recursive: true, force: true }),
  };
}

async function main(): Promise<void> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  await mock.module(
    pathToFileURL(join(moduleDirectory, "..", "tavern", "tavern-management-state.js")).href,
    {
      namedExports: {
        createTavernManagementStateFacade: async (
          _manifest: unknown,
          _lease: unknown,
          profile: { readonly profileId?: string } | undefined,
          worldInfoService: unknown,
        ) => {
          if (scenario === "facade-failure") throw constructionFailure;
          counts.stateFacadeCreated += 1;
          observedProfileIds.facade = profile?.profileId ?? null;
          facadeSawWorldInfoService = worldInfoService === fakeWorldInfoService;
          return fakeStateFacade;
        },
      },
    },
  );
  await mock.module(
    pathToFileURL(join(moduleDirectory, "..", "tavern", "chat-management", "chat-management-service.js")).href,
    {
      namedExports: {
        createChatManagementService: (options: { readonly profile?: { readonly profileId?: string } }) => {
          counts.managementCreated += 1;
          observedProfileIds.management = options?.profile?.profileId ?? null;
          return fakeManagementService;
        },
      },
    },
  );
  await mock.module(
    pathToFileURL(join(moduleDirectory, "..", "tavern", "memory-management", "memory-management.js")).href,
    {
      namedExports: {
        createMemoryManagementService: (options: { readonly profile?: { readonly profileId?: string } }) => {
          counts.memoryCreated += 1;
          observedProfileIds.memory = options?.profile?.profileId ?? null;
          return fakeMemoryService;
        },
      },
    },
  );
  await mock.module(
    pathToFileURL(join(moduleDirectory, "..", "tavern", "world-info-binding", "world-info-binding-management-service.js")).href,
    {
      namedExports: {
        createWorldInfoBindingManagementService: (options: {
          readonly profile?: { readonly profileId?: string };
        }) => {
          counts.worldInfoCreated += 1;
          observedProfileIds.worldInfo = options?.profile?.profileId ?? null;
          return fakeWorldInfoService;
        },
      },
    },
  );
  await mock.module(
    pathToFileURL(join(moduleDirectory, "..", "tavern", "world-info-management", "world-info-management.js")).href,
    {
      namedExports: {
        createWorldInfoManagementRepository: (runtimeRoot: string) => {
          counts.repositoryCreated += 1;
          repositoryRuntimeRoot = runtimeRoot;
          return Object.freeze({});
        },
      },
    },
  );

  const { startTavernManagementPresentationAdmission } = await import(
    pathToFileURL(join(moduleDirectory, "..", "composition", "desktop-presentation-admission-owner.js")).href
  );
  const fixture = await artifactFixture(scenario !== "unverified-artifact");
  eventStream = createChatEventStream();
  const observations: Record<string, unknown> = {
    scenario,
    runtimeRoot: "E:/fixture/runtime-root",
  };
  let admission:
    | Awaited<ReturnType<typeof startTavernManagementPresentationAdmission>>
    | undefined;
  try {
    try {
      admission = await startTavernManagementPresentationAdmission({
        manifest: Object.freeze({ runtimeRoot: observations.runtimeRoot }) as never,
        hostArtifactRoot: fixture.hostArtifactRoot,
        bootstrapToken,
        eventStream,
        lease: Object.freeze({}) as never,
        inspector: inspector(),
      });
      observations.outcome = "resolved";
    } catch (error) {
      observations.outcome = "rejected";
      observations.propagatedOriginalFailure = error === constructionFailure;
      observations.errorMessage = error instanceof Error ? error.message : String(error);
    }
    if (admission !== undefined) {
      const origin = new URL(admission.launchUrl).origin;
      observations.launchUrlMatchesToken =
        admission.launchUrl === `${origin}/#profile=management&boot=${bootstrapToken}`;
      const shell = await fetch(`${origin}/`);
      observations.shellStatus = shell.status;
      observations.shellServesArtifact = (await shell.text()).includes("app-abcdef12.js");
      const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
      });
      observations.bootstrapStatus = bootstrap.status;
      if (bootstrap.status === 200) {
        const root = (await bootstrap.json()) as { build: { profileId: string } };
        observations.profileId = root.build.profileId;
      } else {
        observations.bootstrapBody = await bootstrap.text();
      }
      await Promise.all([admission.close(), admission.close()]);
      observations.listenerClosedAfterClose = await fetch(`${origin}/`).then(
        () => false,
        () => true,
      );
    }
  } finally {
    if (admission === undefined) {
      try {
        await rm(fixture.hostArtifactRoot, { recursive: true, force: true });
      } catch {
        // The fixture root is disposable.
      }
    } else {
      await fixture.dispose();
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      ...counts,
      observedProfileIds,
      facadeSawWorldInfoService,
      repositoryRuntimeRoot,
      ...observations,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? String(error.stack ?? error) : String(error));
  process.exit(1);
});