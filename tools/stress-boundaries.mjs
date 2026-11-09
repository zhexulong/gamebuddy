#!/usr/bin/env node
/**
 * stress-boundaries.mjs - Suite 1
 *
 * Blasts extreme data shapes through the REAL product services (the compiled
 * Host in `host/dist-test`): the artifact store, the Chat thread store, the
 * library/import services, the companion world book writer, the profile writer,
 * the macro engine and the Chat authored-context catalog materializer. Nothing
 * is stubbed. Each case prints one row: what was created, what the read returned
 * (status + raw bounded code), whether a turn could be assembled, and whether
 * anything was silently truncated or invented.
 *
 * Dimensions:
 *   zero  - an emptied surface: no Chats, no companions, an empty book, an empty
 *           draft, a dropped connection.
 *   many  - 150 companions / world-book entries / chats / memory records pushed
 *           through the real writers, then read back through every read route.
 *   long  - persona / scenario / world book entry / memory record at 2000, 4000,
 *           8000 and 16000 characters, mounted and asked to assemble a turn.
 *
 * Usage: node tools/stress-boundaries.mjs [--json] [--case <name>]
 * Non-zero exit when any case fails. Each case is runnable alone via --case.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bindHostRuntime,
  freshRoot,
  identity,
  loadHost,
  macroTableFor,
  printTable,
  releaseRoot,
  row,
  runCase,
  summarize,
  utf8Bytes,
  walkStrings,
} from "./lib/stress-harness/common.mjs";
import { materializeChatCatalog, promptStrings } from "./lib/stress-harness/turn.mjs";
import { findUnrenderedMacros } from "./lib/stress-harness/common.mjs";

const args = new Set(process.argv.slice(2));
const JSON_OUTPUT = args.has("--json");
const ONLY = argValue("--case");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const rows = [];

async function caseDef(meta, body) {
  if (ONLY !== undefined && meta.case !== ONLY) return;
  rows.push(await runCase(meta, body));
}

/** 150 records through the real writer path. */
const MANY = 150;

async function main() {
  await bindHostRuntime();

  await zeroCases();
  await manyCases();
  await longCases();

  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    printTable(rows, [
      { label: "case", value: (item) => item.case },
      { label: "dim", value: (item) => item.dimension },
      { label: "created", value: (item) => item.created },
      { label: "read", value: (item) => item.read },
      { label: "turn", value: (item) => item.turn },
      { label: "status", value: (item) => item.status },
      { label: "detail", value: (item) => item.detail },
    ]);
  }
  process.exitCode = summarize("stress-boundaries", rows);
}

// ---------------------------------------------------------------------------
// zero
// ---------------------------------------------------------------------------

async function zeroCases() {
  await caseDef({ case: "zero-empty-chat-list", dimension: "zero" }, async () => {
    const root = await freshRoot("stress-zero-chat-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      const chats = await services.service.listChats();
      const companions = await services.service.listCompanions();
      const active = await services.service.activeChatSelection();
      const flags = [];
      if (!Array.isArray(chats)) flags.push("chats_not_array");
      if (active !== null) flags.push("active_not_null");
      return {
        created: "0 chats",
        read: `listChats=${chats.length} listCompanions=${companions.length} active=${active === null ? "null" : "set"}`,
        turn: "n/a",
        flags,
        detail: flags.length
          ? `raw empty-list read: chats=${JSON.stringify(chats)} active=${JSON.stringify(active)}`
          : "empty list reads as empty",
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "zero-companion-library-empty", dimension: "zero" }, async () => {
    const root = await freshRoot("stress-zero-lib-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      const companions = await services.service.listCompanions();
      const flags = [];
      if (companions.length !== 0) flags.push("nonempty_library");
      return {
        created: "no companion artifact",
        read: `listCompanions=${companions.length}`,
        turn: "n/a",
        flags,
        detail:
          companions.length === 0
            ? "empty library reads empty (no invented companion)"
            : `raw=${JSON.stringify(companions)}`,
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "zero-worldbook-entries", dimension: "zero" }, async () => {
    const { writeCompanionWorldBook, readCompanionWorldBook } = await import("./lib/stress-harness/common.mjs");
    const root = await freshRoot("stress-zero-wb-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      await writeCompanionWorldBook(services.paths.runtimeCwd, {
        schemaVersion: 1,
        worldBookId: "wb-empty",
        revision: 1,
        alwaysOnPremise: "",
        entries: [],
      });
      const book = await readCompanionWorldBook(services.paths.runtimeCwd);
      const flags = [];
      if (book === null) flags.push("book_read_null");
      const { projectCompanionWorldBook } = await loadHost("tavern/companion-world-book-service.js");
      const projection = projectCompanionWorldBook(book);
      if (flags.length === 0 && projection.present !== true) flags.push("projection_absent");
      if (flags.length === 0 && projection.entries.length !== 0) flags.push("invented_entries");
      const state = await openChatWithBook(services, id, book);
      const catalog = await materializeChatCatalog(services, id, state, "c");
      return {
        created: "worldbook with 0 entries",
        read: `present=${projection.present} entries=${projection.entries.length} stableSources=${catalog.stableSources.length}`,
        turn: "catalog assembled",
        flags,
        detail: flags.length
          ? `raw=present:${projection.present} entries:${projection.entries.length}`
          : "empty book projects empty and still assembles",
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "zero-empty-draft", dimension: "zero" }, async () => {
    const root = await freshRoot("stress-zero-draft-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      await services.service.createNewCompanion({
        companionId: id.companionId,
        continuityId: id.continuityId,
        name: "Draft",
        profileId: `profile-${id.companionId}`,
        profileRevision: 1,
        profileHash: "a".repeat(64),
      });
      const state = await services.service.createNewChat({
        chatThreadId: "thread_1",
        chatSurfaceSessionId: "surface_1",
        opening: { kind: "blank" },
      });
      const resumed = await services.threads.resumeThread("thread_1", "surface_1");
      const flags = [];
      if (resumed.messages.length !== 0) flags.push("messages_nonempty");
      if (resumed.draft.revision < 0) flags.push("bad_draft_revision");
      return {
        created: "chat with blank opening",
        read: `messages=${resumed.messages.length} draftContent=${JSON.stringify(resumed.draft.content)} revision=${resumed.draft.revision}`,
        turn: "n/a",
        flags,
        detail: flags.length ? `raw=${JSON.stringify(resumed.draft)}` : "blank opening is an ordinary empty draft",
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "zero-game-connection-dropped", dimension: "zero" }, async () => {
    // A game connection dropped mid-attachment is a Game-surface lifecycle fact.
    // This harness runs no live game, so it is a NAMED skip rather than a silent pass.
    return {
      created: "n/a",
      read: "n/a",
      turn: "n/a",
      status: "skip",
      flags: ["requires_live_game"],
      detail: "skip: needs a live Stardew bridge/connection; the Game lifecycle path is not driven here",
    };
  });
}

async function openChatWithBook(services, id, book) {
  const { worldBookMetadata } = await loadHost("worldbook.js");
  const binding = {
    worldBookId: book.worldBookId,
    revision: book.revision,
    canonicalHash: worldBookMetadata(book).canonicalHash,
    provenance: "reviewed-import",
  };
  await services.service.createNewCompanion({
    companionId: id.companionId,
    continuityId: id.continuityId,
    name: "Book",
    profileId: `profile-${id.companionId}`,
    profileRevision: 1,
    profileHash: "a".repeat(64),
  });
  return await services.service.createNewChat({
    chatThreadId: "thread_book",
    chatSurfaceSessionId: "surface_book",
    companionWorldBookBinding: binding,
    opening: { kind: "blank" },
  });
}

// ---------------------------------------------------------------------------
// many
// ---------------------------------------------------------------------------

async function manyCases() {
  await caseDef({ case: "many-150-companions", dimension: "many" }, async () => {
    const root = await freshRoot("stress-many-comp-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      const { TavernArtifactStore } = await loadHost("tavern/artifact-store.js");
      const { validateTavernArtifact } = await loadHost("tavern/types.js");
      const { createHash } = await import("node:crypto");
      const store = new TavernArtifactStore(root);
      const created = [];
      for (let index = 0; index < MANY; index += 1) {
        const companionId = `companion-${index}`;
        const digest = createHash("sha256").update(`p\u001f${companionId}`, "utf8").digest("hex");
        const path = join(root, "tavern", "v1", "companions", digest, "companion.json");
        const artifact = {
          schemaVersion: 1,
          revision: 1,
          companionId,
          continuityId: `continuity-${index}`,
          name: `伙伴 ${index}`,
          profileId: `profile-${index}`,
          profileRevision: 1,
          profileHash: "b".repeat(64),
        };
        try {
          await store.write(path, artifact, validateTavernArtifact);
          created.push(companionId);
        } catch (error) {
          return {
            created: `${created.length}/${MANY}`,
            read: "n/a",
            turn: "n/a",
            flags: ["write_refused"],
            detail: `raw=${error.message} at index ${index}`,
          };
        }
      }
      const listed = await services.service.listCompanions();
      const flags = [];
      if (listed.length !== MANY) flags.push("read_count_mismatch");
      return {
        created: `${created.length}/${MANY} companions written`,
        read: `listCompanions=${listed.length}`,
        turn: "n/a",
        flags,
        detail:
          listed.length === MANY
            ? "all wrote and read back"
            : `declared cap smaller than writer: wrote ${created.length}, read ${listed.length}`,
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "many-150-worldbook-entries", dimension: "many" }, async () => {
    const { writeCompanionWorldBook, readCompanionWorldBook } = await import("./lib/stress-harness/common.mjs");
    const root = await freshRoot("stress-many-wb-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      const entries = Array.from({ length: MANY }, (_, index) => ({
        entryId: `e${index}`,
        title: `条目 ${index}`,
        content: `这是第 ${index} 条背景。`,
        scope: "setting",
        provenance: "authored",
        tokenBudget: "small",
        keys: [`k${index}`],
      }));
      let writeError;
      try {
        await writeCompanionWorldBook(services.paths.runtimeCwd, {
          schemaVersion: 1,
          worldBookId: "wb-many",
          revision: 1,
          alwaysOnPremise: "总纲。",
          entries,
        });
      } catch (error) {
        writeError = error;
      }
      if (writeError !== undefined) {
        return {
          created: `${MANY} entries attempted`,
          read: "n/a",
          turn: "n/a",
          flags: ["write_refused"],
          detail: `raw=${writeError.message} (worldbook writer cap vs ${MANY})`,
        };
      }
      const book = await readCompanionWorldBook(services.paths.runtimeCwd);
      const flags = [];
      if (book.entries.length !== MANY) flags.push("read_count_mismatch");
      return {
        created: `${MANY} entries written`,
        read: `readBack=${book.entries.length}`,
        turn: "n/a",
        flags,
        detail: book.entries.length === MANY ? "all wrote and read back" : `wrote ${MANY}, read ${book.entries.length}`,
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "many-150-chats", dimension: "many" }, async () => {
    const root = await freshRoot("stress-many-chat-");
    const id = identity("p", "c", "k");
    const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
    try {
      await services.service.createNewCompanion({
        companionId: id.companionId,
        continuityId: id.continuityId,
        name: "Many",
        profileId: `profile-${id.companionId}`,
        profileRevision: 1,
        profileHash: "a".repeat(64),
      });
      for (let index = 0; index < MANY; index += 1) {
        await services.service.createNewChat({
          chatThreadId: `thread_${index}`,
          chatSurfaceSessionId: `surface_${index}`,
          opening: { kind: "blank" },
        });
      }
      const chats = await services.service.listChats();
      const lastMessages = await services.threads.listThreadLastMessages?.();
      const flags = [];
      if (chats.length !== MANY) flags.push("read_count_mismatch");
      if (lastMessages !== undefined && lastMessages.length !== 0) flags.push("blank_chats_have_last_messages");
      return {
        created: `${MANY} chats`,
        read: `listChats=${chats.length} listThreadLastMessages=${lastMessages === undefined ? "n/a" : lastMessages.length}`,
        turn: "n/a",
        flags,
        detail: chats.length === MANY ? "all wrote and read back" : `wrote ${MANY}, read ${chats.length}`,
      };
    } finally {
      await releaseRoot(root, [services.close]);
    }
  });

  await caseDef({ case: "many-150-memory-records", dimension: "many" }, async () => {
    const root = await freshRoot("stress-many-mem-");
    try {
      const { loadMemoryFacade } = await import("./lib/stress-harness/common.mjs");
      const createGameBuddyPlayerMemoryCrudFacade = await loadMemoryFacade();
      const continuityId = "continuity-mem";
      const runtimeCwd = root;
      const binding = { continuityId, runtimeCwd, profileId: "profile-mem", profileRevision: 1 };
      const facade = createGameBuddyPlayerMemoryCrudFacade(binding);
      let written = 0;
      for (let index = 0; index < MANY; index += 1) {
        await facade.create({ continuityId, profileId: "profile-mem", profileRevision: 1, content: `记忆 ${index}` });
        written += 1;
      }
      const listed = await facade.listMemories({ continuityId, profileId: "profile-mem", profileRevision: 1 });
      const flags = [];
      if (listed.length !== MANY) flags.push("read_count_mismatch");
      return {
        created: `${written}/${MANY} memory records via vendor CRUD facade`,
        read: `listMemories=${listed.length}`,
        turn: "n/a",
        flags,
        detail: listed.length === MANY ? "all wrote and read back" : `wrote ${written}, read ${listed.length}`,
      };
    } catch (error) {
      try {
        await releaseRoot(root, []);
      } catch {}
      return {
        created: "n/a",
        read: "n/a",
        turn: "n/a",
        flags: ["memory_facade_unavailable"],
        detail: `raw=${error.message}`,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// long
// ---------------------------------------------------------------------------

async function longCases() {
  for (const chars of [2000, 4000, 8000, 16000]) {
    await caseDef({ case: `long-persona-${chars}`, dimension: "long" }, async () => {
      const root = await freshRoot(`stress-long-persona-${chars}-`);
      const id = identity("p", "c", "k");
      const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
      try {
        const { writeProfile } = await import("./lib/stress-harness/common.mjs");
        const { identityProfileMetadata, DEFAULT_IDENTITY_PROFILE } = await loadHost("identity-profile.js");
        const { runtimePaths } = await import("./lib/stress-harness/common.mjs");
        const profile = {
          ...DEFAULT_IDENTITY_PROFILE,
          profileId: `profile-${id.companionId}`,
          identity: { ...DEFAULT_IDENTITY_PROFILE.identity, name: "长卷" },
          persona: { core: "甲".repeat(chars) },
        };
        const paths = runtimePaths(root, id);
        await writeProfile(paths.identityProfilePath, profile);
        await services.service.createNewCompanion({
          companionId: id.companionId,
          continuityId: id.continuityId,
          name: "长卷",
          profileId: profile.profileId,
          profileRevision: 1,
          profileHash: identityProfileMetadata(profile).canonicalHash,
        });
        const state = await services.service.createNewChat({
          chatThreadId: "thread_long",
          chatSurfaceSessionId: "surface_long",
          opening: { kind: "blank" },
        });
        const catalog = await materializeChatCatalog(services, id, state, "长卷");
        const prompt = await promptStrings(profile, catalog);
        const macros = prompt.flatMap((item) =>
          findUnrenderedMacros(item.text).map((macro) => `${item.path}:${macro}`),
        );
        const flags = [];
        if (macros.length > 0) flags.push("unrendered_macro");
        const rendered = prompt[0].text.length;
        const bytes = utf8Bytes(prompt[0].text);
        return {
          created: `persona.core=${chars} chars (${utf8Bytes(profile.persona.core)} bytes)`,
          read: `systemPrompt=${rendered} chars/${bytes} bytes, stableSources=${catalog.stableSources.length}`,
          turn: "catalog + prompt assembled",
          flags,
          detail: macros.length
            ? `offending fields: ${macros.slice(0, 3).join(", ")}`
            : rendered < profile.persona.core.length
              ? `persona appears truncated: core=${profile.persona.core.length} in prompt=${rendered}`
              : "persona reached the prompt whole",
        };
      } finally {
        await releaseRoot(root, [services.close]);
      }
    });

    await caseDef({ case: `long-scenario-${chars}`, dimension: "long" }, async () => {
      const root = await freshRoot(`stress-long-scenario-${chars}-`);
      const id = identity("p", "c", "k");
      const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
      try {
        const { createScenarioManagementService } = await loadHost("tavern/scenario-management/scenario-management.js");
        const scenarioService = createScenarioManagementService(services.artifacts, services.paths.companionRoot);
        await services.service.createNewCompanion({
          companionId: id.companionId,
          continuityId: id.continuityId,
          name: "场景",
          profileId: `profile-${id.companionId}`,
          profileRevision: 1,
          profileHash: "a".repeat(64),
        });
        const text = "场".repeat(chars);
        let createError;
        try {
          await scenarioService.create({ name: "Long", description: text });
        } catch (error) {
          createError = error;
        }
        if (createError !== undefined) {
          return {
            created: `scenario=${chars} chars attempted`,
            read: "n/a",
            turn: "n/a",
            flags: ["write_refused"],
            detail: `raw=${createError.message} (scenario writer bound)`,
          };
        }
        const state = await services.service.createNewChat({
          chatThreadId: "thread_scenario",
          chatSurfaceSessionId: "surface_scenario",
          opening: { kind: "blank" },
        });
        let catalog;
        let turnFlags = [];
        let turnDetail = "scenario reached the catalog whole";
        try {
          catalog = await materializeChatCatalog(services, id, state, "场景");
          const scenarioSource = catalog.stableSources.find((source) => source.kind === "scenario");
          if (scenarioSource === undefined) turnFlags = ["scenario_source_absent"];
          else if (scenarioSource.content.length < text.length) {
            turnFlags = ["scenario_truncated"];
            turnDetail = `scenario bound: authored=${text.length} inCatalog=${scenarioSource.content.length}`;
          }
        } catch (error) {
          turnFlags = ["turn_refused"];
          turnDetail = `raw=${error.message}`;
        }
        return {
          created: `scenario=${chars} chars (${utf8Bytes(text)} bytes)`,
          read: `scenario.read=${(await scenarioService.read()) === null ? "null" : "present"}`,
          turn: turnFlags.length ? "refused" : "catalog assembled",
          flags: turnFlags,
          detail: turnDetail,
        };
      } finally {
        await releaseRoot(root, [services.close]);
      }
    });

    await caseDef({ case: `long-worldbook-entry-${chars}`, dimension: "long" }, async () => {
      const { writeCompanionWorldBook, readCompanionWorldBook } = await import("./lib/stress-harness/common.mjs");
      const root = await freshRoot(`stress-long-wb-${chars}-`);
      const id = identity("p", "c", "k");
      const services = await (await import("./lib/stress-harness/common.mjs")).openServices(root, id);
      try {
        await writeCompanionWorldBook(services.paths.runtimeCwd, {
          schemaVersion: 1,
          worldBookId: "wb-long",
          revision: 1,
          alwaysOnPremise: "",
          entries: [
            {
              entryId: "e1",
              title: "长条目",
              content: "设".repeat(chars),
              scope: "setting",
              provenance: "authored",
              tokenBudget: "small",
              constant: true,
            },
          ],
        });
        const book = await readCompanionWorldBook(services.paths.runtimeCwd);
        const state = await openChatWithBook(services, id, book);
        const catalog = await materializeChatCatalog(services, id, state, "c");
        const constant = catalog.stableSources.find((source) => source.kind === "lorebook_constant");
        const flags = [];
        if (constant === undefined) flags.push("constant_source_absent");
        // The stable layer is budget-bounded: a book over 2048 tokens degrades to
        // an overview rather than blowing the ceiling. That is a documented
        // truncation, and the row says so.
        const degraded = constant !== undefined && constant.content.length < chars;
        return {
          created: `worldbook entry=${chars} chars`,
          read: `readBack=${book.entries[0].content.length}`,
          turn: degraded ? "catalog assembled (stable layer budget-degraded)" : "catalog assembled",
          flags,
          detail:
            constant === undefined
              ? "no lorebook_constant source"
              : degraded
                ? `stable content=${constant.content.length} < authored=${chars} (documented budget bound)`
                : "entry reached the stable layer whole",
        };
      } finally {
        await releaseRoot(root, [services.close]);
      }
    });

    await caseDef({ case: `long-memory-record-${chars}`, dimension: "long" }, async () => {
      const root = await freshRoot(`stress-long-mem-${chars}-`);
      try {
        const { loadMemoryFacade } = await import("./lib/stress-harness/common.mjs");
        const createGameBuddyPlayerMemoryCrudFacade = await loadMemoryFacade();
        const continuityId = "continuity-long-mem";
        const binding = { continuityId, runtimeCwd: root, profileId: "profile-mem", profileRevision: 1 };
        const facade = createGameBuddyPlayerMemoryCrudFacade(binding);
        const content = "忆".repeat(chars);
        try {
          await facade.create({ continuityId, profileId: "profile-mem", profileRevision: 1, content });
        } catch (error) {
          return {
            created: `memory=${chars} chars attempted`,
            read: "n/a",
            turn: "n/a",
            flags: ["write_refused"],
            detail: `raw=${error.message} (memory ${chars} chars; 4096-byte bound)`,
          };
        }
        const listed = await facade.listMemories({ continuityId, profileId: "profile-mem", profileRevision: 1 });
        const flags = [];
        if (listed[0]?.content !== content) flags.push("readback_mismatch");
        return {
          created: `memory=${chars} chars (${utf8Bytes(content)} bytes)`,
          read: `listMemories=${listed.length} firstLen=${listed[0]?.content.length ?? "n/a"}`,
          turn: "n/a",
          flags,
          detail:
            listed[0]?.content === content
              ? "round-trips whole"
              : `read back ${listed[0]?.content.length ?? "?"} of ${chars}`,
        };
      } catch (error) {
        return {
          created: "n/a",
          read: "n/a",
          turn: "n/a",
          flags: ["memory_facade_unavailable"],
          detail: `raw=${error.message}`,
        };
      } finally {
        await releaseRoot(root, []);
      }
    });
  }
}

main().catch((error) => {
  process.stderr.write(`stress-boundaries fatal: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
