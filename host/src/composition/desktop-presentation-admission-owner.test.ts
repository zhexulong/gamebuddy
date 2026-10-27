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
  managementCreated: number;
  memoryCreated: number;
  worldInfoCreated: number;
  repositoryCreated: number;
  connectionCreated: number;
  managementClosed: number;
  memoryClosed: number;
  worldInfoClosed: number;
  connectionClosed: number;
  observedProfileIds: Readonly<{
    management: string | null;
    memory: string | null;
    worldInfo: string | null;
  }>;
  managementChatsStatus?: number;
  managementChatsBody?: unknown;
  propagatedOriginalFailure?: boolean;
  errorMessage?: string;
  launchUrlMatchesToken?: boolean;
  shellStatus?: number;
  shellRefusal?: string | null;
  bootstrapCause?: string | null;
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
  shellRefusal?: string | null;
  shellStatus?: number;
  shellServesArtifact?: boolean;
  bootstrapCause?: string | null;
  bootstrapStatus?: number;
  profileId?: string;
  voiceStateObserved?: string | null;
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
  chatFacadeCreated: number;
  chatServiceCreated: number;
  chatServiceClosed: number;
  managementCreated: number;
  memoryCreated: number;
  worldInfoCreated: number;
  repositoryCreated: number;
  connectionCreated: number;
  managementClosed: number;
  memoryClosed: number;
  worldInfoClosed: number;
  connectionClosed: number;
  observedProfileIds: Readonly<{
    chatFacade: string | null;
    chatService: string | null;
    management: string | null;
    memory: string | null;
    worldInfo: string | null;
  }>;
  facadeSawSharedStream: boolean;
  serviceSawSharedStream: boolean;
  connectionAgentDir: string | null;
  repositoryRuntimeRoot: string | null;
  runtimeRoot?: string;
  propagatedOriginalFailure?: boolean;
  errorMessage?: string;
  launchUrlMatchesToken?: boolean;
  shellStatus?: number;
  shellServesArtifact?: boolean;
  bootstrapStatus?: number;
  profileId?: string;
  gameIsNull?: boolean;
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
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
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
  assert.equal(observed.shellStatus, 200, "the shell answers; refusal: " + String(observed.shellRefusal ?? "none"));
  assert.equal(observed.shellServesArtifact, true);
  // The composed broker reaches both lanes: the Chat snapshot and the game
  // state of the supplied projection, under the composed profile identity.
  assert.equal(observed.bootstrapStatus, 200, "bootstrap answers; cause: " + String(observed.bootstrapCause ?? "none"));
  assert.equal(observed.composedProfileId, "gamebuddy.composed.reference-game");
  assert.equal(observed.chatProfileId, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.gameProfileId, "gamebuddy.game.preview");
  assert.ok(observed.readGameCalls >= 1);
  // The management domains the shell's Chats/Characters/Game/Settings/Memory/
  // World Info panels read and write are mounted by this exact admission: the
  // management profile and the same lease-bound services over the same durable
  // stores the standalone management surface mounts. Without them those panels
  // report the route as unsupported while the functional backend behind it
  // already worked.
  assert.equal(observed.managementCreated, 1);
  assert.equal(observed.memoryCreated, 1);
  assert.equal(observed.worldInfoCreated, 1);
  assert.equal(observed.repositoryCreated, 1);
  assert.equal(observed.connectionCreated, 1);
  const managementProfileId = "gamebuddy.tavern-management.chat-list-title";
  assert.equal(observed.observedProfileIds.management, managementProfileId);
  assert.equal(observed.observedProfileIds.memory, managementProfileId);
  assert.equal(observed.observedProfileIds.worldInfo, managementProfileId);
  // A management route the composed shell answered 404 for until now is served,
  // from the injected service, under the composed broker's own session.
  assert.equal(observed.managementChatsStatus, 200);
  const chatsBody = observed.managementChatsBody as {
    apiVersion?: number;
    chats?: readonly { title?: string; status?: string }[];
  } | null;
  assert.equal(chatsBody?.apiVersion, 1);
  assert.deepEqual(
    chatsBody?.chats?.map((chat) => [chat.title, chat.status]),
    [["Exact Chat", "active"]],
  );
  // The lifecycle owner's bind sink received the broker's admission issuer.
  assert.equal(observed.issuerBoundBeforeClose, true);
  // Closing once (twice requested) closes the one listener and drains the Chat
  // pipeline service and the management domains behind it exactly once.
  assert.equal(observed.listenerClosedAfterClose, true);
  assert.equal(observed.serviceClosedAfterClose, 1);
  assert.equal(observed.managementClosed, 1);
  assert.equal(observed.memoryClosed, 1);
  assert.equal(observed.worldInfoClosed, 1);
  assert.equal(observed.connectionClosed, 1);
});

test("presentation admission owner drains the Chat pipeline service and propagates an unverified artifact failure", async () => {
  const observed = await runPresentationAdmissionFixture("unverified-artifact");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.facadeCreated, 1);
  assert.equal(observed.serviceCreated, 1);
  // The listener never started, so the created Chat admission owner is drained
  // and the original artifact failure is propagated unchanged. The management
  // domains exist before the artifact is verified, so they drain in reverse
  // creation order too: no created service outlives a failed construction.
  assert.equal(observed.serviceClosed, 1);
  assert.equal(observed.managementClosed, 1);
  assert.equal(observed.memoryClosed, 1);
  assert.equal(observed.worldInfoClosed, 1);
  assert.equal(observed.connectionClosed, 1);
  assert.equal(observed.propagatedOriginalFailure, false);
  assert.ok((observed.errorMessage ?? "").length > 0);
});

test("chat-only presentation entry point serves the one composed shell without any game surface", async () => {
  const observed = await runChatOnlyPresentationAdmissionFixture("start-close");

  assert.equal(observed.outcome, "resolved");
  // The entry point declares the one reference Chat surface; both the state facade
  // and the pipeline service project that exact tavern profile over the one
  // shared event stream, and no game projection participates.
  assert.equal(observed.facadeCreated, 1);
  assert.equal(observed.serviceCreated, 1);
  assert.equal(observed.tavernProfileIdObservedByFacade, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.tavernProfileIdObservedByService, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.facadeSawSharedStream, true);
  assert.equal(observed.serviceSawSharedStream, true);
  // The verified browser artifact is served by the real listener under the one
  // product profile marker, and the waiter carries the one-time token.
  assert.equal(observed.launchUrlMatchesToken, true);
  assert.equal(observed.shellStatus, 200);
  assert.equal(observed.shellServesArtifact, true);
  // The composed bootstrap projection carries the reference profile identity in
  // its nested Chat snapshot; there is no game profile anywhere in this surface,
  // and the additive v1 voice surface projects through the real facade +
  // composed bootstrap route (mic icon lights up in the browser).
  assert.equal(observed.bootstrapStatus, 200, "bootstrap answers; cause: " + String(observed.bootstrapCause ?? "none"));
  assert.equal(observed.profileId, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(
    (observed as ChatOnlyPresentationAdmissionObservations & { voiceStateObserved?: string | null }).voiceStateObserved,
    "ready",
  );
  // Closing once (twice requested) closes the one listener and drains the Chat
  // pipeline service through its delegated handler exactly once. The entry point
  // never touches the mounted lease or any facade, and it created no Game owner.
  assert.equal(observed.listenerClosedAfterClose, true);
  assert.equal(observed.serviceClosedAfterClose, 1);
});

test("chat-only presentation entry point drains the Chat pipeline service and propagates an unverified artifact failure", async () => {
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

test("chat-only presentation entry point creates no Chat admission owner when the state facade does not construct", async () => {
  const observed = await runChatOnlyPresentationAdmissionFixture("facade-failure");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.propagatedOriginalFailure, true);
  assert.equal(observed.facadeCreated, 0);
  assert.equal(observed.serviceCreated, 0);
  assert.equal(observed.serviceClosed, 0);
});

test("management presentation entry point serves the one composed shell over its Chat-owned management services without any game surface", async () => {
  const observed = await runManagementPresentationAdmissionFixture("start-close");

  assert.equal(observed.outcome, "resolved");
  // The entry point serves the same single app the composed reference-game
  // surface serves: the reference Chat Core lane (state facade + pipeline
  // service, both on the one shared event stream) plus the management domains
  // the Chats/Characters/Settings/Memory surfaces read and write, over the one
  // management profile and the real durable managed repository. No Game
  // authority is constructed.
  assert.equal(observed.chatFacadeCreated, 1);
  assert.equal(observed.chatServiceCreated, 1);
  assert.equal(observed.observedProfileIds.chatFacade, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.observedProfileIds.chatService, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.facadeSawSharedStream, true);
  assert.equal(observed.serviceSawSharedStream, true);
  assert.equal(observed.managementCreated, 1);
  assert.equal(observed.memoryCreated, 1);
  assert.equal(observed.worldInfoCreated, 1);
  assert.equal(observed.repositoryCreated, 1);
  const managementProfileId = "gamebuddy.tavern-management.chat-list-title";
  assert.equal(observed.observedProfileIds.management, managementProfileId);
  assert.equal(observed.observedProfileIds.memory, managementProfileId);
  assert.equal(observed.observedProfileIds.worldInfo, managementProfileId);
  assert.equal(observed.repositoryRuntimeRoot, observed.runtimeRoot);
  // The connection service receives the exact agent directory of the mounted
  // Chat runtime - the identity's own context root, not a shared one. ADR-0010
  // makes a connection switch Class B, so the service is not wired to turn
  // state and never refuses a running turn.
  assert.equal(observed.connectionCreated, 1);
  const agentDir = (observed.connectionAgentDir ?? "").replaceAll("\\", "/");
  const runtimeRoot = (observed.runtimeRoot ?? "").replaceAll("\\", "/");
  assert.match(agentDir, /\/contexts\/[a-f0-9]{64}\/pi-agent$/);
  assert.ok(agentDir.startsWith(`${runtimeRoot}/`), `expected ${agentDir} under ${runtimeRoot}`);
  // The verified browser artifact is served by the real listener under the one
  // product profile marker, and the waiter carries the one-time token.
  assert.equal(observed.launchUrlMatchesToken, true);
  assert.equal(observed.shellStatus, 200);
  assert.equal(observed.shellServesArtifact, true);
  // The composed bootstrap carries the reference Chat projection and the honest
  // null Game projection: this entry point declares no game profile, so no Game
  // route and no lifecycle admission exists for it.
  assert.equal(observed.bootstrapStatus, 200);
  assert.equal(observed.profileId, "gamebuddy.chat-core.reference-pipeline");
  assert.equal(observed.gameIsNull, true);
  // Closing once (twice requested) closes the one listener and drains the Chat
  // pipeline service and every management service behind it exactly once; the
  // mounted lease and the reference facade stay their own owners'.
  assert.equal(observed.listenerClosedAfterClose, true);
  assert.equal(observed.chatServiceClosed, 1);
  assert.equal(observed.managementClosed, 1);
  assert.equal(observed.memoryClosed, 1);
  assert.equal(observed.worldInfoClosed, 1);
  assert.equal(observed.connectionClosed, 1);
});

test("management presentation entry point drains every created service and propagates an unverified artifact failure", async () => {
  const observed = await runManagementPresentationAdmissionFixture("unverified-artifact");

  assert.equal(observed.outcome, "rejected");
  // Every Chat-owned service was created before the listener verification
  // failed; the entry point drains them (Chat pipeline service, management,
  // Memory, World Info, connection) and propagates the original artifact
  // failure unchanged.
  assert.equal(observed.chatServiceClosed, 1);
  assert.equal(observed.managementClosed, 1);
  assert.equal(observed.memoryClosed, 1);
  assert.equal(observed.worldInfoClosed, 1);
  assert.equal(observed.connectionClosed, 1);
  assert.equal(observed.propagatedOriginalFailure, false);
  assert.ok((observed.errorMessage ?? "").length > 0);
});

test("management presentation entry point propagates a reference-facade failure and creates no service behind it", async () => {
  const observed = await runManagementPresentationAdmissionFixture("facade-failure");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.propagatedOriginalFailure, true);
  // The reference Chat lane is the first thing the one assembly constructs, so a
  // facade that does not construct leaves nothing created behind it: no Chat
  // pipeline service and no management domain ever exists, and nothing needs
  // draining.
  assert.equal(observed.chatFacadeCreated, 0);
  assert.equal(observed.chatServiceCreated, 0);
  assert.equal(observed.managementCreated, 0);
  assert.equal(observed.memoryCreated, 0);
  assert.equal(observed.worldInfoCreated, 0);
  assert.equal(observed.connectionCreated, 0);
  assert.equal(observed.chatServiceClosed, 0);
});

/**
 * The class gate the mount-level test cannot be for a lane that never runs it: a
 * route declared in the production management profile that no canonical group
 * accepts is green in tsc and in every focused suite that never mounts the
 * surface, and it is fatal to a real launch - the mount throws
 * `tavern_management_profile_operation_unavailable` during provisioning and the
 * product never starts. `composeTavernManagementProfile` is the one declaration
 * the mounted surface uses, so holding it against the dispatcher's own canonical
 * groups here fails at the change instead of in the launcher.
 */
test("the production management profile declaration fits the dispatcher's canonical groups", async () => {
  const { composeTavernManagementProfile } = await import("./desktop-presentation-admission-owner.js");
  const { managementProfileFitsCanonicalGroups } = await import("../tavern-management-dialogue-web.js");
  assert.equal(
    managementProfileFitsCanonicalGroups(composeTavernManagementProfile()),
    true,
    "the production management profile must declare exactly the canonical groups the dispatcher serves: a route outside every group throws at provisioning",
  );
});

/**
 * Every settings group the player can reach is ACTUALLY DECLARED by the production profile.
 *
 * The fit test above is not enough on its own, and the reason is a real green-through-the-defect
 * shape: `managementProfileFitsCanonicalGroups` asks whether the profile is a legal selection of
 * the dispatcher's groups, which is equally true when BOTH sides simply omit a group. A new
 * settings route could therefore be added to the contract, served by the dispatcher, and then
 * dropped from the profile - and the surface would answer `profile_operation_unavailable` to a
 * player while every test stayed green.
 *
 * So the population is derived from the settings route pairs the CONTRACT declares (any
 * `*.read`/`*.update` pair under `settings.`), and each one must appear in the production
 * profile's routes and operations. A contract that grows a settings pair fails here until the
 * profile declares it, which is the direction that costs a launch rather than a feature.
 */
test("the production management profile declares every settings pair the contract publishes", async () => {
  const { composeTavernManagementProfile } = await import("./desktop-presentation-admission-owner.js");
  const { TavernBrowserContractV1 } = await import("../tavern/browser-contract/index.js");
  const profile = composeTavernManagementProfile();

  const settingsRouteIds = TavernBrowserContractV1.routes
    .map((route) => route.routeId)
    .filter((routeId) => routeId.startsWith("settings."));
  assert.ok(settingsRouteIds.length > 0, "the contract publishes no settings routes at all");

  const missing = settingsRouteIds.filter((routeId) => !profile.routeIds.includes(routeId as never));
  assert.deepEqual(
    missing,
    [],
    `the production profile omits settings route(s) the contract publishes: ${missing.join(", ")} - the surface would answer profile_operation_unavailable`,
  );

  // Every one of those routes is also an OPERATION the browser can address, because these are
  // the settings groups the panel calls by operation id; a route with no operation is a route
  // the dispatcher serves and no projection lists.
  const profileOperations = new Set<string>(profile.operationIds);
  const missingOperations = settingsRouteIds.filter((routeId) => !profileOperations.has(routeId));
  assert.deepEqual(
    missingOperations,
    [],
    `the production profile omits settings operation(s) the contract publishes: ${missingOperations.join(", ")}`,
  );
});
