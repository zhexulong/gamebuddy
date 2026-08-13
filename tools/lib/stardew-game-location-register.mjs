import { createHash } from "node:crypto";
import { parseCSharpSyntaxStructure } from "./stardew-csharp-syntax-structural-canary.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const LOCATION_ROOT = "GameLocation";
const LOCATION_PREFIX = "StardewValley/Locations/";
const INTERACTION_NAMES = new Set([
  "performAction",
  "performToolAction",
  "answerDialogue",
  "answerDialogueAction",
  "startEvent",
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function sourceSlice(source, locator) {
  return Buffer.from(source, "utf8").subarray(locator.startByte, locator.endByte).toString("utf8");
}

function isLocationFile(relativePath) {
  return relativePath === "StardewValley/GameLocation.cs" || relativePath.startsWith(LOCATION_PREFIX);
}

function directBaseName(baseListSyntax) {
  if (!baseListSyntax) return null;
  const match = baseListSyntax.match(/:\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/);
  return match ? match[1].split(".").at(-1) : null;
}

function isHostedMember(name) {
  return INTERACTION_NAMES.has(name) || /(?:update|day|time|event|dialogue)/i.test(name);
}

function memberFamily(name) {
  if (INTERACTION_NAMES.has(name)) return `interaction:${name}`;
  if (/dialogue/i.test(name)) return "interaction:dialogue-host";
  if (/event/i.test(name)) return "continuation:event-host";
  if (/day/i.test(name)) return "continuation:day-host";
  if (/time/i.test(name)) return "continuation:time-host";
  return "continuation:update-host";
}

function locationDeclarations(parsed) {
  return parsed.declarations.filter((item) => item.declarationSyntaxKind === "class_declaration");
}

function findOwner(declarations, locator) {
  return (
    declarations
      .filter((item) => item.locator.startByte <= locator.startByte && item.locator.endByte >= locator.endByte)
      .sort((a, b) => a.locator.endByte - a.locator.startByte - (b.locator.endByte - b.locator.startByte))[0] ?? null
  );
}

function rowId(layer, sourcePath, locator, suffix = "") {
  return `${layer}:${sha256(`${sourcePath}\0${locator.startByte}\0${locator.endByte}\0${suffix}`)}`;
}

function handoffsFor({ source, member, owner, typeByName }) {
  const body = member.bodyLocator ? sourceSlice(source, member.bodyLocator) : "";
  const handoffs = [];
  const baseName = directBaseName(owner.baseListSyntax);
  const baseMethod = new RegExp(`\\bbase\\.${member.identifierSyntax}\\s*\\(`).test(body);
  if (baseMethod) {
    handoffs.push(
      Object.freeze({
        kind: "source-owner",
        target: baseName && typeByName.has(baseName) ? typeByName.get(baseName).typeId : null,
        targetSyntax: baseName ? `${baseName}.${member.identifierSyntax}` : `base.${member.identifierSyntax}`,
        resolution:
          baseName && typeByName.has(baseName) ? "resolved-within-location-cluster" : "gap-unresolved-base-owner",
      }),
    );
  }
  if (member.identifierSyntax !== "startEvent" && /\bstartEvent\s*\(/.test(body)) {
    handoffs.push(
      Object.freeze({
        kind: "source-owner",
        target: typeByName.get(LOCATION_ROOT)?.typeId ?? null,
        targetSyntax: "GameLocation.startEvent",
        resolution: typeByName.has(LOCATION_ROOT) ? "resolved-within-location-cluster" : "gap-missing-root-owner",
      }),
    );
  }
  if (/\bnew\s+Event\s*\(/.test(body) || /\bcurrentEvent\b/.test(body)) {
    handoffs.push(
      Object.freeze({
        kind: "native-subsystem-boundary",
        target: "StardewValley.Event",
        targetSyntax: "Event",
        resolution: "outside-location-cluster",
      }),
    );
  }
  if (/\bGame1\./.test(body)) {
    handoffs.push(
      Object.freeze({
        kind: "source-owner-boundary",
        target: "StardewValley.Game1",
        targetSyntax: "Game1",
        resolution: "outside-location-cluster",
      }),
    );
  }
  if (/\b(?:DataLoader|content|temporaryContent|festivalContent)\./.test(body)) {
    handoffs.push(
      Object.freeze({
        kind: "content-boundary",
        target: null,
        targetSyntax: "content-loader-syntax",
        resolution: "unresolved-content-target",
      }),
    );
  }
  if (handoffs.length === 0) {
    handoffs.push(
      Object.freeze({ kind: "gap", target: null, targetSyntax: null, resolution: "needs-source-owner-review" }),
    );
  }
  return Object.freeze(handoffs);
}

/**
 * Build a deliberately neutral Stage-1/2 register for GameLocation and every
 * source class under StardewValley/Locations that inherits it. It records
 * lexical declarations and immediate syntactic owner/handoff/boundary/gap
 * rows only; it does not derive calls, transitions, actions, or primitives.
 */
export async function buildGameLocationInteractionRegister(sourceRecords) {
  if (!Array.isArray(sourceRecords) || sourceRecords.length === 0)
    fail("location_register_sources_required", "Non-empty exact source records are required.");
  const selected = sourceRecords.filter(
    (record) =>
      record &&
      typeof record.relativePath === "string" &&
      typeof record.text === "string" &&
      isLocationFile(record.relativePath.replaceAll("\\", "/")),
  );
  if (!selected.some((record) => record.relativePath.replaceAll("\\", "/") === "StardewValley/GameLocation.cs"))
    fail("location_register_root_missing", "StardewValley/GameLocation.cs is required.");
  const parsedByPath = new Map();
  const parseGaps = [];
  for (const record of selected) {
    const sourcePath = record.relativePath.replaceAll("\\", "/");
    if (parsedByPath.has(sourcePath))
      fail("location_register_duplicate_source", "Duplicate selected source path.", { sourcePath });
    const parsed = await parseCSharpSyntaxStructure({ source: record.text, relativePath: sourcePath });
    parsedByPath.set(sourcePath, { source: record.text, parsed });
    if (parsed.parse.hasError || parsed.parse.errorNodes.length || parsed.parse.missingNodes.length)
      parseGaps.push(Object.freeze({ sourcePath, parse: parsed.parse }));
  }
  const allClasses = [];
  for (const [sourcePath, { parsed }] of parsedByPath) {
    if (parsed.parse.hasError) continue;
    for (const declaration of locationDeclarations(parsed)) {
      allClasses.push(Object.freeze({ sourcePath, declaration, baseName: directBaseName(declaration.baseListSyntax) }));
    }
  }
  const root = allClasses.find(
    (item) =>
      item.sourcePath === "StardewValley/GameLocation.cs" && item.declaration.identifierSyntax === LOCATION_ROOT,
  );
  if (!root) fail("location_register_root_declaration_missing", "GameLocation class declaration was not found.");
  const classesByName = new Map(allClasses.map((item) => [item.declaration.identifierSyntax, item]));
  const includedNames = new Set([LOCATION_ROOT]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of allClasses) {
      if (includedNames.has(item.declaration.identifierSyntax)) continue;
      if (item.baseName && includedNames.has(item.baseName)) {
        includedNames.add(item.declaration.identifierSyntax);
        changed = true;
      }
    }
  }
  const typeRows = [];
  const typeByName = new Map();
  for (const item of allClasses
    .filter((entry) => includedNames.has(entry.declaration.identifierSyntax))
    .sort((a, b) => a.declaration.identifierSyntax.localeCompare(b.declaration.identifierSyntax))) {
    const typeId = rowId("location-type", item.sourcePath, item.declaration.locator, item.declaration.identifierSyntax);
    const base = item.baseName;
    const baseResolved = !base || base === LOCATION_ROOT || includedNames.has(base);
    const row = Object.freeze({
      typeId,
      rowKind: "location-type-owner",
      sourcePath: item.sourcePath,
      sourceLocator: item.declaration.locator,
      typeSyntax: item.declaration.identifierSyntax,
      immediateBaseSyntax: base,
      immediateOwnerOrBoundary: !base
        ? Object.freeze({ kind: "root", target: null, resolution: "source-root" })
        : Object.freeze({
            kind: baseResolved ? "source-owner" : "gap",
            target: baseResolved ? base : null,
            resolution: baseResolved ? "resolved-within-location-cluster" : "unresolved-base-owner",
          }),
      reviewState: "pending-source-owner-review",
    });
    typeRows.push(row);
    typeByName.set(row.typeSyntax, row);
  }
  const memberRows = [];
  for (const type of typeRows) {
    const state = parsedByPath.get(type.sourcePath);
    if (!state || state.parsed.parse.hasError) continue;
    const members = state.parsed.declarations.filter(
      (item) =>
        item.declarationSyntaxKind === "method_declaration" &&
        isHostedMember(item.identifierSyntax) &&
        findOwner(state.parsed.declarations, item.locator)?.identifierSyntax === type.typeSyntax,
    );
    for (const member of members) {
      memberRows.push(
        Object.freeze({
          memberId: rowId(
            "location-member",
            type.sourcePath,
            member.locator,
            `${type.typeSyntax}.${member.identifierSyntax}`,
          ),
          rowKind: "location-interaction-or-continuation-host",
          family: memberFamily(member.identifierSyntax),
          sourcePath: type.sourcePath,
          sourceLocator: member.locator,
          ownerTypeId: type.typeId,
          ownerTypeSyntax: type.typeSyntax,
          memberSyntax: member.identifierSyntax,
          modifiersSyntax: member.modifiersSyntax,
          parametersSyntax: member.parametersSyntax,
          immediateHandoffs: handoffsFor({ source: state.source, member, owner: type, typeByName }),
          reviewState: "pending-source-owner-review",
        }),
      );
    }
  }
  const sortedMembers = memberRows.sort((a, b) => a.memberId.localeCompare(b.memberId));
  return Object.freeze({
    artifactKind: "game_location_interaction_continuation_register",
    sourceFileCount: selected.length,
    locationTypeCount: typeRows.length,
    typeRows: Object.freeze(typeRows.sort((a, b) => a.typeId.localeCompare(b.typeId))),
    memberRowCount: sortedMembers.length,
    memberRows: Object.freeze(sortedMembers),
    parseGaps: Object.freeze(parseGaps),
    analysisBoundary: Object.freeze({
      immediateOwnerAndHandoffSyntax: "performed",
      dispatchResolution: "not_performed",
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      playerOperationDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
