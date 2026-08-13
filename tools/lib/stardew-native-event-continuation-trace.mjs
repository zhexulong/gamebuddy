import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_METHODS = new Set(["Fire", "Poll", "Clear"]);
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function locator(value, field, details) {
  if (
    !value ||
    typeof value.relativePath !== "string" ||
    !Number.isInteger(value.startByte) ||
    !Number.isInteger(value.endByte) ||
    value.endByte <= value.startByte ||
    !SHA256.test(value.sliceSha256 ?? "") ||
    !SHA256.test(value.sourceFileSha256 ?? "")
  )
    fail("native_event_trace_locator_invalid", `Expected exact ${field} locator.`, details);
}
function sourceSlice(value, sourceFiles, field, details) {
  locator(value, field, details);
  const source = sourceFiles?.[value.relativePath];
  if (!source || typeof source.text !== "string" || source.sha256 !== value.sourceFileSha256)
    fail("native_event_trace_source_missing", `Exact source for ${field} is absent or stale.`, details);
  const bytes = Buffer.from(source.text, "utf8");
  if (
    value.endByte > bytes.length ||
    createHash("sha256").update(bytes.subarray(value.startByte, value.endByte)).digest("hex") !== value.sliceSha256
  )
    fail("native_event_trace_locator_stale", `${field} does not match exact source bytes.`, details);
  return bytes.subarray(value.startByte, value.endByte).toString("utf8");
}
function noProductTerms(value, at = "$") {
  const forbidden = new Set([
    "action",
    "actionId",
    "primitive",
    "primitiveId",
    "operation",
    "operationId",
    "semanticFamily",
    "intent",
    "contract",
    "receipt",
    "evidence",
    "policy",
    "capability",
    "publicActionId",
    "projection",
    "reuse",
  ]);
  if (Array.isArray(value)) return value.forEach((entry, index) => noProductTerms(entry, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key))
      fail("native_event_trace_forbidden_field", `Native event trace must not infer ${key}.`, { at: `${at}.${key}` });
    noProductTerms(entry, `${at}.${key}`);
  }
}
/** Exact-source trace of one NetEvent-style source continuation. It validates
 * registration, Fire/Poll source handoff, and handler locator without naming
 * a transition or deciding what the handler means. */
export function validateNativeEventContinuationTrace(trace, { sourceFiles } = {}) {
  noProductTerms(trace);
  if (!trace || trace.schemaVersion !== 1 || trace.artifactKind !== "native_event_continuation_trace")
    fail("native_event_trace_schema_invalid", "Expected native event continuation trace schema version 1.");
  if (
    typeof trace.eventField !== "string" ||
    !trace.eventField.trim() ||
    typeof trace.handlerMember !== "string" ||
    !trace.handlerMember.trim()
  )
    fail("native_event_trace_invalid", "Trace requires eventField and handlerMember.");
  const eventDeclaration = sourceSlice(trace.eventDeclaration, sourceFiles, "eventDeclaration", {});
  if (!eventDeclaration.includes(trace.eventField))
    fail("native_event_trace_event_field_missing", "Event declaration must name eventField.");
  const registration = sourceSlice(trace.registration, sourceFiles, "registration", {});
  if (
    !registration.includes(trace.eventField) ||
    !registration.includes(trace.handlerMember) ||
    !registration.includes("onEvent")
  )
    fail(
      "native_event_trace_registration_missing",
      "Registration must bind the event field to the exact handler member.",
    );
  const handler = sourceSlice(trace.handlerDeclaration, sourceFiles, "handlerDeclaration", {});
  if (!handler.includes(trace.handlerMember))
    fail("native_event_trace_handler_missing", "Handler declaration must name handlerMember.");
  if (!Array.isArray(trace.eventClassMethods) || !trace.eventClassMethods.length)
    fail("native_event_trace_methods_missing", "Trace requires exact event class method anchors.");
  const methods = new Set();
  for (const method of trace.eventClassMethods) {
    if (!EVENT_METHODS.has(method?.name) || methods.has(method.name))
      fail("native_event_trace_method_invalid", "Event trace methods must have unique Fire/Poll/Clear names.");
    const text = sourceSlice(method.declaration, sourceFiles, "eventClassMethods[].declaration", { name: method.name });
    if (!text.includes(` ${method.name}(`))
      fail("native_event_trace_method_missing", "Event method anchor does not contain method name.", {
        name: method.name,
      });
    methods.add(method.name);
  }
  if (!methods.has("Fire") || !methods.has("Poll"))
    fail(
      "native_event_trace_required_method_missing",
      "Event continuation requires exact Fire and Poll method anchors.",
    );
  if (
    !Array.isArray(trace.triggerCallsites) ||
    !trace.triggerCallsites.length ||
    !Array.isArray(trace.pollCallsites) ||
    !trace.pollCallsites.length
  )
    fail("native_event_trace_callsites_missing", "Trace requires trigger and poll callsites.");
  for (const callsite of trace.triggerCallsites) {
    const text = sourceSlice(callsite, sourceFiles, "event trigger callsite", {});
    if (!text.includes(trace.eventField) || !text.includes(".Fire("))
      fail("native_event_trace_callsite_invalid", "Trigger callsite must invoke Fire on exact event field.");
  }
  for (const callsite of trace.pollCallsites) {
    const text = sourceSlice(callsite, sourceFiles, "event poll callsite", {});
    if (!text.includes(trace.eventField) || !text.includes(".Poll("))
      fail("native_event_trace_callsite_invalid", "Poll callsite must invoke Poll on exact event field.");
  }
  const state =
    trace.continuationState === "locally_attested_polling_and_handler"
      ? "locally_attested_polling_and_handler"
      : "partial";
  return Object.freeze({
    triggerCallsiteCount: trace.triggerCallsites.length,
    pollCallsiteCount: trace.pollCallsites.length,
    continuationState: state,
    analysisBoundary: Object.freeze({
      handlerMeaning: "not_inferred",
      networkDeliveryCompleteness: "not_inferred",
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
