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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The same bounded BCP-47 shape the Host stores for the companion language
// (settings/player-preference-store.ts). The shape is bounded; the language set is the
// player's choice, so this operation's evidence deliberately uses a tag outside the
// pair the panel used to be limited to.
const COMPANION_LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/;

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";
import { readMountedTavernManagementProfile } from "./lib/tavern-mounted-operation-vocabulary.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const OUTPUT_ROOT = process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
/** Bounded wait for the launched Host child to exit before the root is removed. */
const GATE_CHILD_EXIT_TIMEOUT_MS = 20_000;
/** Bounded removal attempts; the Host can hold a handle briefly after exit. */
const GATE_ROOT_REMOVE_ATTEMPTS = 10;
const GATE_ROOT_REMOVE_RETRY_MS = 200;

/**
 * Bounded wait for the launched Host child to actually exit. Node reports the
 * exit through an event, so a caller that only sent `kill()` has no synchronous
 * signal that the process - and the file handles it holds inside the gate root -
 * is gone.
 */
function waitForChildExit(child, timeoutMs) {
  if (child === undefined || child === null) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Remove the disposable gate root, retrying while the Host releases its
 * handles. Returns null on success, or the path that could not be removed so
 * the caller can report it instead of leaving a gigabyte behind silently.
 */
async function removeGateRoot(root) {
  for (let attempt = 0; attempt < GATE_ROOT_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return null;
    } catch {
      await sleep(GATE_ROOT_REMOVE_RETRY_MS);
    }
  }
  return root;
}

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

async function bootstrap(origin, token, sessionEntry) {
  // The surface that was mounted decides how a caller gets a session, and the acknowledgement publishes
  // it. Guessing the management route is how a truthful 404 became a day-long investigation.
  if (sessionEntry?.kind !== "http")
    throw new Error(
      `session_entry_unusable:${sessionEntry?.kind ?? "unpublished"}: the launched surface's session entry is not an HTTP token exchange`,
    );
  const response = await deadlineFetch(`${origin}${sessionEntry.route}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof (body?.csrfToken ?? body?.chat?.csrfToken) !== "string") {
    process.stderr.write(
      `[bootstrap-diag] ${response.status} ${response.url ?? ""} body=${(() => {
        try {
          return JSON.stringify(body ?? null);
        } catch {
          return "unavailable";
        }
      })().slice(0, 300)}\n`,
    );
    throw new Error(`bootstrap_failed:${response.status}`);
  }
  return Object.freeze({ cookie, csrf: body.csrfToken ?? body.chat.csrfToken });
}

async function readJson(origin, client, path) {
  const response = await deadlineFetch(`${origin}${path}`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  if (!response.ok) throw new Error(`read_failed:${path}:${response.status}${await problemSuffix(response)}`);
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
  if (!response.ok) throw new Error(`write_failed:${path}:${response.status}${await problemSuffix(response)}`);
  return response.json();
}

/**
 * The bounded machine code of a refusal, appended to the outcome reason. Without
 * it a `blocked` outcome can only say "409", and the dispatcher maps every
 * unmapped error message to the same `state_reconciliation_required` 409, so a
 * missing mapping is indistinguishable from a genuine conflict. The code is one
 * of the contract's fixed problem codes, never content.
 */
async function problemSuffix(response) {
  try {
    const problem = await response.json();
    return typeof problem?.code === "string" && /^[a-z0-9_]{1,64}$/.test(problem.code) ? `:${problem.code}` : "";
  } catch {
    return "";
  }
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
      // Keep the step's own bounded machine code. A bare code (no colon) is as
      // informative as a classified one, and collapsing it to `operation_failed`
      // hid which assertion actually failed: the reason kept the shape of a
      // channel error while the real cause was a specific postcondition.
      const reason =
        error instanceof Error && /^[a-z0-9_]{3,80}(:[^\s]{0,120})?$/.test(error.message)
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
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
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
    if (!Number.isInteger(draft.revision) || draft.revision <= revision) throw new Error("draft_revision_unadvanced");
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
    if (!Number.isInteger(draft.revision) || draft.revision <= revision) throw new Error("draft_revision_unadvanced");
  });

  // chat.rename: the CAS revision is the SELECTED CHAT LIST ENTRY's
  // `managementRevision` (from `/chats`), not anything on the snapshot, and the
  // command names its target by that entry's own handle - there is no mounted-only
  // selection generation on the wire any more.
  await attempt("chat.rename", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const chatHandle = snapshot?.selection?.chatHandle;
    if (typeof chatHandle !== "string" || chatHandle.length === 0) throw new Error("chat_handle_unavailable");
    const list = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const entries = Array.isArray(list?.chats) ? list.chats : Array.isArray(list) ? list : [];
    const entry = entries.find((candidate) => candidate?.handle === chatHandle);
    if (entry === undefined) throw new Error("selected_chat_entry_unavailable");
    if (!Number.isInteger(entry.managementRevision) || entry.managementRevision < 0)
      throw new Error("management_revision_unavailable");
    await sendJson(origin, client, "PUT", "/api/tavern/v1/chat/title", {
      apiVersion: 1,
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

  // chat.opening: the greeting variant choice for the mounted, not-yet-sealed Chat. It is legal
  // exactly while `opening_locked_at_event_id` is null, which a fresh run's Chat is - the lock is
  // written by a submit and this runner never submits - and it must run before `greeting.update`
  // below, which rewrites the greeting set the mounted Chat's opening was drawn from.
  await attempt("chat.opening", async () => {
    const greeting = await readJson(origin, client, "/api/tavern/v1/greeting");
    const count = Array.isArray(greeting?.variants) ? greeting.variants.length : 0;
    if (count < 1) throw new Error("chat_opening_greeting_variants_unavailable");
    const before = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = before?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
    const opened = Array.isArray(before?.chat?.transcript) ? before.chat.transcript[0]?.openingVariant : undefined;
    const currentIndex = Number.isInteger(opened?.index) ? opened.index : 0;
    // A different position whenever the set has one, so a pass cannot be the variant the Chat
    // already opened with.
    const targetIndex = count > 1 && currentIndex === 0 ? 1 : 0;
    const chosen = await sendJson(origin, client, "PUT", "/api/tavern/v1/chat/opening", {
      apiVersion: 1,
      selectionGeneration: generation,
      targetIndex,
    });
    if (chosen === null || typeof chosen !== "object") throw new Error("chat_opening_result_unavailable");
    const variant = chosen.openingVariant;
    if (variant === null || typeof variant !== "object") throw new Error("chat_opening_variant_unavailable");
    if (variant.index !== targetIndex) throw new Error("chat_opening_index_not_applied");
    if (variant.count !== count) throw new Error("chat_opening_count_mismatch");
    if (typeof variant.variantId !== "string" || variant.variantId.length === 0)
      throw new Error("chat_opening_variant_id_missing");
    if (variant.locked !== false) throw new Error("chat_opening_sealed_by_commit");
    // The durable half, read through the snapshot: message zero must carry the committed variant,
    // so a commit that only answered its own projection fails here.
    const after = await readJson(origin, client, "/api/tavern/v1/state");
    const opening = Array.isArray(after?.chat?.transcript) ? after.chat.transcript[0]?.openingVariant : undefined;
    if (opening === undefined || opening === null) throw new Error("chat_opening_not_durable");
    if (opening.variantId !== variant.variantId) throw new Error("chat_opening_variant_not_durable");
    if (opening.index !== targetIndex) throw new Error("chat_opening_index_not_durable");
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
    if (result.projectionRevision === memory.projectionRevision) throw new Error("projection_revision_unadvanced");
    if (!Array.isArray(result.memories)) throw new Error("memory_result_list_unavailable");
    if (result.memories.length !== before + 1) throw new Error("memory_row_not_created");
  });

  await attempt("world-info.bind", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
    // The world-info CAS revision comes from its own read route; the snapshot
    // carries `chat.worldInfo` but the binding command CASes a revision string.
    const worldInfo = await readJson(origin, client, "/api/tavern/v1/world-info");
    const revision = worldInfo?.revision;
    if (typeof revision !== "string" || revision.length === 0) throw new Error("world_info_revision_unavailable");
    if (!Array.isArray(worldInfo.items)) throw new Error("world_info_items_unavailable");
    // THIS OPERATION'S COVERAGE BOUNDARY, deliberately not papered over. `world-info.bind`
    // seeds nothing and this is the run's first library step, so on a fresh gate root the
    // catalog it reads is empty and `sourceHandle: null` is the ONLY command it can send.
    // The evidence below is therefore evidence for the unbind path and NOT for `bindExact`
    // (managed-world-info-binding.ts); that path stays uncovered by this runner. Asserting
    // a bound state here would require a catalog this step does not create - the authoring
    // steps below create one, and they are what cover the library's write half. The state
    // the command returns is asserted below so the round-trip is real; the gap itself is
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

  // The managed library's authoring half, on the same fresh root the bind step above left
  // empty. Every step reads the current opaque projection first: a handle or a projection
  // revision from any other read is refused rather than guessed, which is why the pair used
  // below always comes from one read.
  const AUTHORED_TITLE = "Gate fixture town";
  const worldInfoProjection = async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
    const state = await readJson(origin, client, "/api/tavern/v1/world-info");
    if (typeof state?.revision !== "string" || state.revision.length === 0)
      throw new Error("world_info_revision_unavailable");
    if (!Array.isArray(state.items)) throw new Error("world_info_items_unavailable");
    return { generation, revision: state.revision, items: state.items };
  };
  const authoredItem = async () => {
    const { generation, revision, items } = await worldInfoProjection();
    const item = items.find((candidate) => candidate.title === AUTHORED_TITLE);
    if (item === undefined) throw new Error("world_info_authored_item_unavailable");
    return { generation, revision, handle: item.handle };
  };
  const worldInfoItemPath = (generation, revision, handle) =>
    `/api/tavern/v1/world-info/item?apiVersion=1&selectionGeneration=${generation}` +
    `&expectedRevision=${revision}&itemHandle=${handle}`;

  await attempt("world-info.create", async () => {
    const { generation, revision, items } = await worldInfoProjection();
    const before = items.length;
    const created = await sendJson(origin, client, "POST", "/api/tavern/v1/world-info/item", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      item: {
        publicTitle: AUTHORED_TITLE,
        summary: "A small valley town.",
        entries: [
          { scope: "setting", publicTitle: "Square", summary: "The town centre." },
          { scope: "companion", publicTitle: "Rain", summary: "It rains on the farm.", keys: ["rain"] },
        ],
      },
    });
    // A create that stored nothing answers with the same projection revision and the same
    // number of items, so both are checked on the reply rather than on the read it CASed
    // against.
    if (created === null || typeof created !== "object") throw new Error("world_info_state_unavailable");
    if (typeof created.revision !== "string" || created.revision === revision)
      throw new Error("world_info_create_revision_unadvanced");
    if (!Array.isArray(created.items) || created.items.length !== before + 1)
      throw new Error("world_info_item_not_created");
  });

  await attempt("world-info.detail", async () => {
    const { generation, revision, handle } = await authoredItem();
    const detail = await readJson(origin, client, worldInfoItemPath(generation, revision, handle));
    // The reply is the item's own content: a read that answered with the list row would
    // carry no entries at all.
    if (detail === null || typeof detail !== "object") throw new Error("world_info_item_unavailable");
    if (detail.publicTitle !== AUTHORED_TITLE) throw new Error("world_info_item_title_mismatch");
    if (detail.revision !== 1) throw new Error("world_info_item_revision_unexpected");
    if (!Array.isArray(detail.entries) || detail.entries.length !== 2)
      throw new Error("world_info_item_entries_unavailable");
  });

  await attempt("world-info.update", async () => {
    const { generation, revision, handle } = await authoredItem();
    const updated = await sendJson(origin, client, "PUT", "/api/tavern/v1/world-info/item", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      itemHandle: handle,
      item: {
        publicTitle: AUTHORED_TITLE,
        summary: "The revised town facts.",
        entries: [{ scope: "setting", publicTitle: "Square", summary: "The town centre, revised." }],
        expectedRevision: 1,
      },
    });
    if (updated === null || typeof updated !== "object") throw new Error("world_info_state_unavailable");
    if (typeof updated.revision !== "string" || updated.revision === revision)
      throw new Error("world_info_update_revision_unadvanced");
    // The library's own revision advanced for the ITEM, not the projection: reading it back
    // through the detail route is what proves the new content was stored.
    const after = await authoredItem();
    const detail = await readJson(origin, client, worldInfoItemPath(after.generation, after.revision, after.handle));
    if (detail?.revision !== 2) throw new Error("world_info_item_revision_unadvanced");
    if (detail?.summary !== "The revised town facts.") throw new Error("world_info_update_not_applied");
    if (detail?.entries?.[0]?.summary !== "The town centre, revised.") throw new Error("world_info_update_not_durable");
  });

  await attempt("world-info.delete", async () => {
    const { generation, revision, items } = await worldInfoProjection();
    const item = items.find((candidate) => candidate.title === AUTHORED_TITLE);
    if (item === undefined) throw new Error("world_info_authored_item_unavailable");
    const before = items.length;
    const removed = await sendJson(origin, client, "DELETE", "/api/tavern/v1/world-info/item", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      itemHandle: item.handle,
    });
    if (removed === null || typeof removed !== "object") throw new Error("world_info_state_unavailable");
    if (typeof removed.revision !== "string" || removed.revision === revision)
      throw new Error("world_info_delete_revision_unadvanced");
    if (!Array.isArray(removed.items) || removed.items.length !== before - 1)
      throw new Error("world_info_item_not_removed");
    // The removal must also be gone from a fresh read, not only from the reply.
    const after = await worldInfoProjection();
    if (after.items.some((candidate) => candidate.title === AUTHORED_TITLE))
      throw new Error("world_info_removed_item_retained");
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
    const written = await sendJson(origin, client, "PUT", "/api/tavern/v1/settings/voice-preference", {
      expectedRevision: revision,
      action: "accept",
      disclosureVersion: "mimo-cloud-tts-v1",
    });
    // Everything above guards the revision this write CASes - a guard a write
    // that stored nothing satisfies just as well. The write's own postcondition
    // is what the reply projects: the consent state that was requested, the
    // disclosure it was requested against, the decision stamp, and a revision
    // the write advanced. Without this the operation reported a pass for a
    // consent that was never recorded.
    if (written === null || typeof written !== "object") throw new Error("voice_consent_write_unavailable");
    if (written.consent !== "accepted") throw new Error("voice_consent_not_applied");
    if (written.disclosureVersion !== "mimo-cloud-tts-v1") throw new Error("voice_disclosure_not_applied");
    if (!Number.isSafeInteger(written.decidedAtMs) || written.decidedAtMs <= 0)
      throw new Error("voice_consent_decision_timestamp_missing");
    if (!Number.isInteger(written.revision) || written.revision <= revision)
      throw new Error("voice_consent_revision_unadvanced");
    // The reply is not the durable postcondition; a separate read through the
    // read route is. It must still report the consented state, on the revision
    // the write returned, or the record never landed in the one player
    // preference document every settings surface shares.
    const after = await readJson(origin, client, "/api/tavern/v1/settings/voice-preference");
    if (after?.consent !== "accepted") throw new Error("voice_consent_not_durable");
    if (after?.revision !== written.revision) throw new Error("voice_consent_readback_revision_mismatch");
  });

  await attempt("settings.voice.devices", async () => {
    const devices = await readJson(origin, client, "/api/tavern/v1/settings/voice-devices");
    // An empty list is legal (gateway absent / headless); an unparseable reply is not.
    if (devices === null || typeof devices !== "object") throw new Error("voice_devices_unavailable");
    if (!Array.isArray(devices.devices)) throw new Error("voice_device_list_unavailable");
    if (devices.defaultSelectable !== true) throw new Error("voice_default_not_selectable");
  });

  // settings.language.read / .update: the companion language the runtimes read
  // at mount. It is a field group of the SAME one-revision player-preference
  // record the Voice surface above writes, read through its own route and
  // mutated with a revision-checked command. The read proves the surface is
  // mounted; the update must read back through the read route, because a 2xx
  // whose value never landed is exactly the hollow success this producer exists
  // to rule out.
  await attempt("settings.language.read", async () => {
    const language = await readJson(origin, client, "/api/tavern/v1/settings/language");
    if (language === null || typeof language !== "object") throw new Error("language_preference_unavailable");
    // The declared projection (design/28 5.1), not just "some object came
    // back": a revision and a bounded BCP-47 tag (null = never configured).
    if (!Number.isInteger(language.revision) || language.revision < 0) throw new Error("language_revision_unavailable");
    if (language.locale !== null && !COMPANION_LOCALE_PATTERN.test(language.locale))
      throw new Error("language_locale_invalid");
  });

  await attempt("settings.language.update", async () => {
    const before = await readJson(origin, client, "/api/tavern/v1/settings/language");
    const expectedRevision = before?.revision;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("language_revision_unavailable");
    // Write the locale the record does not already carry, so the assertions
    // below cannot pass on a value that was there before the write. The tag is
    // deliberately outside the pair the panel used to be limited to: accepting it is
    // the capability this operation is evidence for.
    const locale = before?.locale === "ja-JP" ? "en-US" : "ja-JP";
    const written = await sendJson(origin, client, "PUT", "/api/tavern/v1/settings/language", {
      expectedRevision,
      locale,
    });
    if (written === null || typeof written !== "object") throw new Error("language_write_unavailable");
    if (written.locale !== locale) throw new Error("language_locale_not_applied");
    if (!Number.isInteger(written.revision) || written.revision <= expectedRevision)
      throw new Error("language_revision_unadvanced");
    // The reply is not the postcondition. A separate read through the read route
    // is: it must report the locale that was written, still on the revision the
    // write returned, or the mutation was never durable.
    const after = await readJson(origin, client, "/api/tavern/v1/settings/language");
    if (after?.locale !== locale) throw new Error("language_locale_not_durable");
    if (after?.revision !== written.revision) throw new Error("language_readback_revision_mismatch");
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
    if (!Number.isInteger(state?.revision) || state.revision < 1)
      throw new Error("connection_create_revision_unadvanced");
    if (!Array.isArray(state?.connections) || state.connections.length === 0)
      throw new Error("connection_create_not_stored");
  });

  // After create, the connection list carries the new record; we must find its
  // id and revision to drive test/activate/model/remove. The environment
  // connection is the zero-configuration default, so it will usually be ready
  // and activatable without any probe on the real loopback endpoint.
  const connectionList = async () => {
    const state = await readJson(origin, client, "/api/tavern/v1/settings/connection");
    const connection = Array.isArray(state?.connections)
      ? state.connections.find((entry) => entry?.connectionId)
      : undefined;
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
    const state = await sendJson(
      origin,
      client,
      "POST",
      `/api/tavern/v1/settings/connections/${connectionId}/activate`,
      {
        apiVersion: 1,
        expectedRevision: revision,
      },
    );
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
    const removed = await sendJson(origin, client, "DELETE", `/api/tavern/v1/settings/connections/${freshId}`, {
      apiVersion: 1,
      expectedRevision: revision,
    });
    // A delete that is only issued is not a delete: the reply is the whole
    // connection document (TavernConnectionStateV1Schema), so the removed
    // record must be gone from it and the document revision must have advanced
    // past the one the create returned.
    if (!Array.isArray(removed?.connections)) throw new Error("connection_remove_document_unavailable");
    if (removed.connections.some((candidate) => candidate?.connectionId === freshId))
      throw new Error("connection_remove_record_retained");
    if (!Number.isInteger(removed.revision) || removed.revision <= revision)
      throw new Error("connection_remove_revision_unadvanced");
    // The reply is the write's own projection, not proof the record is durably
    // gone. Re-read through the read route: the removed handle must not be in
    // the list that route returns, and that list must carry a revision past the
    // one the create returned.
    const after = await readJson(origin, client, "/api/tavern/v1/settings/connection");
    if (!Array.isArray(after?.connections)) throw new Error("connection_remove_readback_unavailable");
    if (after.connections.some((candidate) => candidate?.connectionId === freshId))
      throw new Error("connection_remove_not_durable");
    if (!Number.isInteger(after.revision) || after.revision <= revision)
      throw new Error("connection_remove_readback_revision_unadvanced");
  });

  // design/28 §2.3: the player's own model choice. The read projects the two
  // durable profiles plus the shipped guidance catalog; the update writes a
  // model id the recommendation does NOT name, which is the whole point of the
  // ruling, and it must read back exactly.
  await attempt("settings.profiles.read", async () => {
    const profiles = await readJson(origin, client, "/api/tavern/v1/settings/profiles");
    if (profiles === null || typeof profiles !== "object") throw new Error("profiles_unavailable");
    for (const surface of ["chat", "game"]) {
      const profile = profiles[surface];
      if (profile === null || typeof profile !== "object") throw new Error("profile_missing");
      if (!Number.isInteger(profile.revision) || profile.revision < 0) throw new Error("profile_revision_missing");
      if (typeof profile.modelId !== "string" || profile.modelId.length === 0) throw new Error("profile_model_missing");
      if (typeof profile.thinkingLevel !== "string" || profile.thinkingLevel.length === 0)
        throw new Error("profile_thinking_level_missing");
    }
    // The guidance catalog must be non-empty: an empty list would tell the player
    // nothing while still claiming to ship a recommendation.
    if (!Array.isArray(profiles.recommendedModels) || profiles.recommendedModels.length === 0)
      throw new Error("recommended_models_missing");
  });

  await attempt("settings.profiles.update", async () => {
    const before = await readJson(origin, client, "/api/tavern/v1/settings/profiles");
    const surface = "game";
    const expectedRevision = before?.[surface]?.revision;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("profile_revision_unavailable");
    const modelId = "qwen2.5-coder:7b";
    const updated = await sendJson(origin, client, "PUT", "/api/tavern/v1/settings/profiles", {
      apiVersion: 1,
      surface,
      expectedRevision,
      modelId,
      thinkingLevel: "xhigh",
    });
    const profile = updated?.[surface];
    // A model id the shipped catalog does not list must be stored verbatim, not
    // silently replaced with a recommended one, and the other surface's durable
    // revision must not move.
    if (profile?.modelId !== modelId) throw new Error("profile_model_not_applied");
    if (profile?.thinkingLevel !== "xhigh") throw new Error("profile_thinking_level_not_applied");
    if (!Number.isInteger(profile?.revision) || profile.revision <= expectedRevision)
      throw new Error("profile_revision_unadvanced");
    const other = surface === "chat" ? "game" : "chat";
    if (updated?.[other]?.revision !== before?.[other]?.revision) throw new Error("profile_other_surface_changed");
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
      if (typeof entry?.handle !== "string" || entry.handle.length === 0)
        throw new Error("companion_handle_unavailable");
      if (typeof entry?.name !== "string" || entry.name.length === 0) throw new Error("companion_name_missing");
    }
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

  // The mounted companion's own opaque handle, re-read from the library immediately before each
  // use: a handle belongs to the projection it was read in, so it is never cached across steps.
  const currentCompanionHandle = async () => {
    const list = await readJson(origin, client, "/api/tavern/v1/companions");
    const current = Array.isArray(list?.companions)
      ? list.companions.find((entry) => entry?.isCurrent === true)
      : undefined;
    if (current === undefined || typeof current.handle !== "string" || current.handle.length === 0)
      throw new Error("companion_current_handle_unavailable");
    return current.handle;
  };

  // companion.worldbook.read: her OWN book (what the reviewed card carried), which is a different
  // store from the attachable library above. The mounted companion was provisioned from a card
  // whose world book the conversation's own binding names, so an absent book here would mean the
  // surface lost the book the Chat is actually carrying. (This step used to report `blocked`: the
  // route validates its reply with `CompanionWorldBookV1Schema` and the published entry schema did
  // not declare the `content` the service projects. It declares it now, so the read round-trips.)
  await attempt("companion.worldbook.read", async () => {
    const handle = await currentCompanionHandle();
    // KNOWN BLOCKER for this operation, recorded so nobody has to derive it again: the route
    // validates its own reply with `CompanionWorldBookV1Schema`
    // (`host/src/tavern-management-dialogue-web.ts:1333`) and fails closed with
    // `companion_record_unreadable` (503), because the service's entry projection carries `content`
    // (`host/src/tavern/companion-world-book-service.ts:41,62`) which the published entry schema
    // does not declare (`host/src/tavern/browser-contract/index.ts:910`). Until those two agree this
    // operation reports `blocked` here - which is the truth about it - and the projector below
    // still asserts the field the surface reads.
    const book = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/worldbook`);
    if (book === null || typeof book !== "object") throw new Error("companion_world_book_unavailable");
    if (book.present !== true) throw new Error("companion_world_book_not_present");
    if (!Array.isArray(book.entries) || book.entries.length === 0)
      throw new Error("companion_world_book_entries_missing");
    for (const entry of book.entries) {
      if (typeof entry?.title !== "string" || entry.title.length === 0)
        throw new Error("companion_world_book_title_missing");
      if (typeof entry.constant !== "boolean") throw new Error("companion_world_book_constant_invalid");
      if (!Array.isArray(entry.keys)) throw new Error("companion_world_book_keys_missing");
      if (typeof entry.content !== "string") throw new Error("companion_world_book_content_missing");
    }
  });

  // companion.worldbook.update: the player rewrites her OWN book. It is one durable file replaced
  // whole, so the edit CASes on the revision the read above carried, and the entry list it sends is
  // the list it read - the projection's own shape.
  //
  // The RESTORE is part of this operation's postcondition, not cleanup. This harness edits a real
  // companion's real book inside the run's own root, and an artifact that left a run's companion
  // carrying test prose would describe a product state nobody has. So the step asserts three facts,
  // none of which can hold against a server that stored nothing: the reply shows the marked body at
  // the next revision, the read route shows the marked body too (the file, not the reply), and the
  // read after the restore shows HER OWN body back at exactly two revisions further - which is the
  // evidence that both writes landed, because a book that never changed cannot be two ahead.
  await attempt("companion.worldbook.update", async () => {
    const handle = await currentCompanionHandle();
    const path = `/api/tavern/v1/companions/${handle}/worldbook`;
    const before = await readJson(origin, client, path);
    if (before === null || typeof before !== "object") throw new Error("worldbook_unavailable");
    if (before.present !== true) throw new Error("worldbook_not_present");
    if (!Number.isSafeInteger(before.revision) || before.revision < 1)
      throw new Error("worldbook_revision_unavailable");
    if (!Array.isArray(before.entries) || before.entries.length === 0) throw new Error("worldbook_entries_missing");
    const originalEntries = before.entries;
    const markedEntries = originalEntries.map((entry, index) =>
      index === 0 ? { ...entry, content: `${entry.content}\n[evidence: companion.worldbook.update]` } : entry,
    );
    const edited = await sendJson(origin, client, "PUT", path, {
      apiVersion: 1,
      expectedRevision: before.revision,
      entries: markedEntries,
    });
    if (edited === null || typeof edited !== "object") throw new Error("worldbook_edit_unavailable");
    if (edited.revision !== before.revision + 1) throw new Error("worldbook_edit_revision_unadvanced");
    if (edited.entries?.[0]?.content !== markedEntries[0].content) throw new Error("worldbook_edit_not_applied");
    // The durable half: the read route is a second read of the store the file lives in.
    const afterEdit = await readJson(origin, client, path);
    if (afterEdit?.entries?.[0]?.content !== markedEntries[0].content) throw new Error("worldbook_edit_not_durable");
    const restored = await sendJson(origin, client, "PUT", path, {
      apiVersion: 1,
      expectedRevision: edited.revision,
      entries: originalEntries,
    });
    if (restored?.revision !== edited.revision + 1) throw new Error("worldbook_restore_revision_unadvanced");
    const afterRestore = await readJson(origin, client, path);
    if (afterRestore?.entries?.[0]?.content !== originalEntries[0].content)
      throw new Error("worldbook_restore_not_applied");
    if (afterRestore?.revision !== before.revision + 2) throw new Error("worldbook_revision_unadvanced");
  });

  // companion.profile.read: the read-only character inspector - one ROSTER companion's own
  // authored facts, addressed by the handle the roster just handed out. It is the one
  // companion-addressed read that resolves a companion who is NOT the mounted one, so the step
  // reads the row the list marks current and checks the shape the inspector renders.
  await attempt("companion.profile.read", async () => {
    const handle = await currentCompanionHandle();
    const profile = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/profile`);
    if (profile === null || typeof profile !== "object") throw new Error("companion_profile_unavailable");
    if (typeof profile.name !== "string" || profile.name.length === 0)
      throw new Error("companion_profile_name_missing");
    if (typeof profile.persona?.present !== "boolean") throw new Error("companion_profile_persona_missing");
    for (const dimension of ["core", "interactionStyle", "expressionStyle"]) {
      const value = profile.persona[dimension];
      if (value !== null && (typeof value !== "string" || value.length === 0))
        throw new Error("companion_profile_persona_dimension_invalid");
    }
    if (typeof profile.scenario?.present !== "boolean") throw new Error("companion_profile_scenario_missing");
    if (typeof profile.greetings?.present !== "boolean") throw new Error("companion_profile_greetings_missing");
    if (!Array.isArray(profile.greetings?.variants)) throw new Error("companion_profile_greeting_variants_missing");
    const book = profile.worldBook;
    if (book === null || typeof book !== "object") throw new Error("companion_profile_worldbook_missing");
    if (typeof book.present !== "boolean") throw new Error("companion_profile_worldbook_present_invalid");
    // The revision the inspector carries with the book: a positive integer when she has one,
    // null exactly when she has none.
    if (book.present === true ? !Number.isSafeInteger(book.revision) || book.revision < 1 : book.revision !== null)
      throw new Error("companion_profile_worldbook_revision_invalid");
  });

  // companion.card.export: the same roster companion's own records taken out as a standard Tavern
  // V3 card, in the JSON form the request names. The card is a projection of records that already
  // exist, so the postcondition is the card's own fields against her records read live in this
  // same step - her name, her openings in order, and her own world book - not the parse of a reply
  // that could have been assembled from anything.
  //
  // One seam runs through that comparison, and it is named rather than assumed: the card carries
  // the AUTHORED text (the export service reads the durable records), while the read routes render
  // the run's macro table at their own seam. The greeting store projects its variants verbatim on
  // both sides, and her book carries no `{{...}}` placeholder, so the two spellings coincide for
  // this run's companion; a book that gained one reports the mismatch by name instead of passing
  // quietly.
  await attempt("companion.card.export", async () => {
    const handle = await currentCompanionHandle();
    const profile = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/profile`);
    const greeting = await readJson(origin, client, "/api/tavern/v1/greeting");
    const held = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/worldbook`);
    const exported = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/card?format=json`);
    if (exported === null || typeof exported !== "object") throw new Error("card_export_unavailable");
    // The reply names the form the request named, and the JSON arm is the card's own text: a
    // reply that carried the PNG envelope too would be two answers to one question.
    if (exported.format !== "json") throw new Error("card_export_format_not_json");
    if (exported.cardFileBase64 !== undefined) throw new Error("card_export_form_mixed");
    if (typeof exported.fileName !== "string" || !exported.fileName.endsWith(".json"))
      throw new Error("card_export_file_name_not_json");
    // The format's own version, declared by the reply and by the card text it handed over: one
    // card, not two spellings of a version.
    if (exported.spec !== "chara_card_v3") throw new Error("card_export_spec_invalid");
    let card;
    try {
      card = JSON.parse(exported.card);
    } catch {
      throw new Error("card_export_card_unparsable");
    }
    if (card === null || typeof card !== "object") throw new Error("card_export_card_not_an_object");
    if (card.spec !== exported.spec) throw new Error("card_export_spec_mismatch");
    const data = card.data;
    if (data === null || typeof data !== "object") throw new Error("card_export_data_missing");
    // Her name, as the inspector beside it serves it.
    if (data.name !== profile?.name) throw new Error("card_export_name_mismatch");
    // Her openings, in order: the first is the card's `first_mes` and the rest are
    // `alternate_greetings` - the spec's own split, which the import folds back into one set.
    if (greeting?.present !== true) throw new Error("card_export_greeting_unavailable");
    const variants = Array.isArray(greeting.variants) ? greeting.variants : [];
    if (variants.length === 0) throw new Error("card_export_greeting_variants_missing");
    if (data.first_mes !== variants[0].text) throw new Error("card_export_first_opening_mismatch");
    const alternates = variants.slice(1).map((variant) => variant.text);
    const alternateOpenings = data.alternate_greetings;
    // A single opening writes no `alternate_greetings` at all; several write exactly her own, in
    // her own order.
    if (
      alternates.length === 0
        ? alternateOpenings !== undefined
        : JSON.stringify(alternateOpenings) !== JSON.stringify(alternates)
    )
      throw new Error("card_export_alternate_openings_mismatch");
    // Her own world book, entry for entry, under the spec's own field names.
    if (held?.present !== true) throw new Error("card_export_world_book_missing");
    const entries = Array.isArray(held.entries) ? held.entries : [];
    if (entries.length === 0) throw new Error("card_export_world_book_entries_missing");
    const exportedEntries = data.character_book?.entries;
    if (!Array.isArray(exportedEntries) || exportedEntries.length !== entries.length)
      throw new Error("card_export_book_entry_count_mismatch");
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const projected = exportedEntries[index];
      if (projected?.comment !== entry.title) throw new Error("card_export_book_title_mismatch");
      if (projected?.content !== entry.content) throw new Error("card_export_book_content_mismatch");
      if ((projected?.constant === true) !== (entry.constant === true))
        throw new Error("card_export_book_constant_mismatch");
      // A keyless entry omits the field rather than writing an empty list, exactly as the durable
      // book stores it - the worldbook validator refuses an empty key list.
      const keys = Array.isArray(entry.keys) ? entry.keys : [];
      if (keys.length === 0 ? projected?.keys !== undefined : JSON.stringify(projected?.keys) !== JSON.stringify(keys))
        throw new Error("card_export_book_keys_mismatch");
    }
  });

  // companion.avatar.update: the player's own picture for a roster companion, at the same
  // roster-wide addressing the inspector and the card export above use. The reply is a digest, and
  // the digest of the bytes that were SENT is also what a Host that merely echoed its input would
  // answer - so the durable fact is read back from the one URL the runtime asset face serves for
  // that handle, and it is the bytes IT serves that are hashed. Unlike the world-book edit above,
  // nothing is put back afterwards: replacing her picture is this operation, and the run's own
  // disposable root is the only place it lands.
  const AVATAR_PICTURE_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await attempt("companion.avatar.update", async () => {
    const handle = await currentCompanionHandle();
    // A real 1x1 PNG - signature, IHDR, IDAT, IEND, each with its own valid CRC - so nothing in
    // the run has to be told the picture is a stub.
    const picture = Buffer.from(AVATAR_PICTURE_PNG_BASE64, "base64");
    const uploaded = await sendJson(origin, client, "PUT", `/api/tavern/v1/companions/${handle}/avatar`, {
      apiVersion: 1,
      // Re-encoded from the bytes it decodes to: the route accepts only the canonical spelling of
      // a file, and a payload it cannot decode is a different, shorter picture.
      avatarBase64: picture.toString("base64"),
    });
    if (uploaded === null || typeof uploaded !== "object") throw new Error("avatar_update_unavailable");
    if (uploaded.handle !== handle) throw new Error("avatar_update_handle_mismatch");
    if (typeof uploaded.digest !== "string" || !/^[0-9a-f]{64}$/.test(uploaded.digest))
      throw new Error("avatar_update_digest_invalid");
    // The digest describes the picture that was sent: the service answers a read-back of the file
    // it just wrote, so a reply that named anything else fails here.
    if (uploaded.digest !== createHash("sha256").update(picture).digest("hex"))
      throw new Error("avatar_update_digest_not_the_written_picture");
    // The durable half: the asset face that draws this companion serves exactly those bytes at the
    // one URL it owns for her, and publishes the same digest as that URL's ETag.
    const face = await deadlineFetch(`${origin}/assets/companions/${handle}/avatar.png`, {
      headers: { Origin: origin },
    });
    if (face.status !== 200) throw new Error("avatar_update_face_unavailable");
    const served = Buffer.from(await face.arrayBuffer());
    if (createHash("sha256").update(served).digest("hex") !== uploaded.digest)
      throw new Error("avatar_update_not_durable");
    if (face.headers.get("etag") !== `"${uploaded.digest}"`) throw new Error("avatar_update_face_etag_mismatch");
  });

  // character.voice.read / .update: the mounted companion's own performance directive, held on her
  // identity profile and edited against that profile's exact revision. The read proves the surface;
  // the write must advance the profile revision AND read back through the read route.
  await attempt("character.voice.read", async () => {
    const handle = await currentCompanionHandle();
    const voice = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/voice`);
    if (voice === null || typeof voice !== "object") throw new Error("character_voice_unavailable");
    if (!Number.isInteger(voice.profileRevision) || voice.profileRevision < 0)
      throw new Error("character_voice_profile_revision_unavailable");
    const directive = voice.characterVoice;
    if (directive !== null && directive !== undefined) {
      if (typeof directive.text !== "string" || directive.text.length === 0)
        throw new Error("character_voice_text_missing");
      if (directive.source !== "card" && directive.source !== "player")
        throw new Error("character_voice_source_invalid");
    }
  });

  await attempt("character.voice.update", async () => {
    const handle = await currentCompanionHandle();
    const before = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/voice`);
    const expectedProfileRevision = before?.profileRevision;
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 0)
      throw new Error("character_voice_profile_revision_unavailable");
    const written = await sendJson(origin, client, "PUT", `/api/tavern/v1/companions/${handle}/voice`, {
      apiVersion: 1,
      expectedProfileRevision,
      text: "The gate keeps the ledger, and the ledger keeps the gate.",
    });
    if (written === null || typeof written !== "object") throw new Error("character_voice_write_unavailable");
    if (written.characterVoice?.text !== "The gate keeps the ledger, and the ledger keeps the gate.")
      throw new Error("character_voice_not_applied");
    // An edit always re-authors the directive as the player's own, which is the provenance the
    // review surface reads; a write that stored the text as `card` did not record the edit.
    if (written.characterVoice?.source !== "player") throw new Error("character_voice_source_not_player");
    if (!Number.isInteger(written.profileRevision) || written.profileRevision <= expectedProfileRevision)
      throw new Error("character_voice_profile_revision_unadvanced");
    const after = await readJson(origin, client, `/api/tavern/v1/companions/${handle}/voice`);
    if (after?.characterVoice?.text !== written.characterVoice.text) throw new Error("character_voice_not_durable");
    if (after?.profileRevision !== written.profileRevision)
      throw new Error("character_voice_readback_revision_mismatch");
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

  // chat.create / chat.select: the new-chat flow and the focus transfer. chat.create answers with
  // the created Chat's list entry (the contract fixes that it is NOT the mounted one); chat.select
  // then chooses it, and the mount's own projection must report the choice - which is what makes
  // this a switch rather than the no-op the already-selected Chat is. Both run here, while the
  // mounted Chat is still active, so the retention steps below then operate on the selected Chat
  // exactly as they operate on any mounted Chat.
  let createdChatHandle = null;
  await attempt("chat.create", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
    const before = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const listed = Array.isArray(before?.chats) ? before.chats : [];
    if (listed.length === 0) throw new Error("chat_list_empty_before_create");
    const created = await sendJson(origin, client, "POST", "/api/tavern/v1/chats", {
      apiVersion: 1,
      selectionGeneration: generation,
    });
    if (created === null || typeof created !== "object") throw new Error("chat_create_unavailable");
    const entry = created.chat;
    if (entry === null || typeof entry !== "object") throw new Error("chat_create_entry_unavailable");
    if (typeof entry.handle !== "string" || entry.handle.length === 0) throw new Error("chat_create_handle_missing");
    if (entry.status !== "active") throw new Error("chat_create_status_invalid");
    // The contract's own fact: the created Chat is not the mounted one until a selection says so.
    if (entry.isSelected !== false) throw new Error("chat_create_claimed_selection");
    if (!Number.isInteger(entry.managementRevision) || entry.managementRevision < 0)
      throw new Error("chat_create_revision_unavailable");
    if (typeof entry.updatedAtMs !== "number" || entry.updatedAtMs <= 0)
      throw new Error("chat_create_timestamp_missing");
    if (created.opening !== null && (typeof created.opening !== "string" || created.opening.length === 0))
      throw new Error("chat_create_opening_invalid");
    // The durable postcondition: the active list gained exactly one row, naming the created Chat
    // and still reporting the mounted one as the selected one.
    const after = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const afterListed = Array.isArray(after?.chats) ? after.chats : [];
    if (afterListed.length !== listed.length + 1) throw new Error("chat_create_not_listed");
    const row = afterListed.find((candidate) => candidate?.handle === entry.handle);
    if (row === undefined) throw new Error("chat_create_row_missing");
    if (row.isSelected !== false) throw new Error("chat_create_row_claimed_selection");
    if (!afterListed.some((candidate) => candidate?.isSelected === true))
      throw new Error("chat_create_lost_the_selected_chat");
    createdChatHandle = entry.handle;
  });

  await attempt("chat.select", async () => {
    if (createdChatHandle === null) throw new Error("chat_select_target_unavailable");
    const before = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = before?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("selection_generation_unavailable");
    if (before?.selection?.chatHandle === createdChatHandle) throw new Error("chat_select_target_already_selected");
    const selected = await sendJson(origin, client, "PUT", "/api/tavern/v1/chat/select", {
      apiVersion: 1,
      selectionGeneration: generation,
      chatHandle: createdChatHandle,
    });
    if (selected === null || typeof selected !== "object") throw new Error("chat_select_result_unavailable");
    if (selected.status !== "switched") throw new Error("chat_select_not_switched");
    // The durable half: the mount's own projection names the chosen Chat, and the active list marks
    // exactly that row selected. A reply that said `switched` while the mount stayed where it was
    // fails here.
    const after = await readJson(origin, client, "/api/tavern/v1/state");
    if (after?.selection?.chatHandle !== createdChatHandle) throw new Error("chat_select_not_durable");
    const listed = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const row = Array.isArray(listed?.chats)
      ? listed.chats.find((candidate) => candidate?.handle === createdChatHandle)
      : undefined;
    if (row === undefined) throw new Error("chat_select_target_missing_from_list");
    if (row.isSelected !== true) throw new Error("chat_select_selection_not_durable");
  });

  // Chat lifecycle retention: the target's handle + management revision come
  // from the chat list; each transition CASes that revision and asserts the
  // durable status in the reply. Archive then restore then trash, so the final
  // state is trashed and every transition is real. The active list only carries
  // active chats, so after archiving the next revision is threaded from the
  // previous transition's result instead of a re-read. The command names the
  // target by its own handle and revision - no mounted-only selection
  // generation - so this still drives the mounted chat, and a later run could
  // equally drive any other.
  let retainedChat;
  const currentChat = async () => {
    if (retainedChat !== undefined) return retainedChat;
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const chatHandle = snapshot?.selection?.chatHandle;
    if (typeof chatHandle !== "string" || chatHandle.length === 0) throw new Error("chat_handle_unavailable");
    const list = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const entries = Array.isArray(list?.chats) ? list.chats : Array.isArray(list) ? list : [];
    const entry = entries.find((candidate) => candidate?.handle === chatHandle);
    if (entry === undefined) throw new Error("selected_chat_entry_unavailable");
    if (!Number.isInteger(entry.managementRevision) || entry.managementRevision < 0)
      throw new Error("management_revision_unavailable");
    return { chatHandle, managementRevision: entry.managementRevision };
  };

  await attempt("chat.archive", async () => {
    const { chatHandle, managementRevision } = await currentChat();
    const result = await sendJson(origin, client, "POST", `/api/tavern/v1/chats/${chatHandle}/archive`, {
      apiVersion: 1,
      expectedManagementRevision: managementRevision,
    });
    if (result === null || typeof result !== "object") throw new Error("chat_archive_unavailable");
    if (result.status !== "archived") throw new Error("chat_archive_not_applied");
    if (!Number.isInteger(result.managementRevision) || result.managementRevision <= managementRevision)
      throw new Error("chat_archive_revision_unadvanced");
    retainedChat = Object.freeze({ chatHandle, managementRevision: result.managementRevision });
  });

  await attempt("chat.restore", async () => {
    const { chatHandle, managementRevision } = await currentChat();
    const result = await sendJson(origin, client, "POST", `/api/tavern/v1/chats/${chatHandle}/restore`, {
      apiVersion: 1,
      expectedManagementRevision: managementRevision,
    });
    if (result === null || typeof result !== "object") throw new Error("chat_restore_unavailable");
    if (result.status !== "active") throw new Error("chat_restore_not_applied");
    if (!Number.isInteger(result.managementRevision) || result.managementRevision <= managementRevision)
      throw new Error("chat_restore_revision_unadvanced");
    retainedChat = Object.freeze({ chatHandle, managementRevision: result.managementRevision });
  });

  await attempt("chat.trash", async () => {
    // Trash is legal directly from active (resolveLifecycleTransition:
    // trash from active or archived), and the previous restore left the chat
    // active with a threaded revision, so this is a single real transition.
    const { chatHandle, managementRevision } = await currentChat();
    const result = await sendJson(origin, client, "POST", `/api/tavern/v1/chats/${chatHandle}/trash`, {
      apiVersion: 1,
      expectedManagementRevision: managementRevision,
    });
    if (result === null || typeof result !== "object") throw new Error("chat_trash_unavailable");
    if (result.status !== "trashed") throw new Error("chat_trash_not_applied");
    if (!Number.isInteger(result.managementRevision) || result.managementRevision <= managementRevision)
      throw new Error("chat_trash_revision_unadvanced");
  });

  // design/28 Import/export row: reviewed ST-card import. A synthetic card
  // with one reviewed persona field AND one always-on world-book entry drives
  // the whole pipeline (stage -> read -> review -> confirm). The confirmed
  // companion must appear in the library list with its safe name - the durable
  // postcondition that provisioning actually landed (profile + world book).
  const IMPORT_CARD = {
    spec: "chara_card_v3",
    data: {
      name: "Imported Rae",
      description: "Quiet, attentive, fond of the valley.",
      mes_example: "<START>\n{{user}}: Morning!\n{{char}}: A quiet start; I like it.",
      character_book: {
        entries: [
          {
            keys: [],
            content: "Imported Rae knows every footpath around the valley.",
            extensions: {},
            name: "Footpaths",
            constant: true,
            comment: "Always-on world book entry.",
          },
        ],
      },
    },
  };
  let stagedImportId = null;
  await attempt("character.import.stage", async () => {
    const staged = await sendJson(origin, client, "POST", "/api/tavern/v1/imports", {
      apiVersion: 1,
      card: JSON.stringify(IMPORT_CARD),
    });
    if (staged === null || typeof staged !== "object") throw new Error("character_import_stage_unavailable");
    if (typeof staged.importId !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(staged.importId))
      throw new Error("character_import_id_invalid");
    if (staged.name !== "Imported Rae") throw new Error("character_import_name_not_applied");
    if (!Array.isArray(staged.fields) || staged.fields.length === 0) throw new Error("character_import_fields_missing");
    if (!Array.isArray(staged.dispositions)) throw new Error("character_import_dispositions_missing");
    // The card's world book must travel as candidate fields (the S3 link: a
    // reviewed world book entry is what later reaches the companion's m[0]
    // lorebook_constant source). The exact entryId is derived by the import
    // service from the card format and index, so assert the prefix rather than
    // a guessed identifier.
    if (!staged.fields.some((field) => typeof field?.field === "string" && field.field.startsWith("worldbook_")))
      throw new Error("character_import_worldbook_field_missing");
    stagedImportId = staged.importId;
  });

  await attempt("character.import.read", async () => {
    if (stagedImportId === null) throw new Error("character_import_stage_prerequisite");
    const read = await readJson(origin, client, `/api/tavern/v1/imports/${stagedImportId}`);
    if (read === null || typeof read !== "object") throw new Error("character_import_read_unavailable");
    if (read.importId !== stagedImportId) throw new Error("character_import_read_id_mismatch");
    if (read.reviewed !== false) throw new Error("character_import_read_review_state_invalid");
    if (!Array.isArray(read.fields) || read.fields.length === 0)
      throw new Error("character_import_read_fields_missing");
  });

  await attempt("character.import.review", async () => {
    if (stagedImportId === null) throw new Error("character_import_stage_prerequisite");
    const review = await sendJson(origin, client, "POST", `/api/tavern/v1/imports/${stagedImportId}/review`, {
      apiVersion: 1,
      // Review the card's own name together with its persona: both are
      // reviewed fields, so the confirmed companion is named what the player
      // imported instead of silently keeping the default name.
      reviewedFields: ["name", "persona_core"],
      approvedAtMs: Date.now(),
    });
    if (review === null || typeof review !== "object") throw new Error("character_import_review_unavailable");
    if (review.importId !== stagedImportId) throw new Error("character_import_review_id_mismatch");
    if (!Array.isArray(review.reviewedFields) || review.reviewedFields[0] !== "name")
      throw new Error("character_import_review_not_applied");
    if (!Number.isInteger(review.approvedAtMs) || review.approvedAtMs <= 0)
      throw new Error("character_import_review_timestamp_missing");
  });

  await attempt("character.import.confirm", async () => {
    if (stagedImportId === null) throw new Error("character_import_stage_prerequisite");
    const confirmed = await sendJson(origin, client, "POST", `/api/tavern/v1/imports/${stagedImportId}/confirm`, {
      apiVersion: 1,
    });
    if (confirmed === null || typeof confirmed !== "object") throw new Error("character_import_confirm_unavailable");
    if (confirmed.name !== "Imported Rae") throw new Error("character_import_confirm_name_not_applied");
    // Durably visible: the provisioned companion joins the library.
    const list = await readJson(origin, client, "/api/tavern/v1/companions");
    if (!Array.isArray(list?.companions) || !list.companions.some((entry) => entry?.name === "Imported Rae"))
      throw new Error("character_import_confirm_not_listed");
  });

  // character.import.history: the durable loss report every confirmed import
  // leaves behind. The confirm above already wrote this run's record, so the
  // read must project it back - keyed by the SAME opaque importId the stage step
  // observed - with the per-class disposition counts the report carried. The
  // projection is content-free by contract (no card body text is expressible in
  // it) and this step keeps the evidence the same way: it compares an opaque
  // handle and integer counts, and records neither a name nor any field text.
  await attempt("character.import.history", async () => {
    if (stagedImportId === null) throw new Error("character_import_history_importid_unavailable");
    const history = await readJson(origin, client, "/api/tavern/v1/import-history");
    if (history === null || typeof history !== "object") throw new Error("character_import_history_unavailable");
    if (!Array.isArray(history.entries)) throw new Error("character_import_history_entries_missing");
    const entry = history.entries.find((candidate) => candidate?.importId === stagedImportId);
    if (entry === undefined) throw new Error("character_import_history_entry_missing");
    if (!Number.isSafeInteger(entry.occurredAtMs) || entry.occurredAtMs <= 0)
      throw new Error("character_import_history_timestamp_invalid");
    const counts = entry.counts;
    if (counts === null || typeof counts !== "object") throw new Error("character_import_history_counts_missing");
    // Every class must be a real count, and at least one field must have been
    // classified: a record written with an empty report would still be listed,
    // so an all-zero row would report a pass for evidence that says nothing.
    let classified = 0;
    for (const classification of ["accepted_typed", "preserved_opaque", "dropped_unsupported", "rejected_invalid"]) {
      const count = counts[classification];
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("character_import_history_count_invalid");
      classified += count;
    }
    if (classified <= 0) throw new Error("character_import_history_counts_empty");
  });

  return results;
}

export async function runManagementOperationEvidence({ outcomesPath, reportPath } = {}) {
  if (typeof outcomesPath !== "string" || outcomesPath.length === 0) throw new Error("outcomes_path_required");
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
    const client = await bootstrap(origin, bootstrapToken, launch.ack?.sessionEntry);
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
    // The gate root is a full install of the generation (runtime tree, staged
    // dependency closure and the SQLite databases the evidence run creates), so
    // it is roughly a gigabyte per run; fifteen runs filled the machine's temp
    // volume. It is disposable by construction - the composition mounts it
    // fresh each run and every durable output the caller asked for already went
    // to `outcomesPath`/`reportPath` - so the run owns its removal.
    //
    // Order matters on Windows: `dispose()` only tears down the launcher's IPC
    // peer and `kill()` is asynchronous, while the Host runtime keeps the
    // SQLite/WAL handles inside the root open until the process has really
    // exited. Removing the root before that races the shutdown and leaves the
    // whole install behind, which is how the leak stayed invisible. Wait for
    // the exit, then retry the removal, and report a failure rather than
    // swallowing it.
    await waitForChildExit(launch.child, GATE_CHILD_EXIT_TIMEOUT_MS);
    const leakedRoot = await removeGateRoot(root);
    if (leakedRoot !== null) process.stderr.write(`gate_root_not_removed:${leakedRoot}\n`);
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
