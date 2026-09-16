#!/usr/bin/env node
/**
 * Chat Conversational Quality Gate (多轮会话与记忆测试门禁)
 *
 * Evaluates four core dimensions of multi-turn conversational quality and memory integrity:
 * 1. Prefix Bit-Stability Gate (M0 冷区前缀缓存比特级稳定性)
 * 2. Semantic Memory Retention Gate (长程延迟针式检索留存)
 * 3. Memory Superseded Anti-Hallucination Gate (记忆覆写与防旧设定幻觉)
 * 4. Lorebook Trigger Precision Gate (世界书/易变条目触发与退场精准度)
 *
 * Conforms to AGENTS.md: pure, deterministic, modular, fail-closed.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const CHAT_CONVERSATIONAL_GATE_SCHEMA = "chat_conversational_quality_gate/v1";
export const GATE_ID = "chat-conversational-quality-gate";

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function normalizeText(text) {
  if (typeof text !== "string") return "";
  return text.normalize("NFC").toLowerCase().trim();
}

/**
 * Finds the first character divergence between two strings for exact diagnostic reporting.
 */
export function computeStringDivergence(strA, strB) {
  const minLen = Math.min(strA.length, strB.length);
  for (let i = 0; i < minLen; i++) {
    if (strA[i] !== strB[i]) {
      const line = strA.slice(0, i).split("\n").length;
      const lastNewLine = strA.lastIndexOf("\n", i);
      const col = lastNewLine === -1 ? i + 1 : i - lastNewLine;
      const snippetStart = Math.max(0, i - 20);
      const snippetEnd = Math.min(minLen, i + 20);
      return {
        offset: i,
        line,
        col,
        charExpected: JSON.stringify(strA[i]),
        charActual: JSON.stringify(strB[i]),
        expectedSnippet: strA.slice(snippetStart, snippetEnd),
        actualSnippet: strB.slice(snippetStart, snippetEnd),
        lengthA: strA.length,
        lengthB: strB.length,
      };
    }
  }
  if (strA.length !== strB.length) {
    return {
      offset: minLen,
      line: strA.slice(0, minLen).split("\n").length,
      col: 1,
      charExpected: strA.length > minLen ? JSON.stringify(strA[minLen]) : "<EOF>",
      charActual: strB.length > minLen ? JSON.stringify(strB[minLen]) : "<EOF>",
      expectedSnippet: strA.slice(Math.max(0, minLen - 20), minLen + 20),
      actualSnippet: strB.slice(Math.max(0, minLen - 20), minLen + 20),
      lengthA: strA.length,
      lengthB: strB.length,
    };
  }
  return null;
}

/**
 * Extracts the M0 stable context XML block from a turn representation.
 */
export function extractM0StableContext(turn) {
  if (!turn || typeof turn !== "object") return undefined;
  if (typeof turn.contextComponents?.m0StableContextXml === "string") {
    return turn.contextComponents.m0StableContextXml;
  }
  if (typeof turn.m0StableContextXml === "string") {
    return turn.m0StableContextXml;
  }
  const dump =
    typeof turn.promptDump === "string"
      ? turn.promptDump
      : typeof turn.systemPrompt === "string"
        ? turn.systemPrompt
        : "";
  if (!dump) return undefined;

  const matchAuthored = dump.match(/<gamebuddy-authored-context[\s\S]*?<\/gamebuddy-authored-context>/);
  if (matchAuthored) return matchAuthored[0];

  const matchStable = dump.match(/<gamebuddy-stable-context[\s\S]*?<\/gamebuddy-stable-context>/);
  if (matchStable) return matchStable[0];

  return undefined;
}

/**
 * Extracts the M1 volatile context XML block from a turn representation.
 */
export function extractM1VolatileContext(turn) {
  if (!turn || typeof turn !== "object") return undefined;
  if (typeof turn.contextComponents?.m1VolatileContextXml === "string") {
    return turn.contextComponents.m1VolatileContextXml;
  }
  if (typeof turn.m1VolatileContextXml === "string") {
    return turn.m1VolatileContextXml;
  }
  const dump = typeof turn.promptDump === "string" ? turn.promptDump : "";
  if (!dump) return undefined;

  const matchVolatile = dump.match(/<gamebuddy-volatile-context[\s\S]*?<\/gamebuddy-volatile-context>/);
  if (matchVolatile) return matchVolatile[0];

  return undefined;
}

/**
 * Extracts active volatile source IDs from a turn's M1 XML or annotations.
 */
export function extractVolatileSourceIds(turn) {
  if (Array.isArray(turn.activeVolatileSources)) {
    return [...turn.activeVolatileSources];
  }
  const m1Xml = extractM1VolatileContext(turn);
  if (!m1Xml) return [];

  const matches = m1Xml.matchAll(/<gamebuddy-volatile-source\s+[^>]*source-id="([^"]+)"/g);
  const ids = [];
  for (const m of matches) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * Checks if target text contains keywords.
 */
export function checkKeywordHits(text, keywords) {
  const norm = normalizeText(text);
  const hits = [];
  const misses = [];
  for (const kw of keywords) {
    const normKw = normalizeText(kw);
    if (normKw.length > 0 && norm.includes(normKw)) {
      hits.push(kw);
    } else {
      misses.push(kw);
    }
  }
  return { hits, misses, hitRate: keywords.length > 0 ? hits.length / keywords.length : 1 };
}

/**
 * Resolves memory rows either from an open SQLite DatabaseSync instance,
 * a database file path, or the transcript's embedded dbSnapshot.
 */
export function resolveDatabaseMemories({ db, dbPath, transcript } = {}) {
  if (db && typeof db.prepare === "function") {
    const stmt = db.prepare(
      "SELECT id, category, content, status, superseded_by_memory_id, created_at, updated_at FROM memories ORDER BY id ASC",
    );
    return stmt.all();
  }
  if (typeof dbPath === "string" && dbPath.length > 0) {
    let ownedDb;
    try {
      ownedDb = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = ownedDb.prepare(
        "SELECT id, category, content, status, superseded_by_memory_id, created_at, updated_at FROM memories ORDER BY id ASC",
      );
      return stmt.all();
    } finally {
      if (ownedDb) ownedDb.close();
    }
  }
  if (Array.isArray(transcript?.dbSnapshot?.memories)) {
    return transcript.dbSnapshot.memories;
  }
  return undefined;
}

// ==============================================================================
// 维度 1：M0 前缀缓存比特级稳定性门禁 (Prefix Bit-Stability Gate)
// ==============================================================================
export function evaluatePrefixBitStability(transcript, _options = {}) {
  const turns = Array.isArray(transcript?.turns) ? transcript.turns : [];
  if (turns.length === 0) {
    return {
      dimension: "prefix_bit_stability",
      verdict: "blocked",
      reason: "transcript_contains_no_turns",
      violations: [{ code: "no_turns", message: "Transcript has no turns to evaluate" }],
    };
  }

  let baselineXml;
  let baselineSha;
  let baselineTurn;
  const violations = [];
  let evaluatedTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnIndex = turn.turnIndex ?? i + 1;
    const m0 = extractM0StableContext(turn);

    if (m0 === undefined || m0.trim().length === 0) {
      violations.push({
        turnIndex,
        code: "m0_missing_in_turn",
        message: `Turn ${turnIndex} does not contain an M0 stable context block`,
      });
      continue;
    }

    evaluatedTurns++;

    // 1. Check for CRLF injection (must be pure LF to guarantee cross-platform prefix cache stability)
    if (m0.includes("\r")) {
      violations.push({
        turnIndex,
        code: "m0_carriage_return_detected",
        message: `Turn ${turnIndex} M0 stable context contains Windows carriage returns (\\r\\n), violating byte stability`,
      });
    }

    // 2. Check for volatile entry contamination inside M0
    if (m0.includes("<gamebuddy-volatile-source") || m0.includes("<gamebuddy-volatile-context")) {
      violations.push({
        turnIndex,
        code: "m0_volatile_pollution",
        message: `Turn ${turnIndex} M0 stable context is polluted with volatile source tags`,
      });
    }

    const currentSha = sha256(m0);

    if (baselineXml === undefined) {
      baselineXml = m0;
      baselineSha = currentSha;
      baselineTurn = turnIndex;
    } else if (currentSha !== baselineSha) {
      const divergence = computeStringDivergence(baselineXml, m0);
      violations.push({
        turnIndex,
        code: "m0_hash_divergence",
        message: `Turn ${turnIndex} M0 sha256 (${currentSha}) diverges from Turn ${baselineTurn} baseline (${baselineSha})`,
        divergence,
      });
    }
  }

  const passed = violations.length === 0 && evaluatedTurns > 0;
  return {
    dimension: "prefix_bit_stability",
    verdict: passed ? "passed" : "failed",
    baselineSha256: baselineSha ?? null,
    totalTurns: turns.length,
    evaluatedTurns,
    violations,
  };
}

// ==============================================================================
// 维度 2：长程延迟针式检索留存门禁 (Semantic Memory Retention Gate)
// ==============================================================================
export function evaluateSemanticMemoryRetention(transcript, options = {}) {
  const turns = Array.isArray(transcript?.turns) ? transcript.turns : [];
  const needles = [];

  // Collect needles from top-level expectations or per-turn expectations
  if (Array.isArray(transcript?.expectations?.needleFacts)) {
    needles.push(...transcript.expectations.needleFacts);
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnIndex = turn.turnIndex ?? i + 1;
    if (turn.expectations?.needleFact) {
      needles.push({
        probeTurn: turnIndex,
        ...turn.expectations.needleFact,
      });
    }
    if (turn.annotations?.needleProbe) {
      needles.push({
        probeTurn: turnIndex,
        ...turn.annotations.needleProbe,
      });
    }
  }

  if (needles.length === 0) {
    // If no needle test is registered, dimension is not_applicable
    return {
      dimension: "semantic_memory_retention",
      verdict: "not_applicable",
      reason: "no_needle_tests_specified",
      probesEvaluated: 0,
      violations: [],
    };
  }

  const violations = [];
  let passedProbes = 0;

  for (const needle of needles) {
    const probeTurnIndex = needle.probeTurn;
    const probeTurn = turns.find((t, idx) => (t.turnIndex ?? idx + 1) === probeTurnIndex);
    if (!probeTurn) {
      violations.push({
        needleId: needle.needleId ?? "unknown",
        probeTurn: probeTurnIndex,
        code: "needle_probe_turn_not_found",
        message: `Probe turn ${probeTurnIndex} specified for needle '${needle.needleId}' does not exist in transcript`,
      });
      continue;
    }

    const response = probeTurn.modelResponse ?? "";
    const requiredKeywords = Array.isArray(needle.requiredKeywords) ? needle.requiredKeywords : [];
    const forbiddenKeywords = Array.isArray(needle.forbiddenKeywords) ? needle.forbiddenKeywords : [];

    const keywordCheck = checkKeywordHits(response, requiredKeywords);
    const minHitRate = typeof needle.minKeywordHitRate === "number" ? needle.minKeywordHitRate : 1.0;

    let probeFailed = false;

    if (keywordCheck.hitRate < minHitRate) {
      probeFailed = true;
      violations.push({
        needleId: needle.needleId ?? "unknown",
        probeTurn: probeTurnIndex,
        code: "needle_semantic_recall_failed",
        message: `Model response at turn ${probeTurnIndex} missed required needle keywords: [${keywordCheck.misses.join(", ")}] (hit rate: ${Math.round(keywordCheck.hitRate * 100)}% < ${Math.round(minHitRate * 100)}%)`,
        hits: keywordCheck.hits,
        misses: keywordCheck.misses,
      });
    }

    if (forbiddenKeywords.length > 0) {
      const forbiddenCheck = checkKeywordHits(response, forbiddenKeywords);
      if (forbiddenCheck.hits.length > 0) {
        probeFailed = true;
        violations.push({
          needleId: needle.needleId ?? "unknown",
          probeTurn: probeTurnIndex,
          code: "needle_distractor_confusion",
          message: `Model response at turn ${probeTurnIndex} hallucinated forbidden/distractor keywords: [${forbiddenCheck.hits.join(", ")}]`,
          forbiddenHits: forbiddenCheck.hits,
        });
      }
    }

    // Check context retrieval if activeMemories or promptDump is available
    if (needle.verifyContextRetrieval === true || options.requireContextRetrieval === true) {
      const dump = probeTurn.promptDump ?? "";
      const activeMemories = Array.isArray(probeTurn.contextComponents?.activeMemories)
        ? probeTurn.contextComponents.activeMemories.join(" ")
        : "";
      const searchSpace = `${dump} ${activeMemories}`;
      const contextHits = checkKeywordHits(searchSpace, requiredKeywords);
      if (contextHits.hitRate < minHitRate) {
        violations.push({
          needleId: needle.needleId ?? "unknown",
          probeTurn: probeTurnIndex,
          code: "needle_not_retrieved_into_context",
          message: `Memory retrieval failed to surface needle into prompt context at turn ${probeTurnIndex}`,
        });
        probeFailed = true;
      }
    }

    if (!probeFailed) {
      passedProbes++;
    }
  }

  const passed = violations.length === 0;
  return {
    dimension: "semantic_memory_retention",
    verdict: passed ? "passed" : "failed",
    probesEvaluated: needles.length,
    passedProbes,
    recallRate: needles.length > 0 ? passedProbes / needles.length : 1.0,
    violations,
  };
}

// ==============================================================================
// 维度 3：记忆覆写与防旧设定幻觉门禁 (Memory Superseded Anti-Hallucination Gate)
// ==============================================================================
export function evaluateMemorySupersededAntiHallucination(transcript, dbMemories, options = {}) {
  const turns = Array.isArray(transcript?.turns) ? transcript.turns : [];
  const supersedeTests = [];

  if (Array.isArray(transcript?.expectations?.memorySupersedes)) {
    supersedeTests.push(...transcript.expectations.memorySupersedes);
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnIndex = turn.turnIndex ?? i + 1;
    if (turn.expectations?.memorySupersede) {
      supersedeTests.push({
        probeTurn: turnIndex,
        ...turn.expectations.memorySupersede,
      });
    }
  }

  if (supersedeTests.length === 0) {
    return {
      dimension: "memory_superseded_anti_hallucination",
      verdict: "not_applicable",
      reason: "no_supersede_tests_specified",
      testsEvaluated: 0,
      violations: [],
    };
  }

  const violations = [];
  let dialoguePassedCount = 0;
  let dataLevelPassedCount = 0;

  for (const test of supersedeTests) {
    const probeTurnIndex = test.probeTurn;
    const probeTurn = turns.find((t, idx) => (t.turnIndex ?? idx + 1) === probeTurnIndex);
    if (!probeTurn) {
      violations.push({
        testId: test.testId ?? "unknown",
        probeTurn: probeTurnIndex,
        code: "supersede_probe_turn_not_found",
        message: `Probe turn ${probeTurnIndex} not found in transcript`,
      });
      continue;
    }

    const response = probeTurn.modelResponse ?? "";
    const requiredNewKeywords = Array.isArray(test.requiredNewKeywords) ? test.requiredNewKeywords : [];
    const forbiddenOldKeywords = Array.isArray(test.forbiddenOldKeywords) ? test.forbiddenOldKeywords : [];

    let testDialogueFailed = false;

    // Check (a) Dialogue level: must adopt new fact
    const newCheck = checkKeywordHits(response, requiredNewKeywords);
    if (newCheck.hitRate < 1.0) {
      testDialogueFailed = true;
      violations.push({
        testId: test.testId ?? "unknown",
        probeTurn: probeTurnIndex,
        code: "superseded_new_fact_missing",
        message: `Model response at turn ${probeTurnIndex} failed to adopt new superseded fact keywords: [${newCheck.misses.join(", ")}]`,
        misses: newCheck.misses,
      });
    }

    // Check (a) Dialogue level: strictly forbid obsolete old fact
    const oldCheck = checkKeywordHits(response, forbiddenOldKeywords);
    if (oldCheck.hits.length > 0) {
      testDialogueFailed = true;
      violations.push({
        testId: test.testId ?? "unknown",
        probeTurn: probeTurnIndex,
        code: "superseded_old_fact_hallucinated",
        message: `Model response at turn ${probeTurnIndex} hallucinated deprecated old fact keywords: [${oldCheck.hits.join(", ")}]`,
        forbiddenHits: oldCheck.hits,
      });
    }

    if (!testDialogueFailed) {
      dialoguePassedCount++;
    }

    // Check (b) Context level: old fact must not leak into active memories in prompt
    const promptDump = probeTurn.promptDump ?? "";
    const activeMemories = Array.isArray(probeTurn.contextComponents?.activeMemories)
      ? probeTurn.contextComponents.activeMemories.join(" ")
      : "";
    const promptMemoryArea = `${promptDump} ${activeMemories}`;
    if (forbiddenOldKeywords.length > 0 && promptMemoryArea.length > 0) {
      const leakCheck = checkKeywordHits(promptMemoryArea, forbiddenOldKeywords);
      if (leakCheck.hits.length > 0) {
        violations.push({
          testId: test.testId ?? "unknown",
          probeTurn: probeTurnIndex,
          code: "superseded_memory_leaked_into_context",
          message: `Deprecated old memory leaked into active prompt context at turn ${probeTurnIndex}: [${leakCheck.hits.join(", ")}]`,
        });
      }
    }

    // Check (c) Data level: SQLite / DB snapshot invariants
    if (Array.isArray(dbMemories)) {
      let dataFailed = false;
      const oldFactMatch = test.oldFactContent ?? test.forbiddenOldKeywords?.[0];
      const newFactMatch = test.newFactContent ?? test.requiredNewKeywords?.[0];

      const newRows = dbMemories.filter((m) =>
        newFactMatch
          ? normalizeText(m.content).includes(normalizeText(newFactMatch)) &&
            (m.status === "active" || m.superseded_by_memory_id === null)
          : false,
      );
      const newRowIds = new Set(newRows.map((r) => r.id));
      const oldRows = dbMemories.filter((m) =>
        oldFactMatch ? normalizeText(m.content).includes(normalizeText(oldFactMatch)) && !newRowIds.has(m.id) : false,
      );

      if (oldRows.length === 0) {
        dataFailed = true;
        violations.push({
          testId: test.testId ?? "unknown",
          code: "superseded_old_record_missing_in_db",
          message: `Could not find old memory row matching '${oldFactMatch}' in database`,
        });
      }

      if (newRows.length === 0) {
        dataFailed = true;
        violations.push({
          testId: test.testId ?? "unknown",
          code: "superseded_new_record_missing_in_db",
          message: `Could not find new memory row matching '${newFactMatch}' in database`,
        });
      }

      for (const oldRow of oldRows) {
        // Invariant 1: status must be archived or superseded, NEVER active
        if (oldRow.status === "active") {
          dataFailed = true;
          violations.push({
            testId: test.testId ?? "unknown",
            rowId: oldRow.id,
            code: "superseded_old_record_still_active",
            message: `Old memory row id=${oldRow.id} still has status='active' instead of 'archived' or 'superseded'`,
          });
        }
        // Invariant 2: superseded_by_memory_id must point to the successor new memory
        if (newRows.length > 0) {
          const newRowIds = newRows.map((r) => r.id);
          if (oldRow.superseded_by_memory_id === null || !newRowIds.includes(oldRow.superseded_by_memory_id)) {
            dataFailed = true;
            violations.push({
              testId: test.testId ?? "unknown",
              rowId: oldRow.id,
              code: "superseded_by_id_mismatch",
              message: `Old memory row id=${oldRow.id} superseded_by_memory_id (${oldRow.superseded_by_memory_id}) does not point to new memory ID (${newRowIds.join(", ")})`,
            });
          }
        }
      }

      for (const newRow of newRows) {
        if (newRow.status !== "active") {
          dataFailed = true;
          violations.push({
            testId: test.testId ?? "unknown",
            rowId: newRow.id,
            code: "superseded_new_record_not_active",
            message: `New memory row id=${newRow.id} has status='${newRow.status}' instead of 'active'`,
          });
        }
        if (newRow.superseded_by_memory_id !== null && newRow.superseded_by_memory_id !== undefined) {
          dataFailed = true;
          violations.push({
            testId: test.testId ?? "unknown",
            rowId: newRow.id,
            code: "superseded_new_record_prematurely_superseded",
            message: `New active memory row id=${newRow.id} has non-null superseded_by_memory_id (${newRow.superseded_by_memory_id})`,
          });
        }
      }

      if (!dataFailed) {
        dataLevelPassedCount++;
      }
    } else if (options.requireDatabase === true) {
      violations.push({
        testId: test.testId ?? "unknown",
        code: "database_verification_required_but_unavailable",
        message: "Database verification was required but no DB connection or snapshot was provided",
      });
    }
  }

  const passed = violations.length === 0;
  return {
    dimension: "memory_superseded_anti_hallucination",
    verdict: passed ? "passed" : "failed",
    testsEvaluated: supersedeTests.length,
    dialoguePassed: dialoguePassedCount === supersedeTests.length,
    dataLevelPassed: dbMemories ? dataLevelPassedCount === supersedeTests.length : null,
    violations,
  };
}

// ==============================================================================
// 维度 4：世界书/易变条目触发与退场精准度门禁 (Lorebook Trigger Precision Gate)
// ==============================================================================
export function evaluateLorebookTriggerPrecision(transcript, _options = {}) {
  const turns = Array.isArray(transcript?.turns) ? transcript.turns : [];
  const lorebookRules = [];

  if (Array.isArray(transcript?.expectations?.lorebookTurns)) {
    lorebookRules.push(...transcript.expectations.lorebookTurns);
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnIndex = turn.turnIndex ?? i + 1;
    if (turn.expectations?.lorebook) {
      lorebookRules.push({
        turnIndex,
        ...turn.expectations.lorebook,
      });
    }
  }

  if (lorebookRules.length === 0) {
    return {
      dimension: "lorebook_trigger_precision",
      verdict: "not_applicable",
      reason: "no_lorebook_rules_specified",
      turnsEvaluated: 0,
      violations: [],
    };
  }

  const violations = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const rule of lorebookRules) {
    const turnIndex = rule.turnIndex;
    const turn = turns.find((t, idx) => (t.turnIndex ?? idx + 1) === turnIndex);
    if (!turn) {
      violations.push({
        turnIndex,
        code: "lorebook_turn_not_found",
        message: `Turn ${turnIndex} specified in lorebook expectations does not exist`,
      });
      continue;
    }

    const actualVolatiles = extractVolatileSourceIds(turn);
    const expectedTriggered = Array.isArray(rule.expectedTriggered) ? rule.expectedTriggered : [];
    const expectedEvicted = Array.isArray(rule.expectedEvicted) ? rule.expectedEvicted : [];

    // Check false negatives (expected but missing)
    for (const sourceId of expectedTriggered) {
      if (actualVolatiles.includes(sourceId)) {
        truePositives++;
      } else {
        falseNegatives++;
        violations.push({
          turnIndex,
          sourceId,
          code: "lorebook_trigger_missed",
          message: `Turn ${turnIndex} missed required volatile trigger for '${sourceId}' (False Negative)`,
        });
      }
    }

    // Check false positives (expected to be evicted or absent, but present)
    for (const sourceId of expectedEvicted) {
      if (actualVolatiles.includes(sourceId)) {
        falsePositives++;
        violations.push({
          turnIndex,
          sourceId,
          code: "lorebook_eviction_failed",
          message: `Turn ${turnIndex} failed to evict inactive volatile source '${sourceId}' (False Positive / Stale Leak)`,
        });
      } else {
        trueNegatives++;
      }
    }
  }

  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 1.0;
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 1.0;

  const passed = violations.length === 0;
  return {
    dimension: "lorebook_trigger_precision",
    verdict: passed ? "passed" : "failed",
    turnsEvaluated: lorebookRules.length,
    metrics: {
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives,
      precision,
      recall,
    },
    violations,
  };
}

// ==============================================================================
// 综合 Gate 评测编排器 (Master Quality Gate Runner)
// ==============================================================================
export async function checkChatConversationalQualityGate({
  transcript,
  transcriptPath,
  db,
  dbPath,
  options = {},
} = {}) {
  let loadedTranscript = transcript;
  if (!loadedTranscript && transcriptPath) {
    try {
      const raw = await readFile(resolve(transcriptPath), "utf8");
      loadedTranscript = JSON.parse(raw);
    } catch (error) {
      return {
        schemaVersion: 1,
        gate: CHAT_CONVERSATIONAL_GATE_SCHEMA,
        evaluatedAt: new Date().toISOString(),
        verdict: "blocked",
        reason: `failed_to_load_transcript: ${error instanceof Error ? error.message : String(error)}`,
        dimensions: {},
        violations: [{ code: "transcript_load_error", message: String(error) }],
      };
    }
  }

  if (!loadedTranscript || typeof loadedTranscript !== "object") {
    return {
      schemaVersion: 1,
      gate: CHAT_CONVERSATIONAL_GATE_SCHEMA,
      evaluatedAt: new Date().toISOString(),
      verdict: "blocked",
      reason: "invalid_or_missing_transcript",
      dimensions: {},
      violations: [{ code: "invalid_transcript", message: "Transcript is missing or not a JSON object" }],
    };
  }

  // Resolve DB memories
  let dbMemories;
  try {
    dbMemories = resolveDatabaseMemories({ db, dbPath, transcript: loadedTranscript });
  } catch (dbError) {
    if (options.requireDatabase) {
      return {
        schemaVersion: 1,
        gate: CHAT_CONVERSATIONAL_GATE_SCHEMA,
        evaluatedAt: new Date().toISOString(),
        verdict: "blocked",
        reason: `failed_to_query_database: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        dimensions: {},
        violations: [{ code: "db_query_error", message: String(dbError) }],
      };
    }
  }

  const prefixBitStability = evaluatePrefixBitStability(loadedTranscript, options);
  const semanticMemoryRetention = evaluateSemanticMemoryRetention(loadedTranscript, options);
  const memorySupersededAntiHallucination = evaluateMemorySupersededAntiHallucination(
    loadedTranscript,
    dbMemories,
    options,
  );
  const lorebookTriggerPrecision = evaluateLorebookTriggerPrecision(loadedTranscript, options);

  const dimensions = {
    prefixBitStability,
    semanticMemoryRetention,
    memorySupersededAntiHallucination,
    lorebookTriggerPrecision,
  };

  const allViolations = [
    ...prefixBitStability.violations,
    ...semanticMemoryRetention.violations,
    ...memorySupersededAntiHallucination.violations,
    ...lorebookTriggerPrecision.violations,
  ];

  const dimensionList = Object.values(dimensions);
  const hasFailure = dimensionList.some((d) => d.verdict === "failed");
  const hasBlocked = dimensionList.some((d) => d.verdict === "blocked");

  const verdict = hasBlocked ? "blocked" : hasFailure ? "failed" : "passed";

  return {
    schemaVersion: 1,
    gate: CHAT_CONVERSATIONAL_GATE_SCHEMA,
    evaluatedAt: new Date().toISOString(),
    verdict,
    summary: {
      totalTurns: loadedTranscript.turns?.length ?? 0,
      dimensionsEvaluated: dimensionList.length,
      dimensionsPassed: dimensionList.filter((d) => d.verdict === "passed").length,
      dimensionsFailed: dimensionList.filter((d) => d.verdict === "failed").length,
      dimensionsNotApplicable: dimensionList.filter((d) => d.verdict === "not_applicable").length,
      totalViolations: allViolations.length,
    },
    dimensions,
    violations: allViolations,
  };
}

// ==============================================================================
// CLI Parameter Parsing & Execution
// ==============================================================================
export function parseCliArgs(argv) {
  const parsed = {
    transcriptPath: undefined,
    dbPath: undefined,
    reportPath: undefined,
    format: "text",
    requireDatabase: false,
    quiet: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg.startsWith("--transcript=")) {
      parsed.transcriptPath = arg.slice("--transcript=".length);
    } else if ((arg === "--transcript" || arg === "-t") && i + 1 < argv.length) {
      parsed.transcriptPath = argv[++i];
    } else if (arg.startsWith("--db=")) {
      parsed.dbPath = arg.slice("--db=".length);
    } else if ((arg === "--db" || arg === "-d") && i + 1 < argv.length) {
      parsed.dbPath = argv[++i];
    } else if (arg.startsWith("--report=")) {
      parsed.reportPath = arg.slice("--report=".length);
    } else if ((arg === "--report" || arg === "-r") && i + 1 < argv.length) {
      parsed.reportPath = argv[++i];
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg.startsWith("--format=")) {
      parsed.format = arg.slice("--format=".length);
    } else if (arg === "--require-db") {
      parsed.requireDatabase = true;
    } else if (arg === "--quiet" || arg === "-q") {
      parsed.quiet = true;
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage: node tools/check-chat-conversational-quality-gate.mjs [options]

Options:
  --transcript, -t <path>  Path to conversational JSON transcript file (required)
  --db, -d <path>          Path to SQLite context.db file for memory record audit (optional)
  --report, -r <path>      Output JSON report destination file (optional)
  --require-db             Enforce strict SQLite verification for memory supersede checks
  --format <json|text>     Output summary format (default: text)
  --json                   Shorthand for --format=json
  --quiet, -q              Suppress detailed diagnostic output
  --help, -h               Show this help message
`);
}

export function formatReportText(report) {
  const lines = [];
  lines.push("================================================================================");
  lines.push(` GameBuddy Chat Conversational Quality Gate — Verdict: [${report.verdict.toUpperCase()}]`);
  lines.push("================================================================================");
  lines.push(`Evaluated at: ${report.evaluatedAt}`);
  lines.push(`Total turns : ${report.summary?.totalTurns ?? 0}`);
  lines.push(`Violations  : ${report.summary?.totalViolations ?? 0}`);
  lines.push("--------------------------------------------------------------------------------");
  lines.push("Dimensions Status:");

  for (const [name, dim] of Object.entries(report.dimensions || {})) {
    const mark =
      dim.verdict === "passed" ? "[PASS]" : dim.verdict === "failed" ? "[FAIL]" : `[${dim.verdict.toUpperCase()}]`;
    lines.push(`  * ${name.padEnd(36)}: ${mark}`);
  }

  if (report.violations && report.violations.length > 0) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push(`Gate Violations (${report.violations.length}):`);
    for (let i = 0; i < report.violations.length; i++) {
      const v = report.violations[i];
      const turnPrefix =
        v.turnIndex !== undefined
          ? `[Turn ${v.turnIndex}] `
          : v.probeTurn !== undefined
            ? `[Probe Turn ${v.probeTurn}] `
            : "";
      lines.push(`  ${i + 1}. ${turnPrefix}${v.code}: ${v.message}`);
      if (v.divergence) {
        lines.push(`     -> Offset: ${v.divergence.offset}, Line: ${v.divergence.line}, Col: ${v.divergence.col}`);
        lines.push(`     -> Expected: ${JSON.stringify(v.divergence.expectedSnippet)}`);
        lines.push(`     -> Actual  : ${JSON.stringify(v.divergence.actualSnippet)}`);
      }
    }
  }
  lines.push("================================================================================");
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cliArgs = parseCliArgs(process.argv);
  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }

  if (!cliArgs.transcriptPath) {
    console.error("Error: --transcript <path> is required.");
    printUsage();
    process.exit(2);
  }

  const report = await checkChatConversationalQualityGate({
    transcriptPath: cliArgs.transcriptPath,
    dbPath: cliArgs.dbPath,
    options: {
      requireDatabase: cliArgs.requireDatabase,
    },
  });

  if (cliArgs.reportPath) {
    await writeFile(resolve(cliArgs.reportPath), JSON.stringify(report, null, 2), "utf8");
  }

  if (!cliArgs.quiet) {
    if (cliArgs.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReportText(report));
    }
  }

  if (report.verdict === "passed") {
    process.exit(0);
  } else if (report.verdict === "failed") {
    process.exit(1);
  } else {
    process.exit(2);
  }
}
