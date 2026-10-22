/**
 * The two player paths this lane owes: lorebook import and chat export.
 *
 * Both capabilities already existed as services with no browser route - the managed library's own
 * importer (`world-info-management.ts` `import()`, reached through the binding service) and
 * `exportSafeChat` (`interchange.ts`) - so against an established AI role-play tool a player could
 * neither bring a world book in nor take a conversation out. This file is the falsifier for each:
 * it drives the REAL dispatcher (`createTavernManagementDialogueWebRequestHandler`) over the real
 * services and the real on-disk repositories, and asserts the bytes the route returned are the bytes
 * the service produced - not a fixture and not a second implementation.
 *
 * It runs in a mounted child, exactly like `world-info-binding-management-service.test.ts` and
 * `chat-management-service.test.ts`: the semantic production authority owns durable process-wide
 * resources, and the child is what makes its teardown deterministic.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

const mountPreamble = `
  const [contractUrl, compositionUrl, coordinatorUrl, deploymentUrl, storeUrl, runtimeUrl, repoUrl, bindingUrl, chatUrl, dispatchUrl, root] = process.argv.slice(1);
  const { createHash } = await import("node:crypto");
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const { writeFile } = await import("node:fs/promises");
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = root + "/manifest.json";
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const { composeTavernManagementProfile } = await import(compositionUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
  const { createChatThreadStore, createProfileAwareChatThreadCreationCapability } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { createWorldInfoManagementRepository } = await import(repoUrl);
  const { createWorldInfoBindingManagementService } = await import(bindingUrl);
  const { createChatManagementService } = await import(chatUrl);
  const { createTavernManagementDialogueWebRequestHandler } = await import(dispatchUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const threadIds = { chatThreadId: "chat-" + "1".repeat(16), chatSurfaceSessionId: "surface-" + "1".repeat(16) };
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const profile = composeTavernManagementProfile();
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const store = createChatThreadStore(root, identityKey(principal));
  const creation = createProfileAwareChatThreadCreationCapability(store, { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }; } });
  await creation.createExplicit({ ...threadIds, companionId: "companion_01", continuityId: "continuity_01", opening: { messageId: "opening_01", text: "The parsnips took.", source: { greetingSetId: "greetings_01", sourceRevision: 1, canonicalHash: "a".repeat(64), variantId: "first", profileRevision: 1, scenarioRevision: null } } });
  const chatHandle = createHash("sha256").update(threadIds.chatThreadId + "\\u0000" + threadIds.chatSurfaceSessionId, "utf8").digest("base64url").slice(0, 43);
  const companionHandle = createHash("sha256").update("companion_01", "utf8").digest("base64url").slice(0, 43);
  const repository = createWorldInfoManagementRepository(root);
  const worldInfoService = createWorldInfoBindingManagementService({ manifest, lease, profile, repository });
  const managementService = createChatManagementService({ manifest, lease, profile });
  const facade = Object.freeze({
    read: async () => Object.freeze({ selection: { chatHandle: chatHandle, generation: 1, stateRevision: chatHandle }, companionDisplayName: "Mira", companionHandle, title: null, transcript: [], draft: { revision: 0, text: null }, turn: null, operations: [], worldInfo: null }),
    close: async () => undefined,
  });
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService,
    worldInfoService,
    playerPreferenceStore: Object.freeze({ read: async () => ({ revision: 0, locale: null, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }), update: async () => { throw new Error("preference_not_used"); } }),
    profile,
    bootstrapToken: token,
  });
  class ControlledResponse extends EventEmitter {
    writableEnded = false;
    writableFinished = false;
    destroyed = false;
    headers = new Map();
    status = 0;
    body = "";
    setHeader(name, value) { this.headers.set(name, value); this.headers.set(name.toLowerCase(), value); }
    writeHead(status, headers) { this.status = status; for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v); }
    end(body = "") { this.body = body; this.writableEnded = true; this.writableFinished = true; this.emit("finish"); }
  }
  const request = (method, path, headers, body) => {
    const hasBody = body !== undefined;
    const encoded = hasBody ? JSON.stringify(body) : "";
    return Object.assign(Readable.from([encoded]), { method, url: path, headers: { host: "127.0.0.1:7331", ...(hasBody ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}), ...headers } });
  };
  const dispatch = async (input) => {
    const output = new ControlledResponse();
    handler.handle(input, output, "http://127.0.0.1:7331");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return output;
  };
  const code = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
  const bootstrap = await dispatch(request("POST", "/api/tavern/v1/bootstrap", { Origin: "http://127.0.0.1:7331" }, { apiVersion: 1, bootstrapToken: token }));
  const csrf = JSON.parse(bootstrap.body).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie").split(";", 1)[0];
`;

async function runMountedChild(body: string, root: string): Promise<Record<string, unknown>> {
  const url = (name: string) => new URL(name, import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      mountPreamble + body,
      url("./browser-contract/index.js"),
      url("../composition/desktop-presentation-admission-owner.js"),
      url("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js"),
      url("../deployment-manifest.js"),
      url("./chat-thread-store.js"),
      url("../runtime.js"),
      url("./world-info-management/world-info-management.js"),
      url("./world-info-binding/world-info-binding-management-service.js"),
      url("./chat-management/chat-management-service.js"),
      url("../tavern-management-dialogue-web.js"),
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const [exitCode] = (await once(child, "exit")) as [number | null];
  assert.equal(exitCode, 0, Buffer.concat(errors).toString("utf8"));
  return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, unknown>;
}

async function mounted(body: string): Promise<Record<string, unknown>> {
  const root = await canonicalTestRoot("gamebuddy-player-path-");
  try {
    return await runMountedChild(body, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the lorebook-import route serves the library's own importer and the library grows by its translation", async () => {
  const results = await mounted(`
    const before = await worldInfoService.read();
    const lorebook = { name: "Teyvat Geography", entries: { "0": { comment: "Wangshu Inn", content: "South of Dihua Marsh.", key: ["Wangshu Inn", "Inn"] }, "1": { comment: "Dihua Marsh", content: "Alluvial plain.", keys: ["Dihua Marsh"], constant: true } } };
    const imported = await dispatch(request("POST", "/api/tavern/v1/world-info/import", { Origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf }, { apiVersion: 1, selectionGeneration: 1, expectedRevision: before.revision, lorebook }));
    const listed = await repository.list();
    const detail = await repository.detail("Teyvat Geography");
    // A file the importer refuses is a bounded refusal, never a fake success.
    const refused = await dispatch(request("POST", "/api/tavern/v1/world-info/import", { Origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf }, { apiVersion: 1, selectionGeneration: 1, expectedRevision: JSON.parse(imported.body).revision, lorebook: {} }));
    const listedAfterRefusal = await repository.list();
    process.stdout.write(JSON.stringify({
      beforeItems: before.items.length,
      status: imported.status,
      body: imported.body,
      titles: listed.map((item) => item.publicTitle),
      entryTitles: detail === null ? null : detail.entries.map((entry) => entry.publicTitle),
      firstKeys: detail === null ? null : detail.entries[0].keys,
      refusedStatus: refused.status,
      titlesAfterRefusal: listedAfterRefusal.map((item) => item.publicTitle),
    }));
    await worldInfoService.close();
    await managementService.close();
    await handler.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal(results.beforeItems, 0);
  assert.equal(results.status, 200, String(results.body));
  const body = JSON.parse(results.body as string) as {
    items: ReadonlyArray<{ title: string }>;
  };
  // The route returned what the SERVICE produced, and the durable library grew by exactly the item
  // the importer's own ST/Chub translation names - proving the route reached the real importer.
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.title, "Teyvat Geography");
  assert.deepEqual(results.titles, ["Teyvat Geography"]);
  assert.deepEqual(results.entryTitles, ["Wangshu Inn", "Dihua Marsh"]);
  assert.deepEqual(results.firstKeys, ["Wangshu Inn", "Inn"]);
  // An unreadable file (no title) is refused and adds nothing.
  assert.ok(
    (results.refusedStatus as number) >= 400,
    `an unreadable lorebook must refuse, got ${results.refusedStatus}`,
  );
  assert.deepEqual(results.titlesAfterRefusal, ["Teyvat Geography"]);
});

test("the chat-export route returns the interchange's own file for a Chat the list named", async () => {
  const results = await mounted(`
    const exported = await managementService.exportChat({ chatHandle });
    const response = await dispatch(request("GET", "/api/tavern/v1/chat/export?chatHandle=" + chatHandle, { Origin: "http://127.0.0.1:7331", cookie, "sec-fetch-site": "same-origin" }));
    const missing = await dispatch(request("GET", "/api/tavern/v1/chat/export?chatHandle=" + token, { Origin: "http://127.0.0.1:7331", cookie, "sec-fetch-site": "same-origin" }));
    process.stdout.write(JSON.stringify({ exported, status: response.status, body: response.body, missingStatus: missing.status }));
    await managementService.close();
    await handler.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal(results.status, 200, String(results.body));
  const exported = results.exported as {
    canonicalHash: string;
    jsonl: string;
    messageCount: number;
    dispositions: readonly unknown[];
    format: string;
  };
  const served = JSON.parse(results.body as string) as typeof exported;
  // The route's answer IS the service's answer: same canonical hash, same file, same dispositions.
  assert.equal(served.canonicalHash, exported.canonicalHash);
  assert.equal(served.jsonl, exported.jsonl);
  assert.equal(served.messageCount, exported.messageCount);
  assert.deepEqual(served.dispositions, exported.dispositions);
  assert.equal(served.format, "tavern-interchange/v1");
  // The file itself is the interchange's ST chat JSONL: a header line then the durable bubbles.
  const lines = served.jsonl.split("\n");
  assert.notEqual((JSON.parse(lines[0]!) as { user_name?: string }).user_name, undefined);
  assert.ok(lines.length >= 2);
  assert.ok(served.jsonl.includes("The parsnips took."));
  // A handle that names no Chat of this partition is a bounded 404, not a fabricated file.
  assert.equal(results.missingStatus, 404);
});
