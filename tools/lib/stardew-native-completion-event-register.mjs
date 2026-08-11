import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(code, message, details = {}) { const error = new Error(message); error.code = code; error.details = details; throw error; }
function noProductTerms(value, at = "$") { const forbidden = new Set(["action", "actionId", "primitive", "primitiveId", "operation", "operationId", "semanticFamily", "intent", "contract", "receipt", "evidence", "policy", "capability", "publicActionId", "projection", "reuse"]); if (Array.isArray(value)) return value.forEach((entry, index) => noProductTerms(entry, `${at}[${index}]`)); if (!value || typeof value !== "object") return; for (const [key, entry] of Object.entries(value)) { if (forbidden.has(key)) fail("completion_event_register_forbidden_field", `Completion-event register must not infer ${key}.`, { at: `${at}.${key}` }); noProductTerms(entry, `${at}.${key}`); } }
function source(sourceFiles, relativePath) { const item = sourceFiles?.[relativePath]; if (!item || typeof item.text !== "string" || !SHA256.test(item.sha256 ?? "") || hash(Buffer.from(item.text, "utf8")) !== item.sha256) fail("completion_event_register_source_invalid", "Exact source text/hash is required.", { relativePath }); return item; }
function loc(relativePath, bytes, startByte, endByte) { return Object.freeze({ relativePath, startByte, endByte, sliceSha256: hash(bytes.subarray(startByte, endByte)), sourceFileSha256: hash(bytes) }); }
function matchLocators(relativePath, text, regex) { const bytes = Buffer.from(text, "utf8"), result = []; for (let match; (match = regex.exec(text));) { const startByte = Buffer.byteLength(text.slice(0, match.index), "utf8"); result.push(loc(relativePath, bytes, startByte, startByte + Buffer.byteLength(match[0], "utf8"))); } return result; }
/** Enumerates only source-visible `NetEvent* finishEvent` wiring: declaration,
 * onEvent handler registration, every local `.Fire()`, and `.Poll()` callsite.
 * It does not assert what the handler effects mean or when they execute. */
export function deriveNativeCompletionEventRegister({ sourceFiles, definitions } = {}) {
  if (!Array.isArray(definitions) || !definitions.length) fail("completion_event_register_definitions_missing", "Nonempty exact completion-event definitions are required.");
  const ids = new Set(), events = [];
  for (const definition of definitions) {
    const { eventId, relativePath, eventField = "finishEvent", handlerMember = "doFinish" } = definition ?? {};
    if (typeof eventId !== "string" || !eventId || ids.has(eventId)) fail("completion_event_register_id_invalid", "Event IDs must be unique and nonempty.", { eventId }); ids.add(eventId);
    const record = source(sourceFiles, relativePath), text = record.text;
    const declaration = matchLocators(relativePath, text, new RegExp(`\\b(?:private|protected|public)\\s+(?:readonly\\s+)?NetEvent\\w*\\s+${eventField}\\s*=`, "g"));
    const registrations = matchLocators(relativePath, text, new RegExp(`\\b${eventField}\\.onEvent\\s*\\+=\\s*${handlerMember}\\s*;`, "g"));
    const fires = matchLocators(relativePath, text, new RegExp(`\\b${eventField}\\.Fire\\s*\\(`, "g"));
    const polls = matchLocators(relativePath, text, new RegExp(`\\b${eventField}\\.Poll\\s*\\(`, "g"));
    const handler = matchLocators(relativePath, text, new RegExp(`\\b(?:private|protected|public)\\s+(?:void|bool)\\s+${handlerMember}\\s*\\(`, "g"));
    if (declaration.length !== 1 || registrations.length !== 1 || !fires.length || !polls.length || handler.length !== 1) fail("completion_event_register_wiring_missing", "Completion event requires one declaration/registration/handler and visible Fire/Poll callsites.", { eventId, declarationCount: declaration.length, registrationCount: registrations.length, fireCount: fires.length, pollCount: polls.length, handlerCount: handler.length });
    events.push(Object.freeze({ eventId, relativePath, eventField, handlerMember, declaration: declaration[0], registration: registrations[0], fireCallsites: Object.freeze(fires), pollCallsites: Object.freeze(polls), handlerDeclaration: handler[0], sourceWiringState: "source_visible_fire_poll_handler" }));
  }
  return Object.freeze({ schemaVersion: 1, artifactKind: "native_completion_event_register", eventCount: events.length, events: Object.freeze(events), analysisBoundary: Object.freeze({ sourceWiringEnumeration: "performed", eventDeliverySemantics: "not_inferred", handlerStateEffectInterpretation: "not_performed", continuationTerminality: "not_inferred", transitionDerivation: "not_performed", primitiveDerivation: "not_performed", publicActionProjection: "not_performed" }) });
}
export function validateNativeCompletionEventRegister(register, { sourceFiles } = {}) { noProductTerms(register); const definitions = register?.events?.map(({ eventId, relativePath, eventField, handlerMember }) => ({ eventId, relativePath, eventField, handlerMember })); const derived = deriveNativeCompletionEventRegister({ sourceFiles, definitions }); if (JSON.stringify(register.events) !== JSON.stringify(derived.events)) fail("completion_event_register_stale", "Register does not match exact source event wiring."); return derived; }
