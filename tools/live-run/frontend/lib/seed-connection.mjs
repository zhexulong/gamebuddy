// The run root's own model connection, seeded through the PRODUCT's writer before the Host child boots.
//
// A fresh run root has no activated connection, so the product answers `ChatModelRoute = none`: the
// composer refuses the send, and every driver that needs a real turn takes its named skip - a green
// `DONE-CAPTURE failed=0` with the turn-dependent screenshots missing. The harness owns the root and
// the endpoint's credential, so it supplies the connection the way a player's Settings screen does:
// create, probe, activate, through `createTavernConnectionService` as compiled into the exact
// generation this launch is about to install. No file is hand-written.
//
// The record is the operator's environment gateway (`cpa-oai`): its endpoint and credential come from
// the environment. The credential is never read, echoed or stored here - the store resolves it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER_ID = "cpa-oai";
/**
 * The gateway's own `/models` listing blinks: measured on 2026-10-27, one probe read 15 ids and omitted
 * the model the catalog names, which records `not_found` and leaves the root unseeded. The probe is a
 * plain GET, so re-asking is a read rather than a repair.
 */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 1_500;

/** The generation directory the artifact's own pointer names - the one the launcher will install. */
async function resolveGenerationRoot(artifactRoot) {
  let pointer;
  try {
    pointer = JSON.parse(await readFile(join(artifactRoot, "current.json"), "utf8"));
  } catch {
    throw new Error("artifact_pointer_unreadable");
  }
  if (typeof pointer?.generation !== "string" || !/^[a-z0-9-]+$/i.test(pointer.generation))
    throw new Error("artifact_pointer_generation_invalid");
  return join(artifactRoot, "generations", pointer.generation);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Seeds one active connection into `runtimeRoot` and answers what the product now holds there.
 *
 * Returns a closed outcome rather than throwing for every state a run can legitimately be in: an absent
 * credential, or an endpoint that will not answer, leaves the root as it was and the drivers take their
 * named skips exactly as before. Only a broken artifact throws, because that is not a run state.
 */
export async function seedRunConnection({ artifactRoot, runtimeRoot, principal, credential }) {
  if (typeof credential !== "string" || credential.length === 0)
    return Object.freeze({ kind: "skipped", reason: "credential_absent" });
  const generationRoot = await resolveGenerationRoot(artifactRoot);
  const load = (module) => import(pathToFileURL(join(generationRoot, module)).href);
  const { resolveRuntimePaths } = await load("runtime-identity.js");
  const { TAVERN_BROWSER_API_VERSION } = await load("tavern/browser-contract/index.js");
  const { createTavernConnectionService } = await load("tavern/connection-service.js");

  const paths = resolveRuntimePaths(principal, runtimeRoot);
  const service = createTavernConnectionService({ agentDir: paths.agentDir });
  try {
    const created = await service.create({ apiVersion: TAVERN_BROWSER_API_VERSION, providerId: PROVIDER_ID });
    const record = created.connections[0];
    if (record === undefined) return Object.freeze({ kind: "skipped", reason: "connection_create_projected_no_row" });

    let state = created;
    let failure = null;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
      const probe = await service.test(record.connectionId, state.revision);
      state = probe.state;
      failure = probe.outcome === "ready" ? null : probe.failure;
      if (failure === null) break;
      if (attempt < PROBE_ATTEMPTS) await delay(PROBE_RETRY_DELAY_MS);
    }
    // The store's own invariant is the reason the probe cannot be skipped: a record that is not `ready`
    // cannot be activated, so an endpoint that did not answer leaves this root with no connection.
    if (failure !== null) return Object.freeze({ kind: "skipped", reason: `probe_${failure}` });

    const activated = await service.activate(record.connectionId, state.revision);
    if (activated.active === null) return Object.freeze({ kind: "skipped", reason: "activate_projected_no_active" });
    return Object.freeze({
      kind: "seeded",
      providerId: activated.active.providerLabel,
      modelId: activated.active.modelId,
      thinkingLevel: activated.active.thinkingLevel,
    });
  } finally {
    await service.close();
  }
}
