#!/usr/bin/env bun
/**
 * Zero-LLM offline AIRP verification against archived live-run artifacts (`context.db` + `session*.jsonl`).
 *
 * Drives the actual Magic Context & GameBuddy Host implementations on isolated temporary copies
 * of a captured run's `context.db` and session transcript—no Stardew Valley instance and no live
 * LLM provider call required.
 *
 * Usage:
 *   bun run tools/verify-magic-context-airp-offline.ts
 *   bun run tools/verify-magic-context-airp-offline.ts --run-dir .live-runs/game-ladder/<run>
 *   bun run tools/verify-magic-context-airp-offline.ts --json
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { COMPANION_ARCHIVE_TOOL_DESCRIPTIONS } from "../host/src/companion-archive-tool-descriptions.ts";
import { GAMEBUDDY_PROTECTED_TOOLS } from "../host/src/magic-context-protected-tools.ts";
import {
  clearAutoSearchForPiSession,
  runAutoSearchHintForPi,
} from "../vendor/magic-context/packages/pi-plugin/src/auto-search-pi.ts";
import {
  createCtxMemoryListTool,
  createCtxMemoryTool,
} from "../vendor/magic-context/packages/pi-plugin/src/tools/ctx-memory.ts";
import { createCtxSearchTool } from "../vendor/magic-context/packages/pi-plugin/src/tools/ctx-search.ts";
import { readReflectWindow } from "../vendor/magic-context/packages/plugin/src/features/magic-context/dreamer/reflect.ts";
import { promoteSessionFactsDurable } from "../vendor/magic-context/packages/plugin/src/features/magic-context/memory/promotion.ts";
import { getMemoryCount } from "../vendor/magic-context/packages/plugin/src/features/magic-context/memory/storage-memory.ts";
import { searchMemoriesFTS } from "../vendor/magic-context/packages/plugin/src/features/magic-context/memory/storage-memory-fts.ts";
import { runMigrations } from "../vendor/magic-context/packages/plugin/src/features/magic-context/migrations.ts";
import {
  closeDatabase,
  getActiveTagsBySession,
  insertTag,
  markProtectedTailPolicyV3Seeded,
  openDatabase,
} from "../vendor/magic-context/packages/plugin/src/features/magic-context/storage.ts";
import { initializeDatabase } from "../vendor/magic-context/packages/plugin/src/features/magic-context/storage-db.ts";
import {
  BLOCK_UNTIL_DONE_PERCENTAGE,
  MIN_HISTORIAN_FOLD_TOKENS,
  checkCompartmentTrigger,
} from "../vendor/magic-context/packages/plugin/src/hooks/magic-context/compartment-trigger.ts";
import { withRawMessageProvider } from "../vendor/magic-context/packages/plugin/src/hooks/magic-context/read-session-chunk.ts";
import type { RawMessage } from "../vendor/magic-context/packages/plugin/src/hooks/magic-context/read-session-raw.ts";
import {
  buildSupersessionReclaimOps,
  recentSupersessionOwnerMessageIds,
} from "../vendor/magic-context/packages/plugin/src/hooks/magic-context/supersession-reclaim.ts";
import type { TagTarget } from "../vendor/magic-context/packages/plugin/src/hooks/magic-context/tag-messages.ts";
import { Database } from "../vendor/magic-context/packages/plugin/src/shared/sqlite.ts";
import { closeQuietly } from "../vendor/magic-context/packages/plugin/src/shared/sqlite-helpers.ts";

const DEFAULT_RUN_DIR =
  ".live-runs/game-ladder/2026-11-24T09-55-06-982Z-multiday_routine";

function parseCliArgs(argv: readonly string[]) {
  let runDir = DEFAULT_RUN_DIR;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run-dir" && i + 1 < argv.length) {
      runDir = argv[i + 1]!;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    }
  }
  return { runDir: resolve(runDir), json };
}

function findNewestMatchingFile(
  dir: string,
  predicate: (name: string) => boolean,
): string | null {
  if (!existsSync(dir)) return null;
  const matches: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && predicate(entry.name)) {
        const st = statSync(fullPath);
        matches.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(dir);
  matches.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs);
  return matches[0]?.path ?? null;
}

interface ParsedSessionEntry {
  type?: string;
  id?: string;
  tokensBefore?: number;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    timestamp?: number;
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

function makeScratchCopy(srcDbPath: string, tempRoot: string): string {
  const dataDir = join(tempRoot, "data", "cortexkit", "magic-context");
  mkdirSync(dataDir, { recursive: true });
  const dstDbPath = join(dataDir, "context.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${srcDbPath}${suffix}`;
    if (existsSync(candidate)) {
      copyFileSync(candidate, `${dstDbPath}${suffix}`);
    }
  }
  return dstDbPath;
}

function makeRawTextMessage(
  ordinal: number,
  id: string,
  role: "user" | "assistant",
  text: string,
): RawMessage {
  return {
    ordinal,
    id,
    role,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    parts: [{ type: "text", text }],
  };
}

async function runOfflineVerification() {
  const { runDir, json } = parseCliArgs(process.argv.slice(2));
  const srcDbPath = findNewestMatchingFile(runDir, (n) => n === "context.db");
  const sessionJsonlPath = findNewestMatchingFile(
    join(runDir, "runtime-root"),
    (n) => n.endsWith(".jsonl") && n !== "environment-facts.jsonl",
  );

  if (!srcDbPath || !sessionJsonlPath) {
    const missing = {
      status: "not_measured",
      reason: "missing_archived_run_artifacts",
      runDir,
      srcDbPath,
      sessionJsonlPath,
    };
    console.error(JSON.stringify(missing, null, 2));
    process.exitCode = 1;
    return;
  }

  const lines = readFileSync(sessionJsonlPath, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ParsedSessionEntry);
  const compactions = lines.filter((l) => l.type === "compaction");
  const userEntries = lines.filter(
    (l) => l.type === "message" && l.message?.role === "user",
  );
  const planWorkResults = lines.filter(
    (l) =>
      l.type === "message" &&
      l.message?.role === "toolResult" &&
      l.message.toolName === "stardew_plan_work",
  );
  const observeResults = lines.filter(
    (l) =>
      l.type === "message" &&
      l.message?.role === "toolResult" &&
      l.message.toolName === "stardew_observe",
  );

  const sessionMatch = /_([0-9a-f-]+)\.jsonl$/i.exec(sessionJsonlPath);
  const historicalSessionId = sessionMatch?.[1] ?? "";
  assert.ok(historicalSessionId.length > 0, "expected session id in filename");

  const tempRoot = resolve(".tmp", `airp-offline-verify-${process.pid}`);
  mkdirSync(tempRoot, { recursive: true });
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;

  let copiedDb: Database | null = null;
  let isolatedTriggerDb: Database | null = null;
  let reflectDb: Database | null = null;

  try {
    const copiedDbPath = makeScratchCopy(srcDbPath, tempRoot);
    copiedDb = new Database(copiedDbPath);
    copiedDb.exec("PRAGMA busy_timeout = 5000");

    const preChapters = (
      copiedDb.prepare("SELECT count(*) AS n FROM chapters").get() as { n: number }
    ).n;
    const preCompartments = (
      copiedDb.prepare("SELECT count(*) AS n FROM compartments").get() as { n: number }
    ).n;
    const preMemories = (
      copiedDb.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }
    ).n;
    const historicalProject =
      (
        copiedDb
          .prepare(
            "SELECT cached_m0_project_identity AS p FROM session_meta WHERE cached_m0_project_identity IS NOT NULL LIMIT 1",
          )
          .get() as { p?: string } | null
      )?.p ?? "gamebuddy:offline-verify";

    // --- WP-A: Tool Domain & Host Archive Descriptions ---
    const ctxMemory = createCtxMemoryTool({
      db: copiedDb,
      memoryEnabled: true,
      embeddingEnabled: false,
      memoryDomain: "ongoing-interaction",
    });
    const ctxMemoryList = createCtxMemoryListTool({
      db: copiedDb,
      memoryEnabled: true,
      embeddingEnabled: false,
      memoryDomain: "ongoing-interaction",
    });
    const ctxSearch = createCtxSearchTool({
      db: copiedDb,
      memoryEnabled: true,
      embeddingEnabled: false,
      gitCommitsEnabled: true,
      memoryDomain: "ongoing-interaction",
    });
    const memorySchema = JSON.stringify(ctxMemory.parameters.properties.category);
    const listSchema = JSON.stringify(ctxMemoryList.parameters.properties.category);
    const searchSchema = JSON.stringify(ctxSearch.parameters.properties.sources);
    assert.ok(memorySchema.includes("SEMANTIC_MEMORY"));
    assert.ok(memorySchema.includes("INTERACTION_EPISODE"));
    assert.equal(memorySchema.includes("PROJECT_RULES"), false);
    assert.equal(listSchema.includes("PROJECT_RULES"), false);
    assert.equal(searchSchema.includes("git_commit"), false);
    for (const [toolName, meta] of Object.entries(COMPANION_ARCHIVE_TOOL_DESCRIPTIONS)) {
      assert.doesNotMatch(
        meta.description,
        /\bOpenCode\b|\bGitHub\b|\bgit_commit\b/i,
        `coding term leaked in ${toolName}`,
      );
    }

    // --- WP-C (Migration): v10_003 on real historical context.db ---
    runMigrations(copiedDb);
    const postChapters = (
      copiedDb.prepare("SELECT count(*) AS n FROM chapters").get() as { n: number }
    ).n;
    const postCompartments = (
      copiedDb.prepare("SELECT count(*) AS n FROM compartments").get() as { n: number }
    ).n;
    assert.equal(postChapters, preChapters, "chapters count must remain intact after v10_003");
    assert.equal(postCompartments, preCompartments);
    const hasCjkTable = Boolean(
      copiedDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_cjk_fts'")
        .get(),
    );
    assert.equal(hasCjkTable, true, "v10_003 must create memories_cjk_fts");

    // --- WP-B: Micro-fold floor & Natural Chinese + Historical Receipt Admission Replay ---
    const historicalMicroFolds = compactions.filter(
      (c) => typeof c.tokensBefore === "number" && c.tokensBefore <= MIN_HISTORIAN_FOLD_TOKENS,
    ).length;

    const triggerRoot = join(tempRoot, "trigger-check");
    mkdirSync(triggerRoot, { recursive: true });
    process.env.XDG_DATA_HOME = triggerRoot;
    delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    isolatedTriggerDb = openDatabase() as Database;
    const triggerSes = "offline-micro-fold";
    markProtectedTailPolicyV3Seeded(isolatedTriggerDb, triggerSes, 1);
    const microMsgs: RawMessage[] = [
      makeRawTextMessage(1, "mm-1", "user", "hi"),
      makeRawTextMessage(2, "mm-2", "assistant", "ok"),
      makeRawTextMessage(3, "mm-3", "user", "tail prompt ".repeat(2_000)),
      makeRawTextMessage(4, "mm-4", "assistant", "tail reply ".repeat(2_000)),
    ];
    for (const msg of microMsgs) {
      const tok = msg.ordinal <= 2 ? 24 : 8_000;
      insertTag(
        isolatedTriggerDb,
        triggerSes,
        msg.id,
        "message",
        tok,
        msg.ordinal,
        0,
        null,
        0,
        null,
        null,
        { tokenCount: tok, inputTokenCount: 0, reasoningTokenCount: 0 },
      );
    }
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let skipAt85 = false;
    let fireAt96Emergency = false;
    try {
      withRawMessageProvider(triggerSes, { readMessages: () => microMsgs }, () => {
        const res85 = checkCompartmentTrigger(
          isolatedTriggerDb!,
          triggerSes,
          { sessionId: triggerSes, compartmentInProgress: false, lastContextPercentage: 84 } as never,
          { percentage: 85, inputTokens: 17_000 },
          84,
          65,
          5_000,
          undefined,
          undefined,
          undefined,
          20_000,
        );
        skipAt85 = res85.shouldFire === false;

        const res96 = checkCompartmentTrigger(
          isolatedTriggerDb!,
          triggerSes,
          { sessionId: triggerSes, compartmentInProgress: false, lastContextPercentage: 95 } as never,
          { percentage: BLOCK_UNTIL_DONE_PERCENTAGE + 1, inputTokens: 19_200 },
          95,
          65,
          5_000,
          undefined,
          undefined,
          undefined,
          20_000,
        );
        fireAt96Emergency = res96.shouldFire === true;
      });
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
    }
    assert.equal(skipAt85, true, "must skip <250 token micro-fold below emergency pressure");
    assert.equal(fireAt96Emergency, true, "must not deadlock at >=95% emergency pressure");

    const sampleObserveText = extractText(observeResults[0]?.message?.content).slice(0, 140);
    const samplePlanWorkText = extractText(planWorkResults[0]?.message?.content).slice(0, 140);
    const validNaturalFacts = [
      {
        category: "SEMANTIC_MEMORY",
        content: "你喜欢每天早上先检查北边蓝箱子的库存位置，再去给草莓浇水。",
      },
      {
        category: "SEMANTIC_MEMORY",
        content: "你习惯等这批土豆收获后，我们再一起规划下矿带的补给。",
      },
      {
        category: "INTERACTION_EPISODE",
        content: "今天我们约定明早去森林看看树林里那块空地再决定工作计划。",
      },
    ];
    const noisyMachineFacts = [
      {
        category: "SEMANTIC_MEMORY",
        content: samplePlanWorkText || "stardew_plan_work tool_call settled action_receipt",
      },
      {
        category: "INTERACTION_EPISODE",
        content: `tool_result snapshot revision=42: ${sampleObserveText}`,
      },
      {
        category: "PROJECT_RULES",
        content: "Always run bun test in vendor/magic-context before commits.",
      },
    ];

    const beforeMemCount = getMemoryCount(copiedDb, historicalProject);
    const naturalPromote = promoteSessionFactsDurable(
      copiedDb,
      historicalSessionId,
      historicalProject,
      validNaturalFacts,
      "ongoing-interaction",
    );
    const noisePromote = promoteSessionFactsDurable(
      copiedDb,
      historicalSessionId,
      historicalProject,
      noisyMachineFacts,
      "ongoing-interaction",
    );
    const afterMemCount = getMemoryCount(copiedDb, historicalProject);
    assert.equal(naturalPromote.factsPromoted, validNaturalFacts.length);
    assert.equal(noisePromote.factsPromoted, 0, "machine receipts & coding rules must be rejected");
    assert.equal(afterMemCount - beforeMemCount, validNaturalFacts.length);

    // --- WP-C (Inline Recall Gating across all real historical user turns) ---
    const directHits = searchMemoriesFTS(
      copiedDb,
      historicalProject,
      "北边蓝箱子的草莓库存怎么样",
      5,
    );
    assert.ok(directHits.length >= 1, "CJK bigram FTS5 must recall promoted Chinese memory");

    const replayedUserMessages = userEntries.map((entry, idx) => ({
      role: "user" as const,
      id: entry.id ?? `real-user-${idx}`,
      content: [{ type: "text" as const, text: extractText(entry.message?.content) }],
      timestamp: entry.message?.timestamp ?? 1_700_000_000_000 + idx,
    }));
    const mechanicalReplayed = await Promise.all(
      replayedUserMessages.map(async (msg, idx) => {
        const cloned = [{ ...msg, content: [...msg.content] }];
        const ses = `offline-replay-real-${idx}`;
        clearAutoSearchForPiSession(ses);
        await runAutoSearchHintForPi({
          sessionId: ses,
          db: copiedDb!,
          messages: cloned as never,
          entryIds: [msg.id],
          options: {
            enabled: true,
            scoreThreshold: 0.55,
            minPromptChars: 12,
            projectPath: historicalProject,
            memoryEnabled: true,
            memoryDomain: "ongoing-interaction",
          },
        });
        const rendered = extractText(cloned[0]?.content);
        return {
          hasRecall: rendered.includes("<memory-recall>"),
          rawPreserved: rendered.startsWith(extractText(msg.content).slice(0, 40)),
        };
      }),
    );

    const dialogueProbe = [
      {
        role: "user" as const,
        id: "offline-dialogue-probe-1",
        content: [
          {
            type: "text" as const,
            text: "<world-state>Day 6 06:00</world-state>\n我们昨天约定土豆收获后怎么规划下矿？另外北边蓝箱子在哪？",
          },
        ],
        timestamp: 1_700_000_999_000,
      },
    ];
    clearAutoSearchForPiSession("offline-dialogue-probe-ses");
    await runAutoSearchHintForPi({
      sessionId: "offline-dialogue-probe-ses",
      db: copiedDb,
      messages: dialogueProbe as never,
      entryIds: ["offline-dialogue-probe-1"],
      options: {
        enabled: true,
        scoreThreshold: 0.55,
        minPromptChars: 12,
        projectPath: historicalProject,
        memoryEnabled: true,
        memoryDomain: "ongoing-interaction",
      },
    });
    const probeRendered = extractText(dialogueProbe[0]?.content);
    assert.ok(probeRendered.includes("<memory-recall>"), "dialogue turn must inline <memory-recall>");
    assert.ok(probeRendered.startsWith("<world-state>Day 6 06:00</world-state>\n"), "must not alter world-state header");
    assert.ok(probeRendered.endsWith("</memory-recall>"), "must append strictly at user tail");

    // --- WP-D: Reflect short-session fallback vs pure mechanical session ---
    reflectDb = new Database(":memory:");
    initializeDatabase(reflectDb);
    runMigrations(reflectDb);
    reflectDb
      .prepare("INSERT INTO session_meta (session_id, last_response_time, cached_m0_project_identity) VALUES (?, ?, ?)")
      .run("short-mech", Date.now(), historicalProject);
    reflectDb
      .prepare("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)")
      .run("short-mech", "1", "sm-1", "user", extractText(userEntries[0]?.message?.content));
    const mechReflectRows = readReflectWindow(reflectDb, historicalProject, 0);

    reflectDb
      .prepare("INSERT INTO session_meta (session_id, last_response_time, cached_m0_project_identity) VALUES (?, ?, ?)")
      .run("short-chat", Date.now() + 10, historicalProject);
    reflectDb
      .prepare("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)")
      .run("short-chat", "1", "sc-1", "user", "<world-state>Day 1</world-state>\n今天真累，明早别忘了先收防风草。");
    const chatReflectRows = readReflectWindow(reflectDb, historicalProject, 0);
    assert.ok(chatReflectRows.length >= 1, "short dialogue fallback must feed reflect");

    // --- WP-E: Protected-tools supersession reclaim on real active tags ---
    const activeTags = getActiveTagsBySession(copiedDb, historicalSessionId);
    const activePlanWorkTags = activeTags.filter(
      (t) => t.type === "tool" && t.toolName === "stardew_plan_work",
    );
    const recentIds = recentSupersessionOwnerMessageIds(copiedDb, historicalSessionId);
    const targets = new Map<number, TagTarget>();
    for (const tag of activeTags) {
      if (tag.type !== "tool") continue;
      targets.set(tag.tagNumber, {
        canDrop: () => true,
        setContent: () => true,
        drop: () => "removed",
      });
    }
    const baselineReclaimOps = buildSupersessionReclaimOps({
      db: copiedDb,
      sessionId: historicalSessionId,
      targets,
      recentMessageIds: recentIds,
      protectedTools: {},
    });
    const reclaimOps = buildSupersessionReclaimOps({
      db: copiedDb,
      sessionId: historicalSessionId,
      targets,
      recentMessageIds: recentIds,
      protectedTools: GAMEBUDDY_PROTECTED_TOOLS,
    });
    const planWorkDrops = reclaimOps.filter((op) =>
      activePlanWorkTags.some((t) => t.tagNumber === op.tagId),
    );
    const newestPlanWorkTag = activePlanWorkTags.reduce<number>(
      (max, t) => (t.tagNumber > max ? t.tagNumber : max),
      -1,
    );
    assert.equal(
      reclaimOps.some((op) => op.tagId === newestPlanWorkTag),
      false,
      "newest N=1 stardew_plan_work frame must stay protected",
    );
    assert.ok(planWorkDrops.length > 0, "older stardew_plan_work frames outside recent window must be reclaimed");
    const reclaimedPlanWorkBytes = planWorkDrops.reduce((sum, op) => {
      const match = activePlanWorkTags.find((t) => t.tagNumber === op.tagId);
      return sum + (match?.byteSize ?? 0);
    }, 0);
    const activeProtectedBytesTotal = activePlanWorkTags.reduce((s, t) => s + (t.byteSize ?? 0), 0);

    const summary = {
      status: "passed",
      runDir,
      sessionJsonl: sessionJsonlPath,
      historicalBaseline: {
        preChapters,
        preCompartments,
        preMemories,
        historicalMicroFoldsLeq250: historicalMicroFolds,
        totalCompactionsInSession: compactions.length,
        activePlanWorkTagsBeforeReclaim: activePlanWorkTags.length,
        activePlanWorkBytesBeforeReclaim: activeProtectedBytesTotal,
        medianPlanWorkResultBytes: planWorkResults.length
          ? Math.round(
              planWorkResults.reduce(
                (s, r) => s + Buffer.byteLength(extractText(r.message?.content), "utf8"),
                0,
              ) / planWorkResults.length,
            )
          : 0,
      },
      checks: {
        wpA: {
          examinedArchiveDescriptions: Object.keys(COMPANION_ARCHIVE_TOOL_DESCRIPTIONS).length,
          ongoingCategoryEnumClean: true,
          gitCommitRemovedFromSearch: true,
        },
        wpB: {
          microFoldSkippedBelow250At85Pct: skipAt85,
          emergencyFiredAt96Pct: fireAt96Emergency,
          naturalChineseFactsPromoted: `${naturalPromote.factsPromoted}/${validNaturalFacts.length}`,
          machineReceiptsRejected: `${noisyMachineFacts.length - noisePromote.factsPromoted}/${noisyMachineFacts.length}`,
        },
        wpC: {
          v10_003MigratedChaptersIntact: postChapters,
          cjkFtsDirectHits: directHits.length,
          realUserTurnsExamined: replayedUserMessages.length,
          mechanicalTurnsRecalledCount: mechanicalReplayed.filter((r) => r.hasRecall).length,
          allWorldStateHeadersPreserved: mechanicalReplayed.every((r) => r.rawPreserved),
          dialogueProbeInlinedRecall: true,
        },
        wpD: {
          pureMechanicalShortSessionRows: mechReflectRows.length,
          shortDialogueFallbackRows: chatReflectRows.length,
        },
        wpE: {
          recentProtectedWindowOwners: recentIds.size,
          baselineSupersessionDropOpsWithoutProtectedTools: baselineReclaimOps.length,
          airpSupersessionDropOps: reclaimOps.length,
          reclaimedPlanWorkFrames: planWorkDrops.length,
          reclaimedPlanWorkBytes,
          newestPlanWorkTagPreserved: newestPlanWorkTag,
        },
      },
    };

    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("Magic Context AIRP 0-LLM Offline Verification: PASSED");
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    closeDatabase();
    if (copiedDb) closeQuietly(copiedDb);
    if (isolatedTriggerDb) closeQuietly(isolatedTriggerDb);
    if (reflectDb) closeQuietly(reflectDb);
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = prevStorage;
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

await runOfflineVerification();
