import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The composition-owned presentation admission owner is exercised through the
 * real composed static shell composition over a real verified browser artifact
 * and a real loopback listener; only the durable mounted-Chat lane builders are
 * module-mocked inside the worker, so the owner's own assembly (Chat profile
 * declaration, composed profile, game projection wiring, drain, listener close)
 * runs for real.
 */

type PresentationAdmissionObservations = Readonly<{
  scenario: string;
  outcome: "resolved" | "rejected";
  facadeCreated: number;
  serviceCreated: number;
  serviceClosed: number;
  readGameCalls: number;
  tavernProfileIdObservedByFacade: string | null;
  tavernProfileIdObservedByService: string | null;
  facadeSawSharedStream: boolean;
  serviceSawSharedStream: boolean;
  propagatedOriginalFailure?: boolean;
  errorMessage?: string;
  launchUrlMatchesToken?: boolean;
  shellStatus?: number;
  shellServesArtifact?: boolean;
  bootstrapStatus?: number;
  composedProfileId?: string;
  chatProfileId?: string;
  gameProfileId?: string | null;
  issuerBoundBeforeClose?: boolean;
  listenerClosedAfterClose?: boolean;
  serviceClosedAfterClose?: number;
}>;

function runChatOnlyPresentationAdmissionFixture(
  scenario: "start-close" | "unverified-artifact" | "facade-failure",
): Promise<ChatOnlyPresentationAdmissionObservations> {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test-fixtures",
    "desktop-presentation-admission-chat-only-worker.js",
  );
  return runFixture("chat_only", fixturePath, scenario) as Promise<ChatOnlyPresentationAdmissionObservations>;
}

type ChatOnlyPresentationAdmissionObservations = Readonly<{
  scenario: string;
  outcome: "resolved" | "rejected";
  facadeCreated: number;
  serviceCreated: number;
  serviceClosed: number;
  tavernProfileIdObservedByFacade: string | null;
  tavernProfileIdObservedByService: string | null;
  facadeSawSharedStream: boolean;
  serviceSawSharedStream: boolean;
  propagatedOriginalFailure?: boolean;
  errorMessage?: string;
  launchUrlMatchesToken?: boolean;
  shellStatus?: number;
  shellServesArtifact?: boolean;
  bootstrapStatus?: number;
  profileId?: string;
  listenerClosedAfterClose?: boolean;
  serviceClosedAfterClose?: number;
}>;

function runManagementPresentationAdmissionFixture(
  scenario: "start-close" | "unverified-artifact" | "facade-failure",
): Promise<ManagementPresentationAdmissionObservations> {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test-fixtures",
    "desktop-presentation-admission-management-worker.js",
  );
  return runFixture("management", fixturePath, scenario) as Promise<ManagementPresentationAdmissionObservations>;
}

type ManagementPresentationAdmissionObservations = Readonly<{
  scenario: string;
  outcome: "resolved" | "rejected";
  stateFacadeCreated: number;
  managementCreated: number;
  memoryCreated: number;
  worldInfoCreated: number;
  repositoryCreated: number;
  managementClosed: number;
  memoryClosed: number;
  worldInfoClosed: number;
  observedProfileIds: Readonly<{
    facade: string | null;
    management: string | null;
    memory: string | null;
    worldInfo: string | null;
  }>;
  facadeSawWorldInfoService: boolean;
  repositoryRuntimeRoot: string | null;
  runtimeRoot?: string;
  propagatedOriginalFailure?: boolean;
  errorMessage?: string;
  launchUrlMatchesToken?: boolean;
  shellStatus?: number;
  shellServesArtifact?: boolean;
  bootstrapStatus?: number;
  profileId?: string;
  listenerClosedAfterClose?: boolean;
}>;

function runFixture(
  kind: "presentation" | "chat_only" | "management",
  fixturePath: string,
  scenario: string,
): Promise<unknown> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", fixturePath, scenario], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error(`${kind}_admission_fixture_timeout:${scenario}`));
    }, 30_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timeout); rejectResult(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectResult(new Error(`${kind}_admission_fixture_exit_${String(code)}:${stderr || "<no stderr>"}`));
        return;
      }
      try {
        resolveResult(JSON.parse(output));
      } catch {
        rejectResult(new Error(`${kind}_admission_fixture_output_invalid:${output || "<no output>"}`));
      }
    });
  });
}

function runPresentationAdmissionFixture(
  scenario: "start-close" | "unverified-artifact" | "facade-failure",
): Promise<PresentationAdmissionObservations> {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test-fixtures",
    "desktop-presentation-admission-owner-worker.js",
  );
  return runFixture("presentation", fixturePath, scenario) as Promise<PresentationAdmissionObservations>;
}

test("presentation admission owner serves the composed reference-game shell over the mounted Chat lane and the game projection", async () => {
  const observed = await runPresentationAdmissionFixture("start-close");

  assert.equal(observed.outcome, "resolved");
  // The owner declares the one reference Chat surface and composes it with the
  // game projection it was handed; both the state facade and the pipeline
  // service project that exact tavern profile over the one shared event stream.
  assert.equal(observed.facadeCreated, 1);
  assert.equal(observed.serviceCreated, 1);
  assert.equal(observed.tavernProfileIdObservedByFacade, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.tavernProfileIdObservedByService, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.facadeSawSharedStream, true);
  assert.equal(observed.serviceSawSharedStream, true);
  // The verified browser artifact of the owning Host generation is served by the
  // real listener, and the launch URL carries the composed profile marker plus
  // the one-time bootstrap token.
  assert.equal(observed.launchUrlMatchesToken, true);
  assert.equal(observed.shellStatus, 200);
  assert.equal(observed.shellServesArtifact, true);
  // The composed broker reaches both lanes: the Chat snapshot and the game
  // state of the supplied projection, under the composed profile identity.
  assert.equal(observed.bootstrapStatus, 200);
  assert.equal(observed.composedProfileId, "gamebuddy.composed.reference-game");
  assert.equal(observed.chatProfileId, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.gameProfileId, "gamebuddy.game.preview");
  assert.ok(observed.readGameCalls >= 1);
  // The lifecycle owner's bind sink received the broker's admission issuer.
  assert.equal(observed.issuerBoundBeforeClose, true);
  // Closing once (twice requested) closes the one listener and drains the Chat
  // pipeline service through its delegated handler exactly once.
  assert.equal(observed.listenerClosedAfterClose, true);
  assert.equal(observed.serviceClosedAfterClose, 1);
});

test("presentation admission owner drains the Chat pipeline service and propagates an unverified artifact failure", async () => {
  const observed = await runPresentationAdmissionFixture("unverified-artifact");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.facadeCreated, 1);
  assert.equal(observed.serviceCreated, 1);
  // The listener never started, so the created Chat admission owner is drained
  // and the original artifact failure is propagated unchanged.
  assert.equal(observed.serviceClosed, 1);
  assert.equal(observed.propagatedOriginalFailure, false);
  assert.ok((observed.errorMessage ?? "").length > 0);
});

test("chat-only presentation admission variant serves the reference Chat Core shell without any game surface", async () => {
  const observed = await runChatOnlyPresentationAdmissionFixture("start-close");

  assert.equal(observed.outcome, "resolved");
  // The variant declares the one reference Chat surface; both the state facade
  // and the pipeline service project that exact tavern profile over the one
  // shared event stream, and no game projection participates.
  assert.equal(observed.facadeCreated, 1);
  assert.equal(observed.serviceCreated, 1);
  assert.equal(observed.tavernProfileIdObservedByFacade, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.tavernProfileIdObservedByService, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.facadeSawSharedStream, true);
  assert.equal(observed.serviceSawSharedStream, true);
  // The verified browser artifact is served by the real listener under the
  // reference profile marker, and the waiter carries the one-time token.
  assert.equal(observed.launchUrlMatchesToken, true);
  assert.equal(observed.shellStatus, 200);
  assert.equal(observed.shellServesArtifact, true);
  // The Chat Core bootstrap projection carries the reference profile identity;
  // there is no composed or game profile anywhere in this surface.
  assert.equal(observed.bootstrapStatus, 200);
  assert.equal(observed.profileId, "gamebuddy.chat-core.reference-pipeline");
  // Closing once (twice requested) closes the one listener and drains the Chat
  // pipeline service through its delegated handler exactly once. The chat-only
  // variant never touches the mounted lease or any facade, and it created no
  // Game owner.
  assert.equal(observed.listenerClosedAfterClose, true);
  assert.equal(observed.serviceClosedAfterClose, 1);
});

test("chat-only presentation admission variant drains the Chat pipeline service and propagates an unverified artifact failure", async () => {
  const observed = await runChatOnlyPresentationAdmissionFixture("unverified-artifact");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.facadeCreated, 1);
  assert.equal(observed.serviceCreated, 1);
  // The listener never started, so the created Chat admission owner is drained
  // and the original artifact failure is propagated unchanged.
  assert.equal(observed.serviceClosed, 1);
  assert.equal(observed.propagatedOriginalFailure, false);
  assert.ok((observed.errorMessage ?? "").length > 0);
});

test("chat-only presentation admission variant creates no Chat admission owner when the state facade does not construct", async () => {
  const observed = await runChatOnlyPresentationAdmissionFixture("facade-failure");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.propagatedOriginalFailure, true);
  assert.equal(observed.facadeCreated, 0);
  assert.equal(observed.serviceCreated, 0);
  assert.equal(observed.serviceClosed, 0);
});

test("management presentation admission variant serves the tavern_management shell over its Chat-owned services without any game surface", async () => {
  const observed = await runManagementPresentationAdmissionFixture("start-close");

  assert.equal(observed.outcome, "resolved");
  // The variant assembles the state facade, management service, Memory service,
  // World Info binding service, and the real durable managed repository, all
  // over the one management profile; the facade receives the exact binding
  // service and the repository is created from the manifest runtime root.
  assert.equal(observed.stateFacadeCreated, 1);
  assert.equal(observed.managementCreated, 1);
  assert.equal(observed.memoryCreated, 1);
  assert.equal(observed.worldInfoCreated, 1);
  assert.equal(observed.repositoryCreated, 1);
  assert.equal(observed.observedProfileIds.facade, "gamebuddy.tavern-management.chat-list-title");
  assert.equal(observed.observedProfileIds.management, "gamebuddy.tavern-management.chat-list-title");
  assert.equal(observed.observedProfileIds.memory, "gamebuddy.tavern-management.chat-list-title");
  assert.equal(observed.observedProfileIds.worldInfo, "gamebuddy.tavern-management.chat-list-title");
  assert.equal(observed.facadeSawWorldInfoService, true);
  assert.equal(observed.repositoryRuntimeRoot, observed.runtimeRoot);
  // The verified browser artifact is served by the real listener under the
  // management profile marker, and the waiter carries the one-time token.
  assert.equal(observed.launchUrlMatchesToken, true);
  assert.equal(observed.shellStatus, 200);
  assert.equal(observed.shellServesArtifact, true);
  assert.equal(observed.bootstrapStatus, 200);
  assert.equal(observed.profileId, "gamebuddy.tavern-management.chat-list-title");
  // Closing once (twice requested) closes the one listener and drains the
  // management, Memory, and World Info services behind it exactly once; the
  // mounted lease and any facade stay their own owners'.
  assert.equal(observed.listenerClosedAfterClose, true);
  assert.equal(observed.managementClosed, 1);
  assert.equal(observed.memoryClosed, 1);
  assert.equal(observed.worldInfoClosed, 1);
});

test("management presentation admission variant drains every created service and propagates an unverified artifact failure", async () => {
  const observed = await runManagementPresentationAdmissionFixture("unverified-artifact");

  assert.equal(observed.outcome, "rejected");
  // Every Chat-owned service was created before the listener verification
  // failed; the variant drains them (management, Memory, World Info) and
  // propagates the original artifact failure unchanged.
  assert.equal(observed.managementClosed, 1);
  assert.equal(observed.memoryClosed, 1);
  assert.equal(observed.worldInfoClosed, 1);
  assert.equal(observed.propagatedOriginalFailure, false);
  assert.ok((observed.errorMessage ?? "").length > 0);
});

test("management presentation admission variant drains only the services already created when the state facade fails", async () => {
  const observed = await runManagementPresentationAdmissionFixture("facade-failure");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.propagatedOriginalFailure, true);
  assert.equal(observed.stateFacadeCreated, 0);
  // The binding service was created before the facade; management and Memory
  // never constructed, and only the created binding service drains.
  assert.equal(observed.worldInfoCreated, 1);
  assert.equal(observed.managementCreated, 0);
  assert.equal(observed.memoryCreated, 0);
  assert.equal(observed.worldInfoClosed, 1);
  assert.equal(observed.managementClosed, 0);
  assert.equal(observed.memoryClosed, 0);
});
