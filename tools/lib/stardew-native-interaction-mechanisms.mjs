import { createHash } from "node:crypto";
import { parseCSharpSyntaxStructure } from "./stardew-csharp-syntax-structural-canary.mjs";

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

// These are intentionally broad, syntax-level discovery families. A match is
// review input, never evidence that the member is a gameplay mechanism.
const HOST_MEMBER_NAMES = new Set([
  "UpdateControlInput", "pressActionButton", "pressUseToolButton", "pressSwitchToolButton", "updateActiveMenu", "updateTextEntry", "showTextEntry", "closeTextEntry", "Update", "_update", "UpdateOther", "doMainGameUpdates", "performAction", "answerDialogueAction", "answerDialogue", "performToolAction", "performUseAction", "placementAction", "checkAction", "checkForAction", "leftClick", "LowPriorityLeftClick", "beginUsing", "endUsing", "DoFunction", "tickUpdate", "DayUpdate", "dayUpdate", "update", "updateEvenIfFarmerIsntHere", "UpdateWhenCurrentLocation", "updateWhenCurrentLocation", "updateWhenNotCurrentLocation", "updateWhenFarmNotCurrentLocation", "timeUpdate", "performTenMinuteUpdate", "performTenMinuteAction", "startEvent", "checkForEvents", "Save", "Load", "getSaveEnumerator", "getLoadEnumerator", "NewDay", "newDayAfterFade", "PollForEndOfNewDaySync", "UpdateEarly", "UpdateLate", "UpdateLoading", "updateRoots", "receiveMessages", "sendMessages", "Poll", "Raise", "TryRunAction", "TryRunActions", "tryEventCommand", "ParseAction", "ParseCommands", "initNetFields",

]);

const CONTENT_INTERPRETER_PATTERNS = Object.freeze([
  Object.freeze({ id: "content:dataloader", expression: /\bDataLoader\.[A-Za-z_]\w*\s*\(/g }),
  Object.freeze({ id: "content:load", expression: /\b(?:[A-Za-z_]\w*\.)?(?:temporaryContent|content|festivalContent)\.Load(?:String)?(?:<[^>]+>)?\s*\(/g }),
  Object.freeze({ id: "content:map-property", expression: /\b(?:doesTileHaveProperty|GetTilePropertySplitBySpaces|TileIndexProperties|TouchAction)\b/g }),
  Object.freeze({ id: "content:event", expression: /\b(?:SetupEventCommandsIfNeeded|TryGetEventCommandHandler|tryEventCommand|ParseCommands|RegisterCommand)\b/g }),
  Object.freeze({ id: "content:trigger", expression: /\b(?:TriggerActionManager\.|TryRunAction|TryRunActions|GetActionsByTrigger|ParseAction)\b/g }),
  Object.freeze({ id: "content:query", expression: /\b(?:ItemQueryResolver|GameStateQuery|TokenParser)\b/g }),
]);

const CONTINUATION_PATTERNS = Object.freeze([
  Object.freeze({ id: "continuation:delayed", expression: /\b(?:DelayedAction|delayedActions)\b/g }),
  Object.freeze({ id: "continuation:enumerator", expression: /\b(?:IEnumerator(?:<[^>]+>)?|MoveNext\s*\()\b/g }),
  Object.freeze({ id: "continuation:task", expression: /\b(?:Task\b|_newDayTask|IsCompleted)\b/g }),
  Object.freeze({ id: "continuation:event-menu-minigame", expression: /\b(?:currentEvent|activeClickableMenu|currentMinigame|IClickableMenu|IMinigame)\b/g }),
  Object.freeze({ id: "continuation:network", expression: /\b(?:Multiplayer|receiveMessages|sendMessages|NetEvent\w*|\.Poll\s*\()\b/g }),
  Object.freeze({ id: "continuation:delegate-event", expression: /\b(?:Delegate\.CreateDelegate|\.onEvent\s*[+\-]=|\.Fire\s*\(|Register(?:Command|Action|TileAction)\s*\()\b/g }),
  Object.freeze({ id: "continuation:dynamic-construction", expression: /\b(?:Activator\.CreateInstance|Type\.GetType\s*\(|\.GetMethods\s*\()\b/g }),
]);

function sourceLine(source, index) {
  return source.slice(0, index).split("\n").length;
}

function ownerFor(declarations, locator) {
  const owners = declarations
    .filter((item) => ["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"].includes(item.declarationSyntaxKind))
    .filter((item) => item.locator.startByte <= locator.startByte && item.locator.endByte >= locator.endByte)
    .sort((left, right) => left.locator.endByte - left.locator.startByte - (right.locator.endByte - right.locator.startByte));
  return owners[0] ?? null;
}

function overlapsAny(locator, locators) {
  return locators.some((other) => locator.startByte < other.endByte && other.startByte < locator.endByte);
}

function structuralMechanisms(parsed, fileSyntaxState) {
  return parsed.declarations
    .filter((item) => ["interface_declaration", "event_declaration", "event_field_declaration"].includes(item.declarationSyntaxKind))
    .map((item) => Object.freeze({
      mechanismId: `structural:${hash(`${item.locator.relativePath}\0${item.locator.startByte}\0${item.locator.endByte}`)}`,
      category: "structural-declaration-syntax",
      family: `structural:${item.declarationSyntaxKind}`,
      sourcePath: item.locator.relativePath,
      sourceLocator: item.locator,
      lexicalOwnerSyntax: ownerFor(parsed.declarations, item.locator)?.identifierSyntax ?? null,
      lexicalOwnerLocator: ownerFor(parsed.declarations, item.locator)?.locator ?? null,
      identifierSyntax: item.identifierSyntax,
      fileSyntaxState,
      reviewState: "pending_source_owner_review",
    }));
}

function hostMechanisms(parsed, fileSyntaxState) {
  const invalidSyntax = [...parsed.parse.errorNodes, ...parsed.parse.missingNodes];
  return parsed.declarations
    .filter((item) => item.declarationSyntaxKind === "method_declaration" && HOST_MEMBER_NAMES.has(item.identifierSyntax))
    .filter((item) => !overlapsAny(item.locator, invalidSyntax))
    .map((item) => {
      const owner = ownerFor(parsed.declarations, item.locator);
      return Object.freeze({
        mechanismId: `host:${hash(`${item.locator.relativePath}\0${item.locator.startByte}\0${item.locator.endByte}`)}`,
        category: "host-declaration-syntax",
        family: `host:${item.identifierSyntax}`,
        sourcePath: item.locator.relativePath,
        sourceLocator: item.locator,
        lexicalOwnerSyntax: owner?.identifierSyntax ?? null,
        lexicalOwnerLocator: owner?.locator ?? null,
        modifiersSyntax: item.modifiersSyntax,
        declarationShape: item.modifiersSyntax.some((modifier) => ["virtual", "override", "new"].includes(modifier)) ? "polymorphic-syntax" : "non-polymorphic-syntax",
        fileSyntaxState,
        returnSyntax: item.typeSyntax,
        parametersSyntax: item.parametersSyntax,
        reviewState: "pending_source_owner_review",
      });
    });
}

function patternMechanisms(sourcePath, source, patterns, category, fileSyntaxState, declarations) {
  const rows = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.expression)) {
      const sourceLocator = Object.freeze({ relativePath: sourcePath, startByte: Buffer.byteLength(source.slice(0, match.index)), endByte: Buffer.byteLength(source.slice(0, match.index + match[0].length)), line: sourceLine(source, match.index), sliceSha256: hash(match[0]) });
      const memberOwner = declarations
        .filter((item) => item.declarationSyntaxKind === "method_declaration" && item.bodyLocator)
        .filter((item) => item.locator.startByte <= sourceLocator.startByte && item.locator.endByte >= sourceLocator.endByte)
        .sort((left, right) => left.locator.endByte - left.locator.startByte - (right.locator.endByte - right.locator.startByte))[0] ?? null;
      rows.push(Object.freeze({
        mechanismId: `${category}:${hash(`${sourcePath}\0${pattern.id}\0${match.index}\0${match[0]}`)}`,
        category,
        family: pattern.id,
        sourcePath,
        sourceLocator,
        lexicalMemberSyntax: memberOwner?.identifierSyntax ?? null,
        lexicalMemberLocator: memberOwner?.locator ?? null,
        fileSyntaxState,
        reviewState: "pending_source_owner_review",
      }));
    }
  }
  return rows;
}

export async function enumerateNativeInteractionMechanisms(sourceRecords) {
  if (!Array.isArray(sourceRecords) || sourceRecords.length === 0) fail("mechanism_source_records_required", "Provide non-empty exact source records.");
  const sourcePaths = new Set();
  const mechanisms = [];
  const parseGaps = [];
  let parser = null;
  for (const record of [...sourceRecords].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    if (!record || typeof record.relativePath !== "string" || typeof record.text !== "string") fail("mechanism_source_record_invalid", "Invalid source record.");
    const sourcePath = record.relativePath.replaceAll("\\", "/");
    if (sourcePaths.has(sourcePath)) fail("mechanism_source_duplicate", "Duplicate source record.", { sourcePath });
    sourcePaths.add(sourcePath);
    const parsed = await parseCSharpSyntaxStructure({ source: record.text, relativePath: sourcePath });
    parser ??= parsed.parser;
    const fileSyntaxState = parsed.parse.hasError || parsed.parse.errorNodes.length || parsed.parse.missingNodes.length
      ? "partial_syntax_only"
      : "parse_clean";
    if (fileSyntaxState === "partial_syntax_only") {
      parseGaps.push(Object.freeze({ sourcePath, parse: parsed.parse }));
    }
    // A parse gap invalidates absence/whole-body claims, not every declaration
    // outside its exact spans. Keep non-overlapping anchors visible for review.
    mechanisms.push(...structuralMechanisms(parsed, fileSyntaxState));
    mechanisms.push(...hostMechanisms(parsed, fileSyntaxState));
    mechanisms.push(...patternMechanisms(sourcePath, record.text, CONTENT_INTERPRETER_PATTERNS, "content-interpreter-syntax", fileSyntaxState, parsed.declarations));
    mechanisms.push(...patternMechanisms(sourcePath, record.text, CONTINUATION_PATTERNS, "continuation-syntax", fileSyntaxState, parsed.declarations));
  }
  const uniqueMechanisms = new Map();
  for (const mechanism of mechanisms) {
    const prior = uniqueMechanisms.get(mechanism.mechanismId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(mechanism)) fail("mechanism_id_duplicate", "Mechanism enumeration generated conflicting identities.", { mechanismId: mechanism.mechanismId });
    uniqueMechanisms.set(mechanism.mechanismId, mechanism);
  }
  const ordered = [...uniqueMechanisms.values()].sort((left, right) => left.mechanismId.localeCompare(right.mechanismId));
  const byFamily = new Map();
  for (const mechanism of ordered) byFamily.set(mechanism.family, (byFamily.get(mechanism.family) ?? 0) + 1);
  return Object.freeze({
    sourceFileCount: sourcePaths.size,
    mechanismCount: ordered.length,
    parser,
    parseGaps: Object.freeze(parseGaps),
    mechanisms: Object.freeze(ordered),
    familyCounts: Object.freeze([...byFamily].map(([family, count]) => Object.freeze({ family, count })).sort((a, b) => a.family.localeCompare(b.family))),
    analysisBoundary: Object.freeze({ sourceSyntaxEnumeration: "performed", sourceOwnerResolution: "not_performed", transitionDerivation: "not_performed", primitiveDerivation: "not_performed", playerOperationDerivation: "not_performed", publicActionProjection: "not_performed" }),
  });
}
