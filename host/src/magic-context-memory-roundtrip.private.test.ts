/**
 * A NOTE SHE WROTE, READ BACK BY THE NEXT SESSION - AND THE STORE THAT HOLDS IT.
 *
 * <p>
 * The finding this file answers: a measured 34-minute Game run called `ctx_search` zero times while calling
 * `ctx_reduce` six times, and then said "I tilled nothing, planted nothing" over a transcript holding four
 * `plant_seed` calls. Presence of the tool was already pinned by
 * `magic-context-companion-guidance.private.test.ts` and `tool-surface.private.test.ts`, and presence was never the
 * open question. What was open is the round trip: a note written by the companion, found again by the identity that
 * wrote it - and, when it is not, which partition swallowed it.
 * </p>
 *
 * <p>
 * Every case drives the REAL Game runtime (`createCompanionRuntime`, `surface: "game"`) through the wrapper Pi
 * installs for extension tools. Passing no context lets the runner supply the session's own
 * (`tool-definition-wrapper.js`: `ctx ?? ctxFactory?.(toolCallId, signal)`), so the cwd, the session identity and the
 * store are the runtime's, never a fixture's. The store is then read with `node:sqlite` from the file the runtime
 * created, because the one thing a search result cannot say is which partition it came from.
 * </p>
 *
 * <p>
 * The three negative arms exist because a green first arm proves very little alone: a search answered from an
 * in-process cache would also pass. So the same read is pointed at the same continuity under another runtime root,
 * at another continuity under the same root, and at a store whose row was deleted - and each must find nothing.
 * </p>
 *
 * <p>
 * A note hit and an empty search are read by SHAPE here (`[note]` against `No … results found`), never by "the
 * marker is absent from the text": the empty reply quotes the query back, so a substring test reports a missing note
 * as found.
 * </p>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { getDeclaredProjectIdentity } from "@cortexkit/pi-magic-context/memory";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import {
  type CompanionIdentity,
  createCompanionRuntime,
  MAGIC_CONTEXT_RECALL_ENABLED,
  type RuntimeSession,
} from "./runtime.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

/** One token, so the note ranks on an exact phrase rather than on a word every other row shares. */
const MARKER = "gamebuddy-noteroundtrip9f41c2";
const NOTE_TEXT = `${MARKER} the wagon needs a new axle before winter`;
const SURFACE_SESSION_ID = "game_memory_roundtrip_01";

/** What a note hit looks like in a search result, and what a search that answered nothing looks like. */
const NOTE_HIT = /\[note\]/u;
const NO_HITS = /No .{0,16}results found/u;

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_memory_roundtrip",
  playerId: "player_memory_roundtrip",
  saveId: "save_memory_roundtrip",
  worldId: "world_memory_roundtrip",
  companionId: "companion_memory_roundtrip",
});

/** A second continuity: the same player and companion, so the identity is the only variable that moved. */
const otherIdentity: CompanionIdentity = Object.freeze({
  ...identity,
  continuityId: "continuity_memory_roundtrip_other",
});

/** The Game runtime exactly as production mounts it. */
async function mountGameRuntime(root: string, who: CompanionIdentity): Promise<RuntimeSession> {
  return await createCompanionRuntime(
    who,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    SURFACE_SESSION_ID,
    undefined,
    "game",
  );
}

type MountedTool = RuntimeSession["session"]["agent"]["state"]["tools"][number];

/**
 * One tool call, through the tool object the session mounted.
 *
 * The context is left off on purpose: Pi's wrapper supplies the runner's own on execution
 * (`tool-definition-wrapper.js`: `ctx ?? ctxFactory?.(toolCallId, signal)`), so the extension sees this session's cwd
 * and session manager rather than a context assembled here.
 */
async function callMountedTool(
  runtime: RuntimeSession,
  name: string,
  params: Record<string, unknown>,
): Promise<string> {
  const tool: MountedTool | undefined = runtime.session.agent.state.tools.find((candidate) => candidate.name === name);
  assert.ok(
    tool !== undefined,
    `the Game surface does not mount ${name}; it mounts ${runtime.session.agent.state.tools
      .map((candidate) => candidate.name)
      .join(", ")}`,
  );
  const result = await tool.execute(`${name}_call_01`, params, new AbortController().signal);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * The player's turn, written through the session's own store.
 *
 * <p>
 * A Pi session file is created by its first message, and `SessionManager.continueRecent` can only continue a file
 * that exists: a mount that was never prompted leaves nothing behind, and the next mount legitimately starts a new
 * session. A real Game session is prompted, so the fixture is one player message - written by the same
 * `appendMessage` Pi itself calls to persist a turn - and nothing else.
 * </p>
 */
function writePlayerTurn(runtime: RuntimeSession): void {
  runtime.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "早，今天的农场怎么样？" }],
    timestamp: Date.now(),
  });
}

/** Every `context.db` below a runtime root: the store this runtime's extension opened, found rather than assumed. */
async function storesUnder(runtimeCwd: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === "context.db") found.push(path);
    }
  };
  await walk(runtimeCwd);
  return found;
}

async function onlyStoreUnder(runtimeCwd: string): Promise<string> {
  const stores = await storesUnder(runtimeCwd);
  assert.equal(
    stores.length,
    1,
    `a runtime must own exactly one context.db under ${runtimeCwd}; found ${stores.join(", ") || "none"}`,
  );
  return stores[0] as string;
}

async function onlyStore(runtime: RuntimeSession): Promise<string> {
  return await onlyStoreUnder(runtime.paths.runtimeCwd);
}

type NoteRow = Readonly<{
  id: number;
  type: string;
  status: string;
  content: string;
  session_id: string | null;
  project_path: string | null;
}>;

function noteRows(storePath: string, marker: string): NoteRow[] {
  const database = new DatabaseSync(storePath);
  try {
    return database
      .prepare("SELECT id, type, status, content, session_id, project_path FROM notes WHERE content LIKE ? ORDER BY id")
      .all(`%${marker}%`) as unknown as NoteRow[];
  } finally {
    database.close();
  }
}

function deleteNoteRows(storePath: string, marker: string): number {
  const database = new DatabaseSync(storePath);
  try {
    return Number(database.prepare("DELETE FROM notes WHERE content LIKE ?").run(`%${marker}%`).changes);
  } finally {
    database.close();
  }
}

/**
 * One search, in a child process, in a runtime this process cannot represent.
 *
 * <p>
 * Magic Context locks the declared project identity for the life of the process and refuses a second, different
 * value, so a second continuity or a second runtime root cannot be mounted beside the first in one process - the
 * lock exists so two tenants can never be read through one declaration. A child is therefore the only place the
 * negative arms are real.
 * </p>
 *
 * <p>
 * The child runs from a script FILE rather than `--input-type=module`: Node's workers inherit the parent's CLI
 * options, and the vendor's migration worker loads a file, so an inline module would start it as
 * `node --input-type=module <file>` and fail to load - which fails closed to a storage-less runtime with no tools.
 * </p>
 */
const childSearchScript = `
  const [runtimeUrl, lockUrl, reclaimerUrl, requestJson] = process.argv.slice(2);
  const request = JSON.parse(requestJson);
  const { bindWindowsStaleLockReclaimer } = await import(lockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const { createCompanionRuntime } = await import(runtimeUrl);
  const runtime = await createCompanionRuntime(
    request.identity,
    request.root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    request.sessionId,
    undefined,
    "game",
  );
  const tool = runtime.session.agent.state.tools.find((candidate) => candidate.name === "ctx_search");
  const result = await tool.execute("child_search_01", { query: request.query }, new AbortController().signal);
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\\n");
  const payload = { piSessionId: runtime.piSessionId, runtimeCwd: runtime.paths.runtimeCwd, text };
  await new Promise((resolve) => process.stdout.write(JSON.stringify(payload), resolve));
  runtime.session.dispose();
  process.exit(0);
`;

async function searchInChild(
  childRoot: string,
  who: CompanionIdentity,
  query: string,
): Promise<{ piSessionId: string; runtimeCwd: string; text: string }> {
  await mkdir(childRoot, { recursive: true });
  const scriptPath = join(childRoot, "memory-roundtrip-search-child.mjs");
  await writeFile(scriptPath, childSearchScript, "utf8");
  const child = spawn(
    process.env.GAMEBUDDY_HOST_TEST_NODE ?? process.execPath,
    [
      scriptPath,
      new URL("./runtime.js", import.meta.url).href,
      new URL("./path-lock.js", import.meta.url).href,
      new URL("./windows-stale-lock-reclaimer/index.js", import.meta.url).href,
      JSON.stringify({ identity: who, root: childRoot, sessionId: SURFACE_SESSION_ID, query }),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
    piSessionId: string;
    runtimeCwd: string;
    text: string;
  };
}

test("a note she writes is read back by her own session, and by the next session for the same continuity", async () => {
  const root = await canonicalTestRoot("gamebuddy-memory-roundtrip-");
  try {
    const writing = await mountGameRuntime(root, identity);
    const piSessionId = writing.piSessionId;
    let sameSession: string;
    try {
      writePlayerTurn(writing);
      const saved = await callMountedTool(writing, "ctx_note", { action: "write", content: NOTE_TEXT });
      assert.match(saved, /Saved session note #\d+\./u, `ctx_note did not record a session note: ${saved}`);
      sameSession = await callMountedTool(writing, "ctx_search", { query: MARKER });
    } finally {
      writing.session.dispose();
    }
    assert.match(
      sameSession,
      NOTE_HIT,
      `the note she wrote a moment ago is not searchable in her own session, so the write and the read do not meet:\n${sameSession}`,
    );
    assert.ok(sameSession.includes(MARKER), `the hit is not her note:\n${sameSession}`);

    const next = await mountGameRuntime(root, identity);
    try {
      // The continuity's own Pi session file is what a note is scoped to, so "the next session" is that file
      // continued. If a second mount ever started a fresh session instead, every note the previous mount wrote would
      // be stranded under an id nothing reads again.
      assert.equal(
        next.piSessionId,
        piSessionId,
        "a second mount of one continuity started a new Pi session, so every session note the previous mount wrote is now unreachable",
      );
      const foundAgain = await callMountedTool(next, "ctx_search", { query: MARKER });
      assert.match(
        foundAgain,
        NOTE_HIT,
        `the next session for the same continuity cannot find the note:\n${foundAgain}`,
      );
      process.stderr.write(
        [
          "[memory-roundtrip] the store works: her own session and the next session of the same continuity both read the note back.",
          "[memory-roundtrip] the note as the next session reads it:",
          ...foundAgain
            .trim()
            .split("\n")
            .slice(0, 4)
            .map((line) => `  ${line}`),
        ].join("\n") + "\n",
      );
    } finally {
      next.session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the note lands in this continuity's own store, under this continuity's own Pi session", async () => {
  const root = await canonicalTestRoot("gamebuddy-memory-partition-");
  try {
    const writing = await mountGameRuntime(root, identity);
    try {
      writePlayerTurn(writing);
      await callMountedTool(writing, "ctx_note", { action: "write", content: NOTE_TEXT });
      const store = await onlyStore(writing);
      assert.ok(
        store.startsWith(writing.paths.runtimeCwd),
        `the store the runtime opened is outside its own runtime root: ${store} vs ${writing.paths.runtimeCwd}`,
      );
      const rows = noteRows(store, MARKER);
      assert.equal(rows.length, 1, `exactly one note row carries the marker; found ${rows.length} in ${store}`);
      const row = rows[0] as NoteRow;
      assert.equal(row.type, "session");
      assert.equal(row.status, "active");
      // The partition a note lives in is the store plus the Pi session inside it: `ctx_note` writes a session-scoped
      // row, and only a smart note (surface_condition) or a Memory carries the project identity as a column.
      assert.equal(
        row.session_id,
        writing.piSessionId,
        `the note is not scoped to the session that wrote it: ${String(row.session_id)} vs ${writing.piSessionId}`,
      );
      assert.equal(row.project_path, null);
      const declared = getDeclaredProjectIdentity();
      assert.ok(
        declared !== undefined,
        "the runtime declared no project identity, so the render side reads a different partition than the management facade",
      );
      assert.ok(
        declared.endsWith(`:continuity:${identity.continuityId}`),
        `the declared partition does not name this continuity: ${declared}`,
      );
      process.stderr.write(
        [
          `[memory-roundtrip] runtimeCwd: contexts/${writing.identityKey}`,
          `[memory-roundtrip] store: ${store.slice(root.length + 1)}`,
          `[memory-roundtrip] declared memory partition: ${declared}`,
          `[memory-roundtrip] note row: id=#${row.id} type=${row.type} status=${row.status} session_id=${String(row.session_id)} project_path=${String(row.project_path)}`,
        ].join("\n") + "\n",
      );
    } finally {
      writing.session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("another continuity's session finds nothing for the same marker", async () => {
  const root = await canonicalTestRoot("gamebuddy-memory-cross-identity-");
  try {
    const writing = await mountGameRuntime(root, identity);
    let writerRuntimeCwd: string;
    try {
      writePlayerTurn(writing);
      await callMountedTool(writing, "ctx_note", { action: "write", content: NOTE_TEXT });
      writerRuntimeCwd = writing.paths.runtimeCwd;
    } finally {
      writing.session.dispose();
    }
    const other = await searchInChild(root, otherIdentity, MARKER);
    // The negative is worth something only if the two identities really are different stores.
    assert.notEqual(
      other.runtimeCwd,
      writerRuntimeCwd,
      "both continuities resolved to one runtime root, so this case proves nothing",
    );
    assert.doesNotMatch(
      other.text,
      NOTE_HIT,
      `a note written by ${identity.continuityId} is visible to ${otherIdentity.continuityId}, which is worse than losing it:\n${other.text}`,
    );
    assert.match(other.text, NO_HITS, `the other continuity's search did not report an empty result:\n${other.text}`);
    assert.deepEqual(noteRows(await onlyStoreUnder(other.runtimeCwd), MARKER), []);
    process.stderr.write(
      `[memory-roundtrip] cross-identity: ${identity.continuityId} wrote, ${otherIdentity.continuityId} read ${other.runtimeCwd.slice(root.length + 1)} - ${other.text.trim().split("\n")[0]}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the same continuity pointed at another runtime root finds nothing", async () => {
  const root = await canonicalTestRoot("gamebuddy-memory-other-root-");
  try {
    const writing = await mountGameRuntime(root, identity);
    let writerRuntimeCwd: string;
    try {
      writePlayerTurn(writing);
      await callMountedTool(writing, "ctx_note", { action: "write", content: NOTE_TEXT });
      writerRuntimeCwd = writing.paths.runtimeCwd;
    } finally {
      writing.session.dispose();
    }
    // Same continuity, same surface session id, another root: the write and the read no longer meet, which is what
    // proves the read is bound to this store rather than to something the process remembers.
    const elsewhere = await searchInChild(join(root, "elsewhere"), identity, MARKER);
    assert.notEqual(elsewhere.runtimeCwd, writerRuntimeCwd);
    assert.doesNotMatch(elsewhere.text, NOTE_HIT, `the note followed the runtime to another root:\n${elsewhere.text}`);
    assert.match(elsewhere.text, NO_HITS);
    process.stderr.write(
      `[memory-roundtrip] other-root: the writer's store was ${writerRuntimeCwd.slice(root.length + 1)}, the reader's ${elsewhere.runtimeCwd.slice(root.length + 1)} - ${elsewhere.text.trim().split("\n")[0]}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("deleting the row makes the search return nothing, so the search reads the store", async () => {
  const root = await canonicalTestRoot("gamebuddy-memory-deleted-");
  try {
    const runtime = await mountGameRuntime(root, identity);
    try {
      writePlayerTurn(runtime);
      await callMountedTool(runtime, "ctx_note", { action: "write", content: NOTE_TEXT });
      const store = await onlyStore(runtime);
      const before = await callMountedTool(runtime, "ctx_search", { query: MARKER });
      assert.match(
        before,
        NOTE_HIT,
        `the note is not searchable before the delete, so the delete would prove nothing:\n${before}`,
      );
      assert.equal(deleteNoteRows(store, MARKER), 1);
      const after = await callMountedTool(runtime, "ctx_search", { query: MARKER });
      assert.doesNotMatch(
        after,
        NOTE_HIT,
        `the row is gone and the search still returns it, so the result is not the store's:\n${after}`,
      );
      assert.match(after, NO_HITS);
      process.stderr.write(
        [
          "[memory-roundtrip] the search is the store's: the same query found the note, then 1 row deleted, then nothing.",
          // The product fact this gate measures, printed rather than asserted: the store is healthy and nothing in
          // the runtime asks it to be searched before she acts. Each of the three places a turn could ask, and what
          // each does today:
          `[memory-roundtrip] nothing asks before she acts: memory.auto_search.enabled=${MAGIC_CONTEXT_RECALL_ENABLED} is the only automatic recall gate there is.`,
          "[memory-roundtrip]   the fact brief (fact-brief.ts): world facts only - it names no archive and no search.",
          "[memory-roundtrip]   the prompt floor (game-surface-prompt-floor.ts): no ctx_* mention at all; the desk protocol arrives separately, in Magic Context's own prompt section, as prose telling her to search when something is not in view - and no code path performs that search for her.",
          "[memory-roundtrip]   the plan compiler (body-program-*): compiles an action program from the live snapshot; it never queries the archive.",
        ].join("\n") + "\n",
      );
    } finally {
      runtime.session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
