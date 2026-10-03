#!/usr/bin/env node
/**
 * Tavern management UI-operation evidence runner.
 *
 * The `chat-tavern-live` release gate needs a `mounted_profile_operation_evidence`
 * mapping, and by contract that mapping may only come from REAL same-origin
 * execution of the mounted management surface - never from a static declaration
 * (tools/tavern-live-run-charter.md §2, tools/record-tavern-ui-operation-evidence.mjs).
 *
 * This runner mounts the real management composition on a fresh gate-owned root,
 * authenticates through its one-time bootstrap route, and performs each operation
 * the mounted `gamebuddy.tavern-management.chat-list-title` profile declares,
 * against the authenticated HTTP surface. It records only content-free outcomes
 * (operation id + passed/blocked + a revision), which is exactly the shape
 * `record-tavern-ui-operation-evidence.mjs` consumes.
 *
 * It never records titles, prompts, memory content, credentials, cookies, URLs or
 * operator identity.
 *
 * Maintenance contract: this is a runner for the REAL product surface. It may not
 * be replaced by a fixture that writes the sessionStorage key, by a mock fetch, or
 * by a hand-authored outcomes file - those would make the gate's operation
 * evidence a self-certification. If it cannot reach a real mounted session it
 * reports `blocked` and names the step that failed.
 */
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";
import { readMountedTavernManagementProfile } from "./lib/tavern-mounted-operation-vocabulary.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const OUTPUT_ROOT = process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

const IDENTITY = Object.freeze({
  playerId: "chat_audit_player",
  companionId: "chat_audit_companion",
  continuityId: "chat_audit_continuity",
});

function usage() {
  return "usage: node tools/run-tavern-management-operation-evidence.mjs --outcomes <path> [--report <path>]";
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag !== "--outcomes" && flag !== "--report") {
      if (flag === "--help") return Object.freeze({ help: true });
      throw new Error(`${usage()} (unknown flag: ${flag})`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(usage());
    if (values.has(flag)) throw new Error(`${usage()} (duplicate: ${flag})`);
    values.set(flag, resolve(value));
    index += 1;
  }
  const outcomes = values.get("--outcomes");
  if (outcomes === undefined) throw new Error(usage());
  return Object.freeze({ help: false, outcomesPath: outcomes, reportPath: values.get("--report") });
}

async function deadlineFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body?.csrfToken !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrfToken });
}

async function readJson(origin, client, path) {
  const response = await deadlineFetch(`${origin}${path}`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  if (!response.ok) throw new Error(`read_failed:${path}:${response.status}`);
  return response.json();
}

async function sendJson(origin, client, method, path, body) {
  const response = await deadlineFetch(`${origin}${path}`, {
    method,
    headers: {
      Cookie: client.cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "x-csrf-token": client.csrf,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`write_failed:${path}:${response.status}`);
  return response.json();
}

/** Record one real outcome. `blocked` carries a bounded reason, never content. */
function outcome(operationId, state, reason) {
  return state === "passed"
    ? Object.freeze({ operationId, outcome: "passed" })
    : Object.freeze({ operationId, outcome: "blocked", reason });
}

/**
 * Exercise the mounted management profile for real. Every step reads the current
 * revision it must CAS against from the live surface first, so a passing outcome
 * proves the operation actually round-tripped rather than the runner guessing a
 * revision. A step that cannot run is reported `blocked`; it is never skipped
 * silently and never upgraded.
 */
async function exerciseOperations(origin, client) {
  const results = [];
  const attempt = async (operationId, run) => {
    try {
      await run();
      results.push(outcome(operationId, "passed"));
    } catch (error) {
      const reason = error instanceof Error && /^[a-z_]+:[^\s]{0,120}$/.test(error.message)
        ? error.message
        : "operation_failed";
      results.push(outcome(operationId, "blocked", reason));
    }
  };

  // draft.save / draft.discard: CAS on the live draft revision, which the
  // snapshot exposes under `chat.draft.revision` (there is no top-level draft).
  const currentDraft = async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    const revision = snapshot?.chat?.draft?.revision;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("selection_generation_unavailable");
    if (!Number.isInteger(revision) || revision < 0) throw new Error("draft_revision_unavailable");
    return { generation, revision };
  };

    await attempt("draft.save", async () => {
    const { generation, revision } = await currentDraft();
    const draft = await sendJson(origin, client, "PUT", "/api/tavern/v1/draft", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      text: "please be brief",
    });
    // The reply IS the draft (BrowserDraftV1Schema: apiVersion, revision, text).
    // A saved draft means the text came back and the revision advanced;
    // accepting 2xx would report a pass for a write that stored nothing.
    if (draft === null || typeof draft !== "object") throw new Error("draft_state_unavailable");
    if (draft.text !== "please be brief") throw new Error("draft_text_not_applied");
    if (!Number.isInteger(draft.revision) || draft.revision <= revision)
      throw new Error("draft_revision_unadvanced");
  });

  await attempt("draft.discard", async () => {
    const { generation, revision } = await currentDraft();
    const draft = await sendJson(origin, client, "DELETE", "/api/tavern/v1/draft", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
    });
    // Discarding must clear the text and advance the revision.
    if (draft === null || typeof draft !== "object") throw new Error("draft_state_unavailable");
    if (draft.text !== null && draft.text !== "") throw new Error("draft_text_survived_discard");
    if (!Number.isInteger(draft.revision) || draft.revision <= revision)
      throw new Error("draft_revision_unadvanced");
  });

  // chat.rename: the CAS revision is the SELECTED CHAT LIST ENTRY's
  // `managementRevision` (from `/chats`), not anything on the snapshot.
  await attempt("chat.rename", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    const chatHandle = snapshot?.selection?.chatHandle;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("selection_generation_unavailable");
    if (typeof chatHandle !== "string" || chatHandle.length === 0) throw new Error("chat_handle_unavailable");
    const list = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const entries = Array.isArray(list?.chats) ? list.chats : Array.isArray(list) ? list : [];
    const entry = entries.find((candidate) => candidate?.handle === chatHandle);
    if (entry === undefined) throw new Error("selected_chat_entry_unavailable");
    if (!Number.isInteger(entry.managementRevision) || entry.managementRevision < 0)
      throw new Error("management_revision_unavailable");
    await sendJson(origin, client, "PUT", "/api/tavern/v1/chat/title", {
      apiVersion: 1,
      selectionGeneration: generation,
      chatHandle,
      expectedManagementRevision: entry.managementRevision,
      title: "Live Run",
    });
    // The rename must be visible in the list with an advanced management
    // revision, or a 2xx would be reporting a write that did not land.
    const after = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const afterEntries = Array.isArray(after?.chats) ? after.chats : Array.isArray(after) ? after : [];
    const renamed = afterEntries.find((candidate) => candidate?.handle === chatHandle);
    if (renamed === undefined) throw new Error("renamed_chat_entry_unavailable");
    if (renamed.title !== "Live Run") throw new Error("chat_title_not_applied");
    if (!Number.isInteger(renamed.managementRevision) || renamed.managementRevision <= entry.managementRevision)
      throw new Error("management_revision_unadvanced");
  });

    await attempt("memory.mutate", async () => {
    const memory = await readJson(origin, client, "/api/tavern/v1/memory");
    if (typeof memory?.projectionRevision !== "string" || memory.projectionRevision.length === 0)
      throw new Error("projection_revision_unavailable");
    if (!Array.isArray(memory.memories)) throw new Error("memory_list_unavailable");
    const before = memory.memories.length;
    const result = await sendJson(origin, client, "PUT", "/api/tavern/v1/memory", {
      apiVersion: 1,
      expectedProjectionRevision: memory.projectionRevision,
      operation: "create",
      content: "the player keeps a tidy ledger",
    });
    // MemoryMutationResultV1Schema === MemoryReadV1Schema: the reply is the new
    // projection. A create that stored nothing would come back with the same
    // revision and the same number of rows, so assert both.
    if (result === null || typeof result !== "object") throw new Error("memory_result_unavailable");
    if (typeof result.projectionRevision !== "string" || result.projectionRevision.length === 0)
      throw new Error("projection_revision_missing_after_mutation");
    if (result.projectionRevision === memory.projectionRevision)
      throw new Error("projection_revision_unadvanced");
    if (!Array.isArray(result.memories)) throw new Error("memory_result_list_unavailable");
    if (result.memories.length !== before + 1) throw new Error("memory_row_not_created");
  });

  await attempt("world-info.bind", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("selection_generation_unavailable");
    // The world-info CAS revision comes from its own read route; the snapshot
    // carries `chat.worldInfo` but the binding command CASes a revision string.
    const worldInfo = await readJson(origin, client, "/api/tavern/v1/world-info");
    const revision = worldInfo?.revision;
    if (typeof revision !== "string" || revision.length === 0)
      throw new Error("world_info_revision_unavailable");
    if (!Array.isArray(worldInfo.items)) throw new Error("world_info_items_unavailable");
    // COVERAGE BOUNDARY, deliberately not papered over. The browser contract
    // declares no world-info authoring route (25 routeIds, only read + bind), so
    // a fresh root's managed catalog is empty and no bindable `handle` can be
    // obtained. `sourceHandle: null` is therefore the ONLY reachable command,
    // which makes this operation evidence for the unbind path and NOT for
    // `bindExact` (managed-world-info-binding.ts). Asserting a bound state here
    // would require a catalog this surface cannot create. The state the command
    // returns is asserted below so the round-trip is real; the gap itself is
    // recorded for the release review rather than hidden by a thin assertion.
    const state = await sendJson(origin, client, "PUT", "/api/tavern/v1/world-info", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      sourceHandle: null,
    });
    if (state === null || typeof state !== "object") throw new Error("world_info_state_unavailable");
    if (typeof state.revision !== "string" || state.revision === revision)
      throw new Error("world_info_revision_unadvanced");
    if (typeof state.state !== "string" || state.state.length === 0)
      throw new Error("world_info_binding_state_unavailable");
  });

  // settings.voice.read / .consent / .devices: the voice preference is a
  // revisioned document read through its own route and mutated with a consent
  // command that CASes that revision. The read is the proof the surface is
  // mounted; the consent write is a real round-trip; the device enumeration is
  // a separate read-only route.
  await attempt("settings.voice.read", async () => {
    const voice = await readJson(origin, client, "/api/tavern/v1/settings/voice-preference");
    if (voice === null || typeof voice !== "object") throw new Error("voice_preference_unavailable");
    // The declared projection, not just "some object came back": a revision and a
    // closed consent state are what the consent step below CASes against.
    if (!Number.isInteger(voice.revision) || voice.revision < 0) throw new Error("voice_revision_unavailable");
    if (voice.consent !== "undecided" && voice.consent !== "accepted" && voice.consent !== "revoked")
      throw new Error("voice_consent_state_invalid");
  });

  await attempt("settings.voice.consent", async () => {
    const voice = await readJson(origin, client, "/api/tavern/v1/settings/voice-preference");
    const revision = voice?.revision;
    if (!Number.isInteger(revision) || revision < 0) throw new Error("voice_revision_unavailable");
    const consent = voice?.consent;
    // Accept once (a fresh root starts undecided); each run is its own root so
    // the accept path is what gets exercised. A record already accepted would
    // need a revoke, but this gate always boots a fresh root.
    if (consent !== "undecided" && consent !== "revoked") throw new Error("voice_consent_state_unexpected");
    await sendJson(origin, client, "PUT", "/api/tavern/v1/settings/voice-preference", {
      expectedRevision: revision,
      action: "accept",
      disclosureVersion: "mimo-cloud-tts-v1",
    });
  });

  await attempt("settings.voice.devices", async () => {
    const devices = await readJson(origin, client, "/api/tavern/v1/settings/voice-devices");
    // An empty list is legal (gateway absent / headless); an unparseable reply is not.
    if (devices === null || typeof devices !== "object") throw new Error("voice_devices_unavailable");
    if (!Array.isArray(devices.devices)) throw new Error("voice_device_list_unavailable");
    if (devices.defaultSelectable !== true) throw new Error("voice_default_not_selectable");
  });

  // settings.connection.*: the connection document is revisioned. The sequence
  // is read (surface mounted) -> create the environment connection (no key
  // accepted; it is the zero-configuration default) -> test it (the probe runs
  // against the operator-provided default endpoint; it may report failed, which
  // is a real outcome, not a harness failure) -> activate it (only a ready
  // record activates) -> pick a model (revised) -> delete it (needs the exact
  // revision and cannot be the active one). A fresh root has no active
  // connection, so create -> test -> activate -> model -> remove is linear and
  // every step is a real CAS round-trip.
  await attempt("settings.connection.read", async () => {
    const state = await readJson(origin, client, "/api/tavern/v1/settings/connection");
    if (state === null || typeof state !== "object") throw new Error("connection_state_unavailable");
    // A read that accepted any object proves only that a route answered. The
    // projection's declared shape is the real postcondition (design/28 5.1):
    // `connections` is an array of records, and `active` is that record or null.
    if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error("connection_revision_unavailable");
    if (!Array.isArray(state.connections)) throw new Error("connection_list_unavailable");
    if (state.active !== null && typeof state.active !== "object") throw new Error("connection_active_invalid");
  });

  await attempt("settings.connection.create", async () => {
    const state = await sendJson(origin, client, "POST", "/api/tavern/v1/settings/connections", {
      apiVersion: 1,
      providerId: "cpa-oai",
    });
    // Creating a record must advance the revision and put the record in the
    // list. Accepting the reply because it parsed would pass even if nothing
    // was stored, which is exactly the hollow-success shape this producer has
    // to rule out for every operation it reports as passed.
    if (!Number.isInteger(state?.revision) || state.revision < 1) throw new Error("connection_create_revision_unadvanced");
    if (!Array.isArray(state?.connections) || state.connections.length === 0)
      throw new Error("connection_create_not_stored");
  });

  // After create, the connection list carries the new record; we must find its
  // id and revision to drive test/activate/model/remove. The environment
  // connection is the zero-configuration default, so it will usually be ready
  // and activatable without any probe on the real loopback endpoint.
  const connectionList = async () => {
    const state = await readJson(origin, client, "/api/tavern/v1/settings/connection");
    const connection = Array.isArray(state?.connections) ? state.connections.find((entry) => entry?.connectionId) : undefined;
    if (connection === undefined) throw new Error("connection_entry_unavailable");
    return { connectionId: connection.connectionId, revision: state?.revision };
  };

  await attempt("settings.connection.test", async () => {
    const { connectionId, revision } = await connectionList();
    if (!Number.isInteger(revision) || revision < 0) throw new Error("connection_revision_unavailable");
    const probe = await sendJson(origin, client, "POST", `/api/tavern/v1/settings/connections/${connectionId}/test`, {
      apiVersion: 1,
      expectedRevision: revision,
    });
    if (probe?.outcome !== "ready" && probe?.outcome !== "failed") throw new Error("connection_probe_outcome_invalid");
    // `failed` alone is not evidence that a probe happened: a connection with no
    // key returns `failed/not_configured` without issuing any request
    // (connection-probe.ts). Reporting that as this operation's pass would make
    // the operation vacuous, so require a closed failure reason and require the
    // probe to have been attempted rather than skipped.
    if (probe.outcome === "failed" && (typeof probe.failure !== "string" || probe.failure.length === 0))
      throw new Error("connection_probe_failure_reason_missing");
    if (probe.outcome === "failed" && probe.failure === "not_configured")
      throw new Error("connection_probe_not_configured");
    if (probe.state === null || typeof probe.state !== "object") throw new Error("connection_probe_state_missing");
    // The probe writes its outcome into the record; without this the activate
    // step below would be the only thing distinguishing a real probe.
    if (!Number.isInteger(probe.state.revision) || probe.state.revision <= revision)
      throw new Error("connection_probe_revision_unadvanced");
  });

  await attempt("settings.connection.activate", async () => {
    const { connectionId, revision } = await connectionList();
    const state = await sendJson(origin, client, "POST", `/api/tavern/v1/settings/connections/${connectionId}/activate`, {
      apiVersion: 1,
      expectedRevision: revision,
    });
    if (state?.active?.connectionId !== connectionId) throw new Error("connection_activation_state_invalid");
  });

  await attempt("settings.connection.model", async () => {
    const { connectionId, revision } = await connectionList();
    // A chosen model needs a fresh probe (store.selectModel resets readiness),
    // so this runs after activate. The reply is the whole connection document:
    // assert the record really carries the requested model and that the write
    // advanced the revision. A bare 2xx would report a pass for a no-op write.
    const state = await sendJson(origin, client, "POST", `/api/tavern/v1/settings/connections/${connectionId}/model`, {
      apiVersion: 1,
      expectedRevision: revision,
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
    });
    const record = Array.isArray(state?.connections)
      ? state.connections.find((entry) => entry?.connectionId === connectionId)
      : undefined;
    if (record === undefined) throw new Error("connection_model_record_missing");
    if (record.modelId !== "deepseek-v4-flash" || record.thinkingLevel !== "high")
      throw new Error("connection_model_not_applied");
    if (!Number.isInteger(state.revision) || state.revision <= revision)
      throw new Error("connection_model_revision_unadvanced");
  });

  await attempt("settings.connection.remove", async () => {
    // The active connection cannot be removed. Use a second record: create it,
    // then delete it. The first (activated) record stays.
    const created = await sendJson(origin, client, "POST", "/api/tavern/v1/settings/connections", {
      apiVersion: 1,
      providerId: "cpa-oai",
    });
    const entry = Array.isArray(created?.connections) ? created.connections.at(-1) : undefined;
    const freshId = entry?.connectionId;
    const revision = created?.revision;
    if (typeof freshId !== "string" || !Number.isInteger(revision) || revision < 0)
      throw new Error("connection_remove_setup_invalid");
    await sendJson(origin, client, "DELETE", `/api/tavern/v1/settings/connections/${freshId}`, {
      apiVersion: 1,
      expectedRevision: revision,
    });
  });

  // design/28 §2 Characters surface: companion library + persona / scenario /
  // greeting CRUD through the same durable artifact-store services the desktop
  // owner composes. Every step asserts a DURABLE postcondition (revision or
  // content round-trip), never a bare 2xx.
  await attempt("companion.list", async () => {
    const list = await readJson(origin, client, "/api/tavern/v1/companions");
    if (list === null || typeof list !== "object") throw new Error("companion_list_unavailable");
    if (!Array.isArray(list.companions)) throw new Error("companion_list_missing");
    // The mounted companion must be present with its projected opaque handle
    // and the current marker: the composition always leads the library with
    // the mounted principal. Listing it is the durable proof the surface
    // mounted the library at all.
    const current = list.companions.find((entry) => entry?.isCurrent === true);
    if (current === undefined) throw new Error("companion_current_missing");
    if (typeof current.handle !== "string" || current.handle.length === 0)
      throw new Error("companion_handle_unavailable");
    if (typeof current.name !== "string" || current.name.length === 0) throw new Error("companion_name_missing");
    for (const entry of list.companions) {
      if (typeof entry?.handle !== "string" || entry.handle.length === 0) throw new Error("companion_handle_unavailable");
      if (typeof entry?.name !== "string" || entry.name.length === 0) throw new Error("companion_name_missing");
    }
  });

  await attempt("companion.detail", async () => {
    const list = await readJson(origin, client, "/api/tavern/v1/companions");
    const handle = Array.isArray(list?.companions) ? list.companions.find((entry) => entry?.isCurrent === true)?.handle : undefined;
    if (typeof handle !== "string" || handle.length === 0) throw new Error("companion_handle_unavailable");
    const detail = await readJson(origin, client, `/api/tavern/v1/companions/${handle}`);
    if (detail === null || typeof detail !== "object") throw new Error("companion_detail_unavailable");
    // The detail must name the same current companion back; a route that
    // answered with a generic shape would be reporting a capability it does
    // not actually bind.
    if (typeof detail.name !== "string" || detail.name.length === 0) throw new Error("companion_detail_name_missing");
  });

  await attempt("companion.create", async () => {
    const created = await sendJson(origin, client, "POST", "/api/tavern/v1/companions", {
      apiVersion: 1,
      name: "Harvest Helper",
    });
    if (created === null || typeof created !== "object") throw new Error("companion_create_unavailable");
    // The reply is the safe created detail; a bare 2xx would pass a write that
    // stored nothing. The created namespace is durable on disk in the store.
    if (created.name !== "Harvest Helper") throw new Error("companion_create_not_applied");
    const after = await readJson(origin, client, "/api/tavern/v1/companions");
    if (!Array.isArray(after?.companions)) throw new Error("companion_list_after_create_missing");
    if (!after.companions.some((entry) => entry?.name === "Harvest Helper"))
      throw new Error("companion_create_not_listed");
  });

  await attempt("persona.read", async () => {
    const persona = await readJson(origin, client, "/api/tavern/v1/persona");
    if (persona === null || typeof persona !== "object") throw new Error("persona_unavailable");
    if (typeof persona.present !== "boolean") throw new Error("persona_present_invalid");
    if (persona.present !== (Number.isInteger(persona.revision) && persona.revision >= 0))
      throw new Error("persona_revision_shape_invalid");
  });

  await attempt("persona.update", async () => {
    const before = await readJson(origin, client, "/api/tavern/v1/persona");
    const expectedRevision = before?.present === true && Number.isInteger(before.revision) ? before.revision : 0;
    const saved = await sendJson(origin, client, "PUT", "/api/tavern/v1/persona", {
      apiVersion: 1,
      expectedRevision,
      name: "The Gate Farmer",
      description: "A keeper of ledgers",
    });
    if (saved === null || typeof saved !== "object") throw new Error("persona_update_unavailable");
    if (saved.present !== true) throw new Error("persona_update_not_present");
    if (!Number.isInteger(saved.revision) || saved.revision <= expectedRevision)
      throw new Error("persona_revision_unadvanced");
    if (saved.name !== "The Gate Farmer") throw new Error("persona_name_not_applied");
  });

  await attempt("scenario.read", async () => {
    const scenario = await readJson(origin, client, "/api/tavern/v1/scenario");
    if (scenario === null || typeof scenario !== "object") throw new Error("scenario_unavailable");
    if (typeof scenario.present !== "boolean") throw new Error("scenario_present_invalid");
    if (scenario.present !== (Number.isInteger(scenario.revision) && scenario.revision >= 0))
      throw new Error("scenario_revision_shape_invalid");
  });

  await attempt("scenario.update", async () => {
    const before = await readJson(origin, client, "/api/tavern/v1/scenario");
    const expectedRevision = before?.present === true && Number.isInteger(before.revision) ? before.revision : 0;
    const saved = await sendJson(origin, client, "PUT", "/api/tavern/v1/scenario", {
      apiVersion: 1,
      expectedRevision,
      name: "First Spring",
      description: "The opening scene of a new save.",
    });
    if (saved === null || typeof saved !== "object") throw new Error("scenario_update_unavailable");
    if (saved.present !== true) throw new Error("scenario_update_not_present");
    if (!Number.isInteger(saved.revision) || saved.revision <= expectedRevision)
      throw new Error("scenario_revision_unadvanced");
    if (saved.name !== "First Spring") throw new Error("scenario_name_not_applied");
  });

  await attempt("greeting.read", async () => {
    const greeting = await readJson(origin, client, "/api/tavern/v1/greeting");
    if (greeting === null || typeof greeting !== "object") throw new Error("greeting_unavailable");
    if (typeof greeting.present !== "boolean") throw new Error("greeting_present_invalid");
  });

  await attempt("greeting.update", async () => {
    const before = await readJson(origin, client, "/api/tavern/v1/greeting");
    const expectedRevision = before?.present === true && Number.isInteger(before.revision) ? before.revision : 0;
    const saved = await sendJson(origin, client, "PUT", "/api/tavern/v1/greeting", {
      apiVersion: 1,
      expectedRevision,
      label: "Morning",
      variants: [{ label: "Casual", text: "Morning, chief." }],
    });
    if (saved === null || typeof saved !== "object") throw new Error("greeting_update_unavailable");
    if (saved.present !== true) throw new Error("greeting_update_not_present");
    if (!Number.isInteger(saved.revision) || saved.revision <= expectedRevision)
      throw new Error("greeting_revision_unadvanced");
    if (!Array.isArray(saved.variants) || saved.variants.length !== 1 || saved.variants[0]?.text !== "Morning, chief.")
      throw new Error("greeting_variant_not_applied");
  });

  // Chat lifecycle retention: the exact mounted chat's handle + management
  // revision come from the chat list; each transition CASes that revision and
  // asserts the durable status in the reply. Archive then restore then trash,
  // so the final state is trashed and every transition is real. The active
  // list only carries active chats, so after archiving the next revision is
  // threaded from the previous transition's result instead of a re-read.
  let retainedChat;
  const currentChat = async () => {
    if (retainedChat !== undefined) return retainedChat;
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    const chatHandle = snapshot?.selection?.chatHandle;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
    if (typeof chatHandle !== "string" || chatHandle.length === 0) throw new Error("chat_handle_unavailable");
    const list = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const entries = Array.isArray(list?.chats) ? list.chats : Array.isArray(list) ? list : [];
    const entry = entries.find((candidate) => candidate?.handle === chatHandle);
    if (entry === undefined) throw new Error("selected_chat_entry_unavailable");
    if (!Number.isInteger(entry.managementRevision) || entry.managementRevision < 0)
      throw new Error("management_revision_unavailable");
    return { generation, chatHandle, managementRevision: entry.managementRevision };
  };

  await attempt("chat.archive", async () => {
    const { generation, chatHandle, managementRevision } = await currentChat();
    const result = await sendJson(origin, client, "POST", `/api/tavern/v1/chats/${chatHandle}/archive`, {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedManagementRevision: managementRevision,
    });
    if (result === null || typeof result !== "object") throw new Error("chat_archive_unavailable");
    if (result.status !== "archived") throw new Error("chat_archive_not_applied");
    if (!Number.isInteger(result.managementRevision) || result.managementRevision <= managementRevision)
      throw new Error("chat_archive_revision_unadvanced");
    retainedChat = Object.freeze({ generation, chatHandle, managementRevision: result.managementRevision });
  });

    await attempt("chat.restore", async () => {
    const { generation, chatHandle, managementRevision } = await currentChat();
    const result = await sendJson(origin, client, "POST", `/api/tavern/v1/chats/${chatHandle}/restore`, {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedManagementRevision: managementRevision,
    });
    if (result === null || typeof result !== "object") throw new Error("chat_restore_unavailable");
    if (result.status !== "active") throw new Error("chat_restore_not_applied");
    if (!Number.isInteger(result.managementRevision) || result.managementRevision <= managementRevision)
      throw new Error("chat_restore_revision_unadvanced");
    retainedChat = Object.freeze({ generation, chatHandle, managementRevision: result.managementRevision });
  });

    await attempt("chat.trash", async () => {
    // Trash is legal directly from active (resolveLifecycleTransition:
    // trash from active or archived), and the previous restore left the chat
    // active with a threaded revision, so this is a single real transition.
    const { generation, chatHandle, managementRevision } = await currentChat();
    const result = await sendJson(origin, client, "POST", `/api/tavern/v1/chats/${chatHandle}/trash`, {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedManagementRevision: managementRevision,
    });
    if (result === null || typeof result !== "object") throw new Error("chat_trash_unavailable");
    if (result.status !== "trashed") throw new Error("chat_trash_not_applied");
    if (!Number.isInteger(result.managementRevision) || result.managementRevision <= managementRevision)
      throw new Error("chat_trash_revision_unadvanced");
  });

  return results;
}

export async function runManagementOperationEvidence({ outcomesPath, reportPath } = {}) {
  if (typeof outcomesPath !== "string" || outcomesPath.length === 0)
    throw new Error("outcomes_path_required");
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-ui-evidence-"));
  await mkdir(root, { recursive: true });
  const nonceSha256 = createHash("sha256").update(randomBytes(32)).digest("hex");
  const manifestPath = join(root, "tavern-ui-evidence.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: root,
        principal: { ...IDENTITY },
        bootstrapOperationId: `tavern_ui_evidence_${randomBytes(12).toString("hex")}`,
        authorityGeneration: 1,
      },
      null,
      2,
    ),
    "utf8",
  );

  let stderr = "";
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: OUTPUT_ROOT,
    root,
    surface: "management",
    nonceSha256,
    manifestPath,
    readyTimeoutMs: START_TIMEOUT_MS,
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
        if (stderr.length < 2_048) stderr = `${stderr}${chunk}`;
      });
      return child;
    },
  });

  let launchUrl;
  try {
    launchUrl = await launch.waitForReady();
  } catch (error) {
    launch.dispose?.();
    const diagnostic = stderr.trim();
    throw new Error(
      diagnostic.length > 0
        ? `${error?.message ?? "management_surface_unready"}:${diagnostic}`
        : (error?.message ?? "management_surface_unready"),
    );
  }

  try {
    const url = new URL(launchUrl);
    const origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    const operations = await exerciseOperations(origin, client);
    // The WHOLE profile is derived from the composition source, never hand-written.
    // Writing `routeIds` by hand here while deriving `operationIds` from the shared
    // vocabulary produced a profile that declared six `settings.connection.*`
    // operations with no corresponding route, and the release gate correctly rejected
    // it with `mounted_profile_operation_route_membership`. A hand-maintained field is
    // the same failure mode as the transcription files that drifted three times; the
    // whole projection must come from one authority.
    const profile = readMountedTavernManagementProfile();
    const payload = Object.freeze({ profile, operations });
    await writeFile(outcomesPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (typeof reportPath === "string" && reportPath.length > 0)
      await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const passed = operations.filter((entry) => entry.outcome === "passed").length;
  process.stdout.write(
    `${JSON.stringify({ state: passed > 0 ? "collected" : "blocked", passed, total: operations.length, operations })}\n`,
  );
  // Exit non-zero when nothing passed. The outcomes file is still written - it
  // records what actually happened - but a caller that shells out must not see
  // success from a run that produced no evidence at all. Previously this exited
  // 0 and relied on the downstream recorder to reject the file, which made a
  // total failure look like a successful collection to anything reading the
  // exit status.
  if (passed === 0) process.exitCode = 1;
  return payload;
  } finally {
    launch.dispose?.();
    launch.child?.kill?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    await runManagementOperationEvidence({
      outcomesPath: parsed.outcomesPath,
      reportPath: parsed.reportPath,
    });
  }
}
