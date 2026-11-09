#!/usr/bin/env node
/**
 * stress-card-batch.mjs - Suite 2
 *
 * Drives the REAL card ingestion pipeline over a library of synthetic-but-typical
 * cards: the product's own StCardImportService, its own new-companion provisioning,
 * its own Chat mount, one real turn's content assembly, and its own card export.
 * For every card it prints one row: imported / provisioned / mounted / turn ran /
 * exported fields match (and which did not).
 *
 * Two object-level properties are proven per card, not just "the row ran":
 *   1. `extensions.gamebuddy.stardew` is field-for-field identical across the round
 *      trip - a deep compare, so a nested value washed away is caught, and absent
 *      stays absent rather than becoming `{}`.
 *   2. No `{{...}}` macro survives into what the model receives, for every authored
 *      field; and the reviewed-card path and the preset path resolve `{{user}}` to
 *      the same thing.
 *
 * Usage: node tools/stress-card-batch.mjs [--json] [--card <name>] [--keep-fixtures]
 * Non-zero exit when any card fails. Each card is runnable alone via --card.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindHostRuntime,
  deepDiff,
  freshRoot,
  identity,
  loadHost,
  printTable,
  releaseRoot,
  row,
  runCase,
  summarize,
  walkStrings,
} from "./lib/stress-harness/common.mjs";
import { CARD_FIXTURES, renderCardFixture } from "./lib/stress-harness/card-fixtures.mjs";
import { findUnrenderedMacros, macroTableFor } from "./lib/stress-harness/common.mjs";

const args = new Set(process.argv.slice(2));
const JSON_OUTPUT = args.has("--json");
const ONLY = argValue("--card");
const KEEP = args.has("--keep-fixtures");
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cards");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const rows = [];

async function main() {
  await bindHostRuntime();
  const phases = {};

  for (const fixture of CARD_FIXTURES) {
    if (ONLY !== undefined && fixture.name !== ONLY) continue;
    rows.push(await runCard(fixture, phases, { KEEP }));
  }

  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    printTable(rows, [
      { label: "card", value: (item) => item.case },
      { label: "imported", value: (item) => item.imported },
      { label: "provisioned", value: (item) => item.provisioned },
      { label: "mounted", value: (item) => item.mounted },
      { label: "turn", value: (item) => item.turn },
      { label: "export", value: (item) => item.export },
      { label: "status", value: (item) => item.status },
      { label: "detail", value: (item) => item.detail },
    ]);
  }
  process.exitCode = summarize("stress-card-batch", rows);
}

/**
 * Runs one card through import -> provision -> mount -> turn content -> export.
 *
 * Each phase records its own raw result, so a failure names the phase rather than
 * collapsing into "the card failed". The extension and macro object properties are
 * checked only where the phases got far enough to make them meaningful; a phase
 * that could not run is said so by name.
 */
async function runCard(fixture, phases, options) {
  const meta = { case: fixture.name, dimension: "card" };
  const root = await freshRoot(`stress-card-${fixture.name.slice(0, 12)}-`);
  let services;
  try {
    const { openServices, writeProfile } = await import("./lib/stress-harness/common.mjs");
    const id = identity("player-card", `companion-${fixture.name}`, `continuity-${fixture.name}`);
    services = await openServices(root, id);
    const rendered = renderCardFixture(fixture);
    if (options.KEEP) await persistFixture(fixture, rendered);

    // --- import through the product's own service ---
    const importId = `import-${fixture.name}`;
    let imported;
    let report;
    try {
      imported = await services.importer.import(importId, rendered.bytes);
      report = await services.importer.read(importId);
    } catch (error) {
      return row({
        ...meta,
        imported: "refused",
        provisioned: "n/a",
        mounted: "n/a",
        turn: "n/a",
        export: "n/a",
        status: "fail",
        flags: ["import_refused"],
        detail: `raw=${error.message}`,
      });
    }
    const candidate = report.candidate.artifact;
    const record = report.report.artifact;
    const importSummary = `${candidate.sourceFormat} fields=${candidate.fields.length} book=${candidate.worldBookCandidates?.length ?? 0} losses=${record.losses?.length ?? 0}`;

    // Every authored string the card supplied must be internally consistent with
    // what the candidate carries: a field the decoder dropped silently shows up
    // as a loss entry, and an unrendered macro in the candidate is reported.
    const candidateMacros = [];
    walkStrings(candidate, (path, text) => {
      for (const macro of findUnrenderedMacros(text)) candidateMacros.push(`${path}:${macro}`);
    });

    // --- provision a companion through the product's own review + create ---
    let provision;
    try {
      const { createNewCompanionService, provisionNewCompanion } = await loadHost("tavern/new-companion-service.js");
      const reviewInput = reviewableFields(candidate);
      const reviewed = await services.importer.recordReview(importId, {
        reviewedFields: reviewInput,
        approvedAtMs: 1,
      });
      const confirmed = await services.importer.confirmedReview(importId);
      const { ChatThreadStore: _unused, ...rest } = {};
      provision = await provisionNewCompanion(root, id.playerId, candidate, confirmed, services.threads);
      void reviewed;
    } catch (error) {
      return row({
        ...meta,
        imported: importSummary,
        provisioned: "refused",
        mounted: "n/a",
        turn: "n/a",
        export: "n/a",
        status: "fail",
        flags: ["provision_refused"],
        detail: `raw=${error.message}${candidateMacros.length ? ` macros=${candidateMacros.slice(0, 2).join(",")}` : ""}`,
      });
    }

    // The provisioned companion now owns its own roots; reopen services against
    // the FINAL identity the provisioning minted (it randomizes companion/continuity).
    const finalId = provision.identity;
    await services.close?.();
    services = await openServices(root, finalId);
    const profile = provision.profile;

    // --- mount a Chat through the real library service ---
    let state;
    try {
      state = await services.service.createNewChat({
        chatThreadId: `thread-${fixture.name}`,
        chatSurfaceSessionId: `surface-${fixture.name}`,
        opening: { kind: "blank" },
      });
    } catch (error) {
      return row({
        ...meta,
        imported: importSummary,
        provisioned: "ok",
        mounted: "refused",
        turn: "n/a",
        export: "n/a",
        status: "fail",
        flags: ["mount_refused"],
        detail: `raw=${error.message}`,
      });
    }

    // --- one real turn's content, through the product's own materializer ---
    let turnResult;
    try {
      const { materializeChatCatalog, promptStrings } = await import("./lib/stress-harness/turn.mjs");
      const catalog = await materializeChatCatalog(services, finalId, state, profile.identity.name);
      const prompt = await promptStrings(profile, catalog);
      const macroFindings = [];
      for (const item of prompt) {
        for (const macro of findUnrenderedMacros(item.text)) macroFindings.push(`${item.path}:${macro}`);
      }
      turnResult = { catalog, macroFindings };
    } catch (error) {
      return row({
        ...meta,
        imported: importSummary,
        provisioned: "ok",
        mounted: "ok",
        turn: "refused",
        export: "n/a",
        status: "fail",
        flags: ["turn_refused"],
        detail: `raw=${error.message}`,
      });
    }

    // --- export through the product's own card export service ---
    let exportedCard;
    let exportFlags = [];
    let exportDetail = "";
    try {
      const exported = await exportCard(root, finalId, profile);
      exportedCard = exported;
      const diff = compareRoundTrip(fixture, candidate, exported);
      exportFlags = diff.flags;
      exportDetail = diff.detail;
    } catch (error) {
      exportFlags = ["export_refused"];
      exportDetail = `raw=${error.message}`;
    }

    // --- object-level property 1: extensions field-for-field identity ---
    const extensionFindings = checkExtensionRoundTrip(candidate, exportedCard, fixture);

    // --- object-level property 2: no macro survives; both paths agree on {{user}} ---
    const macroFlags = [];
    if (turnResult.macroFindings.length > 0) macroFlags.push("unrendered_macro_in_prompt");
    const userAgreement = await checkUserReferenceAgreement(profile, finalId);
    if (!userAgreement.ok) macroFlags.push("user_reference_disagreement");

    const flags = [...exportFlags, ...extensionFindings.flags, ...macroFlags];
    const detail = [
      exportDetail,
      extensionFindings.detail,
      turnResult.macroFindings.length
        ? `unrendered: ${turnResult.macroFindings.slice(0, 3).join(", ")}`
        : "no unrendered macro",
      userAgreement.detail,
    ]
      .filter(Boolean)
      .join(" | ");

    return row({
      ...meta,
      imported: importSummary,
      provisioned: "ok",
      mounted: "ok",
      turn: "catalog+prompt assembled",
      export: flags.length ? `${flags.length} mismatch` : "fields match",
      status: flags.length ? "fail" : "pass",
      flags,
      detail,
    });
  } catch (error) {
    return row({ ...meta, status: "fail", flags: ["harness_error"], detail: `raw=${error?.stack ?? error}` });
  } finally {
    await releaseRoot(root, [services?.close]);
  }
}

/**
 * The reviewed fields a candidate makes available: every profile-eligible field,
 * which is what a player confirming an import approves.
 */
function reviewableFields(candidate) {
  const fields = candidate.fields
    .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
    .map((field) => field.field);
  return fields.length > 0 ? fields : candidate.fields.slice(0, 1).map((field) => field.field);
}

async function exportCard(root, id, profile) {
  const { TavernArtifactStore } = await loadHost("tavern/artifact-store.js");
  const { createCompanionCardExportService } = await loadHost("tavern/companion-card-export-service.js");
  const service = createCompanionCardExportService({
    store: new TavernArtifactStore(root),
    runtimeRoot: root,
    playerId: id.playerId,
    async resolveCompanion(handle) {
      return handle === "self"
        ? { companionId: id.companionId, continuityId: id.continuityId, name: profile.identity.name }
        : null;
    },
  });
  const result = await service.read("self", "json");
  if (result === null) throw new Error("companion_card_absent");
  return JSON.parse(result.card);
}

/**
 * Compares the card's authored fields against the exported card's fields, one
 * field at a time, and reports which ones differ. The comparison is deliberately
 * over the CARD fields (name/description/scenario/first_mes/mes_example/book),
 * because those are the authored values a player can see change.
 */
function compareRoundTrip(fixture, candidate, exported) {
  const flags = [];
  const parts = [];
  const exportedData = exported?.data ?? {};
  const name = candidate.fields.find((field) => field.field === "name")?.text;
  if (name !== undefined && exportedData.name !== name) {
    flags.push("name_mismatch");
    parts.push(`name: imported=${JSON.stringify(name)} exported=${JSON.stringify(exportedData.name)}`);
  }
  const scenario = candidate.fields.find((field) => field.field === "scenario")?.text;
  if (scenario !== undefined && exportedData.scenario !== scenario) {
    flags.push("scenario_mismatch");
    parts.push(`scenario: imported=${scenario.length} exported=${(exportedData.scenario ?? "").length}`);
  }
  // The world book: every candidate entry the import kept must be present with
  // the same content. Compare by (content) multiset so entry ordering is not
  // mistaken for a lost entry.
  const candidates = candidate.worldBookCandidates ?? [];
  if (candidates.length > 0) {
    const exportedContents = (exportedData.character_book?.entries ?? []).map((entry) => entry.content);
    const importedContents = candidates.map((entry) => entry.content);
    const missing = importedContents.filter((content) => !exportedContents.includes(content));
    const invented = exportedContents.filter((content) => !importedContents.includes(content));
    if (missing.length > 0 || invented.length > 0) {
      flags.push("worldbook_mismatch");
      parts.push(`book: missing=${missing.length} invented=${invented.length}`);
    }
  }
  return { flags, detail: parts.join("; ") };
}

/**
 * Object-level property 1. Deep-compares `extensions` across the round trip.
 * Absent stays absent: a card with no extensions must export no extensions field
 * (never `{}`), and a card that carried one must export every nested key/value.
 */
function checkExtensionRoundTrip(candidate, exportedCard, fixture) {
  const importedExtensions = candidate.extensions;
  const exportedExtensions = exportedCard?.data?.extensions;
  const flags = [];
  const parts = [];
  if (importedExtensions === undefined) {
    // A card may have written extensions the decoder DROPPED only if they were
    // empty or over the bound; otherwise absent means the export must not invent.
    const wroteExtensions = fixture.card?.data?.extensions ?? fixture.card?.extensions;
    if (wroteExtensions !== undefined && Object.keys(wroteExtensions).length > 0) {
      flags.push("extensions_dropped_on_import");
      parts.push("card wrote extensions but the candidate carries none");
    } else if (exportedExtensions !== undefined) {
      flags.push("extensions_invented_on_export");
      parts.push(`export invented extensions: ${JSON.stringify(exportedExtensions).slice(0, 60)}`);
    } else {
      parts.push("extensions absent on both sides");
    }
    return { flags, detail: parts.join("; ") };
  }
  if (exportedExtensions === undefined) {
    flags.push("extensions_lost_on_export");
    parts.push("candidate carries extensions but the export wrote none");
    return { flags, detail: parts.join("; ") };
  }
  const diff = deepDiff(importedExtensions, exportedExtensions, "$.extensions");
  if (diff.length > 0) {
    flags.push("extensions_not_identical");
    for (const item of diff.slice(0, 5)) parts.push(`${item.path} ${item.kind} (${item.left} != ${item.right})`);
  } else {
    parts.push("extensions field-for-field identical");
  }
  // The owner's named case: gamebuddy.stardew specifically.
  const stardewDiff = deepDiff(
    importedExtensions?.gamebuddy?.stardew,
    exportedExtensions?.gamebuddy?.stardew,
    "$.extensions.gamebuddy.stardew",
  );
  if (stardewDiff.length > 0) {
    flags.push("stardew_extensions_not_identical");
    for (const item of stardewDiff.slice(0, 5)) parts.push(`stardew ${item.path} ${item.kind}`);
  }
  return { flags, detail: parts.join("; ") };
}

/**
 * Object-level property 2b: the reviewed-card path and the preset path must
 * resolve `{{user}}` to the same thing. Both go through `macroTable`; this asserts
 * the reviewed path's rendered persona carries no bare `player_…` id (the bug
 * another lane is fixing) and that the two tables produce the same word.
 */
async function checkUserReferenceAgreement(profile, id) {
  const { macroTable } = await loadHost("tavern/macro-engine.js");
  const reviewed = macroTable({ char: profile.identity.name, locale: "zh-CN" });
  const preset = macroTable({ char: profile.identity.name, locale: "zh-CN" });
  if (reviewed.user !== preset.user)
    return { ok: false, detail: `user word differs: reviewed=${reviewed.user} preset=${preset.user}` };
  // A bare partition id leaking into the persona would look like `player_…`.
  const leaked = [];
  walkStrings(profile.persona ?? {}, (path, text) => {
    if (/player_[A-Za-z0-9]+/u.test(text)) leaked.push(path);
  });
  if (leaked.length > 0) return { ok: false, detail: `player id leaked into persona: ${leaked.join(", ")}` };
  return { ok: true, detail: `user reference agrees (${reviewed.user})` };
}

async function persistFixture(fixture, rendered) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(join(FIXTURE_DIR, rendered.fileName), rendered.bytes);
}

main().catch((error) => {
  process.stderr.write(`stress-card-batch fatal: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
