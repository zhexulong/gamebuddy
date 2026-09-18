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

function runPresentationAdmissionFixture(
  scenario: "start-close" | "unverified-artifact" | "facade-failure",
): Promise<PresentationAdmissionObservations> {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test-fixtures",
    "desktop-presentation-admission-owner-worker.js",
  );
  return new Promise<PresentationAdmissionObservations>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", fixturePath, scenario], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error(`presentation_admission_fixture_timeout:${scenario}`));
    }, 30_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timeout); rejectResult(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectResult(new Error(`presentation_admission_fixture_exit_${String(code)}:${stderr || "<no stderr>"}`));
        return;
      }
      try {
        resolveResult(JSON.parse(output) as PresentationAdmissionObservations);
      } catch {
        rejectResult(new Error(`presentation_admission_fixture_output_invalid:${output || "<no output>"}`));
      }
    });
  });
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

test("presentation admission owner creates no Chat admission owner when the state facade does not construct", async () => {
  const observed = await runPresentationAdmissionFixture("facade-failure");

  assert.equal(observed.outcome, "rejected");
  assert.equal(observed.propagatedOriginalFailure, true);
  assert.equal(observed.facadeCreated, 0);
  assert.equal(observed.serviceCreated, 0);
  assert.equal(observed.serviceClosed, 0);
});
