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
 * Hermetic fixture for the composition-owned chat-only presentation admission
 * variant. It is spawned by desktop-presentation-admission-owner.test.ts with
 * `--experimental-test-module-mocks`: only the two mounted-Chat lane builders
 * (the durable state facade and the Chat pipeline service) are mocked by URL,
 * so the real reference static shell composition still verifies a real browser
 * artifact and serves a real loopback listener. No game projection is ever
 * supplied to the variant. The worker prints one JSON line of observations;
 * the test owns every assertion.
 */

const scenario = process.argv[2] ?? "";
const bootstrapToken = `${"A".repeat(42)}A`;
const constructionFailure = new Error("chat_only_lane_construction_failed");
const counts = { facadeCreated: 0, serviceCreated: 0, serviceClosed: 0 };
let tavernProfileIdObservedByFacade: string | null = null;
let tavernProfileIdObservedByService: string | null = null;
let facadeSawSharedStream = false;
let serviceSawSharedStream = false;
let eventStream: ReturnType<typeof createChatEventStream> | undefined;

const handle = `${"B".repeat(42)}A`;
const base = TavernBrowserFixtureV1.snapshot();
const fakeFacade = Object.freeze({
  read: async () =>
    Object.freeze({
      selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
      companionDisplayName: "Mira",
      title: "Exact Chat",
      transcript: Object.freeze([]),
      draft: Object.freeze({ revision: 1, text: null }),
      turn: null,
      operations: base.operations,
      eventStream: null,
    }),
  readDraft: async () => Object.freeze({ apiVersion: 1, revision: 1, text: "Saved draft" }),
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
  const hostArtifactRoot = await mkdtemp(join(tmpdir(), "gamebuddy-chat-only-admission-"));
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
    pathToFileURL(join(moduleDirectory, "..", "tavern", "reference-pipeline-state.js")).href,
    {
      namedExports: {
        createReferencePipelineStateFacade: async (
          _manifest: unknown,
          _lease: unknown,
          profile: { readonly profileId?: string } | undefined,
          stream: unknown,
        ) => {
          if (scenario === "facade-failure") throw constructionFailure;
          counts.facadeCreated += 1;
          tavernProfileIdObservedByFacade = profile?.profileId ?? null;
          facadeSawSharedStream = stream === eventStream;
          return fakeFacade;
        },
      },
    },
  );
  await mock.module(
    pathToFileURL(join(moduleDirectory, "..", "tavern", "chat-pipeline-service.js")).href,
    {
      namedExports: {
        createChatPipelineService: (options: {
          readonly profile?: { readonly profileId?: string };
          readonly eventStream?: unknown;
        }) => {
          counts.serviceCreated += 1;
          tavernProfileIdObservedByService = options?.profile?.profileId ?? null;
          serviceSawSharedStream = options?.eventStream === eventStream;
          return Object.freeze({
            submitAfterResponseCommit: async () => {
              throw new Error("unused_submit");
            },
            readSubmissionStatus: async () => {
              throw new Error("unused_status");
            },
            cancel: async () => {
              throw new Error("unused_cancel");
            },
            close: async () => {
              counts.serviceClosed += 1;
            },
          });
        },
      },
    },
  );

  const { startChatOnlyPresentationAdmission } = await import(
    pathToFileURL(join(moduleDirectory, "..", "composition", "desktop-presentation-admission-owner.js")).href
  );
  const fixture = await artifactFixture(scenario !== "unverified-artifact");
  eventStream = createChatEventStream();
  const observations: Record<string, unknown> = {
    scenario,
  };
  let admission: Awaited<ReturnType<typeof startChatOnlyPresentationAdmission>> | undefined;
  try {
    try {
      admission = await startChatOnlyPresentationAdmission({
        manifest: Object.freeze({}) as never,
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
        admission.launchUrl === `${origin}/#profile=reference&boot=${bootstrapToken}`;
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
      }
      await Promise.all([admission.close(), admission.close()]);
      observations.listenerClosedAfterClose = await fetch(`${origin}/`).then(
        () => false,
        () => true,
      );
      observations.serviceClosedAfterClose = counts.serviceClosed;
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
      tavernProfileIdObservedByFacade,
      tavernProfileIdObservedByService,
      facadeSawSharedStream,
      serviceSawSharedStream,
      ...observations,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? String(error.stack ?? error) : String(error));
  process.exit(1);
});