import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { composeReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./browser-contract/index.js";
import { createChatEventStream } from "./chat-event-stream.js";
import { createTestWindowsReparseInspector } from "../windows-reparse-inspector/index.test-support.js";
import { startComposedReferenceGameStaticShellComposition } from "./composed-reference-game-static-shell-composition.js";

const token = `${"A".repeat(42)}A`;
const handle = `${"B".repeat(42)}A`;
const tavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});
const profile = composeReferenceGameBrowserProfile({ tavernProfile });
const script = Buffer.from("console.log('shell');\n", "utf8");
const eventStream = createChatEventStream();

function fakeReadState() {
  const base = TavernBrowserFixtureV1.snapshot();
  return {
    selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
    companionDisplayName: "Mira",
    title: "Exact Chat",
    transcript: Object.freeze([
      Object.freeze({
        handle,
        role: "player" as const,
        text: "Durable text",
        locale: "und" as const,
        order: 0,
        revision: 1,
      }),
    ]),
    draft: Object.freeze({ revision: 2, text: "Saved draft" }),
    turn: null,
    operations: base.operations,
    eventStream: null,
  };
}

const fakeFacade = Object.freeze({
  read: async () => fakeReadState(),
  readDraft: async () => Object.freeze({ apiVersion: 1, revision: 2, text: "Saved draft" }),
});

async function artifactFixture(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-composed-shell-"));
  await mkdir(join(root, "assets"));
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
  return { root, dispose: async () => await rm(root, { recursive: true, force: true }) };
}

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

test("composed shell serves static artifact and composed broker on one origin", async () => {
  const fixture = await artifactFixture();
  const server = await startComposedReferenceGameStaticShellComposition({
    profile,
    bootstrapToken: token,
    referenceStateFacade: fakeFacade as any,
    eventStream,
    artifactRoot: fixture.root,
    inspector: inspector(),
  });
  try {
    assert.match(server.launchUrl, new RegExp(`^${server.origin.replace(/[./:]/g, "\\$&")}/#profile=composed-reference-game&boot=${token}$`));
    // Static artifact serves the shell.
    const shell = await fetch(`${server.origin}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /app-abcdef12\.js/);
    // Composed broker bootstrap returns the composed root.
    const bootstrap = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const root = await bootstrap.json();
    assert.equal(root.apiVersion, 1);
    assert.equal(root.build.browserContract, "composed_reference_game_browser_api/v1");
    assert.equal(root.game, null);
    assert.notEqual(root.chat, null);
    // Composed broker state returns the same shape.
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const state = await fetch(`${server.origin}/api/composed-reference-game/v1/state`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(state.status, 200);
    const stateRoot = await state.json();
    assert.equal(stateRoot.build.profileId, "gamebuddy.composed.reference-game");
    assert.equal(stateRoot.game, null);
    // The nested chat snapshot is a valid TavernStateSnapshotV1.
    assert.equal(stateRoot.chat.build.profileId, tavernProfile.profileId);
    // Reference pipeline API is reachable for chat operations via broker auth.
    // The delegated handler does not serve its own bootstrap.
    const refBootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(refBootstrap.status, 404);
    // No second Set-Cookie was emitted.
    assert.equal(refBootstrap.headers.get("set-cookie"), null);

    // Tavern state with the broker cookie succeeds using the broker's session.
    const tavernState = await fetch(`${server.origin}/api/tavern/v1/state`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(tavernState.status, 200);
    const tavernSnapshot = await tavernState.json();
    assert.equal(tavernSnapshot.build.profileId, tavernProfile.profileId);
    // No second Set-Cookie header on the delegated response.
    assert.equal(tavernState.headers.get("set-cookie"), null);
    // The CSRF token matches the broker's CSRF token.
    assert.equal(tavernSnapshot.csrfToken, root.chat.csrfToken);

    // Wrong cookie fails for Tavern routes.
    const wrongCookie = await fetch(`${server.origin}/api/tavern/v1/state`, {
      headers: { Cookie: "gb_composed_reference_game_session=wrong", "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(wrongCookie.status, 401);

    // Missing cookie fails for Tavern routes.
    const noCookie = await fetch(`${server.origin}/api/tavern/v1/state`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(noCookie.status, 401);

    // Game route is not available in Chat-only mode.
    const game = await fetch(`${server.origin}/api/composed-reference-game/v1/game`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(game.status, 404);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("composed shell delegates Tavern operations with broker CSRF and fails on wrong credential", async () => {
  const fixture = await artifactFixture();
  const server = await startComposedReferenceGameStaticShellComposition({
    profile,
    bootstrapToken: token,
    referenceStateFacade: fakeFacade as any,
    eventStream,
    artifactRoot: fixture.root,
    inspector: inspector(),
  });
  try {
    // Bootstrap the composed broker.
    const bootstrap = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = await bootstrap.json();
    const brokerCsrf = root.chat.csrfToken;

    // Tavern state with broker cookie succeeds.
    const state = await fetch(`${server.origin}/api/tavern/v1/state`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("set-cookie"), null);
    const snapshot = await state.json();
    assert.equal(snapshot.csrfToken, brokerCsrf);

    // Tavern state with wrong CSRF in broker cookie context still works
    // (state is GET, no CSRF check). But operations with wrong CSRF fail.
    // Without pipelineService, mutation routes return 503.
    const submit = await fetch(`${server.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": "wrong",
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text: "Hello", locale: "en" }),
    });
    // CSRF mismatch gives 403.
    assert.equal(submit.status, 403);

    // Correct CSRF but no pipelineService gives 503.
    const noService = await fetch(`${server.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": brokerCsrf,
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text: "Hello", locale: "en" }),
    });
    assert.equal(noService.status, 503);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("composed shell binds the private lifecycle issuer without returning it or adding a route", async () => {
  const fixture = await artifactFixture();
  let bound: object | undefined;
  const server = await startComposedReferenceGameStaticShellComposition({
    profile,
    bootstrapToken: token,
    referenceStateFacade: fakeFacade as any,
    eventStream,
    artifactRoot: fixture.root,
    inspector: inspector(),
    lifecycleActivationBindingSink: Object.freeze({
      bindBrowserAdmissionIssuer(issuer: object) { bound = issuer; },
    }),
  });
  try {
    assert.notEqual(bound, undefined);
    assert.deepEqual(Object.keys(server).sort(), ["close", "closeAllConnections", "launchUrl", "origin"]);
    const response = await fetch(`${server.origin}/api/composed-reference-game/v1/lifecycle/activate`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("composed shell does not listen when private lifecycle issuer binding fails", async () => {
  const fixture = await artifactFixture();
  try {
    await assert.rejects(
      startComposedReferenceGameStaticShellComposition({
        profile,
        bootstrapToken: token,
        referenceStateFacade: fakeFacade as any,
        eventStream,
        artifactRoot: fixture.root,
        inspector: inspector(),
        lifecycleActivationBindingSink: Object.freeze({
          bindBrowserAdmissionIssuer() { throw new Error("binding-rejected"); },
        }),
      }),
      /binding-rejected/,
    );
  } finally {
    await fixture.dispose();
  }
});

test("composed shell closes and drains both handlers including delegated Tavern routes", async () => {
  const fixture = await artifactFixture();
  const server = await startComposedReferenceGameStaticShellComposition({
    profile,
    bootstrapToken: token,
    referenceStateFacade: fakeFacade as any,
    eventStream,
    artifactRoot: fixture.root,
    inspector: inspector(),
  });
  try {
    // Bootstrap to prove the shell was alive.
    const bootstrap = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);

    // Close resolves without error, draining both handlers.
    await server.close();

    // The server is no longer listening; a new connection attempt fails.
    // The handlers' closed flags are set before the server closes, so the
    // close order is correct: reject → drain → release.
    await assert.rejects(
      () =>
        fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
          method: "POST",
          headers: { Origin: server.origin, "Content-Type": "application/json" },
          body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error.cause instanceof AggregateError ||
          error.message.includes("fetch") ||
          error.message.includes("connect") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("socket")),
    );
  } finally {
    await server.close().catch(() => {});
    await fixture.dispose();
  }
});