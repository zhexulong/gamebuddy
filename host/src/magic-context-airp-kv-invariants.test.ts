import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createGameBuddyPlayerMemoryCrudFacade,
  resolveGameBuddyMemoryProjectPath,
} from "@cortexkit/pi-magic-context/memory";
import {
  GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
  publishGameBuddyAuthoredStableCatalog,
  renderPostHistoryInstructions,
} from "@cortexkit/pi-magic-context/tavern";

import {
  COMPANION_ARCHIVE_TOOL_DESCRIPTIONS,
  projectArchiveToolDescription,
} from "./companion-archive-tool-descriptions.js";
import { DEFAULT_IDENTITY_PROFILE } from "./identity-profile.js";
import { GAMEBUDDY_PROTECTED_TOOLS } from "./magic-context-protected-tools.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import {
  type CompanionIdentity,
  createCompanionRuntime,
  MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
  MAGIC_CONTEXT_HISTORIAN_ENABLED,
  MAGIC_CONTEXT_MEMORY_DOMAIN,
  MAGIC_CONTEXT_MEMORY_ENABLED,
  type RuntimeSession,
} from "./runtime.js";
import { createPresetBindingStore } from "./tavern/preset-binding.js";
import {
  presetRequestMacros,
  presetRequestMarkers,
  publishPresetRequestSegments,
} from "./tavern/preset-request-segments.js";
import { createPresetStore } from "./tavern/preset-store.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

/**
 * KV PREFIX CACHE & AIRP BOUNDARY INVARIANTS.
 *
 * Drives the real Pi `ExtensionRunner.emitContext(...)` pipeline registered by
 * `@cortexkit/pi-magic-context` on isolated `createCompanionRuntime` instances, backed
 * by real `context.db` SQLite state, preset publication, and authored WorldBook catalogs.
 *
 * Keeps temporary runtime roots cleaned on process exit because Magic Context closes
 * its SQLite handle in its own `exit` listener (`EBUSY` on Windows if deleted early).
 */

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

type AgentMessages = Parameters<RuntimeSession["session"]["extensionRunner"]["emitContext"]>[0];
type AgentMessage = AgentMessages[number];

const pendingRootsForExitCleanup: string[] = [];
process.once("exit", () => {
  for (const root of pendingRootsForExitCleanup) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort exit cleanup on Windows.
    }
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function textOf(message: AgentMessage | undefined): string {
  if (message === undefined || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function userTurn(text: string, timestamp = Date.now()): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistantTextTurn(text: string, timestamp = Date.now()): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 16,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 28,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function observeToolCallTurn(toolCallId: string, location: string, timestamp = Date.now()): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "stardew_observe", arguments: {} }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture-model",
      usage: {
        input: 16,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 24,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId,
      toolName: "stardew_observe",
      content: [{ type: "text", text: JSON.stringify({ location, weather: "sunny", day: 1, stamina: 240 }) }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

function findContextDbPath(runtimeCwd: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name === "context.db") found.push(fullPath);
    }
  };
  walk(runtimeCwd);
  assert.equal(found.length, 1, `expected exactly one context.db under ${runtimeCwd}, found ${found.length}`);
  const dbPath = found[0];
  assert.ok(dbPath !== undefined);
  return dbPath;
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function setupIsolatedRuntime(surface: "game" | "chat", suffix: string) {
  const root = await canonicalTestRoot(`mc-airp-kv-${suffix}-`);
  pendingRootsForExitCleanup.push(root);
  const continuityId = `continuity_kv_${suffix}`;
  const identity: CompanionIdentity = Object.freeze({
    continuityId,
    playerId: `player_kv_${suffix}`,
    saveId: `save_kv_${suffix}`,
    worldId: `world_kv_${suffix}`,
    companionId: `companion_kv_${suffix}`,
  });
  const runtime = await createCompanionRuntime(
    identity,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    surface,
  );
  return { root, continuityId, identity, runtime };
}

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

function disposeRuntimeBestEffort(runtime: RuntimeSession): void {
  try {
    runtime.session.dispose();
  } catch {
    // Best-effort disposal in test teardown.
  }
}

function extractHistoryClosingPrefix(m0Text: string): string {
  const closeTag = "</session-history>";
  const closeIdx = m0Text.indexOf(closeTag);
  assert.notEqual(closeIdx, -1, `m[0] must contain ${closeTag}:\n${m0Text}`);
  return m0Text.slice(0, closeIdx + closeTag.length);
}

test("m[0] stays byte-identical across growing turns and chapters append strictly oldest-first without shifting history prefix", async () => {
  const { continuityId, runtime } = await setupIsolatedRuntime("game", "chapters");
  try {
    const turn1: AgentMessage[] = [
      userTurn("早啊，今天牧场先干点什么？", 1_700_000_001_000),
      assistantTextTurn("先把门口这片防风草浇透。", 1_700_000_002_000),
    ];
    const pass1 = await runtime.session.extensionRunner.emitContext(turn1);
    const m0Pass1 = textOf(pass1[0]);
    assert.match(m0Pass1, /<session-history>[\s\S]*<\/session-history>/);

    // Grow raw tail with a new user turn, tool observation, and assistant reply.
    const turn2: AgentMessage[] = [
      ...turn1,
      userTurn("浇完水顺便看看周边情况。", 1_700_000_003_000),
      ...observeToolCallTurn("obs_1", "Farm", 1_700_000_004_000),
      assistantTextTurn("土地湿润度足够了，我们一会儿去镇上。", 1_700_000_005_000),
    ];
    const pass2 = await runtime.session.extensionRunner.emitContext(turn2);
    const m0Pass2 = textOf(pass2[0]);

    assert.equal(sha256(m0Pass2), sha256(m0Pass1), "raw tail growth without a fold must keep m[0] byte-identical");
    assert.equal(m0Pass2, m0Pass1);

    // Locate the real SQLite store and the session's continuity project identity.
    const dbPath = findContextDbPath(runtime.paths.runtimeCwd);
    const sessionId = runtime.session.sessionId;
    const projectPath = resolveGameBuddyMemoryProjectPath(runtime.paths.runtimeCwd, continuityId);

    // Seal Chapter 1 and trigger a legitimate HARD fold m[0] rebuild.
    const chapter1Marker = "CHAPTER-ONE-SPRING-PLANTING-11a2";
    const chapter2Marker = "CHAPTER-TWO-MINES-EXPLORATION-33b4";
    withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO chapters (
          session_id, project_path, span_start_sequence, span_end_sequence,
          start_date, end_date, title, content, source_compartment_ids,
          importance, sealed_at, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        sessionId,
        projectPath,
        1,
        2,
        "2026-03-01",
        "2026-03-01",
        "春耕开荒",
        chapter1Marker,
        JSON.stringify([1, 2]),
        65,
        1_700_000_010_000,
        1_700_000_010_000,
      );
      db.prepare("UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?").run(
        sessionId,
      );
    });

    const pass3 = await runtime.session.extensionRunner.emitContext(turn2);
    const m0Pass3 = textOf(pass3[0]);
    assert.ok(m0Pass3.includes(chapter1Marker), "HARD fold rebuild must surface sealed Chapter 1 in m[0]");

    // Seal Chapter 2 and trigger the next HARD fold m[0] rebuild.
    withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO chapters (
          session_id, project_path, span_start_sequence, span_end_sequence,
          start_date, end_date, title, content, source_compartment_ids,
          importance, sealed_at, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        sessionId,
        projectPath,
        3,
        4,
        "2026-03-02",
        "2026-03-02",
        "初探矿洞",
        chapter2Marker,
        JSON.stringify([3, 4]),
        70,
        1_700_000_020_000,
        1_700_000_020_000,
      );
      db.prepare("UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?").run(
        sessionId,
      );
    });

    const pass4 = await runtime.session.extensionRunner.emitContext(turn2);
    const m0Pass4 = textOf(pass4[0]);
    const idx1 = m0Pass4.indexOf(chapter1Marker);
    const idx2 = m0Pass4.indexOf(chapter2Marker);
    assert.ok(idx1 >= 0 && idx2 > idx1, "chapters must stay chronological oldest-first inside <session-history>");

    const chapter1LineEndPass3 = m0Pass3.indexOf("\n", m0Pass3.indexOf(chapter1Marker));
    const chapter1LineEndPass4 = m0Pass4.indexOf("\n", idx1);
    assert.ok(chapter1LineEndPass3 > 0 && chapter1LineEndPass4 > 0);
    assert.equal(
      m0Pass4.slice(0, chapter1LineEndPass4),
      m0Pass3.slice(0, chapter1LineEndPass3),
      "sealing Chapter 2 must keep every prefix byte up through Chapter 1 identical",
    );
  } finally {
    disposeRuntimeBestEffort(runtime);
  }
});

test("WP-F KV invariant: adding/mutating durable memories preserves warm m[0] and never shifts <session-history> bytes", async () => {
  const { continuityId, runtime } = await setupIsolatedRuntime("game", "memories");
  try {
    const dbPath = findContextDbPath(runtime.paths.runtimeCwd);
    const sessionId = runtime.session.sessionId;
    const seedTurns: AgentMessage[] = [
      userTurn("第一天先看看农田里的杂草。", 1_700_001_001_000),
      assistantTextTurn("好，我帮着清理北边这几格。", 1_700_001_002_000),
    ];

    // Establish chapter history before touching memories.
    const warmupPass = await runtime.session.extensionRunner.emitContext(seedTurns);
    assert.ok(textOf(warmupPass[0]).includes("<session-history>"));

    const projectPath = resolveGameBuddyMemoryProjectPath(runtime.paths.runtimeCwd, continuityId);

    withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO chapters (
          session_id, project_path, span_start_sequence, span_end_sequence,
          start_date, end_date, title, content, source_compartment_ids,
          importance, sealed_at, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        sessionId,
        projectPath,
        1,
        2,
        "2026-03-01",
        "2026-03-01",
        "农场清理",
        "CHAPTER-BASELINE-BEFORE-MEMORY-55c6",
        JSON.stringify([1, 2]),
        60,
        1_700_001_005_000,
        1_700_001_005_000,
      );
      db.prepare("UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ?").run(sessionId);
    });

    const baselineWithChapter = await runtime.session.extensionRunner.emitContext(seedTurns);
    const m0BeforeMemory = textOf(baselineWithChapter[0]);
    const historyPrefixBeforeMemory = extractHistoryClosingPrefix(m0BeforeMemory);

    // Add a real durable ongoing-interaction memory through Magic Context's CRUD facade.
    const memorySentinel = "PLAYER-PREFERS-STRAWBERRIES-SPRING-77d8";
    const facade = createGameBuddyPlayerMemoryCrudFacade({
      continuityId,
      runtimeCwd: runtime.paths.runtimeCwd,
      profileId: DEFAULT_IDENTITY_PROFILE.profileId,
      profileRevision: DEFAULT_IDENTITY_PROFILE.revision,
    });
    const created = await facade.create({
      continuityId,
      profileId: DEFAULT_IDENTITY_PROFILE.profileId,
      profileRevision: DEFAULT_IDENTITY_PROFILE.revision,
      content: memorySentinel,
    });
    assert.equal(created.category, "semantic");
    const dbCategory = withDb(dbPath, (db) => {
      const row = db.prepare("SELECT category FROM memories WHERE content = ?").get(memorySentinel) as
        | { category: string }
        | undefined;
      return row?.category;
    });
    assert.equal(dbCategory, "SEMANTIC_MEMORY");

    // Pass without invalidating cached m[0]: warm m[0] must NOT bust when a memory is added mid-session.
    const midSessionDeltaPass = await runtime.session.extensionRunner.emitContext([
      ...seedTurns,
      userTurn("记住了吗？明年春天多种草莓。", 1_700_001_010_000),
    ]);
    const m0MidSessionDelta = textOf(midSessionDeltaPass[0]);
    assert.equal(
      sha256(m0MidSessionDelta),
      sha256(m0BeforeMemory),
      "mid-session memory creation must preserve cached m[0] byte-for-byte",
    );

    // Next HARD fold rebuilds m[0]: memories MUST land after </session-history>, leaving history prefix intact.
    withDb(dbPath, (db) => {
      db.prepare("UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?").run(
        sessionId,
      );
    });

    const rebuiltAfterFold = await runtime.session.extensionRunner.emitContext(seedTurns);
    const m0AfterFold = textOf(rebuiltAfterFold[0]);
    const historyEndAfterFold = m0AfterFold.indexOf("</session-history>") + "</session-history>".length;
    const memoryStartAfterFold = m0AfterFold.indexOf("<project-memory>");
    assert.ok(m0AfterFold.includes(memorySentinel), "rebuilt m[0] after fold must surface durable memory");
    assert.ok(
      memoryStartAfterFold > historyEndAfterFold,
      `<project-memory> (${memoryStartAfterFold}) MUST come after </session-history> (${historyEndAfterFold})`,
    );
    assert.equal(
      sha256(extractHistoryClosingPrefix(m0AfterFold)),
      sha256(historyPrefixBeforeMemory),
      "prefix up through </session-history> must stay 100% byte-identical before and after durable memory growth",
    );

    // Negative control: placing <project-memory> before <session-history> (the rejected WP-F draft order)
    // shifts every byte offset inside <session-history> when a memory is added.
    const memoryBlockOnly = m0AfterFold.slice(memoryStartAfterFold);
    const badOrderWithoutMemory = historyPrefixBeforeMemory;
    const badOrderWithMemory = `${memoryBlockOnly}\n\n${historyPrefixBeforeMemory}`;
    assert.notEqual(
      badOrderWithMemory.indexOf("<session-history>"),
      badOrderWithoutMemory.indexOf("<session-history>"),
      "negative control: putting mutable memories before <session-history> shifts history byte offsets",
    );
    assert.notEqual(
      sha256(badOrderWithMemory.slice(0, badOrderWithoutMemory.length)),
      sha256(badOrderWithoutMemory),
      "negative control: prefix cache up to prior history length breaks under reversed WP-F ordering",
    );
  } finally {
    disposeRuntimeBestEffort(runtime);
  }
});

test("Chat authored volatile WorldBook, SillyTavern preset after/depth, and post_history_instructions never bust m[0]", async () => {
  const { root, continuityId, runtime } = await setupIsolatedRuntime("chat", "chat_tail");
  const playerRoot = join(root, "tavern-player");
  await mkdir(playerRoot, { recursive: true });
  const presets = createPresetStore({ runtimeRoot: root, playerRoot });
  const binding = createPresetBindingStore({ runtimeRoot: root, playerRoot }, presets);

  const buildPresetDoc = (afterSentinel: string, depthSentinel: string) => ({
    name: "KV Invariant Preset",
    prompts: [
      { identifier: "main", name: "Main", role: "system", content: "PRESET-MAIN-STABLE-99a0 {{char}}" },
      { identifier: "worldInfoBefore", name: "World Info (before)", marker: true, role: "system", content: "" },
      { identifier: "chatHistory", name: "Chat History", marker: true },
      { identifier: "jailbreak", name: "Jailbreak", role: "system", content: afterSentinel },
      {
        identifier: "depthNote",
        name: "Depth Note",
        role: "user",
        content: depthSentinel,
        injection_position: 1,
        injection_depth: 1,
        injection_order: 10,
      },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "worldInfoBefore", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "jailbreak", enabled: true },
          { identifier: "depthNote", enabled: true },
        ],
      },
    ],
  });

  const makeCatalog = (
    scope: Readonly<{
      continuityId: string;
      sessionId: string;
      surface: "tavern";
      threadId: string;
      profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>;
    }>,
    postHistoryInstructions: string,
  ) => {
    const stableContent = "CONSTANT-WORLDBOOK-STABLE-22e1";
    const volatileContent = "VOLATILE-WORLDBOOK-LANTERN-88f2";
    const body = {
      version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
      scope,
      stableSources: [
        {
          sourceId: "worldbook_constant_01",
          kind: "lorebook_constant" as const,
          revision: "1",
          canonicalHash: sha256(stableContent),
          content: stableContent,
          budgetTokens: 12,
          totalOrderKey: "0001",
          provenance: "test/kv-invariants",
        },
      ],
      volatileSources: [
        {
          sourceId: "worldbook_volatile_01",
          kind: "lorebook_entry" as const,
          revision: "1",
          canonicalHash: sha256(volatileContent),
          content: volatileContent,
          budgetTokens: 12,
          totalOrderKey: "0002",
          provenance: "test/kv-invariants",
          selectionKeys: ["lantern_trigger"],
        },
      ],
    };
    return {
      ...body,
      canonicalHash: sha256(canonicalStableJson(body)),
      postHistoryInstructions,
    };
  };

  let capability: ReturnType<typeof publishGameBuddyAuthoredStableCatalog> | undefined;
  try {
    const profileHash = sha256(JSON.stringify(DEFAULT_IDENTITY_PROFILE));
    const scope = Object.freeze({
      continuityId,
      sessionId: runtime.session.sessionId,
      surface: "tavern" as const,
      threadId: "thread_kv_chat",
      profile: Object.freeze({
        profileId: DEFAULT_IDENTITY_PROFILE.profileId,
        revision: DEFAULT_IDENTITY_PROFILE.revision,
        canonicalHash: profileHash,
      }),
    });

    await presets.import({
      presetId: "kv_preset_v1",
      document: buildPresetDoc("AFTER-TURN-1-44b1", "DEPTH-TURN-1-55c2"),
    });
    await binding.bind("kv_preset_v1");

    capability = publishGameBuddyAuthoredStableCatalog(scope, makeCatalog(scope, "PHI-TURN-1-77d3"));
    await publishPresetRequestSegments({
      projectDir: runtime.paths.runtimeCwd,
      presets,
      binding,
      macros: async () => presetRequestMacros({ profile: DEFAULT_IDENTITY_PROFILE }),
      markers: presetRequestMarkers({ profile: DEFAULT_IDENTITY_PROFILE }),
    });

    const baseTurns: AgentMessage[] = [
      userTurn("今天天气不错。", 1_700_002_001_000),
      assistantTextTurn("嗯，海风吹过来挺舒服的。", 1_700_002_002_000),
    ];
    const pass1 = await runtime.session.extensionRunner.emitContext(baseTurns);
    // When preset `before` is non-empty, `placeSegments` unshifts `{ role: "system", ... }` at index 0,
    // shifting `m[0]` to index 1 and `m[1]` to index 2. Both index 0 (preset before) and m[0] form the stable prefix.
    const presetBeforePass1 = textOf(pass1[0]);
    const m0Pass1 = textOf(pass1[1]);
    assert.equal(pass1[0]?.role, "system");
    assert.ok(
      presetBeforePass1.includes("PRESET-MAIN-STABLE-99a0"),
      "preset before must occupy leading system message",
    );
    assert.ok(m0Pass1.includes("CONSTANT-WORLDBOOK-STABLE-22e1"), "constant WorldBook must sit in m[0]");
    assert.ok(!m0Pass1.includes("VOLATILE-WORLDBOOK-LANTERN-88f2"), "inactive volatile WorldBook must not enter m[0]");
    assert.ok(!m0Pass1.includes("AFTER-TURN-1-44b1"), "preset after segment must never enter m[0]");
    assert.ok(!m0Pass1.includes("PHI-TURN-1-77d3"), "post_history_instructions must never enter m[0]");
    assert.equal(textOf(pass1.at(-1)), renderPostHistoryInstructions("PHI-TURN-1-77d3"));

    // Turn 2: activate volatile WorldBook + mutate preset after/depth + update post_history_instructions.
    const plan = capability.prepare("preflight_turn_2");
    const triggered = capability.materializeVolatileForTurn("turn_2", "Bring out lantern_trigger tonight", "");
    assert.equal(triggered.refs.length, 1);
    capability.assertInstall("turn_2", plan.sourceRefs, triggered.refs);

    await presets.import({
      presetId: "kv_preset_v2",
      document: buildPresetDoc("AFTER-TURN-2-66e4", "DEPTH-TURN-2-99f5"),
    });
    await binding.bind("kv_preset_v2");
    await publishPresetRequestSegments({
      projectDir: runtime.paths.runtimeCwd,
      presets,
      binding,
      macros: async () => presetRequestMacros({ profile: DEFAULT_IDENTITY_PROFILE }),
      markers: presetRequestMarkers({ profile: DEFAULT_IDENTITY_PROFILE }),
    });

    // Replace closing direction while keeping identical stableSources + constant catalog hash.
    await capability.clear();
    capability = publishGameBuddyAuthoredStableCatalog(scope, makeCatalog(scope, "PHI-TURN-2-00a6"));
    const triggeredTurn2 = capability.materializeVolatileForTurn("turn_2b", "lantern_trigger glow", "");
    assert.equal(triggeredTurn2.refs.length, 1);

    const turn2: AgentMessage[] = [...baseTurns, userTurn("把 lantern_trigger 拿出来照明吧。", 1_700_002_003_000)];
    const pass2 = await runtime.session.extensionRunner.emitContext(turn2);
    const presetBeforePass2 = textOf(pass2[0]);
    const m0Pass2 = textOf(pass2[1]);
    const m1Pass2 = textOf(pass2[2]);
    const tailText = pass2.slice(3).map(textOf).join("\n");

    assert.equal(
      sha256(presetBeforePass2),
      sha256(presetBeforePass1),
      "leading preset before message must stay byte-identical across turns",
    );
    assert.equal(
      sha256(m0Pass2),
      sha256(m0Pass1),
      "volatile WorldBook activation, preset after/depth changes, and post_history_instructions edits must preserve m[0]",
    );
    assert.ok(m1Pass2.includes("VOLATILE-WORLDBOOK-LANTERN-88f2"), "triggered volatile WorldBook must ride in m[1]");
    assert.ok(!m0Pass2.includes("VOLATILE-WORLDBOOK-LANTERN-88f2"));
    assert.match(tailText, /DEPTH-TURN-2-99f5/);
    assert.match(tailText, /AFTER-TURN-2-66e4/);
    assert.equal(
      textOf(pass2.at(-1)),
      renderPostHistoryInstructions("PHI-TURN-2-00a6"),
      "post_history_instructions must remain the very last wire message after preset after/depth",
    );
  } finally {
    await capability?.clear().catch(() => undefined);
    disposeRuntimeBestEffort(runtime);
  }
});

test("AIRP host-vendor boundary: written magic-context config, protected tools, and ADR-0014 archive prose hold", async () => {
  const { runtime } = await setupIsolatedRuntime("game", "boundary");
  try {
    const projectConfigPath = join(runtime.paths.runtimeCwd, ".cortexkit", "magic-context.jsonc");
    assert.equal(existsSync(projectConfigPath), true);
    const config = JSON.parse(await readFile(projectConfigPath, "utf8")) as {
      memory?: { domain?: string; enabled?: boolean; auto_promote?: boolean };
      system_prompt_injection?: { enabled?: boolean };
      dreamer?: { inject_docs?: boolean; tasks?: Record<string, { schedule?: string }> };
      protected_tools?: Record<string, number>;
      temporal_awareness?: boolean;
    };

    assert.equal(config.memory?.domain, MAGIC_CONTEXT_MEMORY_DOMAIN);
    assert.equal(MAGIC_CONTEXT_MEMORY_DOMAIN, "ongoing-interaction");
    assert.equal(config.memory?.enabled, MAGIC_CONTEXT_MEMORY_ENABLED);
    assert.equal(config.memory?.auto_promote, MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED);
    assert.equal(MAGIC_CONTEXT_HISTORIAN_ENABLED, true);
    assert.equal(config.system_prompt_injection?.enabled, false);
    assert.equal(config.dreamer?.inject_docs, false);
    assert.equal(config.temporal_awareness, false);
    assert.deepEqual(config.protected_tools, GAMEBUDDY_PROTECTED_TOOLS);

    // ADR-0014 Host projection holds on ctx_search & ctx_expand mounted on Game surface.
    const mountedToolsByName = new Map(runtime.session.agent.state.tools.map((tool) => [tool.name, tool]));
    for (const [toolName, expected] of Object.entries(COMPANION_ARCHIVE_TOOL_DESCRIPTIONS)) {
      const mounted = mountedToolsByName.get(toolName);
      assert.ok(mounted !== undefined, `expected mounted tool ${toolName} on Game runtime`);
      assert.equal(mounted.description, expected.description);
      assert.doesNotMatch(mounted.description, /\bOpenCode\b|\bgit_commit\b/i);
      const projected = projectArchiveToolDescription(
        mounted as unknown as Parameters<typeof projectArchiveToolDescription>[0],
      );
      assert.equal(projected.description, expected.description);
    }
  } finally {
    disposeRuntimeBestEffort(runtime);
  }
});
