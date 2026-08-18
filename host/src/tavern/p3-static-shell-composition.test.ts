import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { composeTavernProfile } from "./browser-contract/index.js";
import { startP3StaticShellComposition } from "./p3-static-shell-composition.js";
import type { P3ExactChatState, P3ExactChatStateFacade } from "./p3-exact-chat-state.js";
import { createTestWindowsReparseInspector } from "../windows-reparse-inspector/index.test-support.js";

const token = "A".repeat(42) + "A";
// Canonical base64url requires unused tail bits to be zero; the final A has
// that property for a 43-character (32-byte) opaque capability.
const handle = "B".repeat(42) + "A";
const profile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.p3", releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read"], operationIds: [], navigationItemIds: ["chat"],
});
const script = Buffer.from("console.log('shell');\n", "utf8");

function fakeFacade(): P3ExactChatStateFacade {
  const state: P3ExactChatState = Object.freeze({
    selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
    companionDisplayName: "Mira", title: "Exact Chat",
    transcript: Object.freeze([Object.freeze({ handle, role: "player" as const, text: "Durable text", locale: "und" as const, order: 0, revision: 1 })]),
    draft: Object.freeze({ revision: 2, text: "Saved draft" }),
  });
  return Object.freeze({ read: async () => state });
}
async function artifactFixture(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p3-shell-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><script src=\"/assets/app-abcdef12.js\"></script>", "utf8");
  await writeFile(join(root, "assets", "app-abcdef12.js"), script);
  await writeFile(join(root, "tavern-browser-artifact-manifest.json"), JSON.stringify({
    schemaVersion: 1, browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1", entryHtml: "index.html",
    assets: [{ path: "assets/app-abcdef12.js", sha256: createHash("sha256").update(script).digest("hex"), bytes: script.length, mime: "text/javascript" }],
  }));
  return { root, dispose: async () => await rm(root, { recursive: true, force: true }) };
}
function inspector() {
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    child.stdin.on("data", () => { child.stdout.end('{"schemaVersion":1,"result":"regular"}\n'); child.stderr.end(); queueMicrotask(() => child.emit("close", 0, null)); });
    return child as unknown as ChildProcess;
  });
}

test("P3 shell uses one origin for verified static bytes and the exact v1 API", async () => {
  const fixture = await artifactFixture();
  const server = await startP3StaticShellComposition({ artifactRoot: fixture.root, inspector: inspector(), p3Facade: fakeFacade(), profile, bootstrapToken: token });
  try {
    assert.match(server.launchUrl, new RegExp(`^${server.origin.replace(/[./:]/g, "\\$&")}/#boot=${token}$`));
    const shell = await fetch(`${server.origin}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(await shell.text(), /app-abcdef12\.js/);
    const asset = await fetch(`${server.origin}/assets/app-abcdef12.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), script.toString("utf8"));
    for (const path of ["/tavern-browser-artifact-manifest.json", "/assets/app-abcdef12.js.map", "/bootstrap", "/events", "/api/tavern/v1/events"]) {
      assert.equal((await fetch(`${server.origin}${path}`)).status, 404, path);
    }
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200, await bootstrap.text());
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.equal((await fetch(`${server.origin}/api/tavern/v1/state`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await fetch(`${server.origin}/api/tavern/v1/draft`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  } finally { await server.close(); await fixture.dispose(); }
});

test("P3 shell drains an admitted facade read before close resolves", async () => {
  const fixture = await artifactFixture();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const readStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const readRelease = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const base = fakeFacade();
  const facade: P3ExactChatStateFacade = Object.freeze({ read: async () => { started!(); await readRelease; return await base.read(); } });
  const server = await startP3StaticShellComposition({ artifactRoot: fixture.root, inspector: inspector(), p3Facade: facade, profile, bootstrapToken: token });
  try {
    const request = fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    // The listener deliberately destroys active sockets during close; claim the
    // rejection now so the drain assertion, not an unhandled fetch error, is
    // the observed outcome.
    const settledRequest = request.catch(() => undefined);
    await readStarted;
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await delay(20);
    assert.equal(closed, false, "listener close must wait for the admitted facade read");
    release!();
    await closing;
    await settledRequest;
  } finally { await server.close(); await fixture.dispose(); }
});

test("P3 shell rejects an artifact with an identity other than the fixed browser build identity", async () => {
  const fixture = await artifactFixture();
  await writeFile(join(fixture.root, "tavern-browser-artifact-manifest.json"), JSON.stringify({ schemaVersion: 1, browserContract: "tavern_browser_api/v1", profileId: "other", entryHtml: "index.html", assets: [] }));
  try {
    await assert.rejects(startP3StaticShellComposition({ artifactRoot: fixture.root, inspector: inspector(), p3Facade: fakeFacade(), profile, bootstrapToken: token }), /invalid_tavern_static_artifact/);
  } finally { await fixture.dispose(); }
});
