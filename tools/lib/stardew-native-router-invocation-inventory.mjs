import { createHash } from "node:crypto";
import { parseCSharpSyntaxStructure } from "./stardew-csharp-syntax-structural-canary.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function fail(code, message, details = {}) { const error = new Error(message); error.code = code; error.details = details; throw error; }
function sourceHash(source) { return sha256(Buffer.from(source, "utf8")); }
function exactMethod(source, relativePath, signature) {
  if (typeof source !== "string" || !source || typeof relativePath !== "string" || !relativePath || typeof signature !== "string" || !signature) fail("router_inventory_argument_invalid", "source, relativePath, and signature are required.");
  const start = source.indexOf(signature);
  if (start < 0 || source.indexOf(signature, start + signature.length) >= 0) fail("router_inventory_method_anchor_missing", "Method signature must occur exactly once.", { signature });
  const brace = source.indexOf("{", start + signature.length); if (brace < 0) fail("router_inventory_method_malformed", "Method signature lacks an opening brace.", { signature });
  let depth = 0; let state = "code";
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (state === "line") { if (char === "\n") state = "code"; continue; }
    if (state === "block") { if (char === "*" && next === "/") { state = "code"; index += 1; } continue; }
    if (state === "string") { if (char === "\\") { index += 1; continue; } if (char === '"') state = "code"; continue; }
    if (char === "/" && next === "/") { state = "line"; index += 1; continue; }
    if (char === "/" && next === "*") { state = "block"; index += 1; continue; }
    if (char === '"') { state = "string"; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) {
      const startByte = Buffer.byteLength(source.slice(0, start), "utf8"); const endByte = Buffer.byteLength(source.slice(0, index + 1), "utf8"); const bytes = Buffer.from(source, "utf8");
      return Object.freeze({ relativePath, startByte, endByte, sliceSha256: sha256(bytes.subarray(startByte, endByte)), sourceFileSha256: sourceHash(source) });
    }
  }
  fail("router_inventory_method_malformed", "Method body is not closed.", { signature });
}
function belongsTo(locator, owner) { return locator.relativePath === owner.relativePath && locator.startByte >= owner.startByte && locator.endByte <= owner.endByte; }
function overlaps(locator, owner) { return locator.relativePath === owner.relativePath && locator.startByte < owner.endByte && locator.endByte > owner.startByte; }

/** Syntax-only inventory of visible invocation expressions lexically inside one
 * exact source router. It resolves neither overloads nor runtime receivers;
 * a partial parse is retained as a blocking source-reading gap, not treated
 * as a complete router-exit inventory. */
export async function deriveNativeRouterInvocationInventory({ source, relativePath, signature } = {}) {
  const owner = exactMethod(source, relativePath, signature);
  const parsed = await parseCSharpSyntaxStructure({ source, relativePath });
  const routerParseGaps = [...parsed.parse.errorNodes, ...parsed.parse.missingNodes].filter((entry) => overlaps(entry, owner)).map((entry) => Object.freeze({ ...entry, sourceFileSha256: owner.sourceFileSha256 }));
  const invocations = parsed.invocationSyntax.filter((entry) => belongsTo(entry.locator, owner)).map((entry, sequence) => Object.freeze({
    invocationId: `router-invocation:${sha256(`${relativePath}\0${entry.locator.startByte}\0${entry.locator.endByte}`)}`,
    sequence,
    sourceLocator: Object.freeze({ ...entry.locator, sourceFileSha256: owner.sourceFileSha256 }),
    calleeLocator: entry.calleeLocator ? Object.freeze({ ...entry.calleeLocator, sourceFileSha256: owner.sourceFileSha256 }) : null,
    calleeSyntaxKind: entry.calleeSyntaxKind,
    calleeSyntaxSha256: entry.calleeSyntaxSha256,
    argumentSyntaxCount: entry.argumentSyntaxCount,
    sourceSyntaxState: parsed.parse.hasError ? "partial_syntax_only" : "parse_clean",
    resolutionState: "not_resolved_by_syntax_inventory",
  })).sort((left, right) => left.sequence - right.sequence);
  const syntaxInventoryState = routerParseGaps.length ? "partial_syntax_only" : "parse_clean_visible_invocations";
  return Object.freeze({ schemaVersion: 1, artifactKind: "native_router_invocation_inventory", routerDeclaration: owner, parser: parsed.parser, parse: parsed.parse, routerParseGaps: Object.freeze(routerParseGaps), syntaxInventoryState, invocationCount: invocations.length, invocations: Object.freeze(invocations), analysisBoundary: Object.freeze({ syntaxInvocationInventory: "performed", sourceCompleteness: syntaxInventoryState === "partial_syntax_only" ? "blocked_by_exact_router_parse_gap" : "not_inferred", overloadResolution: "not_performed", targetResolution: "not_performed", inputProvenance: "not_performed", sourceOwnerResolution: "not_performed", transitionDerivation: "not_performed", primitiveDerivation: "not_performed", publicActionProjection: "not_performed" }) });
}
