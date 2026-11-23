/**
 * The falsifiers for `check-chat-reads-the-chat-route.mjs`.
 *
 * Each case builds a small tree whose modules have the SHAPE the product has - the Chat-read seam, the
 * module that mints the session, a panel holding a composed client from a type - and asks the gate for
 * its verdict. The claims:
 *
 *   1. THE TREE PASSES, with the population printed: 81 modules under `dialogue-web/src`, the composed
 *      receiver set, the six Chat-route reads and the one session mint, derived from declarations.
 *   2. THE FALLBACK IS RED: the seam given back a composed client and `read ?? (await
 *      composedApi.readState())` is `chat_read_uses_the_composed_aggregate` naming that file and line -
 *      the defect this gate exists for, in the shape it shipped in.
 *   3. THE INLINE READ IS RED: a panel that reads the aggregate through a member declared in another
 *      module's type (`bootstrap.composedApiRef.current.readState()`) is named the same way, because a
 *      type says what the receiver is and never which route it takes.
 *   4. THE SESSION MINT IS THE ONE EXEMPTION, and it is derived, not listed: the same aggregate read is
 *      green in the module that spends a boot token.
 *   5. A READ THAT IS NEITHER ROUTE IS NOT GREEN: an unresolvable receiver and a name that resolves to
 *      both clients are each named.
 *   6. ZERO POPULATION BLOCKS: a tree with no module, and the empty tree's exit code.
 *
 * red-proof: inject  the seam's fallback (`read ?? (await composedApi.readState())`) ->
 *   `chat_read_uses_the_composed_aggregate` naming the seam module and the line of that read, exit 1; the
 *   inline read through another module's type -> the same finding naming
 *   `bootstrap.composedApiRef.current.readState` (gates/product/check-chat-reads-the-chat-route.test.mjs)
 * red-proof: inject  an unresolvable receiver and a name declared both ways -> `read_receiver_unresolved`
 *   and `read_receiver_ambiguous`; a tree with no module -> `chat_route_population_empty`, blocked
 *   (gates/product/check-chat-reads-the-chat-route.test.mjs)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import { checkChatReadsTheChatRoute, WEB_SOURCES } from "./check-chat-reads-the-chat-route.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** A tree of modules under the real scope, so the gate walks the same directory it walks on the checkout. */
function fixtureTree(t, modules) {
  const root = mkdtempSync(join(tmpdir(), "chat-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(modules)) {
    const target = join(root, WEB_SOURCES, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

/** The module that mints the session: the one composed `bootstrap(...)` in the tree. */
const MOUNT = `
import { createComposedReferenceGameBrowserApi } from "./composed-api";
export function mount() {
  const composedApiRef = useRef(createComposedReferenceGameBrowserApi());
  return bootToken === null ? composedApiRef.current.readState() : composedApiRef.current.bootstrap(bootToken);
}
`;

/** The Chat-read seam as it now stands: the Chat client, and the Chat half it answers. */
const SEAM = `
import type { ReferencePipelineApi } from "./chat-api";
export async function readChatSnapshotPair(current, tavernApi: ReferencePipelineApi) {
  return chatHalfPair(current, await tavernApi.readState());
}
`;

const codes = (reading) => reading.violations.map((violation) => violation.code);

test("the tree passes: every aggregate read is the session mint's, and every Chat read takes the Chat route", () => {
  const reading = checkChatReadsTheChatRoute({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", `the real tree is red: ${JSON.stringify(reading.violations)}`);
  assert.ok(reading.population > 0, `examined ${String(reading.population)} module(s) under ${WEB_SOURCES}`);
  assert.ok(reading.chatRouteReads > 0, "the Chat half's route is read somewhere, or the reading cannot judge a route");
  assert.equal(
    reading.readSites,
    reading.aggregateReads + reading.chatRouteReads,
    "every read site is classified as exactly one of the two routes",
  );
  // The exemption is a measured module, not a list here: the one that spends a boot token.
  assert.deepEqual(reading.sessionMint, [`${WEB_SOURCES}/components/use-composed-bootstrap.ts`]);
  assert.ok(
    reading.composedReceivers.length > 0,
    "the composed client is resolved from its declarations, or the aggregate half of this gate measured nothing",
  );
});

test("the fallback is red: the seam reading the composed aggregate is named at its own line", (t) => {
  const root = fixtureTree(t, {
    "chat-api.ts": `export type ReferencePipelineApi = Readonly<{ readState(): Promise<unknown> }>;\n`,
    "seam.ts": `
import type { ComposedReferenceGameBrowserApi } from "./composed-api";
import type { ReferencePipelineApi } from "./chat-api";
export async function readChatSnapshotPair(
  composedApi: ComposedReferenceGameBrowserApi,
  read = null,
) {
  const current = read ?? (await composedApi.readState());
  return current.chat;
}
`,
    "mount.ts": MOUNT,
    "chat-route.ts": SEAM,
  });
  const reading = checkChatReadsTheChatRoute({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["chat_read_uses_the_composed_aggregate"]);
  assert.equal(reading.violations[0].at, `${WEB_SOURCES}/seam.ts:8`);
  assert.match(reading.violations[0].detail, /composedApi\.readState/u);
  assert.equal(reading.aggregateReads, 3, "the seam's read is the third aggregate read, beside the mint's own two");
  assert.equal(
    reading.chatRouteReads,
    1,
    "the seam's `read ??` branch is not a read, so only the seam's own route counts",
  );
});

test("an inline aggregate read is red through a member declared in another module's type", (t) => {
  const root = fixtureTree(t, {
    "bootstrap.ts": `
import type { ComposedReferenceGameBrowserApi } from "./composed-api";
export type ComposedBootstrap = Readonly<{ composedApiRef: RefObject<ComposedReferenceGameBrowserApi> }>;
`,
    "world-info.ts": `
export async function readProductWorldInfo(bootstrap: ComposedBootstrap) {
  return bootstrap.composedApiRef.current.readState();
}
`,
    "mount.ts": MOUNT,
    "chat-route.ts": SEAM,
  });
  const reading = checkChatReadsTheChatRoute({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["chat_read_uses_the_composed_aggregate"]);
  assert.equal(reading.violations[0].at, `${WEB_SOURCES}/world-info.ts:3`);
  assert.match(reading.violations[0].detail, /bootstrap\.composedApiRef\.current\.readState/u);
});

test("the session mint is the derived exemption: the same read is green in the module that spends a boot token", (t) => {
  const root = fixtureTree(t, { "mount.ts": MOUNT, "chat-route.ts": SEAM });
  const reading = checkChatReadsTheChatRoute({ root });
  assert.equal(reading.status, "passed", `${reading.violations.map((violation) => violation.at).join(", ")}`);
  assert.deepEqual(reading.sessionMint, [`${WEB_SOURCES}/mount.ts`]);
  assert.equal(reading.aggregateReads, 2);
  // ...and taking the mint away leaves the same two reads as violations rather than as an exemption.
  const withoutMint = fixtureTree(t, {
    "mount.ts": MOUNT.replace("composedApiRef.current.bootstrap(bootToken)", "bootToken"),
    "chat-route.ts": SEAM,
  });
  const judged = checkChatReadsTheChatRoute({ root: withoutMint });
  assert.equal(judged.status, "blocked", "no session mint, so no aggregate read could be judged");
  assert.match(String(judged.blocked), /session_mint_not_found/u);
});

test("a read that is neither route is named, never passed", (t) => {
  const unresolved = checkChatReadsTheChatRoute({
    root: fixtureTree(t, {
      "mystery.ts": `export function read(mystery) {\n  return mystery.readState();\n}\n`,
      "mount.ts": MOUNT,
      "chat-route.ts": SEAM,
    }),
  });
  assert.deepEqual(codes(unresolved), ["read_receiver_unresolved"]);
  assert.equal(unresolved.status, "failed");

  const ambiguous = checkChatReadsTheChatRoute({
    root: fixtureTree(t, {
      "composed.ts": `export type ComposedBootstrap = Readonly<{ apiRef: RefObject<ComposedReferenceGameBrowserApi> }>;\n`,
      "chat.ts": `export type ChatInput = Readonly<{ apiRef: RefObject<ReferencePipelineApi> }>;\n`,
      "panel.ts": `export function read(holder) {\n  return holder.apiRef.current.readState();\n}\n`,
      "mount.ts": MOUNT,
      "chat-route.ts": SEAM,
    }),
  });
  assert.deepEqual(codes(ambiguous), ["read_receiver_ambiguous"]);
  assert.equal(ambiguous.status, "failed");
});

test("a scan that examined no module is blocked, and says which population was empty", (t) => {
  const reading = checkChatReadsTheChatRoute({ root: fixtureTree(t, {}) });
  assert.equal(reading.status, "blocked");
  assert.match(String(reading.blocked), /chat_route_population_empty/u);
  assert.equal(reading.population, 0);
});
